import {
  defineTool,
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionFactory,
  type Theme,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import {
  AGENT_PROMPT_SNIPPET,
  buildCoordinatorPrompt,
} from "./prompts.ts";
import { createExternalHelpTool } from "./external-help.ts";
import {
  filterExternalAgentProfiles,
  formatExternalAgentPolicyError,
  getSubagentProfiles,
  resolveExternalProfile,
} from "./profiles.ts";
import { ConcurrencyLimiter } from "./core/concurrency.ts";
import { getBackendAgentLabel } from "./core/display.ts";
import { filterProfilesForModelRegistry, resolveProfileModel, usesPiBackend } from "./core/model.ts";
import { CHILD_EXCLUDED_TOOLS, spawnSubagent } from "./core/spawn.ts";
import { resolvePermission, permissionLabel, resolveEffectivePermissionTier } from "./core/permissions.ts";
import { pruneRunRecords, runRecordsDirectory } from "./core/retention.ts";
import { createProgressNode, textResult, type AgentToolResult } from "./core/progress.ts";
import { formatUsage, renderSubagentNode } from "./core/subagent-render.ts";
import { SPINNER_INTERVAL_MS } from "./core/spinner.ts";
import { createWorkflowTool } from "./workflow/tool.ts";
import { registerProfileCreator, startProfileInterview } from "./profile-creator.ts";
import { seedDefaultProfiles } from "./defaults.ts";
import { registerExternalCommand } from "./external-command.ts";
import { DEFAULT_EXTERNAL_SETTINGS, loadExternalSettings, resolveExternalSettings } from "./settings.ts";
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
  description: Type.String({
    description: "A short 3-5 word description of the task, used for UI display and routing context.",
  }),
  prompt: Type.String({
    description: "The task briefing to send to the subagent.",
  }),
  role: Type.Optional(Type.String({
    minLength: 1,
    description: "The built-in or custom external role to use, such as reviewer. Required unless using legacy subagent_type.",
  })),
  harness: Type.Optional(Type.Union([Type.Literal("agy"), Type.Literal("claude"), Type.Literal("codex")], {
    description: "Optional external harness override. Omit to use the global defaultHarness setting.",
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
  getDefaultHarness: () => ExternalHarness;
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
      const state = getState();
      const effectiveState: DelegationState = {
        ...state,
        progressEnabled: state.progressEnabled || shouldEnableProgress(ctx),
      };
      const allProfiles = filterProfilesForModelRegistry(getSubagentProfiles(getAgentDir()), ctx.modelRegistry);
      const profiles = filterExternalAgentProfiles(allProfiles);
      let profile: SubagentProfile;
      try {
        profile = resolveExternalProfile(profiles, {
          role: params.role,
          harness: params.harness,
          subagentType: params.subagent_type,
        }, effectiveState.defaultHarness);
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

      const progress = effectiveState.progressEnabled
        ? createProgressNode(toolCallId, params.description, subagentType, "queued", profile.backend)
        : undefined;
      const run = progress ? { toolCallId, progress, onUpdate } : undefined;
      if (run) {
        state.activeRuns.set(toolCallId, run);
        startAgentHeartbeat(state);
        broadcastActiveRunUpdates(state);
      }

      let release: (() => void) | undefined;
      try {
        release = await state.limiter.acquire(signal);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const status = signal?.aborted ? "aborted" : "error";
        if (run) {
          run.progress.status = status;
          run.progress.error = message;
          run.progress.endedAt = Date.now();
          emitActiveRunUpdate(state, run);
          state.activeRuns.delete(toolCallId);
          broadcastActiveRunUpdates(state);
        }
        return textResult(`Subagent "${params.description}" (${subagentType}) ${status}: ${message}`, {
          description: params.description,
          subagentType,
          backend: profile.backend,
          status,
          error: message,
          ...(run ? { progress: run.progress, activeCount: getRunningRunCount(state), frame: state.frame } : {}),
        });
      }

      if (run) {
        run.progress.status = "running";
        run.progress.startedAt = Date.now();
        broadcastActiveRunUpdates(state);
      }

      try {
        const result = await spawnSubagent({
          toolCallId,
          description: params.description,
          prompt: params.prompt,
          profile,
          model,
          thinkingLevel: profile.thinking ?? options.getThinkingLevel(),
          ctx,
          signal,
          timeoutMs: options.getSubagentTimeoutMs(),
          progressEnabled: effectiveState.progressEnabled,
          permission: params.permission,
          defaultPermission: effectiveState.defaultPermission,
          maxBudgetUsd: params.max_budget_usd ?? profile.maxBudgetUsd ?? effectiveState.defaultMaxBudgetUsd,
          resumeRunId: params.resume,
          onProgress: effectiveState.progressEnabled && run
            ? (partial) => {
                const details = partial.details as SubagentToolDetails;
                if (details.progress) {
                  run.progress = details.progress;
                }
                emitActiveRunUpdate(state, run);
              }
            : undefined,
          onUsage: (usage) => options.updateStatus(ctx, toolCallId, usage),
          excludeTools: CHILD_EXCLUDED_TOOLS,
        });
        const details = result.details as SubagentToolDetails;
        if (run && details.progress) {
          run.progress = details.progress;
        }
        if (run) {
          details.progress = run.progress;
          details.activeCount = getRunningRunCount(state);
          details.frame = state.frame;
        }
        return result;
      } finally {
        release();
        if (run) {
          state.activeRuns.delete(toolCallId);
          broadcastActiveRunUpdates(state);
        }
      }
    },
    renderCall(args, theme, context) {
      const subagentType = formatSelectionForDisplay(args, options.getDefaultHarness());
      const state = context.state as AgentRenderState;
      const selectionKey = JSON.stringify([args.role, args.harness, args.subagent_type, options.getDefaultHarness()]);
      if (state.selectionKey !== selectionKey) {
        let profile: SubagentProfile | undefined;
        try {
          profile = resolveExternalProfile(filterExternalAgentProfiles(getSubagentProfiles(getAgentDir())), {
            role: typeof args.role === "string" ? args.role : undefined,
            harness: typeof args.harness === "string" ? args.harness : undefined,
            subagentType: typeof args.subagent_type === "string" ? args.subagent_type : undefined,
          }, options.getDefaultHarness());
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
      getDefaultHarness: () => rootState.defaultHarness,
      updateStatus: (ctx, toolCallId, usage) => {
        if (!ctx.hasUI) {
          return;
        }
        updateUsageStatus(usageStatusState, ctx, toolCallId, usage);
      },
    };

    pi.registerTool(createAgentTool(syncMaxConcurrentSubagents, toolOptions));
    pi.registerTool(createExternalHelpTool({
      getDefaultHarness: () => rootState.defaultHarness,
      workflowEnabled,
    }));
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
    });
    if (workflowEnabled) {
      pi.registerTool(
        createWorkflowTool({
          getLimiter: () => syncMaxConcurrentSubagents().limiter,
          getThinkingLevel: () => pi.getThinkingLevel(),
          getSubagentTimeoutMs: () => syncMaxConcurrentSubagents().subagentTimeoutMs,
          getDefaultPermission: () => rootState.defaultPermission,
          getDefaultHarness: () => rootState.defaultHarness,
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
      return { systemPrompt: `${event.systemPrompt}\n\n${buildCoordinatorPrompt(profiles, rootState.defaultHarness)}` };
    });
  };
}

export const createFlowExtension = createSubagentExtension;

export default createFlowExtension();
