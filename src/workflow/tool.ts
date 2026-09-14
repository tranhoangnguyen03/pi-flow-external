import {
  defineTool,
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
  type Theme,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import type { ConcurrencyLimiter } from "../core/concurrency.ts";
import { isActiveSubagentStatus, isCompletedSubagentStatus, renderSubagentNode } from "../core/subagent-render.ts";
import { SPINNER_INTERVAL_MS } from "../core/spinner.ts";
import { filterProfilesForModelRegistry, resolveProfileModel, usesPiBackend } from "../core/model.ts";
import { CHILD_EXCLUDED_TOOLS, spawnSubagent } from "../core/spawn.ts";
import { createRunRecord } from "../core/run-record.ts";
import { runRecordsDirectory } from "../core/retention.ts";
import { captureParentContext } from "../core/parent-context.ts";
import { RunRegistry } from "../core/run-registry.ts";
import { filterExternalAgentProfiles, getSubagentProfiles, resolveExternalProfile } from "../profiles.ts";
import { WORKFLOW_PROMPT_SNIPPET } from "../prompts.ts";
import type { ExternalHarness, PermissionTier, SubagentToolDetails, SubagentUsage, WorkflowAgentSnapshot, WorkflowToolDetails } from "../types.ts";
import { isWorkflowAbortError, runWorkflow } from "./runtime.ts";
import { prepareWorkflowToolSource, workflowToolParameters } from "./source.ts";
import { ChildRunError, type ChildRunOutcome, type WorkflowAgentRunner } from "./types.ts";
import {
  createStructuredOutputTool,
  STRUCTURED_OUTPUT_CONTRACT,
  WORKFLOW_PLAIN_TEXT_OUTPUT_NOTE,
  type StructuredOutputCapture,
} from "./structured-output.ts";

export interface CreateWorkflowToolOptions {
  registry: RunRegistry;
  getLimiter: () => ConcurrencyLimiter;
  getThinkingLevel: () => ReturnType<ExtensionAPI["getThinkingLevel"]>;
  getSubagentTimeoutMs: () => number;
  updateStatus: (ctx: ExtensionContext, toolCallId: string, usage: SubagentUsage) => void;
  getDefaultPermission: () => PermissionTier;
  getDefaultHarness: (ctx: ExtensionContext) => ExternalHarness;
  getDefaultMaxBudgetUsd: () => number | undefined;
}

function workflowResult(text: string, details: WorkflowToolDetails) {
  return {
    content: [{ type: "text" as const, text }],
    details,
  };
}

/** Build an early-return error result, filling the fixed error-snapshot fields. */
function workflowError(
  text: string,
  details: Partial<WorkflowToolDetails> & { name: string; error: string },
) {
  return workflowResult(text, {
    status: "error",
    agentCount: 0,
    phases: [],
    agents: [],
    logs: [],
    ...details,
  });
}

function cloneSnapshot(snapshot: WorkflowToolDetails): WorkflowToolDetails {
  return {
    ...snapshot,
    phases: [...snapshot.phases],
    plannedPhases: snapshot.plannedPhases?.map((phase) => ({ ...phase })),
    agents: snapshot.agents.map((agent) => ({ ...agent, activity: agent.activity ? [...agent.activity] : undefined })),
    logs: [...snapshot.logs],
  };
}

function formatWarnings(warnings: string[]): string {
  if (!warnings.length) {
    return "";
  }
  return `\n\nWarnings:\n${warnings.map((warning) => `- ${warning}`).join("\n")}`;
}

function formatRecentLogs(logs: string[], max = 10): string {
  if (!logs.length) {
    return "";
  }
  const shown = logs.slice(-max);
  const hidden = logs.length - shown.length;
  const prefix = hidden > 0 ? `- ... ${hidden} earlier log(s)\n` : "";
  return `\n\nLogs:\n${prefix}${shown.map((log) => `- ${log}`).join("\n")}`;
}

function childOutcome(details: SubagentToolDetails): ChildRunOutcome {
  if (details.timedOut) return "timed_out";
  return details.status === "aborted" ? "cancelled" : "failed";
}

export function createWorkflowTool(
  options: CreateWorkflowToolOptions,
): ToolDefinition<typeof workflowToolParameters, WorkflowToolDetails> {
  return defineTool({
    name: "workflow",
    label: "Workflow",
    description: "Run a saved, persisted, or ad-hoc trusted JavaScript workflow that orchestrates external roles.",
    promptSnippet: WORKFLOW_PROMPT_SNIPPET,
    parameters: workflowToolParameters,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const parentMessages = captureParentContext(ctx.sessionManager);
      const sessionId = ctx.sessionManager?.getSessionId?.() ?? `unpersisted:${toolCallId}`;
      const project = ctx.cwd;
      const executionContext = { cwd: project } as ExtensionContext;
      const profiles = filterExternalAgentProfiles(filterProfilesForModelRegistry(getSubagentProfiles(getAgentDir()), ctx.modelRegistry));
      const models = new Map([...profiles].map(([name, profile]) => [name, resolveProfileModel(profile, ctx)]));
      const limiter = options.getLimiter();
      const thinkingLevel = options.getThinkingLevel();
      const timeoutMs = options.getSubagentTimeoutMs();
      const defaultPermission = options.getDefaultPermission();
      const defaultHarness = options.getDefaultHarness(ctx);
      const defaultMaxBudgetUsd = options.getDefaultMaxBudgetUsd();
      const background = params.background === true;
      const prepared = await prepareWorkflowToolSource(params, ctx);
      if (!prepared.ok) {
        return workflowError(prepared.text, prepared.details);
      }

      const {
        script,
        metaName,
        plannedPhases,
        source,
        sourcePath,
        scriptPath,
        warnings,
        identity,
        journalWriter,
        resumeFromRunId,
        resumeAgentResults,
      } = prepared.value;

      const snapshot: WorkflowToolDetails = {
        name: metaName,
        status: "running",
        agentCount: 0,
        phases: [],
        plannedPhases,
        agents: [],
        logs: [...warnings],
        source,
        sourcePath,
        scriptPath,
        runId: identity.runId,
        journalPath: journalWriter?.path,
        resumeFromRunId,
        cachedAgentCount: 0,
      };
      const emit = () => {
        options.registry.update(identity.runId, cloneSnapshot(snapshot));
        if (!background) onUpdate?.(workflowResult(`Workflow "${metaName}" running.`, cloneSnapshot(snapshot)));
      };

      const executeWorkflow = async (runSignal: AbortSignal) => {
        let agentSeq = 0;
        const runAgent: WorkflowAgentRunner = async (call, agentSignal) => {
        const profile = profiles.get(call.subagentType);
        if (!profile) {
          throw new Error(
            `Unknown external subagent_type "${call.subagentType}". Available external agents: ${[...profiles.keys()].join(", ")}. Use the native subagent system for Pi-backed agents.`,
          );
        }
        const model = models.get(call.subagentType);
        if (usesPiBackend(profile) && !model) {
          throw new Error(profile.model ? `Profile model not found: ${profile.model}` : "No model is selected");
        }

        // Structured output: native pi subagents get an injected schema-validated
        // structured_output tool. External CLI subagents use their native
        // final-response schema validation instead.
        let capture: StructuredOutputCapture | undefined;
        let customTools: ToolDefinition[] | undefined;
        let appendInstructions: string;
        const externalOutputSchema = !usesPiBackend(profile) && call.schema !== undefined && call.schema !== null;
        if (call.schema !== undefined && call.schema !== null && !externalOutputSchema) {
          capture = { value: undefined, called: false, count: 0, duplicateCall: false };
          customTools = [createStructuredOutputTool(call.schema, capture)];
          appendInstructions = STRUCTURED_OUTPUT_CONTRACT;
        } else if (externalOutputSchema) {
          appendInstructions = [
            WORKFLOW_PLAIN_TEXT_OUTPUT_NOTE,
            "Structured output contract:",
            "- Return only JSON matching the schema supplied to the CLI. No markdown fences or prose.",
          ].join("\n");
        } else {
          appendInstructions = WORKFLOW_PLAIN_TEXT_OUTPUT_NOTE;
        }

        const childIndex = call.index ?? ++agentSeq;
        const childId = `${toolCallId}:agent:${childIndex}`;
        const result = await spawnSubagent({
          toolCallId: childId,
          description: call.label,
          prompt: call.prompt,
          context: call.context,
          profile,
          model,
          thinkingLevel: profile.thinking ?? thinkingLevel,
          ctx: executionContext,
          signal: agentSignal,
          timeoutMs,
          progressEnabled: true,
          permission: call.permission,
          defaultPermission,
          maxBudgetUsd: call.maxBudgetUsd ?? profile.maxBudgetUsd ?? defaultMaxBudgetUsd,
          resumeRunId: call.resumeRunId,
          onProgress: (partial) => {
            const details = partial.details as SubagentToolDetails;
            const agent = snapshot.agents.find((item) => item.index === childIndex);
            if (agent && details.progress) {
              agent.startedAt = details.progress.startedAt;
              agent.endedAt = details.progress.endedAt;
              agent.activity = [...details.progress.activity];
              agent.activityCount = details.progress.activityCount;
              agent.result = details.progress.result;
              agent.error = details.progress.error;
              agent.assistantOutput = details.progress.assistantOutput;
              agent.processStartedAt = details.progress.processStartedAt;
              agent.firstActivityAt = details.progress.firstActivityAt;
              agent.lastActivityAt = details.progress.lastActivityAt;
              agent.timedOut = details.progress.timedOut;
              agent.usage = details.progress.usage;
              agent.status = details.progress.status;
              agent.context = details.context;
              if (call.runRecord) options.registry.update(call.runRecord.runId, details.progress);
              emit();
            }
          },
          onUsage: background ? () => undefined : (usage) => options.updateStatus(ctx, childId, usage),
          excludeTools: CHILD_EXCLUDED_TOOLS,
          appendInstructions,
          customTools,
          outputSchema: externalOutputSchema ? call.schema : undefined,
          runRecord: call.runRecord,
        });
        const resultDetails = result.details as SubagentToolDetails;
        const agent = snapshot.agents.find((item) => item.index === childIndex);
        if (agent) {
          const progress = resultDetails.progress;
          agent.status = resultDetails.status;
          agent.result = resultDetails.result;
          agent.error = resultDetails.error;
          agent.assistantOutput = resultDetails.assistantOutput;
          agent.processStartedAt = progress?.processStartedAt;
          agent.firstActivityAt = progress?.firstActivityAt;
          agent.lastActivityAt = progress?.lastActivityAt;
          agent.timedOut = resultDetails.timedOut;
          agent.usage = resultDetails.usage;
          agent.externalRunId = resultDetails.runId;
          agent.recordPath = resultDetails.recordPath;
          agent.backendEventCount = resultDetails.backendEventCount;
          agent.nestedActivitySeen = resultDetails.nestedActivitySeen;
          agent.nestedTimeoutExtended = resultDetails.nestedTimeoutExtended;
          agent.effectiveTimeoutMs = resultDetails.effectiveTimeoutMs;
          agent.recordingError = resultDetails.recordingError;
          agent.permission = resultDetails.permission;
          agent.permissionEnforced = resultDetails.permissionEnforced;
          agent.permissionDenials = resultDetails.permissionDenials;
          agent.maxBudgetUsd = resultDetails.maxBudgetUsd;
          agent.sessionId = resultDetails.sessionId;
          agent.resumedFrom = resultDetails.resumedFrom;
          agent.context = resultDetails.context;
          if (progress) {
            agent.startedAt = progress.startedAt;
            agent.endedAt = progress.endedAt;
            agent.activity = [...progress.activity];
            agent.activityCount = progress.activityCount;
          }
          emit();
        }
        if (resultDetails.status !== "done") {
          const runId = resultDetails.runId ?? call.runRecord?.runId ?? childId;
          throw new ChildRunError({
            runId,
            outcome: childOutcome(resultDetails),
            message: resultDetails.error ?? "subagent failed",
            outputRef: { runId, view: "output" },
            diagnosticsRef: { runId, view: "diagnostics" },
          });
        }
        if (externalOutputSchema) {
          try {
            return JSON.parse(resultDetails.result ?? "null");
          } catch {
            throw new Error("external subagent structured output was not valid JSON");
          }
        }
        if (capture) {
          if (!capture.called) {
            throw new Error("subagent finished without calling structured_output");
          }
          return capture.value;
        }
        return resultDetails.result ?? "";
        };

      // Spinner animation is driven here, by the runtime, not by a UI-render
      // timer: while any agent is running we advance a frame counter and re-emit
      // so the live row redraws. The interval's lifecycle is bound to this
      // execute() call (cleared in the finally below), so it cannot outlive the
      // workflow or a torn-down tool row — and renderResult stays a pure function
      // of the snapshot, which also keeps non-live paths (HTML export) timer-free.
      const heartbeat = setInterval(() => {
        if (snapshot.status === "running" && snapshot.agents.some((agent) => isActiveSubagentStatus(agent.status))) {
          snapshot.frame = (snapshot.frame ?? 0) + 1;
          emit();
        }
      }, SPINNER_INTERVAL_MS);
      (heartbeat as { unref?: () => void }).unref?.();

      try {
        const runResult = await runWorkflow(script, {
          args: params.args,
          parentMessages,
          parentToolCallId: toolCallId,
          cwd: project,
          signal: runSignal,
          limiter,
          runAgent,
          startAgentRun: (call, run) => {
            const runId = call.runRecord?.runId;
            if (!runId) throw new Error("workflow child run evidence was not allocated");
            return options.registry.start({
              runId,
              kind: "agent",
              sessionId,
              project,
              workflowRunId: identity.runId,
              run,
              failure: (error, childSignal) => ({
                status: runSignal.aborted || childSignal.aborted ? "aborted" : "error",
                error: error instanceof Error ? error.message : String(error),
              }),
            }).result;
          },
          defaultSubagentType: null,
          resolveSubagentType: (selection) => resolveExternalProfile(
            profiles,
            selection,
            defaultHarness,
          ).name,
          resumeAgentResults,
          onLog: (message) => {
            snapshot.logs.push(message);
            emit();
          },
          onPhase: (title) => {
            if (!snapshot.phases.includes(title)) {
              snapshot.phases.push(title);
            }
            snapshot.currentPhase = title;
            emit();
          },
          onAgentQueued: (event) => {
            const queuedAt = Date.now();
            const profile = profiles.get(event.subagentType);
            const runRecord = createRunRecord({
              directory: runRecordsDirectory(),
              metadata: {
                kind: "workflow-child",
                parentSessionId: sessionId,
                project,
                workflowRunId: identity.runId,
                description: event.label,
                prompt: event.prompt,
                profile: event.subagentType,
                backend: profile?.backend,
                queuedAt: new Date(queuedAt).toISOString(),
              },
            });
            snapshot.agents.push({
              index: event.index,
              label: event.label,
              phase: event.phase,
              subagentType: event.subagentType,
              backend: profiles.get(event.subagentType)?.backend,
              status: "queued",
              externalRunId: runRecord.runId,
              recordPath: runRecord.directory,
              context: event.context,
              queuedAt,
              activity: [],
              activityCount: 0,
            });
            snapshot.agentCount = snapshot.agents.length;
            emit();
            event.runRecord = runRecord;
          },
          onAgentStart: (event) => {
            let agent = snapshot.agents.find((item) => item.index === event.index);
            if (!agent) {
              agent = {
                index: event.index,
                label: event.label,
                phase: event.phase,
                subagentType: event.subagentType,
                backend: profiles.get(event.subagentType)?.backend,
                status: event.cached ? "done" : "running",
                activity: [],
                activityCount: 0,
              };
              snapshot.agents.push(agent);
            }
            agent.status = event.cached ? "done" : "running";
            if (event.runId) agent.externalRunId = event.runId;
            agent.startedAt = Date.now();
            snapshot.agentCount = snapshot.agents.length;
            if (event.cached) {
              agent.endedAt = agent.startedAt;
              snapshot.cachedAgentCount = (snapshot.cachedAgentCount ?? 0) + 1;
            }
            emit();
          },
          onAgentEnd: (event) => {
            const agent = snapshot.agents.find((item) => item.index === event.index);
            if (agent) {
              agent.status = event.error?.outcome === "cancelled" || event.error?.outcome === "timed_out"
                ? "aborted"
                : event.failed ? "error" : "done";
              agent.endedAt = Date.now();
              if (event.error) {
                agent.error = event.error.message;
                agent.externalRunId = event.error.runId;
                agent.timedOut = event.error.outcome === "timed_out";
              } else if (event.failed && !agent.error) agent.error = "subagent failed";
            }
            emit();
          },
          onAgentResult: async (event) => {
            const agent = snapshot.agents.find((item) => item.index === event.index);
            if (agent) {
              if (event.context) agent.context = event.context;
              if (event.runId) agent.externalRunId = event.runId;
              emit();
            }
            await journalWriter?.appendAgentResult(event);
          },
        });

        snapshot.status = "completed";
        snapshot.agentCount = runResult.agentCount;
        snapshot.result = runResult.result;
        try {
          await journalWriter?.complete(runResult.result);
        } catch (error) {
          snapshot.logs.push(`workflow journal completion failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        const resultText = JSON.stringify(runResult.result, null, 2);
        const cachedText = snapshot.cachedAgentCount ? ` (${snapshot.cachedAgentCount} cached)` : "";
        const scriptPathText = snapshot.scriptPath ? `\nscriptPath: ${snapshot.scriptPath}` : "";
        const runIdText = snapshot.runId ? `\nrunId: ${snapshot.runId}` : "";
        return workflowResult(
          `Workflow "${runResult.meta.name}" completed with ${runResult.agentCount} agent(s)${cachedText}.${scriptPathText}${runIdText}${formatWarnings(warnings)}${formatRecentLogs(snapshot.logs)}\n\nResult:\n${resultText}`,
          cloneSnapshot(snapshot),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const aborted = runSignal.aborted || isWorkflowAbortError(error);
        snapshot.status = aborted ? "aborted" : "error";
        snapshot.error = message;
        try {
          await journalWriter?.fail(message);
        } catch {
          // Preserve the original workflow failure; journal write failure is secondary.
        }
        for (const agent of snapshot.agents) {
          if (isActiveSubagentStatus(agent.status)) {
            agent.status = aborted ? "aborted" : "error";
            agent.endedAt = Date.now();
          }
        }
        return workflowResult(
          `Workflow "${metaName}" ${aborted ? "aborted" : "failed"}: ${message}${formatRecentLogs(snapshot.logs)}`,
          cloneSnapshot(snapshot),
        );
      } finally {
        clearInterval(heartbeat);
      }
      };

      const registered = options.registry.start({
        runId: identity.runId,
        kind: "workflow",
        sessionId,
        project,
        ...(background ? {} : { signal }),
        run: executeWorkflow,
        outcome: (result) => ({
          status: result.details.status === "completed" ? "done" : result.details.status === "aborted" ? "aborted" : "error",
          ...(result.details.result !== undefined ? { result: result.details.result } : {}),
          ...(result.details.error ? { error: result.details.error } : {}),
        }),
      });
      if (!background) return await registered.result;
      return workflowResult(
        `Workflow "${metaName}" queued as ${identity.runId}. Use external_runs to inspect, wait, or cancel it.`,
        cloneSnapshot(snapshot),
      );
    },
    renderCall(args, theme, _context) {
      const name = typeof args.name === "string" && args.name.trim() ? ` ${theme.fg("muted", args.name.trim())}` : "";
      return new Text(`${theme.bold("Workflow")}${name} · ${theme.fg("warning", "unsandboxed external agents")}`, 0, 0);
    },
    renderResult(result, { expanded }, theme) {
      // Pure function of the snapshot: the spinner frame is carried on the
      // snapshot itself and advanced by the runtime heartbeat in execute(), so
      // there is no UI-side timer to leak when a row is torn down or rendered in
      // a non-live context (e.g. HTML export).
      const details = result.details as WorkflowToolDetails;
      return renderWorkflowSnapshot(details, theme, details.frame ?? 0, expanded);
    },
  });
}

function agentRenderPriority(agent: WorkflowAgentSnapshot): number {
  if (agent.status === "error" || agent.status === "aborted") return 0;
  if (agent.status === "running") return 1;
  if (agent.status === "queued") return 2;
  return 3;
}

// Pick which agents to show when a phase exceeds `max` rows. Errors first, then
// running, then done (surface failures and active work over finished agents);
// within a tier keep the EARLIEST-started agents so the visible window reads
// #1..#max with `... N more` standing for the later, hidden ones. (A descending
// tie-break here would keep the highest indices and make the list look like it
// starts mid-way.) The final ascending sort restores numeric order across tiers.
function selectAgentsForRender(agents: WorkflowAgentSnapshot[], max = 6): WorkflowAgentSnapshot[] {
  return agents
    .map((agent, index) => ({ agent, index }))
    .sort((a, b) => agentRenderPriority(a.agent) - agentRenderPriority(b.agent) || a.index - b.index)
    .slice(0, max)
    .sort((a, b) => a.index - b.index)
    .map((item) => item.agent);
}

// Ordered list of phase groups: planned phases first, then entered runtime
// phases, then agent-only phases, then an `undefined` bucket for unphased
// agents. Planned phases are visible before their first agent starts; runtime
// phases are kept even before their first agent starts so live phase() updates
// stay visible. Layout inspired by Michaelliv/pi-dynamic-workflows.
function orderedPhases(details: WorkflowToolDetails): (string | undefined)[] {
  const seen = new Set<string>();
  const order: (string | undefined)[] = [];
  for (const planned of details.plannedPhases ?? []) {
    if (!seen.has(planned.title)) {
      seen.add(planned.title);
      order.push(planned.title);
    }
  }
  for (const phase of details.phases) {
    if (!seen.has(phase)) {
      seen.add(phase);
      order.push(phase);
    }
  }
  for (const agent of details.agents) {
    if (agent.phase && !seen.has(agent.phase)) {
      seen.add(agent.phase);
      order.push(agent.phase);
    }
  }
  if (details.agents.some((agent) => !agent.phase)) order.push(undefined);
  return order;
}

function isFailedWorkflowAgent(agent: WorkflowAgentSnapshot): boolean {
  return agent.status === "error" || agent.status === "aborted";
}

function workflowRunningCount(details: WorkflowToolDetails): number {
  return details.agents.filter((agent) => agent.status === "running").length;
}

function formatAgentCounts(done: number, active: number, queued: number, failed: number, total: number): string {
  return `${done} done · ${active} active · ${queued} queued · ${failed} failed / ${total}`;
}

function hiddenFailureCount(agents: WorkflowAgentSnapshot[], shown: WorkflowAgentSnapshot[]): number {
  const visible = new Set(shown);
  return agents.filter((agent) => !visible.has(agent) && isFailedWorkflowAgent(agent)).length;
}

function renderPhaseTree(container: Container, details: WorkflowToolDetails, theme: Theme, frame: number, expanded: boolean): void {
  const runningCount = workflowRunningCount(details);
  for (const phase of orderedPhases(details)) {
    const agents = details.agents.filter((agent) => agent.phase === phase);
    const pDone = agents.filter((agent) => isCompletedSubagentStatus(agent.status)).length;
    const pErr = agents.filter(isFailedWorkflowAgent).length;
    const pRun = agents.filter((agent) => agent.status === "running").length;
    const pQueued = agents.filter((agent) => agent.status === "queued").length;
    const isCurrent = phase !== undefined && details.currentPhase === phase;
    const reached = phase === undefined || details.phases.includes(phase);
    const workflowRunning = details.status === "running";
    const workflowFailed = details.status === "error" || details.status === "aborted";
    const phaseStatus = pErr > 0 || (workflowFailed && isCurrent && agents.length === 0)
      ? "failed"
      : pRun > 0 || pQueued > 0 || (workflowRunning && isCurrent)
        ? "running"
        : agents.length > 0 || reached
          ? "done"
          : "planned";
    const marker = phaseStatus === "failed" ? "✗" : phaseStatus === "done" ? "✓" : phaseStatus === "running" ? "▶" : "·";
    container.addChild(
      new Text(
        `  ${theme.fg(pErr ? "error" : "muted", `${marker} ${phase ?? "unphased"} ${phaseStatus} · ${formatAgentCounts(pDone, pRun, pQueued, pErr, agents.length)}`)}`,
        0,
        0,
      ),
    );
    const shown = selectAgentsForRender(agents);
    for (const agent of shown) {
      container.addChild(renderSubagentNode(agent, theme, frame, runningCount, "    ", Date.now(), expanded, false));
    }
    const hidden = agents.length - shown.length;
    if (hidden > 0) {
      const hiddenFailed = hiddenFailureCount(agents, shown);
      container.addChild(new Text(`    ${theme.fg("muted", `... ${hidden} more${hiddenFailed ? ` (${hiddenFailed} failed)` : ""}`)}`, 0, 0));
    }
  }
}

function renderFlatAgents(container: Container, details: WorkflowToolDetails, theme: Theme, frame: number, expanded: boolean): void {
  const runningCount = workflowRunningCount(details);
  const renderedAgents = selectAgentsForRender(details.agents);
  for (const agent of renderedAgents) {
    container.addChild(renderSubagentNode(agent, theme, frame, runningCount, "  ", Date.now(), expanded, false));
  }
  // selectAgentsForRender keeps the earliest agents, so the hidden ones are the
  // later indices — the "not shown" marker belongs after the visible rows (as in
  // renderPhaseTree), standing for what continues below.
  const hiddenAgents = details.agents.length - renderedAgents.length;
  if (hiddenAgents > 0) {
    const hiddenFailed = hiddenFailureCount(details.agents, renderedAgents);
    container.addChild(new Text(`  ${theme.fg("muted", `... ${hiddenAgents} agent(s) not shown${hiddenFailed ? ` (${hiddenFailed} failed)` : ""}`)}`, 0, 0));
  }
}

function renderWorkflowSnapshot(details: WorkflowToolDetails, theme: Theme, frame: number, expanded: boolean): Container {
  const container = new Container();
  const done = details.agents.filter((agent) => isCompletedSubagentStatus(agent.status)).length;
  const active = workflowRunningCount(details);
  const queued = details.agents.filter((agent) => agent.status === "queued").length;
  const failed = details.agents.filter(isFailedWorkflowAgent).length;
  const counts = formatAgentCounts(done, active, queued, failed, details.agents.length);
  const access = details.status === "running" ? "external host access · " : "";
  container.addChild(
    new Text(
      `${theme.bold(`Workflow(${details.name})`)} ${theme.fg("dim", `${details.status} · ${access}${counts}`)}`,
      0,
      0,
    ),
  );

  // Phase-grouped tree when the workflow uses phase() (including before the first
  // agent in a phase starts); otherwise keep the flat list.
  if ((details.plannedPhases?.length ?? 0) > 0 || details.phases.length > 0 || details.agents.some((agent) => agent.phase)) {
    renderPhaseTree(container, details, theme, frame, expanded);
  } else {
    renderFlatAgents(container, details, theme, frame, expanded);
  }

  for (const line of details.logs.slice(-3)) {
    container.addChild(new Text(`  ${theme.fg("muted", line)}`, 0, 0));
  }

  if (details.error) {
    container.addChild(new Text(`  ${theme.fg("error", details.error)}`, 0, 0));
  }

  if (expanded && details.status !== "running") {
    if (details.runId) {
      container.addChild(new Text(`  ${theme.fg("dim", `Workflow evidence ${details.runId}`)}`, 0, 0));
    }
    if (details.journalPath) {
      container.addChild(new Text(`  ${theme.fg("dim", `Journal ${details.journalPath}`)}`, 0, 0));
    }
  }

  return container;
}
