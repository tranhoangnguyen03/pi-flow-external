import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { join, resolve } from "node:path";
import {
  createProgressEmitter,
  extractFinalAssistantText,
  getFinalAssistantFailure,
  getSubagentUsage,
  textResult,
  updateProgressFromEvent,
  type AgentToolResult,
} from "./progress.ts";
import { spawnClaudeSubagent } from "./claude.ts";
import { spawnCodexSubagent } from "./codex.ts";
import { spawnAgySubagent } from "./agy.ts";
import type {
  PermissionTier,
  SubagentBackend,
  SubagentProfile,
  SubagentProgressNode,
  SubagentToolDetails,
  SubagentUsage,
} from "../types.ts";
import { resolvePermission } from "./permissions.ts";
import { resolveResume } from "./resume.ts";
import { createRunRecord, type RunRecord } from "./run-record.ts";
import { runRecordsDirectory } from "./retention.ts";
import { createTimeoutSignal, markSubagentTimedOut } from "./timeout.ts";
import type { PermissionResolution } from "./permissions.ts";


/**
 * The delegation tools a spawned child must never receive, so subagents cannot
 * recursively fan out. Owned by the spawn core and used as the default exclude
 * list so no caller can accidentally under-specify the nesting block.
 */
export const CHILD_EXCLUDED_TOOLS: readonly string[] = ["Agent", "workflow"];

/**
 * Parameters for a single subagent run. This is the shared spawn primitive used
 * by both the `Agent` tool and the `workflow` tool's `agent()` global.
 * Concurrency accounting lives in the callers, not here; callers acquire a slot
 * before invoking spawnSubagent, so the runtime timeout below excludes queue time.
 */
export interface SpawnSubagentParams {
  toolCallId: string;
  description: string;
  prompt: string;
  profile: SubagentProfile;
  model?: NonNullable<ExtensionContext["model"]>;
  thinkingLevel: string | undefined;
  ctx: ExtensionContext;
  signal: AbortSignal | undefined;
  /** Maximum wall-clock runtime once this spawn starts. Set 0 to disable. */
  timeoutMs: number;
  progressEnabled: boolean;
  onProgress: ((result: AgentToolResult) => void) | undefined;
  onUsage: (usage: SubagentUsage) => void;
  /** Tools (and the extensions that provide them) to keep out of the child session. Defaults to {@link CHILD_EXCLUDED_TOOLS}. */
  excludeTools?: readonly string[];
  /** Text appended after the task prompt (e.g. a structured-output contract). */
  appendInstructions?: string;
  /** Extra tools to register in the child session (e.g. a structured_output tool). */
  customTools?: ToolDefinition[];
  /** JSON schema for CLI backends that can validate final text output natively. */
  outputSchema?: unknown;
  /** Skip the local field record for internal probes such as profile smoke tests. */
  recordRun?: boolean;
  /** Resolved permission tier (call > profile > settings default). */
  permission?: PermissionTier;
  /** Resolved USD budget cap, when any. Enforced natively on claude only. */
  maxBudgetUsd?: number;
  /** Prior local run id whose backend conversation should be continued. */
  resumeRunId?: string;
}

interface SpawnSubagentRuntimeParams extends SpawnSubagentParams {
  onBackendEvent?: (event: unknown) => void;
  resumeSessionId?: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function isNestedToolName(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return ["agent", "spawn_agent", "invoke_subagent", "send_input", "resume_agent", "wait_agent", "close_agent"]
    .includes(value.trim().toLowerCase().replaceAll("-", "_"));
}

export function hasNestedAgentActivity(value: unknown, backend: SubagentBackend): boolean {
  const event = asRecord(value);
  if (!event) return false;

  if (backend === "claude") {
    const message = asRecord(event.message);
    return event.type === "assistant" && Array.isArray(message?.content) && message.content.some((content) => {
      const block = asRecord(content);
      return block?.type === "tool_use" && isNestedToolName(block.name);
    });
  }

  if (backend === "codex") {
    const item = asRecord(event.item);
    return typeof event.type === "string" && event.type.startsWith("item.") && item?.type === "collab_tool_call";
  }

  if (backend === "agy") {
    const update = asRecord(event.step_update);
    return event.event === "step_update" && (update?.step_type === "tool" || update?.step_type === "subagent") &&
      (isNestedToolName(update.tool_name) || asRecord(update.subagent_info) !== undefined);
  }

  return false;
}

function attachRunRecord(
  result: AgentToolResult,
  record: RunRecord,
  backendEventCount: number,
  nestedActivitySeen: boolean,
  nestedTimeoutExtended: boolean,
  effectiveTimeoutMs: number,
  recordingError: string | undefined,
  extras: {
    permission: PermissionResolution | undefined;
    maxBudgetUsd: number | undefined;
    resumedFrom: string | undefined;
    sessionId: string | undefined;
    permissionDenials: number | undefined;
  },
): void {
  const apply = (details: SubagentToolDetails | SubagentProgressNode) => {
    details.runId = record.runId;
    details.recordPath = record.directory;
    details.backendEventCount = backendEventCount;
    details.nestedActivitySeen = nestedActivitySeen;
    details.nestedTimeoutExtended = nestedTimeoutExtended;
    details.effectiveTimeoutMs = effectiveTimeoutMs;
    details.recordingError = recordingError;
    if (extras.permission) {
      details.permission = extras.permission.tier;
      details.permissionEnforced = extras.permission.enforced;
    }
    if (extras.permissionDenials !== undefined) {
      details.permissionDenials = extras.permissionDenials;
    }
    if (extras.sessionId) {
      details.sessionId = extras.sessionId;
    }
    if (extras.maxBudgetUsd !== undefined) {
      details.maxBudgetUsd = extras.maxBudgetUsd;
    }
    if (extras.resumedFrom) {
      details.resumedFrom = extras.resumedFrom;
    }
  };
  apply(result.details as SubagentToolDetails);
  const details = result.details as SubagentToolDetails;
  if (details.progress) {
    apply(details.progress);
  }
}

function rewriteTimeoutResult(
  result: AgentToolResult,
  params: { description: string; profile: SubagentProfile; timeoutMs: number },
): AgentToolResult {
  const details = markSubagentTimedOut(result.details as SubagentToolDetails, params.timeoutMs);
  const message = details.error;
  return textResult(`Subagent "${params.description}" (${params.profile.name}) aborted: ${message}`, {
    ...details,
    description: params.description,
    subagentType: params.profile.name,
    backend: params.profile.backend,
    status: "aborted",
  });
}

export async function spawnSubagent(params: SpawnSubagentParams): Promise<AgentToolResult> {
  const startedAt = Date.now();
  let backendEventCount = 0;
  let nestedActivitySeen = false;
  const permission = resolvePermission(params.permission ?? "danger", params.profile.backend);
  let resumeSession: Awaited<ReturnType<typeof resolveResume>>["session"];
  if (params.resumeRunId) {
    const resolved = await resolveResume(runRecordsDirectory(), params.resumeRunId, params.profile.backend);
    if (resolved.error || !resolved.session) {
      return textResult(`Subagent "${params.description}" (${params.profile.name}) failed: ${resolved.error ?? "resume resolution failed"}`, {
        description: params.description,
        subagentType: params.profile.name,
        backend: params.profile.backend,
        status: "error",
        error: resolved.error ?? "resume resolution failed",
      });
    }
    resumeSession = resolved.session;
  }
  const timeout = createTimeoutSignal(params.signal, params.timeoutMs, params.description);
  const record = params.recordRun === false
    ? undefined
    : createRunRecord({
        directory: runRecordsDirectory(),
        metadata: {
          description: params.description,
          prompt: params.prompt,
          cwd: params.ctx.cwd,
          timeoutMs: params.timeoutMs,
          profile: params.profile,
          permission: permission.tier,
          ...(params.maxBudgetUsd !== undefined ? { maxBudgetUsd: params.maxBudgetUsd } : {}),
          ...(resumeSession ? { resumedFrom: resumeSession.runId } : {}),
        },
      });
  const onBackendEvent = (event: unknown) => {
    backendEventCount++;
    const hadNestedActivity = nestedActivitySeen;
    try {
      nestedActivitySeen ||= hasNestedAgentActivity(event, params.profile.backend);
    } catch {
      // Observation must never change the backend run's result.
    }
    void record?.event("backend_event", { backend: params.profile.backend, event });
    if (!hadNestedActivity && nestedActivitySeen && timeout.extendOnce()) {
      void record?.event("nested_timeout_extended", {
        configuredTimeoutMs: params.timeoutMs,
        effectiveTimeoutMs: timeout.effectiveTimeoutMs(),
      });
    }
  };
  try {
    let result = await spawnSubagentRuntime({
      ...params,
      signal: timeout.signal,
      onBackendEvent,
      resumeSessionId: resumeSession?.sessionId,
    });
    if (timeout.timedOut()) {
      result = rewriteTimeoutResult(result, {
        description: params.description,
        profile: params.profile,
        timeoutMs: timeout.effectiveTimeoutMs(),
      });
    }
    if (record) {
      const details = result.details as SubagentToolDetails;
      await record.finish({
        backend: params.profile.backend,
        profile: params.profile.name,
        model: params.profile.model,
        description: params.description,
        status: details.status,
        timedOut: details.timedOut === true,
        result: details.result,
        error: details.error,
        usage: details.usage,
        durationMs: Date.now() - startedAt,
        backendEventCount,
        nestedActivitySeen,
        nestedAgentControl: "allowed-observed",
        nestedTimeoutExtended: timeout.wasExtended(),
        configuredTimeoutMs: params.timeoutMs,
        effectiveTimeoutMs: timeout.effectiveTimeoutMs(),
        permission: { tier: permission.tier, enforced: permission.enforced, caveat: permission.caveat },
        ...(details.permissionDenials !== undefined ? { permissionDenials: details.permissionDenials } : {}),
        ...(params.maxBudgetUsd !== undefined ? { maxBudgetUsd: params.maxBudgetUsd } : {}),
        // Budgets are enforced mid-run only where the backend supports a
        // native cap (claude). Everywhere else record honestly that the
        // budget could not be enforced, regardless of local cost estimates.
        ...(params.maxBudgetUsd !== undefined && params.profile.backend !== "claude"
          ? { budgetEnforceable: false }
          : {}),
        ...(details.sessionId ? { sessionId: details.sessionId } : {}),
        ...(resumeSession ? { resumedFrom: resumeSession.runId } : {}),
      });
      attachRunRecord(
        result,
        record,
        backendEventCount,
        nestedActivitySeen,
        timeout.wasExtended(),
        timeout.effectiveTimeoutMs(),
        record.writeError?.message,
        {
          permission,
          maxBudgetUsd: params.maxBudgetUsd,
          resumedFrom: resumeSession?.runId,
          sessionId: details.sessionId,
          permissionDenials: details.permissionDenials,
        },
      );
    }
    return result;
  } catch (error) {
    await record?.finish({
      backend: params.profile.backend,
      profile: params.profile.name,
      description: params.description,
      status: "error",
      error: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - startedAt,
      backendEventCount,
      nestedActivitySeen,
      nestedTimeoutExtended: timeout.wasExtended(),
      effectiveTimeoutMs: timeout.effectiveTimeoutMs(),
    });
    throw error;
  } finally {
    timeout.cleanup();
  }
}

async function spawnSubagentRuntime(params: SpawnSubagentRuntimeParams): Promise<AgentToolResult> {
  if (params.profile.backend === "codex") {
    return spawnCodexSubagent({
      toolCallId: params.toolCallId,
      description: params.description,
      prompt: params.prompt,
      profile: params.profile,
      thinkingLevel: params.thinkingLevel,
      ctx: params.ctx,
      signal: params.signal,
      progressEnabled: params.progressEnabled,
      onProgress: params.onProgress,
      onUsage: params.onUsage,
      onBackendEvent: params.onBackendEvent,
      appendInstructions: params.appendInstructions,
      outputSchema: params.outputSchema,
      permission: params.permission,
      resumeSessionId: params.resumeSessionId,
    });
  }
  if (params.profile.backend === "agy") {
    return spawnAgySubagent({
      toolCallId: params.toolCallId,
      description: params.description,
      prompt: params.prompt,
      profile: params.profile,
      thinkingLevel: params.thinkingLevel,
      ctx: params.ctx,
      signal: params.signal,
      progressEnabled: params.progressEnabled,
      onProgress: params.onProgress,
      onUsage: params.onUsage,
      onBackendEvent: params.onBackendEvent,
      appendInstructions: params.appendInstructions,
      outputSchema: params.outputSchema,
      permission: params.permission,
      resumeConversationId: params.resumeSessionId,
    });
  }
  if (params.profile.backend === "claude") {
    return spawnClaudeSubagent({
      toolCallId: params.toolCallId,
      description: params.description,
      prompt: params.prompt,
      profile: params.profile,
      thinkingLevel: params.thinkingLevel,
      ctx: params.ctx,
      signal: params.signal,
      progressEnabled: params.progressEnabled,
      onProgress: params.onProgress,
      onUsage: params.onUsage,
      onBackendEvent: params.onBackendEvent,
      appendInstructions: params.appendInstructions,
      outputSchema: params.outputSchema,
      permission: params.permission,
      maxBudgetUsd: params.maxBudgetUsd,
      resumeSessionId: params.resumeSessionId,
    });
  }
  if (!params.model) {
    return textResult(`Subagent "${params.description}" (${params.profile.name}) failed: No model is selected.`, {
      description: params.description,
      subagentType: params.profile.name,
      backend: params.profile.backend,
      status: "error",
      error: "No model is selected",
    });
  }
  const {
    toolCallId,
    description,
    prompt,
    profile,
    model,
    thinkingLevel,
    ctx,
    signal,
    progressEnabled,
    onProgress,
    onUsage,
  } = params;
  const subagentType = profile.name;
  const excludeTools = params.excludeTools ?? CHILD_EXCLUDED_TOOLS;
  const customTools = params.customTools ?? [];
  // A pinned tool allow-list must still admit any injected tools (e.g. structured_output).
  const toolAllowList =
    profile.tools !== undefined ? [...profile.tools, ...customTools.map((tool) => tool.name)] : undefined;
  const taskPrompt = params.appendInstructions ? `${prompt}\n\n${params.appendInstructions}` : prompt;
  const emitter = createProgressEmitter({
    toolCallId,
    description,
    subagentType,
    backend: profile.backend,
    enabled: progressEnabled,
    onProgress,
  });
  const progress = emitter.progress;

  const agentDir = getAgentDir();
  const cwd = ctx.cwd;
  const settingsManager = SettingsManager.create(cwd, agentDir);
  const appendPrompts = [
    profile.systemPrompt,
  ].filter((value): value is string => Boolean(value));
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    extensionsOverride: (base) => ({
      ...base,
      extensions: base.extensions.filter(
        (extension) => !excludeTools.some((name) => extension.tools.has(name)),
      ),
    }),
    appendSystemPromptOverride: (base) => [...base, ...appendPrompts],
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    cwd,
    agentDir,
    model,
    thinkingLevel: thinkingLevel as NonNullable<Parameters<typeof createAgentSession>[0]>["thinkingLevel"],
    modelRegistry: ctx.modelRegistry,
    settingsManager,
    sessionManager: SessionManager.inMemory(cwd),
    resourceLoader,
    excludeTools: [...excludeTools],
    ...(customTools.length > 0 ? { customTools } : {}),
    ...(toolAllowList !== undefined ? { tools: toolAllowList } : {}),
  });

  let abortHandler: (() => void) | undefined;
  if (signal) {
    abortHandler = () => {
      void session.abort();
    };
    if (!signal.aborted) {
      signal.addEventListener("abort", abortHandler, { once: true });
    }
  }

  const unsubscribe = session.subscribe((event) => {
    if (progress) {
      updateProgressFromEvent(progress, event);
      emitter.emitSoon();
    }
    if (event.type === "message_end" && event.message.role === "assistant") {
      const usage = getSubagentUsage(session);
      if (progress) {
        progress.usage = usage;
      }
      onUsage(usage);
    }
  });

  try {
    if (signal?.aborted) {
      throw new Error("Subagent aborted before prompt start");
    }
    await session.bindExtensions({});
    if (signal?.aborted) {
      throw new Error("Subagent aborted before prompt start");
    }
    emitter.emit();
    emitter.startHeartbeat();
    await session.prompt(taskPrompt, { source: "extension" });
    // pi-ai encodes model/request failures (rate limits, quota exhaustion,
    // provider errors) as a final assistant turn with stopReason "error"/
    // "aborted" instead of throwing, so prompt() resolves even when nothing was
    // produced. Treat that terminal failure as an error rather than reporting a
    // hollow "(no final text output)" success.
    const failure = getFinalAssistantFailure(session.messages);
    if (failure) {
      // The catch below derives the reported status from whether OUR signal
      // aborted (signal?.aborted ? "aborted" : "error"), so a provider-reported
      // stopReason "aborted" that we did not trigger is surfaced as an error.
      // Keep this fallback message status-neutral — quote the stopReason as a
      // diagnostic detail rather than asserting the run was "aborted".
      throw new Error(
        failure.errorMessage || `Subagent model turn did not complete (stopReason: ${failure.stopReason}).`,
      );
    }
    const result = extractFinalAssistantText(session.messages) || "(no final text output)";
    const usage = getSubagentUsage(session);
    onUsage(usage);
    if (progress) {
      progress.status = "done";
      progress.result = result;
      progress.usage = usage;
      progress.endedAt = Date.now();
    }
    return textResult(`Subagent "${description}" (${subagentType}) completed:\n\n${result}`, {
      description,
      subagentType,
      backend: profile.backend,
      status: "done",
      result,
      usage,
      ...(progress ? { progress } : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = signal?.aborted ? "aborted" : "error";
    const usage = getSubagentUsage(session);
    onUsage(usage);
    if (progress) {
      progress.status = status;
      progress.error = message;
      progress.usage = usage;
      progress.endedAt = Date.now();
    }
    const verb = status === "aborted" ? "aborted" : "failed";
    return textResult(`Subagent "${description}" (${subagentType}) ${verb}: ${message}`, {
      description,
      subagentType,
      backend: profile.backend,
      status,
      error: message,
      usage,
      ...(progress ? { progress } : {}),
    });
  } finally {
    emitter.stop();
    unsubscribe?.();
    if (signal && abortHandler) {
      signal.removeEventListener("abort", abortHandler);
    }
    session.dispose();
  }
}
