import {
  defineTool,
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionFactory,
  type Theme,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import {
  AGENT_PROMPT_SNIPPET,
  buildCoordinatorPrompt,
} from "./prompts.ts";
import { createExternalHelpTool } from "./external-help.ts";
import { createExternalRunsTool } from "./external-runs.ts";
import {
  filterExternalAgentProfiles,
  formatExternalAgentPolicyError,
  getSubagentProfiles,
  resolveExternalProfile,
} from "./profiles.ts";
import { ConcurrencyLimiter } from "./core/concurrency.ts";
import { getBackendAgentLabel } from "./core/display.ts";
import { filterProfilesForModelRegistry, resolveProfileModel, usesPiBackend } from "./core/model.ts";
import { attachRunRecordIdentity, CHILD_EXCLUDED_TOOLS, spawnSubagent } from "./core/spawn.ts";
import { createRunRecord } from "./core/run-record.ts";
import { captureParentContext, parentContextSchema, prepareParentContext } from "./core/parent-context.ts";
import { resolvePermission, permissionLabel, resolveEffectivePermissionTier } from "./core/permissions.ts";
import { pruneRunRecords, runRecordsDirectory } from "./core/retention.ts";
import { createProgressNode, textResult, type AgentToolResult } from "./core/progress.ts";
import { RunRegistry } from "./core/run-registry.ts";
import { formatUsage, renderSubagentNode } from "./core/subagent-render.ts";
import { SPINNER_INTERVAL_MS } from "./core/spinner.ts";
import { createWorkflowTool } from "./workflow/tool.ts";
import { registerProfileCreator, startProfileInterview } from "./profile-creator.ts";
import { seedDefaultProfiles } from "./defaults.ts";
import { registerExternalCommand } from "./external-command.ts";
import { DEFAULT_EXTERNAL_SETTINGS, loadExternalSettings, resolveCtxDefaultHarness, resolveExternalSettings, renderDefaultHarness } from "./settings.ts";
import type {
  PermissionTier,
  ExternalHarness,
  SubagentBackend,
  SubagentExtensionOptions,
  SubagentProfile,
  SubagentProgressNode,
  SubagentToolDetails,
  SubagentUsage,
} from "./types.ts";

const DEFAULT_MAX_CONCURRENT_SUBAGENTS = DEFAULT_EXTERNAL_SETTINGS.maxConcurrentSubagents;
const DEFAULT_SUBAGENT_TIMEOUT_MS = DEFAULT_EXTERNAL_SETTINGS.subagentTimeoutMs;
const MAX_CONCURRENT_SUBAGENTS_FLAG = "max-concurrent-subagents";
const SUBAGENT_TIMEOUT_MS_FLAG = "subagent-timeout-ms";
const STATUS_KEY = "pi-flow";

const agentToolParameters = Type.Object({
  context: Type.Optional(parentContextSchema),
  description: Type.String({
    description: "A short 3-5 word description of the task, used for UI display and routing context.",
  }),
  prompt: Type.String({
    description: "The task briefing to send to the subagent.",
  }),
  background: Type.Optional(Type.Boolean({
    description: "Return a stable run handle after registration while the session-owned child continues. Defaults to false.",
  })),
  role: Type.Optional(Type.String({
    minLength: 1,
    description: "The built-in or custom external role to use, such as reviewer. Required unless using legacy subagent_type.",
  })),
  harness: Type.Optional(Type.Union([Type.Literal("agy"), Type.Literal("claude"), Type.Literal("codex")], {
    description: "Optional external harness override. Omit to use the effective default harness: a trusted project override (.pi/pi-flow-external/settings.json) when present, else the global defaultHarness setting.",
  })),
  subagent_type: Type.Optional(Type.String({
    minLength: 1,
    description: "Legacy exact-profile escape hatch. Cannot be combined with role or harness.",
  })),
  permission: Type.Optional(
    Type.Union([Type.Literal("readonly"), Type.Literal("edit"), Type.Literal("danger")], {
      description:
        "Optional permission tier override. Omit to use the profile's calibrated default (recommended). Enforcement varies by backend: codex uses its --sandbox axis, claude denies shell commands below danger, and agy always runs unsandboxed (--dangerously-skip-permissions) — readonly/edit on agy are advisory instructions only, not a boundary. When in doubt, omit.",
    }),
  ),
  max_budget_usd: Type.Optional(
    Type.Number({
      minimum: 0,
      description:
        "Optional USD spending cap for this run. Enforced mid-run on Claude Code (native flag); recorded and reported after the run elsewhere.",
    }),
  ),
  resume: Type.Optional(
    Type.String({
      description:
        "Prior run id (from a completed result's evidence id) whose backend conversation should be continued. Must use the same profile backend.",
    }),
  ),
}, {
  anyOf: [
    { required: ["role"], not: { required: ["subagent_type"] } },
    {
      required: ["subagent_type"],
      not: { anyOf: [{ required: ["role"] }, { required: ["harness"] }] },
    },
  ],
});

type AgentToolParams = Static<typeof agentToolParameters>;

type AgentRenderProfile = Pick<SubagentProfile, "name" | "backend" | "description" | "permission">;

interface AgentRenderState {
  selectionKey?: string;
  profile?: AgentRenderProfile;
}

interface DelegationState {
  limiter: ConcurrencyLimiter;
  maxConcurrentSubagents: number;
  subagentTimeoutMs: number;
  defaultPermission: PermissionTier;
  defaultHarness: ExternalHarness;
  defaultMaxBudgetUsd: number | undefined;
  maxRunRecords: number;
  registry: RunRegistry;
  progressEnabled: boolean;
  activeRuns: Map<string, ActiveAgentRun>;
  frame: number;
  heartbeat?: ReturnType<typeof setInterval>;
}

interface ActiveAgentRun {
  toolCallId: string;
  progress: SubagentProgressNode;
  onUpdate: ((result: AgentToolResult) => void) | undefined;
}

interface SubagentUsageStatusState {
  calls: Map<string, SubagentUsage>;
  latestCacheHitRate?: number;
}

interface CreateAgentToolOptions {
  getLimiter: () => ConcurrencyLimiter;
  getThinkingLevel: () => ReturnType<ExtensionAPI["getThinkingLevel"]>;
  getSubagentTimeoutMs: () => number;
  getDefaultPermission: () => PermissionTier;
  /** Effective default harness for render paths: cwd only, no trust signal. */
  getDefaultHarness: (cwd: string) => ExternalHarness;
  updateStatus: (ctx: ExtensionContext, toolCallId: string, usage: SubagentUsage) => void;
}

const PROGRESS_STATUSES: SubagentProgressNode["status"][] = ["queued", "running", "done", "error", "aborted"];
const SUBAGENT_BACKENDS: SubagentBackend[] = ["pi", "codex", "claude", "agy"];

function shouldEnableProgress(ctx: ExtensionContext): boolean {
  if (!ctx.hasUI) {
    return false;
  }
  try {
    // RPC exposes ExtensionUIContext but has no TUI theme surface. Keep compact
    // progress updates limited to the interactive TUI renderer.
    return ctx.ui.getAllThemes().length > 0;
  } catch {
    return false;
  }
}

function normalizeMaxConcurrentSubagents(value: number | string | boolean | undefined, fallback: number, label: string): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function normalizeSubagentTimeoutMs(value: number | string | boolean | undefined, fallback: number, label: string): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return parsed;
}

function formatSelectionForDisplay(args: Record<string, unknown>, defaultHarness: ExternalHarness): string {
  if (typeof args.subagent_type === "string" && args.subagent_type.trim()) return args.subagent_type.trim();
  if (typeof args.role === "string" && args.role.trim()) {
    const harness = typeof args.harness === "string" && args.harness.trim() ? args.harness.trim() : defaultHarness;
    return `${harness}-${args.role.trim()}`;
  }
  return "profile";
}

// Disclose parent-context sharing on the intent card: it sends conversation
// content to the external harness, so it belongs with access and workspace.
function formatSharedContext(value: unknown): string {
  if (!isRecord(value)) return "";
  if (value.mode === "full") return "full available conversation";
  if (value.mode === "recent") {
    return `recent · up to ${typeof value.turns === "number" ? value.turns : "?"} user turns`;
  }
  return "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function isProgressStatus(value: unknown): value is SubagentProgressNode["status"] {
  return typeof value === "string" && PROGRESS_STATUSES.includes(value as SubagentProgressNode["status"]);
}

function isSubagentBackend(value: unknown): value is SubagentBackend {
  return typeof value === "string" && SUBAGENT_BACKENDS.includes(value as SubagentBackend);
}

function isSubagentProgressNode(value: unknown): value is SubagentProgressNode {
  if (!isRecord(value)) {
    return false;
  }
  const subagentType = value.subagentType;
  return (
    typeof value.id === "string" &&
    typeof value.description === "string" &&
    typeof subagentType === "string" &&
    (value.backend === undefined || isSubagentBackend(value.backend)) &&
    isProgressStatus(value.status) &&
    Number.isFinite(value.startedAt) &&
    Array.isArray(value.activity) &&
    value.activity.every((line) => typeof line === "string") &&
    Number.isFinite(value.activityCount)
  );
}

function createUsageStatusState(): SubagentUsageStatusState {
  return {
    calls: new Map(),
  };
}

function getUsageTotals(state: SubagentUsageStatusState): SubagentUsage {
  const totals: SubagentUsage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    latestCacheHitRate: state.latestCacheHitRate,
  };
  for (const usage of state.calls.values()) {
    totals.input += usage.input;
    totals.output += usage.output;
    totals.cacheRead += usage.cacheRead;
    totals.cacheWrite += usage.cacheWrite;
    totals.cost += usage.cost;
    if (usage.costKnown === false) {
      totals.costKnown = false;
    }
  }
  return totals;
}

function formatUsageStatus(totals: SubagentUsage, theme: Theme): string {
  return `${theme.fg("dim", "pi-flow ")}${theme.fg("dim", formatUsage(totals))}`;
}

function publishUsageStatus(ctx: ExtensionContext, state: SubagentUsageStatusState): void {
  const totals = getUsageTotals(state);
  if (totals.input === 0 && totals.output === 0 && totals.cacheRead === 0 && totals.cacheWrite === 0) {
    ctx.ui.setStatus(STATUS_KEY, undefined);
    return;
  }
  ctx.ui.setStatus(STATUS_KEY, formatUsageStatus(totals, ctx.ui.theme));
}

function updateUsageStatus(
  state: SubagentUsageStatusState,
  ctx: ExtensionContext,
  toolCallId: string,
  usage: SubagentUsage,
): void {
  state.calls.set(toolCallId, usage);
  if (usage.latestCacheHitRate !== undefined) {
    state.latestCacheHitRate = usage.latestCacheHitRate;
  }
  publishUsageStatus(ctx, state);
}

function getRunningRunCount(state: DelegationState): number {
  let count = 0;
  for (const run of state.activeRuns.values()) {
    if (run.progress.status === "running") {
      count++;
    }
  }
  return count;
}

function emitActiveRunUpdate(state: DelegationState, run: ActiveAgentRun): void {
  run.onUpdate?.(textResult(`Subagent "${run.progress.description}" (${run.progress.subagentType}) ${run.progress.status}.`, {
    description: run.progress.description,
    subagentType: run.progress.subagentType,
    backend: run.progress.backend,
    status: run.progress.status,
    result: run.progress.result,
    error: run.progress.error,
    usage: run.progress.usage,
    progress: run.progress,
    activeCount: getRunningRunCount(state),
    frame: state.frame,
  }));
}

function broadcastActiveRunUpdates(state: DelegationState): void {
  for (const run of state.activeRuns.values()) {
    emitActiveRunUpdate(state, run);
  }
}

function startAgentHeartbeat(state: DelegationState): void {
  if (state.heartbeat) {
    return;
  }
  state.heartbeat = setInterval(() => {
    if (state.activeRuns.size === 0) {
      if (state.heartbeat) {
        clearInterval(state.heartbeat);
        state.heartbeat = undefined;
      }
      return;
    }
    state.frame++;
    broadcastActiveRunUpdates(state);
  }, SPINNER_INTERVAL_MS);
  state.heartbeat.unref?.();
}

function createAgentTool(
  getState: () => DelegationState,
  options: CreateAgentToolOptions,
): ToolDefinition<typeof agentToolParameters, SubagentToolDetails> {
  return defineTool({
    name: "Agent",
    label: "Agent",
    description: "Delegate one task to an external Claude Code, Codex CLI, or Antigravity role.",
    promptSnippet: AGENT_PROMPT_SNIPPET,
    parameters: agentToolParameters,
    executionMode: "parallel",
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const briefing = prepareParentContext(params.prompt, params.context,
        params.context && params.context.mode !== "none" ? captureParentContext(ctx.sessionManager) : undefined,
        toolCallId, params.resume);
      const state = getState();
      const effectiveState: DelegationState = {
        ...state,
        progressEnabled: state.progressEnabled || shouldEnableProgress(ctx),
      };
      const allProfiles = filterProfilesForModelRegistry(getSubagentProfiles(getAgentDir()), ctx.modelRegistry);
      const profiles = filterExternalAgentProfiles(allProfiles);
      const defaultHarness = resolveCtxDefaultHarness(effectiveState.defaultHarness, ctx).harness;
      let profile: SubagentProfile;
      try {
        profile = resolveExternalProfile(profiles, {
          role: params.role,
          harness: params.harness,
          subagentType: params.subagent_type,
        }, defaultHarness);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return textResult(
          message,
          {
            description: params.description,
            subagentType: "unknown",
            status: "error",
            error: message,
          },
        );
      }
      const subagentType = profile.name;

      if (profile.backend === "pi") {
        const error = formatExternalAgentPolicyError(profile);
        return textResult(error, {
          description: params.description,
          subagentType,
          backend: profile.backend,
          status: "error",
          error,
        });
      }

      const model = resolveProfileModel(profile, ctx);
      if (usesPiBackend(profile) && !model) {
        const error = profile.model ? `Profile model not found: ${profile.model}` : "No model is selected";
        return textResult(`Cannot launch subagent: ${error}.`, {
          description: params.description,
          subagentType,
          backend: profile.backend,
          status: "error",
          error,
        });
      }

      const queuedAt = Date.now();
      const sessionId = ctx.sessionManager?.getSessionId?.() ?? `unpersisted:${toolCallId}`;
      const sessionVersion = state.registry.sessionVersion(sessionId);
      const project = resolve(ctx.cwd);
      const executionContext = { cwd: project } as ExtensionContext;
      const limiter = state.limiter;
      const timeoutMs = state.subagentTimeoutMs;
      const thinkingLevel = profile.thinking ?? options.getThinkingLevel();
      const defaultPermission = state.defaultPermission;
      const maxBudgetUsd = params.max_budget_usd ?? profile.maxBudgetUsd ?? state.defaultMaxBudgetUsd;
      const background = params.background === true;
      const runRecord = createRunRecord({
        directory: runRecordsDirectory(),
        metadata: {
          kind: "agent",
          parentSessionId: sessionId,
          project,
          description: params.description,
          prompt: briefing.prompt,
          profile: profile.name,
          backend: profile.backend,
          queuedAt: new Date(queuedAt).toISOString(),
        },
      });
      const progress = createProgressNode(toolCallId, params.description, subagentType, "queued", profile.backend);
      progress.context = briefing.context;
      progress.queuedAt = queuedAt;
      progress.runId = runRecord.runId;
      progress.recordPath = runRecord.directory;
      const executeRun = async (runSignal: AbortSignal) => {
        const run: ActiveAgentRun = {
          toolCallId,
          progress,
          onUpdate: !background && effectiveState.progressEnabled ? onUpdate : undefined,
        };
        state.activeRuns.set(toolCallId, run);
        state.registry.update(runRecord.runId, run.progress);
        if (!background && effectiveState.progressEnabled) {
          startAgentHeartbeat(state);
          broadcastActiveRunUpdates(state);
        }

        let release: (() => void) | undefined;
        try {
          release = await limiter.acquire(runSignal);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const status = runSignal.aborted ? "aborted" : "error";
          run.progress.status = status;
          run.progress.error = message;
          run.progress.endedAt = Date.now();
          state.registry.update(runRecord.runId, run.progress);
          emitActiveRunUpdate(state, run);
          state.activeRuns.delete(toolCallId);
          broadcastActiveRunUpdates(state);
          const result = textResult(`Subagent "${params.description}" (${subagentType}) ${status}: ${message}`, {
            description: params.description,
            subagentType,
            backend: profile.backend,
            status,
            error: message,
            progress: run.progress,
            activeCount: getRunningRunCount(state),
            frame: state.frame,
          });
          await runRecord.finish({ status, error: message, queued: true, backendStarted: false });
          attachRunRecordIdentity(result, runRecord);
          return result;
        }

        run.progress.status = "running";
        run.progress.startedAt = Date.now();
        state.registry.update(runRecord.runId, run.progress);
        if (!background) broadcastActiveRunUpdates(state);

        try {
          const result = await spawnSubagent({
          toolCallId,
          description: params.description,
          prompt: briefing.prompt,
          context: briefing.context,
          profile,
          model,
          thinkingLevel,
          ctx: executionContext,
          signal: runSignal,
          timeoutMs,
          progressEnabled: true,
          permission: params.permission,
          defaultPermission,
          maxBudgetUsd,
          resumeRunId: params.resume,
          onProgress: (partial) => {
            const details = partial.details as SubagentToolDetails;
            if (details.progress) run.progress = details.progress;
            state.registry.update(runRecord.runId, run.progress);
            if (!background) emitActiveRunUpdate(state, run);
          },
          onUsage: background ? () => undefined : (usage) => options.updateStatus(ctx, toolCallId, usage),
          excludeTools: CHILD_EXCLUDED_TOOLS,
          runRecord,
        });
          const details = result.details as SubagentToolDetails;
          if (details.progress) run.progress = details.progress;
          details.progress = run.progress;
          details.activeCount = getRunningRunCount(state);
          details.frame = state.frame;
          state.registry.update(runRecord.runId, run.progress);
          return result;
        } finally {
          release();
          state.activeRuns.delete(toolCallId);
          if (!background) broadcastActiveRunUpdates(state);
        }
      };

      const registered = state.registry.start({
        runId: runRecord.runId,
        kind: "agent",
        sessionId,
        sessionVersion,
        project,
        ...(background ? {} : { signal }),
        run: executeRun,
        outcome: (result, runSignal) => {
          const details = result.details as SubagentToolDetails;
          return {
            status: details.status === "done" ? "done" : details.status === "aborted" ? "aborted" : "error",
            outcome: details.status === "done" ? "succeeded" : details.timedOut ? "timed_out" : details.status === "aborted" ? "cancelled" : "failed",
            ...(details.result !== undefined ? { result: details.result } : {}),
            ...(runSignal.aborted && runSignal.reason !== undefined
              ? { error: runSignal.reason instanceof Error ? runSignal.reason.message : String(runSignal.reason) }
              : details.error ? { error: details.error } : {}),
          };
        },
      });
      if (!background) return await registered.result;
      return textResult(
        `Subagent "${params.description}" (${subagentType}) queued as ${runRecord.runId}. Use external_runs to inspect, wait, or cancel it.`,
        {
          description: params.description,
          subagentType,
          backend: profile.backend,
          status: "queued",
          runId: runRecord.runId,
          recordPath: runRecord.directory,
          progress,
        },
      );
    },
    renderCall(args, theme, context) {
      const defaultHarness = options.getDefaultHarness(context.cwd);
      const subagentType = formatSelectionForDisplay(args, defaultHarness);
      const state = context.state as AgentRenderState;
      const selectionKey = JSON.stringify([args.role, args.harness, args.subagent_type, defaultHarness]);
      if (state.selectionKey !== selectionKey) {
        let profile: SubagentProfile | undefined;
        try {
          profile = resolveExternalProfile(filterExternalAgentProfiles(getSubagentProfiles(getAgentDir())), {
            role: typeof args.role === "string" ? args.role : undefined,
            harness: typeof args.harness === "string" ? args.harness : undefined,
            subagentType: typeof args.subagent_type === "string" ? args.subagent_type : undefined,
          }, defaultHarness);
        } catch {
          profile = undefined;
        }
        state.selectionKey = selectionKey;
        state.profile = profile
          ? { name: profile.name, backend: profile.backend, description: profile.description, permission: profile.permission }
          : undefined;
      }
      const profile = state.profile;
      const backend = profile?.backend;
      const description = typeof args.description === "string" ? args.description.trim() : "";
      const requestedTier = typeof args.permission === "string" ? (args.permission as PermissionTier) : undefined;
      const tier = resolveEffectivePermissionTier(
        requestedTier,
        profile,
        options.getDefaultPermission(),
      );
      const elevatedNote = requestedTier && requestedTier !== tier
        ? theme.fg("muted", ` (${requestedTier}→${tier} floor)`)
        : "";
      const tierLabel = permissionLabel(resolvePermission(tier, backend ?? "claude"));
      const lines = [
        `${theme.bold("Delegating")} ${theme.bold(getBackendAgentLabel(backend))} ${theme.fg("muted", `→ ${subagentType}`)} · ${theme.fg("warning", tierLabel)}${elevatedNote}`,
        description ? `${theme.fg("muted", "Task")} ${description}` : "",
        profile?.description ? `${theme.fg("muted", "Why")} ${profile.description}` : "",
        formatSharedContext(args.context) ? `${theme.fg("muted", "Context")} ${formatSharedContext(args.context)}` : "",
        context.cwd ? `${theme.fg("muted", "Workspace")} ${context.cwd}` : "",
      ].filter(Boolean);
      return new Text(lines.join("\n"), 0, 0);
    },
    renderResult(result, { expanded }, theme) {
      const details = result.details as SubagentToolDetails;
      return renderSubagentNode(
        details.progress ?? details,
        theme,
        details.frame ?? 0,
        details.activeCount ?? (details.status === "running" ? 1 : 0),
        "",
        Date.now(),
        expanded,
      );
    },
  });
}

export function createSubagentExtension(options: SubagentExtensionOptions = {}): ExtensionFactory {
  const workflowEnabled = options.workflow !== false;

  return function subagentExtension(pi: ExtensionAPI) {
    const loadedSettings = loadExternalSettings(getAgentDir());
    const configuredSettings = resolveExternalSettings(loadedSettings.settings, options);
    const defaultMaxConcurrentSubagents = normalizeMaxConcurrentSubagents(
      configuredSettings.maxConcurrentSubagents,
      DEFAULT_MAX_CONCURRENT_SUBAGENTS,
      "maxConcurrentSubagents",
    );
    const defaultSubagentTimeoutMs = normalizeSubagentTimeoutMs(
      configuredSettings.subagentTimeoutMs,
      DEFAULT_SUBAGENT_TIMEOUT_MS,
      "subagentTimeoutMs",
    );
    pi.registerFlag(MAX_CONCURRENT_SUBAGENTS_FLAG, {
      description: `Maximum number of pi-flow subagents that may run concurrently (default: ${defaultMaxConcurrentSubagents})`,
      type: "string",
      default: String(defaultMaxConcurrentSubagents),
    });
    pi.registerFlag(SUBAGENT_TIMEOUT_MS_FLAG, {
      description: `Maximum wall-clock runtime for each pi-flow subagent in milliseconds; set 0 to disable (default: ${defaultSubagentTimeoutMs})`,
      type: "string",
      default: String(defaultSubagentTimeoutMs),
    });

    const rootState: DelegationState = {
      limiter: new ConcurrencyLimiter(defaultMaxConcurrentSubagents),
      maxConcurrentSubagents: defaultMaxConcurrentSubagents,
      subagentTimeoutMs: defaultSubagentTimeoutMs,
      defaultPermission: loadedSettings.settings.defaultPermission,
      defaultHarness: loadedSettings.settings.defaultHarness,
      defaultMaxBudgetUsd: loadedSettings.settings.defaultMaxBudgetUsd ?? undefined,
      maxRunRecords: loadedSettings.settings.maxRunRecords,
      registry: new RunRegistry(),
      progressEnabled: false,
      activeRuns: new Map(),
      frame: 0,
    };
    const syncMaxConcurrentSubagents = () => {
      const current = normalizeMaxConcurrentSubagents(
        pi.getFlag(MAX_CONCURRENT_SUBAGENTS_FLAG),
        defaultMaxConcurrentSubagents,
        `--${MAX_CONCURRENT_SUBAGENTS_FLAG}`,
      );
      if (current !== rootState.maxConcurrentSubagents) {
        rootState.limiter = new ConcurrencyLimiter(current);
        rootState.maxConcurrentSubagents = current;
      }
      rootState.subagentTimeoutMs = normalizeSubagentTimeoutMs(
        pi.getFlag(SUBAGENT_TIMEOUT_MS_FLAG),
        defaultSubagentTimeoutMs,
        `--${SUBAGENT_TIMEOUT_MS_FLAG}`,
      );
      return rootState;
    };
    const usageStatusState = createUsageStatusState();
    const toolOptions: CreateAgentToolOptions = {
      getLimiter: () => syncMaxConcurrentSubagents().limiter,
      getThinkingLevel: () => pi.getThinkingLevel(),
      getSubagentTimeoutMs: () => syncMaxConcurrentSubagents().subagentTimeoutMs,
      getDefaultPermission: () => rootState.defaultPermission,
      getDefaultHarness: (cwd) => renderDefaultHarness(rootState.defaultHarness, cwd),
      updateStatus: (ctx, toolCallId, usage) => {
        if (!ctx.hasUI) {
          return;
        }
        updateUsageStatus(usageStatusState, ctx, toolCallId, usage);
      },
    };

    pi.registerTool(createAgentTool(syncMaxConcurrentSubagents, toolOptions));
    pi.registerTool(createExternalHelpTool({
      getDefaultHarness: (ctx) => resolveCtxDefaultHarness(rootState.defaultHarness, ctx).harness,
      workflowEnabled,
    }));
    const externalRuns = createExternalRunsTool({
      registry: rootState.registry,
      runsDirectory: runRecordsDirectory,
    });
    pi.registerTool(externalRuns);
    registerProfileCreator(pi, toolOptions);
    registerExternalCommand(pi, {
      settings: loadedSettings,
      getRuntimeSettings: () => {
        const state = syncMaxConcurrentSubagents();
        return {
          maxConcurrentSubagents: state.maxConcurrentSubagents,
          subagentTimeoutMs: state.subagentTimeoutMs,
        };
      },
      getMaxRunRecords: () => rootState.maxRunRecords,
      startProfileInterview,
      externalRuns,
    });
    if (workflowEnabled) {
      pi.registerTool(
        createWorkflowTool({
          registry: rootState.registry,
          getLimiter: () => syncMaxConcurrentSubagents().limiter,
          getThinkingLevel: () => pi.getThinkingLevel(),
          getSubagentTimeoutMs: () => syncMaxConcurrentSubagents().subagentTimeoutMs,
          getDefaultPermission: () => rootState.defaultPermission,
          getDefaultHarness: (ctx) => resolveCtxDefaultHarness(rootState.defaultHarness, ctx).harness,
          getDefaultMaxBudgetUsd: () => rootState.defaultMaxBudgetUsd,
          updateStatus: (ctx, toolCallId, usage) => {
            if (!ctx.hasUI) {
              return;
            }
            updateUsageStatus(usageStatusState, ctx, toolCallId, usage);
          },
        }),
      );
    }

    pi.on("session_start", (_event, ctx) => {
      rootState.registry.openSession(ctx.sessionManager.getSessionId());
      syncMaxConcurrentSubagents();
      usageStatusState.calls.clear();
      usageStatusState.latestCacheHitRate = undefined;
      // Best-effort retention sweep and one-time default-profile seeding;
      // never blocks or fails the session.
      void pruneRunRecords(runRecordsDirectory(), rootState.maxRunRecords).catch(() => undefined);
      try {
        seedDefaultProfiles(getAgentDir());
      } catch {
        // Seeding is opportunistic; a read-only agent dir must not break startup.
      }
      if (ctx.hasUI) {
        ctx.ui.setStatus(STATUS_KEY, undefined);
      }
    });

    pi.on("session_shutdown", async (_event, ctx) => {
      const cleanup = await rootState.registry.shutdownSession(ctx.sessionManager.getSessionId());
      if (cleanup.pending.length && ctx.hasUI) {
        const shown = cleanup.pending.slice(0, 10);
        ctx.ui.notify(`External run cleanup could not be confirmed for ${shown.join(", ")}${cleanup.pending.length > shown.length ? ` and ${cleanup.pending.length - shown.length} more` : ""}; their evidence is interrupted or uncertain.`, "warning");
      }
    });

    pi.on("before_agent_start", (event, ctx) => {
      const tools = pi.getAllTools();
      if (!tools.some((tool) => tool.name === "Agent")) {
        return;
      }
      // No per-turn counter reset: the shared ConcurrencyLimiter takes a slot
      // synchronously in execute() before the first await and releases it in the
      // finally. Acquisition is synchronous and release always runs, so the
      // in-flight count stays accurate across turns without a reset.
      const profiles = filterExternalAgentProfiles(filterProfilesForModelRegistry(getSubagentProfiles(getAgentDir()), ctx.modelRegistry));
      const defaultHarness = resolveCtxDefaultHarness(rootState.defaultHarness, ctx).harness;
      return { systemPrompt: `${event.systemPrompt}\n\n${buildCoordinatorPrompt(profiles, defaultHarness)}` };
    });
  };
}

export const createFlowExtension = createSubagentExtension;

export default createFlowExtension();
