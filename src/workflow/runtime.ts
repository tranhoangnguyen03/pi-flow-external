import { prepareParentContext } from "../core/parent-context.ts";
import { resolve } from "node:path";
import { parseWorkflowScript } from "./script-validation.ts";
import { fingerprintWorkflowAgentCall } from "./replay-cache.ts";
import { createWorkflowScriptWorker, type ParentToWorkerMessage, type WorkerToParentMessage } from "./script-worker.ts";
import {
  defaultAgentLabel,
  normalizeAgentOptions,
  normalizeJsonSerializable,
  requireString,
  truncateLogLine,
} from "./runtime-values.ts";
import { ChildRunError, childRunErrorData } from "./types.ts";
import type {
  RunWorkflowOptions,
  WorkflowAgentCall,
  WorkflowAgentQueuedEvent,
  WorkflowAgentResultEvent,
  WorkflowLimits,
  WorkflowRunResult,
} from "./types.ts";

export type {
  RunWorkflowOptions,
  WorkflowAgentCall,
  WorkflowAgentResultEvent,
  WorkflowAgentRunner,
  WorkflowCachedAgentResult,
  WorkflowLimits,
  WorkflowMeta,
  WorkflowMetaPhase,
  WorkflowRunResult,
} from "./types.ts";
export { ChildRunError } from "./types.ts";
export { parseWorkflowScript } from "./script-validation.ts";
export { fingerprintWorkflowAgentCall, hashStableValue } from "./replay-cache.ts";

interface RuntimeState {
  currentPhase?: string;
  logs: string[];
  phases: string[];
  agentCount: number;
  resumePrefixActive: boolean;
}

const DEFAULT_SUBAGENT_TYPE = "general-purpose";

const DEFAULT_WORKFLOW_LIMITS: WorkflowLimits = {
  maxAgentCalls: 1_000,
  maxLogs: 500,
  maxLogLength: 4_000,
  workerHeartbeatIntervalMs: 250,
  workerStallTimeoutMs: 60_000,
  workerIdleTimeoutMs: 300_000,
  syncExecutionTimeoutMs: 5_000,
  workerMaxOldGenerationSizeMb: 512,
  workerMaxYoungGenerationSizeMb: 32,
  workerStackSizeMb: 4,
  abortGraceMs: 4_000,
};

async function settleWithin(promises: Promise<unknown>[], timeoutMs: number): Promise<boolean> {
  if (promises.length === 0) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settled = await Promise.race([
    Promise.allSettled(promises).then(() => true),
    new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
  ]);
  if (timer) clearTimeout(timer);
  return settled;
}

class WorkflowFatalError extends Error {
  readonly workflowFatal = true;
}

export class WorkflowAbortError extends WorkflowFatalError {
  readonly workflowAbort = true;
}

function isWorkflowFatalError(error: unknown): error is WorkflowFatalError {
  return error instanceof WorkflowFatalError;
}

function asChildRunError(error: unknown, runId: string): ChildRunError {
  if (error instanceof ChildRunError) return error;
  return new ChildRunError({
    runId,
    outcome: "failed",
    message: error instanceof Error ? error.message : String(error),
    outputRef: { runId, view: "output" },
    diagnosticsRef: { runId, view: "diagnostics" },
  });
}

export function isWorkflowAbortError(error: unknown): error is WorkflowAbortError {
  return error instanceof WorkflowAbortError;
}

export async function runWorkflow<T = unknown>(
  script: string,
  options: RunWorkflowOptions,
): Promise<WorkflowRunResult<T>> {
  const { meta, body } = parseWorkflowScript(script);
  const cwd = resolve(options.cwd);
  const limits = normalizeWorkflowLimits(options.limits);
  const state: RuntimeState = {
    logs: [],
    phases: [],
    agentCount: 0,
    resumePrefixActive: Boolean(options.resumeAgentResults?.length),
  };
  const resumeAgentResults = options.resumeAgentResults ?? [];
  const limiter = options.limiter;
  const defaultSubagentType = options.defaultSubagentType === undefined ? DEFAULT_SUBAGENT_TYPE : options.defaultSubagentType;
  const runtimeAbortController = new AbortController();
  const compositeSignal = AbortSignal.any(
    [options.signal, runtimeAbortController.signal].filter((signal): signal is AbortSignal => Boolean(signal)),
  );
  let abortReason = "workflow aborted";
  let fatalError: Error | undefined;

  const rememberFatal = (error: Error) => {
    if (!fatalError) {
      fatalError = error;
    }
    abortReason = error.message || abortReason;
  };

  const abortRuntime = (error: Error) => {
    rememberFatal(error);
    if (!runtimeAbortController.signal.aborted) {
      runtimeAbortController.abort(error);
    }
  };

  const throwIfAborted = () => {
    if (options.signal?.aborted || runtimeAbortController.signal.aborted) {
      throw fatalError ?? new WorkflowFatalError(abortReason);
    }
  };

  const log = (message: unknown) => {
    const text = truncateLogLine(String(message), limits.maxLogLength);
    if (state.logs.length < limits.maxLogs) {
      state.logs.push(text);
      options.onLog?.(text);
      return;
    }
    if (state.logs.length === limits.maxLogs) {
      const truncated = `workflow logs truncated after ${limits.maxLogs} entries`;
      state.logs.push(truncated);
      options.onLog?.(truncated);
    }
  };

  const phase = (title: unknown) => {
    const text = requireString(title, "phase title");
    state.currentPhase = text;
    if (!state.phases.includes(text)) {
      state.phases.push(text);
    }
    options.onPhase?.(text);
  };

  const recordAgentResult = async (event: WorkflowAgentResultEvent) => {
    try {
      await options.onAgentResult?.(event);
    } catch (error) {
      log(`workflow agent-result hook failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const runAgentCall = async (prompt: unknown, agentOptions: unknown = {}) => {
    throwIfAborted();
    if (state.agentCount >= limits.maxAgentCalls) {
      const error = new WorkflowFatalError(`maximum workflow agent calls exceeded (${limits.maxAgentCalls})`);
      abortRuntime(error);
      throw error;
    }
    const opts = normalizeAgentOptions(agentOptions);
    const originalPrompt = requireString(prompt, "agent prompt");
    const briefing = prepareParentContext(originalPrompt, opts.context,
      options.parentMessages, options.parentToolCallId, opts.resumeRunId);
    const taskPrompt = briefing.prompt;
    const assignedPhase = opts.phase ?? state.currentPhase;
    let subagentType: string | null | undefined;
    try {
      subagentType = options.resolveSubagentType
        ? options.resolveSubagentType({ role: opts.role, harness: opts.harness, subagentType: opts.subagentType })
        : opts.subagentType?.trim() || defaultSubagentType;
    } catch (error) {
      const fatal = new WorkflowFatalError(error instanceof Error ? error.message : String(error));
      abortRuntime(fatal);
      throw fatal;
    }
    if (!subagentType?.trim()) {
      const error = new WorkflowFatalError("agent role or legacy subagent_type is required");
      abortRuntime(error);
      throw error;
    }

    const index = ++state.agentCount;
    const label = opts.label || defaultAgentLabel(assignedPhase, index);
    const call: WorkflowAgentCall = {
      index,
      cwd,
      prompt: taskPrompt,
      ...(briefing.context ? { context: briefing.context } : {}),
      label,
      phase: assignedPhase,
      subagentType,
      schema: opts.schema,
      permission: opts.permission,
      maxBudgetUsd: opts.maxBudgetUsd,
      resumeRunId: opts.resumeRunId,
    };
    const fingerprint = fingerprintWorkflowAgentCall(call);
    const cachedResult = state.resumePrefixActive ? resumeAgentResults[index - 1] : undefined;
    if (cachedResult?.index === index && cachedResult.fingerprint === fingerprint && !cachedResult.failed) {
      options.onAgentStart?.({ index, label, phase: assignedPhase, subagentType, prompt: taskPrompt, cached: true, runId: cachedResult.runId });
      options.onAgentEnd?.({ index, label, phase: assignedPhase, result: cachedResult.result, cached: true, failed: false });
      await recordAgentResult({ ...call, prompt: originalPrompt, index, fingerprint, result: cachedResult.result, failed: false, cached: true, runId: cachedResult.runId });
      return cachedResult.result;
    }
    state.resumePrefixActive = false;

    // Queue on the shared global cap. May reject if aborted while waiting.
    const queuedEvent: WorkflowAgentQueuedEvent = { index, label, phase: assignedPhase, subagentType, prompt: taskPrompt, context: briefing.context };
    await options.onAgentQueued?.(queuedEvent);
    const runRecord = queuedEvent.runRecord;
    if (runRecord) call.runRecord = runRecord;
    const executeAgent = async (childSignal?: AbortSignal) => {
      const executionSignal = AbortSignal.any(
        [compositeSignal, childSignal].filter((signal): signal is AbortSignal => Boolean(signal)),
      );
      const recordFailure = async (childError: ChildRunError) => {
        log(`agent ${label} failed: ${childError.message}`);
        const serialized = childRunErrorData(childError);
        options.onAgentEnd?.({ index, label, phase: assignedPhase, result: undefined, failed: true, cached: false, error: serialized });
        await recordAgentResult({
          ...call,
          prompt: originalPrompt,
          index,
          fingerprint,
          result: undefined,
          failed: true,
          cached: false,
          runId: childError.runId,
          error: serialized,
        });
      };
      const cancelledError = (message: string) => {
        const runId = runRecord?.runId ?? `workflow-child-${index}`;
        return new ChildRunError({
          runId,
          outcome: "cancelled",
          message,
          outputRef: { runId, view: "output" },
          diagnosticsRef: { runId, view: "diagnostics" },
        });
      };

      let release: (() => void) | undefined;
      try {
        release = await limiter.acquire(executionSignal);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await runRecord?.finish({
          status: executionSignal.aborted ? "aborted" : "error",
          error: message,
          queued: true,
          backendStarted: false,
        });
        const fatal = options.signal?.aborted || runtimeAbortController.signal.aborted || isWorkflowFatalError(error);
        const childError = fatal || childSignal?.aborted
          ? cancelledError(fatal ? abortReason : message)
          : asChildRunError(error, runRecord?.runId ?? `workflow-child-${index}`);
        await recordFailure(childError);
        if (fatal) throw error;
        throw childError;
      }

      let result: unknown;
      try {
        options.onAgentStart?.({ index, label, phase: assignedPhase, subagentType, prompt: taskPrompt });
        throwIfAborted();
        result = await options.runAgent(call, executionSignal);
        throwIfAborted();
        result = normalizeJsonSerializable(result, "agent result");
      } catch (error) {
        const fatal = options.signal?.aborted || runtimeAbortController.signal.aborted || isWorkflowFatalError(error);
        const message = error instanceof Error ? error.message : String(error);
        const childError = (fatal || childSignal?.aborted) && !(error instanceof ChildRunError)
          ? cancelledError(fatal ? abortReason : message)
          : asChildRunError(error, runRecord?.runId ?? `workflow-child-${index}`);
        await recordFailure(childError);
        if (fatal) throw error;
        throw childError;
      } finally {
        release();
      }
      options.onAgentEnd?.({ index, label, phase: assignedPhase, result, failed: false, cached: false });
      await recordAgentResult({ ...call, prompt: originalPrompt, index, fingerprint, result, failed: false, cached: false, runId: runRecord?.runId });
      return result;
    };

    return options.startAgentRun
      ? options.startAgentRun(call, (signal) => executeAgent(signal))
      : executeAgent();
  };

  const worker = createWorkflowScriptWorker({
    body,
    metaName: meta.name || "workflow",
    args: options.args,
    cwd,
    limits,
  });

  return await new Promise<WorkflowRunResult<T>>((resolve, reject) => {
    let finished = false;
    let lastHeartbeat = Date.now();
    let lastProgressAt = Date.now();
    let abortTimer: ReturnType<typeof setTimeout> | undefined;
    let stallTimer: ReturnType<typeof setInterval> | undefined;
    const activeAgentTasks = new Set<Promise<void>>();

    const cleanup = () => {
      if (options.signal && onExternalAbort) {
        options.signal.removeEventListener("abort", onExternalAbort);
      }
      if (abortTimer) {
        clearTimeout(abortTimer);
      }
      if (stallTimer) {
        clearInterval(stallTimer);
      }
      worker.removeAllListeners();
    };

    const finishReject = (error: Error) => {
      if (finished) {
        return;
      }
      finished = true;
      abortRuntime(isWorkflowFatalError(error) ? error : new WorkflowFatalError(error.message));
      cleanup();
      void (async () => {
        const drained = await settleWithin([worker.terminate(), ...activeAgentTasks], limits.abortGraceMs);
        if (!drained) options.onLog?.(`workflow cleanup remains uncertain after ${limits.abortGraceMs}ms`);
        reject(error);
      })();
    };

    const finishResolve = (result: unknown) => {
      if (finished) {
        return;
      }
      let normalizedResult: unknown;
      try {
        throwIfAborted();
        if (fatalError) {
          throw fatalError;
        }
        if (state.agentCount === 0) {
          throw new Error("workflow must call agent() at least once");
        }
        normalizedResult = normalizeJsonSerializable(result, "workflow result");
      } catch (error) {
        finishReject(error instanceof Error ? error : new Error(String(error)));
        return;
      }

      finished = true;
      cleanup();
      void (async () => {
        const drained = await settleWithin([...activeAgentTasks, worker.terminate()], limits.abortGraceMs);
        if (!drained) {
          reject(new WorkflowFatalError(`workflow cleanup remains uncertain after ${limits.abortGraceMs}ms`));
          return;
        }
        resolve({
          meta,
          result: normalizedResult as T,
          logs: state.logs,
          phases: state.phases,
          agentCount: state.agentCount,
        });
      })();
    };

    const abortWorkflow = (reason: string) => {
      if (finished) {
        return;
      }
      const error = new WorkflowAbortError(reason);
      abortRuntime(error);
      postToWorker({ type: "abort", reason });
      if (!abortTimer) {
        abortTimer = setTimeout(() => {
          finishReject(error);
        }, limits.abortGraceMs);
        abortTimer.unref?.();
      }
    };

    const externalAbortReason = () => options.signal?.reason === undefined
      ? "workflow aborted"
      : options.signal.reason instanceof Error ? options.signal.reason.message : String(options.signal.reason);
    const onExternalAbort = () => abortWorkflow(externalAbortReason());
    if (options.signal?.aborted) {
      abortWorkflow(externalAbortReason());
    } else {
      options.signal?.addEventListener("abort", onExternalAbort, { once: true });
    }

    const watchdogIntervalMs = Math.max(
      10,
      Math.min(1_000, Math.floor(Math.min(limits.workerStallTimeoutMs, limits.workerIdleTimeoutMs) / 4)),
    );
    stallTimer = setInterval(() => {
      if (finished) {
        return;
      }
      const now = Date.now();
      const silentFor = now - lastHeartbeat;
      if (silentFor >= limits.workerStallTimeoutMs) {
        finishReject(new WorkflowFatalError(`workflow script worker stalled for ${silentFor}ms`));
        return;
      }
      const idleFor = now - lastProgressAt;
      if (activeAgentTasks.size === 0 && idleFor >= limits.workerIdleTimeoutMs) {
        finishReject(new WorkflowFatalError(`workflow script made no progress for ${idleFor}ms`));
      }
    }, watchdogIntervalMs);
    stallTimer.unref?.();

    function postToWorker(message: ParentToWorkerMessage): void {
      if (finished) {
        return;
      }
      try {
        worker.postMessage(message);
      } catch (error) {
        finishReject(error instanceof Error ? error : new Error(String(error)));
      }
    }

    function handleAgentRequest(message: Extract<WorkerToParentMessage, { type: "agent" }>): void {
      const task = (async () => {
        try {
          const result = await runAgentCall(message.prompt, message.options);
          lastProgressAt = Date.now();
          postToWorker({ type: "agentResult", id: message.id, ok: true, result });
        } catch (error) {
          const fatal = options.signal?.aborted || runtimeAbortController.signal.aborted || isWorkflowFatalError(error);
          if (fatal) {
            rememberFatal(error instanceof Error ? error : new WorkflowFatalError(String(error)));
          }
          lastProgressAt = Date.now();
          if (fatal) {
            postToWorker({
              type: "agentResult",
              id: message.id,
              ok: false,
              fatal: true,
              error: error instanceof Error ? error.message : String(error),
            });
          } else {
            postToWorker({
              type: "agentResult",
              id: message.id,
              ok: false,
              error: childRunErrorData(asChildRunError(error, `workflow-child-${message.id}`)),
            });
          }
        }
      })().finally(() => {
        activeAgentTasks.delete(task);
      });
      activeAgentTasks.add(task);
    }

    worker.on("message", (message: WorkerToParentMessage) => {
      if (finished || !message || typeof message !== "object") {
        return;
      }
      try {
        switch (message.type) {
          case "heartbeat":
            lastHeartbeat = Date.now();
            break;
          case "agent":
            lastProgressAt = Date.now();
            handleAgentRequest(message);
            break;
          case "log":
            lastProgressAt = Date.now();
            log(message.message);
            break;
          case "phase":
            lastProgressAt = Date.now();
            phase(message.title);
            break;
          case "fatal":
            lastProgressAt = Date.now();
            abortRuntime(new WorkflowFatalError(message.error));
            break;
          case "complete":
            lastProgressAt = Date.now();
            finishResolve(message.result);
            break;
          case "error":
            finishReject(fatalError ?? (message.childError ? new ChildRunError(message.childError) : new Error(message.error)));
            break;
        }
      } catch (error) {
        finishReject(error instanceof Error ? error : new Error(String(error)));
      }
    });

    worker.on("error", (error) => {
      finishReject(error instanceof Error ? error : new Error(String(error)));
    });

    worker.on("exit", (code) => {
      if (!finished && code !== 0) {
        finishReject(fatalError ?? new Error(`workflow script worker exited with code ${code}`));
      }
    });
  });
}

function normalizeWorkflowLimits(limits: Partial<WorkflowLimits> | undefined): WorkflowLimits {
  const normalized = { ...DEFAULT_WORKFLOW_LIMITS, ...(limits ?? {}) };
  for (const [key, value] of Object.entries(normalized)) {
    if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1) {
      throw new Error(`workflow limit ${key} must be a positive integer`);
    }
  }
  return normalized;
}
