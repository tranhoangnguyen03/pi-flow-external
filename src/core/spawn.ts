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
  extractAssistantMessages,
  assistantOutput,
  formatInterruptedOutputPreview,
  getFinalAssistantFailure,
  getSubagentUsage,
  textResult,
  updateProgressFromEvent,
  type AgentToolResult,
} from "./progress.ts";
import { spawnClaudeSubagent } from "./claude.ts";
import { spawnCodexSubagent } from "./codex.ts";
import { spawnAgySubagent, isTransientAgyFailure } from "./agy.ts";
import { spawnGrokSubagent } from "./grok.ts";
import { museHasNestedAgentActivity, spawnMuseSubagent } from "./muse.ts";
import type {
  PermissionTier,
  SubagentBackend,
  SubagentProfile,
  SubagentProgressNode,
  SubagentToolDetails,
  SubagentUsage,
  ThinkingClamp,
} from "../types.ts";
import { selectorHarness } from "../profiles.ts";
import { PI_TIER_ACTIVE_TOOLS, resolvePermission, resolveEffectivePermissionTier, unsupportedPermissionReason } from "./permissions.ts";
import { resolveResume } from "./resume.ts";
import { formatParentContext, type ParentContextReceipt } from "./parent-context.ts";
import { createRunRecord, type RunRecord } from "./run-record.ts";
import { runRecordsDirectory } from "./retention.ts";
import { createTimeoutSignal, markSubagentTimedOut } from "./timeout.ts";
import type { PermissionResolution } from "./permissions.ts";
import { isValidThinkingLevel, VALID_THINKING_LEVELS } from "../harnesses.ts";


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
  context?: ParentContextReceipt;
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
  /** Requested permission tier override; resolved here (call > profile > defaultPermission). */
  permission?: PermissionTier;
  /** Settings-level default tier used when neither the call nor the profile names one. */
  defaultPermission?: PermissionTier;
  /** Resolved USD budget cap, when any. Enforced natively on claude only. */
  maxBudgetUsd?: number;
  /** Prior local run id whose backend conversation should be continued. */
  resumeRunId?: string;
  /** Evidence identity allocated by the caller before waiting for a concurrency slot. */
  runRecord?: RunRecord;
  /**
   * Execution-start boundary (epoch ms), captured by the caller immediately after
   * the shared concurrency limiter granted this run a slot. Callers always acquire
   * the limiter themselves before calling spawnSubagent (see the class doc comment
   * above); this field only carries that already-captured timestamp through so it
   * reaches the terminal summary and the live progress snapshot.
   */
  executionStartedAt?: number;
  /**
   * Real project-trust decision (ctx.isProjectTrusted()). Pi children load
   * installed skills through the SDK; project-scope skills are visible only
   * when this is true. Omitted means untrusted.
   */
  projectTrusted?: boolean;
}

interface SpawnSubagentRuntimeParams extends SpawnSubagentParams {
  onBackendEvent?: (event: unknown) => void;
  onProcessStart?: (pid: number | undefined) => void;
  resumeSessionId?: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function isNestedToolName(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return ["agent", "spawn_agent", "spawn_subagent", "invoke_subagent", "send_input", "resume_agent", "wait_agent", "close_agent"]
    .includes(value.trim().toLowerCase().replaceAll("-", "_"));
}

export function hasNestedAgentActivity(value: unknown, backend: SubagentBackend): boolean {
  const event = asRecord(value);
  if (!event) return false;

  if (backend === "claude" || backend === "grok") {
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

  if (backend === "muse") {
    return museHasNestedAgentActivity(event);
  }

  return false;
}

export function attachRunRecordIdentity(result: AgentToolResult, record: RunRecord): void {
  const apply = (details: SubagentToolDetails | SubagentProgressNode) => {
    details.runId = record.runId;
    details.recordPath = record.directory;
    if ("activity" in details) details.queuedAt ??= Date.parse(record.queuedAt);
  };
  apply(result.details as SubagentToolDetails);
  const details = result.details as SubagentToolDetails;
  if (details.progress) apply(details.progress);
  const first = result.content[0];
  if (first?.type === "text" && !first.text.includes(`[run ${record.runId}`)) {
    first.text = `${first.text}\n\n[run ${record.runId}]`;
  }
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
    requestedTier: PermissionTier | undefined;
    maxBudgetUsd: number | undefined;
    resumedFrom: string | undefined;
    sessionId: string | undefined;
    permissionDenials: number | undefined;
  },
): void {
  const apply = (details: SubagentToolDetails | SubagentProgressNode) => {
    details.backendEventCount = backendEventCount;
    details.nestedActivitySeen = nestedActivitySeen;
    details.nestedTimeoutExtended = nestedTimeoutExtended;
    details.effectiveTimeoutMs = effectiveTimeoutMs;
    details.recordingError = recordingError;
    if (extras.permission) {
      details.permission = extras.permission.tier;
      details.permissionEnforced = extras.permission.enforced;
    }
    if (extras.requestedTier && extras.permission && extras.requestedTier !== extras.permission.tier) {
      details.permissionRequested = extras.requestedTier;
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
  // Route the receipt's truth into the parent-facing text: the parent model
  // reads this banner, not summary.json. Denials signal a possibly blocked
  // run; the run id is the evidence pointer. Never gates anything.
  const denials = details.permissionDenials ?? 0;
  const blocked =
    denials > 0 ? ` · ${denials} permission denials — commands may have been blocked` : "";
  const elevatedNote = extras.requestedTier && extras.permission && extras.requestedTier !== extras.permission.tier
    ? ` · permission elevated ${extras.requestedTier}→${extras.permission.tier}`
    : "";
  const clampedNote = details.thinkingClamped
    ? ` · thinking clamped ${details.thinkingClamped.requested}→${details.thinkingClamped.effective}`
    : "";
  attachRunRecordIdentity(result, record);
  const first = result.content[0];
  if (first?.type === "text") {
    first.text = first.text.replace(`[run ${record.runId}]`, `[run ${record.runId}${blocked}${elevatedNote}${clampedNote}]`);
  }
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
  const preview = formatInterruptedOutputPreview(details.assistantOutput);
  return textResult(`Subagent "${params.description}" (${params.profile.name}) aborted: ${message}${preview}`, {
    ...details,
    description: params.description,
    subagentType: params.profile.name,
    backend: params.profile.backend,
    status: "aborted",
  });
}

/**
 * Pi child resources: the SDK's minimal surface plus installed skills.
 * Extensions, prompt templates, and themes stay out. Project skills load only
 * when projectTrusted is true. Call reload() after this returns.
 */
export function createPiChildResourceLoader(options: {
  cwd: string;
  agentDir: string;
  settingsManager: SettingsManager;
  projectTrusted: boolean;
  appendSystemPrompt?: string[];
}): DefaultResourceLoader {
  options.settingsManager.setProjectTrusted(options.projectTrusted);
  const extra = options.appendSystemPrompt ?? [];
  return new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir: options.agentDir,
    settingsManager: options.settingsManager,
    noExtensions: true,
    noPromptTemplates: true,
    noThemes: true,
    appendSystemPromptOverride: (base) => [...base, ...extra],
  });
}

export async function spawnSubagent(params: SpawnSubagentParams): Promise<AgentToolResult> {
  const startedAt = Date.now();
  let backendEventCount = 0;
  let nestedActivitySeen = false;
  const requestedTier = params.permission;
  const effectiveTier = resolveEffectivePermissionTier(requestedTier, params.profile, params.defaultPermission ?? "danger");
  const elevated = requestedTier !== undefined && requestedTier !== effectiveTier;
  const permission = resolvePermission(effectiveTier, params.profile.backend);
  const record = params.recordRun === false
    ? undefined
    : params.runRecord ?? createRunRecord({
        directory: runRecordsDirectory(),
        metadata: {
          description: params.description,
          prompt: params.prompt,
          ...(params.context ? { context: params.context } : {}),
          cwd: params.ctx.cwd,
          timeoutMs: params.timeoutMs,
          profile: params.profile,
          harness: selectorHarness(params.profile),
          permission: permission.tier,
          ...(elevated ? { permissionRequested: requestedTier } : {}),
          ...(params.maxBudgetUsd !== undefined ? { maxBudgetUsd: params.maxBudgetUsd } : {}),
          ...(params.resumeRunId ? { resumeRequested: params.resumeRunId } : {}),
        },
      });
  const unsupported = unsupportedPermissionReason(effectiveTier, params.profile.backend);
  if (unsupported) {
    const result = textResult(`Subagent "${params.description}" (${params.profile.name}) failed: ${unsupported}`, {
      description: params.description,
      subagentType: params.profile.name,
      backend: params.profile.backend,
      harness: selectorHarness(params.profile),
      status: "error",
      error: unsupported,
    });
    if (record) {
      await record.finish({
        backend: params.profile.backend,
        profile: params.profile.name,
        description: params.description,
        status: "error",
        error: unsupported,
        queued: true,
        backendStarted: false,
        durationMs: Date.now() - startedAt,
      });
      attachRunRecordIdentity(result, record);
    }
    return result;
  }
  let resumeSession: Awaited<ReturnType<typeof resolveResume>>["session"];
  if (params.resumeRunId) {
    const resolved = await resolveResume(runRecordsDirectory(), params.resumeRunId, params.profile.backend);
    if (resolved.error || !resolved.session) {
      const error = resolved.error ?? "resume resolution failed";
      const result = textResult(`Subagent "${params.description}" (${params.profile.name}) failed: ${error}`, {
        description: params.description,
        subagentType: params.profile.name,
        backend: params.profile.backend,
        harness: selectorHarness(params.profile),
        status: "error",
        error,
          });
      if (record) {
        await record.finish({
          backend: params.profile.backend,
          profile: params.profile.name,
          description: params.description,
          status: "error",
          error,
          queued: true,
          backendStarted: false,
          durationMs: Date.now() - startedAt,
              });
        attachRunRecordIdentity(result, record);
      }
      return result;
    }
    resumeSession = resolved.session;
  }
  const timeout = createTimeoutSignal(params.signal, params.timeoutMs, params.description);
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
  const onProcessStart = (pid: number | undefined) => {
    void record?.event("process_started", { pid });
  };
  try {
    let result = await spawnSubagentRuntime({
      ...params,
      permission: effectiveTier,
      signal: timeout.signal,
      onBackendEvent,
      onProcessStart,
      resumeSessionId: resumeSession?.sessionId,
      onProgress: params.onProgress ? (partial) => {
        if (record) {
          const details = partial.details as SubagentToolDetails;
          details.runId = record.runId;
          details.recordPath = record.directory;
          if (details.progress) {
            details.progress.runId = record.runId;
            details.progress.recordPath = record.directory;
            details.progress.queuedAt ??= Date.parse(record.queuedAt);
          }
        }
        if (params.context) {
          const details = partial.details as SubagentToolDetails;
          details.context = params.context;
          if (details.progress) details.progress.context = params.context;
        }
        params.onProgress?.(partial);
      } : undefined,
    });
    if (timeout.timedOut()) {
      result = rewriteTimeoutResult(result, {
        description: params.description,
        profile: params.profile,
        timeoutMs: timeout.effectiveTimeoutMs(),
      });
    } else if (params.signal?.aborted && params.signal.reason !== undefined) {
      const details = result.details as SubagentToolDetails;
      if (details.status === "aborted") {
        const reason = params.signal.reason instanceof Error ? params.signal.reason.message : String(params.signal.reason);
        details.error = reason;
        if (details.progress) details.progress.error = reason;
        const first = result.content[0];
        if (first?.type === "text") {
          const preview = formatInterruptedOutputPreview(details.assistantOutput);
          first.text = `Subagent "${params.description}" (${params.profile.name}) aborted: ${reason}${preview}`;
        }
      }
    }
    if (params.context) {
      const details = result.details as SubagentToolDetails;
      details.context = params.context;
      if (details.progress) details.progress.context = params.context;
      result.content.push({ type: "text", text: formatParentContext(params.context) });
    }
    if (record) {
      const details = result.details as SubagentToolDetails;
      await record.finish({
        backend: params.profile.backend,
        profile: params.profile.name,
        ...(params.context ? { context: params.context } : {}),
        model: params.profile.model,
        description: params.description,
        status: details.status,
        timedOut: details.timedOut === true,
        result: details.result,
        assistantOutput: details.assistantOutput,
        executionStartedAt: details.progress?.executionStartedAt,
        processStartedAt: details.progress?.processStartedAt,
        firstActivityAt: details.progress?.firstActivityAt,
        lastActivityAt: details.progress?.lastActivityAt,
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
        ...(details.retries !== undefined ? { retries: details.retries } : {}),
        ...(details.retryOf ? { retryOf: details.retryOf } : {}),
        ...(resumeSession ? { resumedFrom: resumeSession.runId } : {}),
        ...(details.thinkingClamped ? { thinkingClamped: details.thinkingClamped } : {}),
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
          requestedTier,
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
      executionStartedAt: params.executionStartedAt,
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
      onProcessStart: params.onProcessStart,
      appendInstructions: params.appendInstructions,
      outputSchema: params.outputSchema,
      permission: params.permission,
      resumeSessionId: params.resumeSessionId,
      executionStartedAt: params.executionStartedAt,
    });
  }
  if (params.profile.backend === "agy") {
    // ponytail: one immediate retry, agy-only, infra-classified failures only; per-attempt backoff if flakes persist
    const agyParams = {
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
      onProcessStart: params.onProcessStart,
      appendInstructions: params.appendInstructions,
      outputSchema: params.outputSchema,
      permission: params.permission,
      resumeConversationId: params.resumeSessionId,
      executionStartedAt: params.executionStartedAt,
      // ponytail: 2x base because extendOnce() may legitimately double the
      // outer deadline; the outer AbortSignal remains the real authority.
      timeoutMs: params.timeoutMs * 2,
    };
    let retryOf: string | undefined;
    for (let attempt = 1; ; attempt++) {
      const result = await spawnAgySubagent(agyParams);
      const details = result.details as SubagentToolDetails;
      const transientFailure =
        details.status === "error" && !params.signal?.aborted && isTransientAgyFailure(details.error);
      if (transientFailure && attempt === 1) {
        retryOf = details.error ?? "agy transient failure";
        // Resume the failed conversation so a mid-turn network failure does not
        // replay already-executed tool calls in a fresh conversation.
        agyParams.resumeConversationId = details.sessionId ?? agyParams.resumeConversationId;
        continue;
      }
      if (retryOf) {
        return { ...result, details: { ...details, retries: attempt - 1, retryOf } };
      }
      return result;
    }
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
      onProcessStart: params.onProcessStart,
      appendInstructions: params.appendInstructions,
      outputSchema: params.outputSchema,
      permission: params.permission,
      maxBudgetUsd: params.maxBudgetUsd,
      resumeSessionId: params.resumeSessionId,
      executionStartedAt: params.executionStartedAt,
    });
  }
  if (params.profile.backend === "grok") {
    return spawnGrokSubagent({
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
      onProcessStart: params.onProcessStart,
      appendInstructions: params.appendInstructions,
      outputSchema: params.outputSchema,
      permission: params.permission,
      resumeSessionId: params.resumeSessionId,
      executionStartedAt: params.executionStartedAt,
    });
  }
  if (params.profile.backend === "muse") {
    return spawnMuseSubagent({
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
      onProcessStart: params.onProcessStart,
      appendInstructions: params.appendInstructions,
      outputSchema: params.outputSchema,
      permission: params.permission,
      resumeSessionId: params.resumeSessionId,
      executionStartedAt: params.executionStartedAt,
    });
  }
  if (!params.model) {
    return textResult(`Subagent "${params.description}" (${params.profile.name}) failed: No model is selected.`, {
      description: params.description,
      subagentType: params.profile.name,
      backend: params.profile.backend,
      harness: selectorHarness(params.profile),
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

  // Thinking preflight: a valid-but-unsupported-by-this-model level is
  // legitimately clamped by createAgentSession itself (checked after session
  // creation below); a value outside the SDK's own closed set is not a
  // capability question, it is a typo or a stale/hand-edited harnesses.json
  // entry, and must fail loudly here rather than reach the SDK at all.
  if (thinkingLevel !== undefined && !isValidThinkingLevel(thinkingLevel)) {
    const error = `Unsupported thinking level "${thinkingLevel}"; expected one of: ${VALID_THINKING_LEVELS.join(", ")}.`;
    return textResult(`Subagent "${description}" (${subagentType}) failed: ${error}`, {
      description,
      subagentType,
      backend: profile.backend,
      harness: selectorHarness(profile),
      status: "error",
      error,
    });
  }

  // Auth preflight: hasConfiguredAuth is a fast, synchronous check that does
  // not refresh OAuth, so a token needing silent refresh could read as
  // unconfigured — acceptable, since prompt() would then simply fail cleanly
  // with a provider error instead of misbehaving silently.
  if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
    const error = `No credentials configured for provider "${model.provider}".`;
    return textResult(`Subagent "${description}" (${subagentType}) failed: ${error}`, {
      description,
      subagentType,
      backend: profile.backend,
      harness: selectorHarness(profile),
      status: "error",
      error,
    });
  }

  const excludeTools = params.excludeTools ?? CHILD_EXCLUDED_TOOLS;
  const customTools = params.customTools ?? [];
  const tier: PermissionTier = params.permission ?? "danger";
  // Curated builtins-only tier table (design §6), derived from the single
  // shared PI_TIER_ACTIVE_TOOLS source (src/core/permissions.ts) rather than
  // a second hand-maintained copy: readonly/edit tiers get a *default*
  // tools: allow-list when the profile itself sets none, so a readonly pi
  // child can actually search the repo (read alone cannot) rather than
  // being technically "read-only" but practically useless. danger keeps the
  // SDK's own default active tools (read/bash/edit/write) with no explicit
  // exclusion list needed — grep/find/ls simply aren't part of that default
  // set, so there is nothing to exclude.
  // The deny-by-exclusion universe is derived from the union of every tier's
  // active-tool list (the single shared PI_TIER_ACTIVE_TOOLS source), not a
  // hand-maintained copy: a builtin added to any tier's allow-list is
  // automatically part of the universe excluded at the other tiers, so the two
  // can never drift out of sync.
  const PI_BUILTIN_TOOL_NAMES = [...new Set(Object.values(PI_TIER_ACTIVE_TOOLS).flat())];
  const tierDefaultTools: Partial<Record<PermissionTier, readonly string[]>> = {
    readonly: PI_TIER_ACTIVE_TOOLS.readonly,
    edit: PI_TIER_ACTIVE_TOOLS.edit,
  };
  const tierExtraExcludes: Record<PermissionTier, readonly string[]> = {
    readonly: PI_BUILTIN_TOOL_NAMES.filter((name) => !PI_TIER_ACTIVE_TOOLS.readonly.includes(name)),
    edit: PI_BUILTIN_TOOL_NAMES.filter((name) => !PI_TIER_ACTIVE_TOOLS.edit.includes(name)),
    danger: [],
  };
  const effectiveExcludeTools = [...new Set([...excludeTools, ...tierExtraExcludes[tier]])];
  // A pinned tool allow-list must still admit any injected tools (e.g. structured_output).
  const effectiveDefaultTools = profile.tools ?? tierDefaultTools[tier];
  const toolAllowList =
    effectiveDefaultTools !== undefined ? [...effectiveDefaultTools, ...customTools.map((tool) => tool.name)] : undefined;
  const taskPrompt = params.appendInstructions ? `${prompt}\n\n${params.appendInstructions}` : prompt;
  const emitter = createProgressEmitter({
    toolCallId,
    description,
    subagentType,
    backend: profile.backend,
    harness: selectorHarness(profile),
    enabled: progressEnabled,
    onProgress,
    executionStartedAt: params.executionStartedAt,
  });
  const progress = emitter.progress;

  const agentDir = getAgentDir();
  const cwd = ctx.cwd;
  // Real global/project settings (compaction, thinking budgets, theme, etc.)
  // still flow through unchanged; only retry is overridden, and only in
  // memory. AgentSession retries transient provider errors on its own
  // (enabled: true, maxRetries 3 by default) entirely inside session.prompt(),
  // before this function's own completion check ever runs. Left as-is, every
  // pi child would silently retry, violating this repo's no-auto-retry
  // contract (AGENTS.md). applyOverrides() merges into the manager's live,
  // in-process `settings` view only — it never calls markModified()/save(),
  // so this can never reach the user's real settings file on disk.
  const settingsManager = SettingsManager.create(cwd, agentDir);
  const appendPrompts = [
    profile.systemPrompt,
  ].filter((value): value is string => Boolean(value));
  const resourceLoader = createPiChildResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    projectTrusted: params.projectTrusted ?? false,
    appendSystemPrompt: appendPrompts,
  });

  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  let unsubscribe: (() => void) | undefined;
  let abortHandler: (() => void) | undefined;
  let lastAgentEnd: { willRetry?: boolean } | undefined;
  let thinkingClamped: ThinkingClamp | undefined;

  const disposeAll = () => {
    emitter.stop();
    unsubscribe?.();
    if (signal && abortHandler) {
      signal.removeEventListener("abort", abortHandler);
    }
    session?.dispose();
  };

  try {
    if (signal?.aborted) {
      throw new Error("Subagent aborted before prompt start");
    }
    // minimal + skills: no extensions, prompt templates, or themes. Installed
    // skills load through the SDK. Project skills follow projectTrusted, which
    // createPiChildResourceLoader applied before this reload. reload() preserves
    // that flag and would discard an earlier settings override, so retry stays
    // disabled after reload.
    await resourceLoader.reload();
    // Third abort guard: the resource loading above does real file I/O
    // (context files, settings, and skill/prompt-template discovery) and can
    // be slow; check again before the heavier session construction so an
    // abort during reload does not proceed to spawn a session that would
    // immediately need to be torn down anyway.
    if (signal?.aborted) {
      throw new Error("Subagent aborted before prompt start");
    }

    // Apply the retry override only *after* resourceLoader.reload(): reload()
    // calls settingsManager.reload() internally, which re-reads from disk and
    // recomputes the manager's live settings view — an override applied
    // before this point would be silently discarded before session.prompt()
    // ever reads it. Still purely in-memory: applyOverrides() never calls
    // markModified()/save(), so this still never reaches the settings file.
    settingsManager.applyOverrides({ retry: { enabled: false } });

    ({ session } = await createAgentSession({
      cwd,
      agentDir,
      model,
      thinkingLevel: thinkingLevel as NonNullable<Parameters<typeof createAgentSession>[0]>["thinkingLevel"],
      modelRegistry: ctx.modelRegistry,
      settingsManager,
      sessionManager: SessionManager.inMemory(cwd),
      resourceLoader,
      excludeTools: [...effectiveExcludeTools],
      ...(customTools.length > 0 ? { customTools } : {}),
      ...(toolAllowList !== undefined ? { tools: toolAllowList } : {}),
    }));

    // Legitimate model-capability clamping (createAgentSession's own
    // documented contract: "clamped to model capabilities"), disclosed the
    // same way permission elevation already is. This only ever fires for a
    // requested level that already passed the six-literal preflight above —
    // a typo/stale value fails outright there and never reaches this
    // comparison.
    if (thinkingLevel !== undefined && session.thinkingLevel !== thinkingLevel) {
      thinkingClamped = { requested: thinkingLevel, effective: session.thinkingLevel };
    }

    if (signal) {
      abortHandler = () => {
        void session?.abort();
      };
      // Register unconditionally: if the signal is already aborted, the abort
      // event was dispatched before this listener existed and will never fire,
      // so also call abort() directly. Checking `!signal.aborted` *before*
      // addEventListener would leave a narrow window where the signal aborts
      // between the check and the registration and the listener misses it.
      signal.addEventListener("abort", abortHandler, { once: true });
      if (signal.aborted) {
        void session.abort();
      }
    }

    unsubscribe = session.subscribe((event) => {
      params.onBackendEvent?.(event);
      const record = asRecord(event);
      if (record?.type === "agent_end") {
        lastAgentEnd = record as { willRetry?: boolean };
      }
      if (progress) {
        updateProgressFromEvent(progress, event);
        emitter.emitSoon();
      }
      if (event.type === "message_end" && event.message.role === "assistant") {
        const usage = getSubagentUsage(session!);
        if (progress) {
          progress.usage = usage;
        }
        onUsage(usage);
      }
    });

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
    // Terminal success requires an *observed* agent_end whose willRetry is
    // exactly false — not merely the absence of a true value. A run that
    // completes without ever having emitted (or forwarded) a terminal
    // agent_end event is exactly as untrustworthy as one that emitted a
    // retrying one: both mean this code cannot actually confirm the SDK
    // considered the turn final, so both must fail rather than fall through
    // to declaring success by default. This also fails loudly, rather than
    // silently reporting success, if a future SDK change breaks the
    // "no retry pending once prompt() resolves" invariant this depends on.
    if (!lastAgentEnd) {
      throw new Error("Subagent completed without an observed agent_end event; treating as an unexpected state.");
    }
    if (lastAgentEnd.willRetry !== false) {
      throw new Error(`Subagent turn reported willRetry=${String(lastAgentEnd.willRetry)} at completion; treating as an unexpected state.`);
    }
    const rawResult = extractFinalAssistantText(session.messages);
    if (!rawResult || !rawResult.trim()) {
      throw new Error("Subagent produced no final assistant text.");
    }
    const result = rawResult;
    const output = assistantOutput(extractAssistantMessages(session.messages), "final", result);
    const usage = getSubagentUsage(session);
    onUsage(usage);
    if (progress) {
      progress.status = "done";
      progress.result = result;
      progress.usage = usage;
      progress.assistantOutput = output;
      progress.endedAt = Date.now();
      if (thinkingClamped) progress.thinkingClamped = thinkingClamped;
    }
    return textResult(`Subagent "${description}" (${subagentType}) completed:\n\n${result}`, {
      description,
      subagentType,
      backend: profile.backend,
      harness: selectorHarness(profile),
      status: "done",
      result,
      usage,
      assistantOutput: output,
      ...(thinkingClamped ? { thinkingClamped } : {}),
      ...(progress ? { progress } : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = signal?.aborted ? "aborted" : "error";
    const usage = session
      ? getSubagentUsage(session)
      : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, costKnown: false };
    const output = assistantOutput(session ? extractAssistantMessages(session.messages) : [], "interrupted");
    onUsage(usage);
    if (progress) {
      progress.status = status;
      progress.error = message;
      progress.usage = usage;
      progress.assistantOutput = output;
      progress.endedAt = Date.now();
      if (thinkingClamped) progress.thinkingClamped = thinkingClamped;
    }
    const verb = status === "aborted" ? "aborted" : "failed";
    const preview = formatInterruptedOutputPreview(output);
    return textResult(`Subagent "${description}" (${subagentType}) ${verb}: ${message}${preview}`, {
      description,
      subagentType,
      backend: profile.backend,
      harness: selectorHarness(profile),
      status,
      error: message,
      usage,
      assistantOutput: output,
      ...(thinkingClamped ? { thinkingClamped } : {}),
      ...(progress ? { progress } : {}),
    });
  } finally {
    disposeAll();
  }
}
