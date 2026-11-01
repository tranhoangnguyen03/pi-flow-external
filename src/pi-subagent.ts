import { ExpectedFlowError } from "./core/errors.ts";
import { agentOutputSchema, agentReceipt, agentToolParameters } from "./contract/agent.ts";
export { agentToolParameters } from "./contract/agent.ts";
import type { PublicError } from "./contract/envelope.ts";
import { liveAgentRun, liveWorkflowRun, type PublicRun } from "./contract/run.ts";
import { getRunRecord } from "./core/run-inspection.ts";
import { redactSecrets } from "./core/run-record.ts";
import {
  defineTool,
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionFactory,
  type Theme,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { resolve, join } from "node:path";
import { resolveExecutionProfile } from './execution-config.ts';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { getCurrentSystemMessage } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { AGENT_PROMPT_SNIPPET, EXTERNAL_MODE_PROMPTS } from "./prompts.ts";
import { getExternalMode, updateExternalModeStatus, EXTERNAL_MODE_STATUS_KEY } from "./external-mode.ts";
import { createExternalHelpTool } from "./external-help.ts";
import { createExternalRunsTool } from "./external-runs.ts";
import {
  loadExternalCatalog,
  resolveExternalProfile,
  selectorHarness,
} from "./profiles.ts";
import { ConcurrencyLimiter } from "./core/concurrency.ts";
import { getBackendAgentLabel } from "./core/display.ts";
import { describeMissingModel, filterProfilesForModelRegistry, resolveProfileModel, usesPiBackend } from "./core/model.ts";
import { attachRunRecordIdentity, CHILD_EXCLUDED_TOOLS, spawnSubagent } from "./core/spawn.ts";
import { createRunRecord } from "./core/run-record.ts";
import { captureParentContext, prepareParentContext } from "./core/parent-context.ts";
import { resolvePermission, permissionLabel, resolveEffectivePermissionTier } from "./core/permissions.ts";
import { pruneRunRecords, runRecordsDirectory } from "./core/retention.ts";
import { createProgressNode, textResult, type AgentToolResult } from "./core/progress.ts";
import { RunRegistry, type RegisteredRunEntry } from "./core/run-registry.ts";
import { formatUsage, renderSubagentNode } from "./core/subagent-render.ts";
import { SPINNER_INTERVAL_MS } from "./core/spinner.ts";
import { createWorkflowTool } from "./workflow/tool.ts";
import { registerProfileCreator, startRoleInterview, startHarnessInterview } from "./profile-creator.ts";
import { registerExternalCommand } from "./external-command.ts";
import { DEFAULT_EXTERNAL_SETTINGS, loadExternalSettings, resolveCtxDefaultHarness, resolveExternalSettings, renderDefaultHarness } from "./settings.ts";
import { EXTERNAL_HARNESSES } from "./types.ts";
import { EXTERNAL_DELEGATE_TOOL, EXTERNAL_WORKFLOW_TOOL } from "./tool-names.ts";
import type {
  PermissionTier,
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
const BG_STATUS_KEY = "pi-flow-runs";
const BACKGROUND_SETTLED_CUSTOM_TYPE = "pi-flow-background-settled";
const DEFAULT_BACKGROUND_WAKE_DEBOUNCE_MS = 150;

type AgentRenderProfile = Pick<SubagentProfile, "name" | "backend" | "description">;

interface AgentRenderState {
  selectionKey?: string;
  profile?: AgentRenderProfile;
}

interface DelegationState {
  limiter: ConcurrencyLimiter;
  maxConcurrentSubagents: number;
  subagentTimeoutMs: number;
  defaultPermission: PermissionTier;
  defaultHarness: string;
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
  getDefaultHarness: (cwd: string) => string;
  updateStatus: (ctx: ExtensionContext, toolCallId: string, usage: SubagentUsage) => void;
  onSessionContext?: (ctx: ExtensionContext, sessionId: string) => void;
}

const PROGRESS_STATUSES: SubagentProgressNode["status"][] = ["queued", "running", "done", "error", "aborted"];
const SUBAGENT_BACKENDS: SubagentBackend[] = ["pi", "codex", "claude", "agy", "grok", "muse", "opencode"];

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

function formatSelectionForDisplay(args: Record<string, unknown>, defaultHarness: string): string {
  if (typeof args.subagent_type === "string" && args.subagent_type.trim()) return args.subagent_type.trim();
  if (typeof args.role === "string" && args.role.trim()) {
    const harness = typeof args.harness === "string" && args.harness.trim() ? args.harness.trim() : defaultHarness;
    return `${harness}/${args.role.trim()}`;
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

// Launcher names a transcript saved before the #85 rename declares, and their replacements.
const RENAMED_LAUNCHERS: ReadonlyArray<readonly [legacy: string, current: string]> = [
  ["Agent", EXTERNAL_DELEGATE_TOOL],
  ["workflow", EXTERNAL_WORKFLOW_TOOL],
];

// Launchers the user kept off on the command line. Pi applies `--tools` modifiers
// to the restored loadout but does not expose them to extensions, and a `-name`
// modifier cannot match the legacy name it replaces. `--no-tools` turns
// extension tools off by default. SDK `tools` options are not visible here.
function cliExcludedLaunchers(argv: readonly string[]): Set<string> {
  if (argv.includes("--no-tools") || argv.includes("-nt")) return new Set(RENAMED_LAUNCHERS.map(([, current]) => current));
  let tools: string[] = [];
  argv.forEach((arg, index) => {
    if ((arg === "--tools" || arg === "-t") && index + 1 < argv.length) {
      tools = argv[index + 1].split(",").map((name) => name.trim());
    }
  });
  return new Set(tools.filter((name) => name.startsWith("-")).map((name) => name.slice(1)));
}

// Pi restores a resumed or tree-navigated session's tool loadout from its
// transcript. A legacy name no longer registers, so its replacement stays off.
// Activate the replacement for each legacy name the restored loadout declares,
// unless the loadout also declares the replacement (it was then turned off on
// purpose) or the command line excludes it. setActiveTools ignores a tool that
// is not registered or not allowed.
function restoreRenamedLaunchers(pi: ExtensionAPI, ctx: ExtensionContext, argv: readonly string[] = process.argv): void {
  const declared = new Set(
    (getCurrentSystemMessage(ctx.sessionManager.buildSessionProjection().messages)?.toolsAdded ?? []).map((tool) => tool.name),
  );
  const active = pi.getActiveTools();
  const excluded = cliExcludedLaunchers(argv);
  const restored = RENAMED_LAUNCHERS
    .filter(([legacy, current]) => declared.has(legacy) && !declared.has(current) && !active.includes(current) && !excluded.has(current))
    .map(([, current]) => current);
  if (restored.length > 0) pi.setActiveTools([...active, ...restored]);
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

function formatBackgroundRunsStatus(roots: RegisteredRunEntry[], theme?: Theme): string | undefined {
  if (roots.length === 0) return undefined;
  const ids = roots.slice(0, 2).map((r) => r.runId.slice(-8)).join(", ") + (roots.length > 2 ? ", …" : "");
  const text = `pi-flow ${roots.length} bg (${ids})`;
  return typeof theme?.fg === "function" ? theme.fg("accent", text) : text;
}

function buildBackgroundWakePayload(entries: RegisteredRunEntry[]): { text: string; runs: PublicRun[] } {
  const runs = entries.map((entry) =>
    (entry.kind === "workflow" ? liveWorkflowRun(entry, { inlineBudget: 0 }) : liveAgentRun(entry, { inlineBudget: 0 })).run,
  );
  const lines = runs.map((run) => {
    const label = run.task.name ?? run.task.description ?? run.kind;
    const outcome = run.state.outcome ?? run.state.status;
    const view = outcome === "succeeded" ? "final" : "diagnostics";
    const failedChildren = run.children?.failed ? ` (${run.children.failed} handled child failure(s))` : "";
    return `- ${run.runId} (${run.kind} "${label}"): ${outcome}${failedChildren} — inspect with external_runs { action: "inspect", runIds: ["${run.runId}"], view: "${view}" }`;
  });
  const rawText = [
    "Background run(s) settled:",
    ...lines,
    "Use external_runs inspect (view: \"final\" for succeeded runs, \"diagnostics\" or \"output\" for failed runs) to read the results and report back to the user.",
  ].join("\n");
  return redactSecrets({ text: rawText, runs }) as { text: string; runs: PublicRun[] };
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
    name: EXTERNAL_DELEGATE_TOOL,
    label: EXTERNAL_DELEGATE_TOOL,
    description: "Delegate one task to an external Claude Code, Codex CLI, Antigravity, Grok CLI, Muse Code, OpenCode, or registered Pi harness role.",
    promptSnippet: AGENT_PROMPT_SNIPPET,
    parameters: agentToolParameters,
    outputSchema: agentOutputSchema,
    executionMode: "parallel",
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const state = getState();
      const receipt = async (result: AgentToolResult, error?: PublicError, settled?: RegisteredRunEntry) => {
        const details = result.details as SubagentToolDetails;
        const durable = details.runId ? await getRunRecord(runRecordsDirectory(), details.runId).catch(() => undefined) : undefined;
        // Evidence I/O may outlast the child: observe live state only after it.
        const entry = settled ?? (details.runId ? state.registry.get(details.runId) : undefined);
        const structuredContent = agentReceipt({ entry, integrity: durable?.integrity, error, inspectable: !!durable || !!(entry && state.registry.get(entry.runId)) });
        return { ...result, content: redactSecrets(result.content) as typeof result.content, structuredContent, isError: !structuredContent.ok };
      };
      const resume = typeof params.resume === "string" && params.resume.trim() !== "" ? params.resume.trim() : undefined;
      let briefing: ReturnType<typeof prepareParentContext>;
      try {
        briefing = prepareParentContext(params.prompt, params.context,
          params.context && params.context.mode !== "none" ? captureParentContext(ctx.sessionManager) : undefined,
          toolCallId, resume);
      } catch (error) {
        if (!(error instanceof ExpectedFlowError)) throw error;
        return receipt(textResult(error.message, { description: params.description, subagentType: "unknown", status: "error", error: error.message }), error);
      }
      const effectiveState: DelegationState = {
        ...state,
        progressEnabled: state.progressEnabled || shouldEnableProgress(ctx),
      };
      const catalog = loadExternalCatalog(getAgentDir());
      if (catalog.blocked) return receipt(textResult(catalog.diagnostics.join(" "), { description: params.description, subagentType: "unknown", status: "error", error: catalog.diagnostics.join(" ") }), { code: "configuration_invalid", message: catalog.diagnostics.join(" ") });
      const allProfiles = catalog.profiles;
      const harnessConfigs = catalog.harnessConfigs;
      const configuredHarnessNames: ReadonlySet<string> = new Set([...EXTERNAL_HARNESSES, ...harnessConfigs.keys()]);
      const profiles = allProfiles;
      const requestedDefault = resolveCtxDefaultHarness(effectiveState.defaultHarness, ctx);
      const defaultHarness = requestedDefault.harness;
      if (params.role && !params.harness && !configuredHarnessNames.has(defaultHarness)) {
        const error = `Default harness "${defaultHarness}" is not registered (missing from settings.json); pass harness explicitly or recreate it via /external config harness create.`;
        return receipt(textResult(error, {
          description: params.description,
          subagentType: "unknown",
          status: "error",
          error,
        }), { code: "harness_unavailable", message: error });
      }
      let profile: SubagentProfile;
      try {
        profile = resolveExternalProfile(profiles, {
          role: params.role,
          harness: params.harness,
          subagentType: params.subagent_type,
        }, defaultHarness, { configuredHarnessNames, disabledHarnesses: catalog.disabledHarnesses });
      } catch (error) {
        if (!(error instanceof ExpectedFlowError)) throw error;
        const message = error.message;
        return receipt(textResult(
          message,
          {
            description: params.description,
            subagentType: "unknown",
            status: "error",
            error: message,
          },
        ), { code: error.code, message });
      }
      const subagentType = profile.name;
      profile = resolveExecutionProfile(profile, options.getThinkingLevel(), state.defaultMaxBudgetUsd);

      const model = resolveProfileModel(profile, ctx);
      if (usesPiBackend(profile) && !model) {
        const error = describeMissingModel(profile, ctx.modelRegistry);
        return receipt(textResult(`Cannot launch subagent: ${error}.`, {
          description: params.description,
          subagentType,
          backend: profile.backend,
          harness: selectorHarness(profile),
          status: "error",
          error,
        }), { code: "model_unavailable", message: error });
      }

      const queuedAt = Date.now();
      const sessionId = ctx.sessionManager?.getSessionId?.() ?? `unpersisted:${toolCallId}`;
      options.onSessionContext?.(ctx, sessionId);
      const sessionVersion = state.registry.sessionVersion(sessionId);
      const project = resolve(ctx.cwd);
      // modelRegistry must survive into the execution context: the pi backend
      // resolves its child model/auth through it (spawn.ts's pi branch), the
      // same already-populated instance the parent used to resolve `profile`.
      const executionContext = { cwd: project, modelRegistry: ctx.modelRegistry } as ExtensionContext;
      const limiter = state.limiter;
      const timeoutMs = state.subagentTimeoutMs;
      const thinkingLevel = profile.thinking;
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
          authoredPrompt: params.prompt,
          plannedConfiguration: { roleInstructions: profile.systemPrompt, model: profile.model, thinking: thinkingLevel, tools: profile.tools, permissionRequested: params.permission ?? "default", timeoutMs, maxBudgetUsd },
          context: briefing.context ?? { mode: "none" },
          profile: profile.name,
          backend: profile.backend,
          harness: selectorHarness(profile),
          queuedAt: new Date(queuedAt).toISOString(),
        },
      });
      await runRecord.event("intent_ready");
      const progress = createProgressNode(toolCallId, params.description, subagentType, "queued", profile.backend, selectorHarness(profile));
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
            harness: selectorHarness(profile),
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
        run.progress.executionStartedAt = run.progress.startedAt;
        void runRecord.event("execution_started");
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
          resumeRunId: resume,
          executionStartedAt: run.progress.executionStartedAt,
          projectTrusted: (() => {
            try {
              return ctx.isProjectTrusted?.() ?? false;
            } catch {
              return false;
            }
          })(),
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

      let registered;
      try {
        registered = state.registry.start({
        runId: runRecord.runId,
        kind: "agent",
        sessionId,
        sessionVersion,
        project,
        background,
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
      } catch (error) {
        if (!(error instanceof ExpectedFlowError)) throw error;
        await runRecord.finish({ status: "error", error: error.message, backendStarted: false });
        return receipt(textResult(error.message, { description: params.description, subagentType, status: "error", error: error.message }), error);
      }
      if (!background) {
        const result = await registered.result;
        const outcome = await registered.terminal;
        return receipt(result, undefined, {
          runId: runRecord.runId, kind: "agent", sessionId, project, state: "terminal",
          observation: (result.details as SubagentToolDetails).progress ?? progress, outcome,
        });
      }
      return receipt(textResult(
        `Subagent "${params.description}" (${subagentType}) queued as ${runRecord.runId}. Do independent local work first, or report the runId and proceed/end your turn without waiting; use external_runs when ready to inspect, wait, or cancel.`,
        {
          description: params.description,
          subagentType,
          backend: profile.backend,
          harness: selectorHarness(profile),
          status: "queued",
          runId: runRecord.runId,
          recordPath: runRecord.directory,
          progress,
          backgroundReceipt: true,
        },
      ));
    },
    renderCall(args, theme, context) {
      const defaultHarness = options.getDefaultHarness(context.cwd);
      const subagentType = formatSelectionForDisplay(args, defaultHarness);
      const state = context.state as AgentRenderState;
      const selectionKey = JSON.stringify([args.role, args.harness, args.subagent_type, defaultHarness]);
      if (state.selectionKey !== selectionKey) {
        let profile: SubagentProfile | undefined;
        try {
          const catalog = loadExternalCatalog(getAgentDir());
          if (catalog.blocked) throw new Error(catalog.diagnostics.join(" "));
          const harnessConfigs = catalog.harnessConfigs;
          const configuredHarnessNames: ReadonlySet<string> = new Set([...EXTERNAL_HARNESSES, ...harnessConfigs.keys()]);
          profile = resolveExternalProfile(
            catalog.profiles,
            {
              role: typeof args.role === "string" ? args.role : undefined,
              harness: typeof args.harness === "string" ? args.harness : undefined,
              subagentType: typeof args.subagent_type === "string" ? args.subagent_type : undefined,
            },
            defaultHarness,
            { configuredHarnessNames, disabledHarnesses: catalog.disabledHarnesses },
          );
        } catch {
          profile = undefined;
        }
        state.selectionKey = selectionKey;
        state.profile = profile
          ? { name: profile.name, backend: profile.backend, description: profile.description }
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
      // An unresolved profile has no backend. Do not borrow Claude's label:
      // that would claim a permission boundary this call has not resolved.
      const tierLabel = backend
        ? permissionLabel(resolvePermission(tier, backend))
        : `${tier} · unresolved`;
      const lines = [
        `${theme.bold("Delegating")} ${theme.bold(getBackendAgentLabel(backend))} ${theme.fg("muted", `→ ${subagentType}`)} · ${theme.fg("warning", tierLabel)}`,
        description ? `${theme.fg("muted", "Task")} ${description}` : "",
        profile?.description ? `${theme.fg("muted", "Role")} ${profile.description}` : "",
        formatSharedContext(args.context) ? `${theme.fg("muted", "Context")} ${formatSharedContext(args.context)}` : "",
        context.cwd ? `${theme.fg("muted", "Workspace")} ${context.cwd}` : "",
        `${theme.fg("muted", "Mode")} ${args.background ? "Background" : "Foreground"}`,
      ].filter(Boolean);
      return new Text(lines.join("\n"), 0, 0);
    },
    renderResult(result, { expanded }, theme) {
      const details = result.details as SubagentToolDetails;
      if (details.backgroundReceipt) return new Text(`${theme.bold("Started in background")}\n${theme.fg("muted", "Launch receipt — not a live monitor")}\n${theme.fg("muted", "Run")} ${expanded ? details.runId : details.runId?.slice(-8)} · ${theme.fg("accent", "/external runs")} ${theme.fg("muted", "to inspect or follow")}`, 0, 0);
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
      default: "",
    });
    pi.registerFlag(SUBAGENT_TIMEOUT_MS_FLAG, {
      description: `Maximum wall-clock runtime for each pi-flow subagent in milliseconds; set 0 to disable (default: ${defaultSubagentTimeoutMs})`,
      type: "string",
      default: "",
    });

    const readinessControllers = new Set<AbortController>();
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
      const latest = loadExternalSettings(getAgentDir());
      Object.assign(loadedSettings, latest);
      rootState.defaultPermission = latest.settings.defaultPermission;
      rootState.defaultHarness = latest.settings.defaultHarness;
      rootState.defaultMaxBudgetUsd = latest.settings.defaultMaxBudgetUsd ?? undefined;
      rootState.maxRunRecords = latest.settings.maxRunRecords;
      const current = normalizeMaxConcurrentSubagents(
        !pi.getFlag(MAX_CONCURRENT_SUBAGENTS_FLAG)
          ? options.maxConcurrentSubagents ?? latest.settings.maxConcurrentSubagents
          : pi.getFlag(MAX_CONCURRENT_SUBAGENTS_FLAG),
        defaultMaxConcurrentSubagents,
        `--${MAX_CONCURRENT_SUBAGENTS_FLAG}`,
      );
      if (current !== rootState.maxConcurrentSubagents && rootState.limiter.activeCount === 0 && rootState.limiter.pendingCount === 0) {
        rootState.limiter = new ConcurrencyLimiter(current);
        rootState.maxConcurrentSubagents = current;
      }
      rootState.subagentTimeoutMs = normalizeSubagentTimeoutMs(
        !pi.getFlag(SUBAGENT_TIMEOUT_MS_FLAG)
          ? options.subagentTimeoutMs ?? latest.settings.subagentTimeoutMs
          : pi.getFlag(SUBAGENT_TIMEOUT_MS_FLAG),
        defaultSubagentTimeoutMs,
        `--${SUBAGENT_TIMEOUT_MS_FLAG}`,
      );
      return rootState;
    };
    const usageStatusState = createUsageStatusState();
    const wakeDebounceMs =
      typeof options.backgroundWakeDebounceMs === "number" &&
      Number.isInteger(options.backgroundWakeDebounceMs) &&
      options.backgroundWakeDebounceMs >= 0
        ? options.backgroundWakeDebounceMs
        : DEFAULT_BACKGROUND_WAKE_DEBOUNCE_MS;
    let activeSessionId: string | undefined;
    let activeUiCtx: ExtensionContext | undefined;
    let inAgentTurn = false;
    let wakeTimer: ReturnType<typeof setTimeout> | undefined;
    const pendingWakeBySession = new Map<string, Map<string, { entry: RegisteredRunEntry; sessionVersion: number }>>();

    const rememberSessionContext = (ctx: ExtensionContext, sessionId = ctx.sessionManager?.getSessionId?.()) => {
      if (sessionId && !sessionId.startsWith("unpersisted:")) {
        if (activeSessionId !== sessionId) activeUiCtx = ctx;
        activeSessionId = sessionId;
      } else if (!activeSessionId && sessionId) {
        activeSessionId = sessionId;
      }
      if (ctx.hasUI || !activeUiCtx) activeUiCtx = ctx;
    };

    const updateBackgroundStatus = (sessionId = activeSessionId) => {
      if (!sessionId || sessionId !== activeSessionId || !activeUiCtx?.hasUI || typeof activeUiCtx.ui?.setStatus !== "function") return;
      const roots = rootState.registry.listBackgroundRoots(sessionId);
      try {
        activeUiCtx.ui.setStatus(BG_STATUS_KEY, formatBackgroundRunsStatus(roots, activeUiCtx.ui.theme));
      } catch {
        // Ignore stale or disposed UI contexts.
      }
    };

    const clearWakeTimer = () => {
      if (wakeTimer) {
        clearTimeout(wakeTimer);
        wakeTimer = undefined;
      }
    };

    const flushPendingWakes = (sessionId: string) => {
      if (inAgentTurn || sessionId !== activeSessionId) return;
      const pending = pendingWakeBySession.get(sessionId);
      if (!pending || pending.size === 0) return;
      pendingWakeBySession.delete(sessionId);
      const uncollected = [...pending.values()].filter(
        (item) =>
          !rootState.registry.isCollected(item.entry.runId) &&
          rootState.registry.isSessionActive(sessionId, item.sessionVersion),
      );
      if (uncollected.length === 0) return;
      const payload = buildBackgroundWakePayload(uncollected.map((item) => item.entry));
      try {
        pi.sendMessage(
          {
            customType: BACKGROUND_SETTLED_CUSTOM_TYPE,
            content: [{ type: "text", text: payload.text }],
            display: true,
            details: { runs: payload.runs },
          },
          { triggerTurn: true, deliverAs: "followUp" },
        );
        for (const item of uncollected) rootState.registry.markCollected(item.entry.runId);
      } catch {
        if (activeSessionId === sessionId) {
          activeSessionId = undefined;
          activeUiCtx = undefined;
        }
      }
    };

    const scheduleWakeFlush = (sessionId: string) => {
      if (inAgentTurn || sessionId !== activeSessionId) return;
      const pending = pendingWakeBySession.get(sessionId);
      if (!pending || pending.size === 0) return;
      clearWakeTimer();
      wakeTimer = setTimeout(() => {
        wakeTimer = undefined;
        flushPendingWakes(sessionId);
      }, wakeDebounceMs);
      (wakeTimer as { unref?: () => void }).unref?.();
    };

    rootState.registry.onBackgroundEvent((event) => {
      updateBackgroundStatus(event.entry.sessionId);
      if (event.type !== "settled") return;
      if (event.suppressed) {
        pendingWakeBySession.get(event.entry.sessionId)?.delete(event.entry.runId);
        return;
      }
      if (
        activeUiCtx?.hasUI &&
        activeSessionId === event.entry.sessionId &&
        typeof activeUiCtx.ui?.notify === "function"
      ) {
        const outcome = event.entry.outcome?.outcome ?? "settled";
        const label = event.entry.kind === "workflow" ? "Background workflow" : "Background subagent";
        activeUiCtx.ui.notify(
          redactSecrets(`${label} ${event.entry.runId} ${outcome}.`) as string,
          outcome === "succeeded" ? "info" : "warning",
        );
      }
      const shouldWake = options.backgroundWake ?? Boolean(activeUiCtx?.hasUI);
      if (!shouldWake) return;
      let sessionPending = pendingWakeBySession.get(event.entry.sessionId);
      if (!sessionPending) {
        sessionPending = new Map();
        pendingWakeBySession.set(event.entry.sessionId, sessionPending);
      }
      sessionPending.set(event.entry.runId, { entry: event.entry, sessionVersion: event.sessionVersion });
      scheduleWakeFlush(event.entry.sessionId);
    });

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
      onSessionContext: rememberSessionContext,
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
      startRoleInterview,
      startHarnessInterview,
      getThinkingLevel: () => pi.getThinkingLevel(),
      testHarness: async (ctx, harness, signal) => {
        const loaded = loadExternalSettings(getAgentDir());
        const config = loaded.settings.harnessSettings?.[harness];
        if (loaded.blocked || !config?.model) return { ok: false, error: loaded.diagnostics.join(' ') || 'No harness model configured' };
        if (!ctx.hasUI || !await ctx.ui.confirm(`Test ${harness}?`, `This sends one potentially paid request to ${config.model} with readonly curated Pi tools (not an OS sandbox), from an empty temporary directory. No configuration is changed.`)) return { ok: false, error: 'Test cancelled' };
        const profile: SubagentProfile = { name: `${harness}/smoke`, harness, backend: 'pi', description: 'Harness readiness test', model: config.model, thinking: config.thinking === 'parent' ? pi.getThinkingLevel() : config.thinking ?? 'off', preset: config.preset ?? 'minimal' };
        const model = resolveProfileModel(profile, ctx);
        if (!model) return { ok: false, error: describeMissingModel(profile, ctx.modelRegistry) };
        const controller = new AbortController();
        readinessControllers.add(controller);
        const abort=()=>controller.abort(signal?.reason);
        if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});
        const deadline = setTimeout(() => controller.abort(new Error('Readiness test timed out')), 60000);
        let release: (() => void) | undefined;
        let cwd: string | undefined;
        try {
          release = await syncMaxConcurrentSubagents().limiter.acquire(controller.signal);
          cwd = await mkdtemp(join(tmpdir(), 'pi-flow-readiness-'));
          const result = await spawnSubagent({ toolCallId: `readiness-${Date.now()}`, description: profile.description, prompt: 'Do not use tools. Reply exactly PI_FLOW_READY.', profile, model, thinkingLevel: profile.thinking, ctx: { ...ctx, cwd }, permission: 'readonly', signal: controller.signal, timeoutMs: Math.min(rootState.subagentTimeoutMs || 60000, 60000), progressEnabled: false, onProgress: undefined, onUsage: () => {}, excludeTools: CHILD_EXCLUDED_TOOLS, recordRun: false });
          const details = result.details as { status?: string; result?: string; error?: string };
          return details.status === 'done' && details.result?.trim() === 'PI_FLOW_READY' ? { ok: true, detail: config.model } : { ok: false, error: details.error ?? 'Unexpected smoke response' };
        } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
        finally { clearTimeout(deadline); signal?.removeEventListener('abort',abort); readinessControllers.delete(controller); release?.(); if (cwd) await rm(cwd, { recursive: true, force: true }); }
      },
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
          onSessionContext: rememberSessionContext,
        }),
      );
    }

    pi.on("agent_start", (_event, ctx) => {
      if (!activeSessionId) rememberSessionContext(ctx);
      inAgentTurn = true;
      clearWakeTimer();
    });

    pi.on("agent_end", (_event, ctx) => {
      if (!activeSessionId) rememberSessionContext(ctx);
      inAgentTurn = false;
      if (activeSessionId) scheduleWakeFlush(activeSessionId);
    });

    pi.on("session_tree", (_event, ctx) => {
      restoreRenamedLaunchers(pi, ctx);
      updateExternalModeStatus(ctx);
    });
    pi.on("session_start", (_event, ctx) => {
      restoreRenamedLaunchers(pi, ctx);
      const sessionId = ctx.sessionManager.getSessionId();
      rememberSessionContext(ctx, sessionId);
      inAgentTurn = false;
      clearWakeTimer();
      pendingWakeBySession.clear();
      rootState.registry.openSession(sessionId);
      syncMaxConcurrentSubagents();
      usageStatusState.calls.clear();
      usageStatusState.latestCacheHitRate = undefined;
      // Retention never blocks startup. Built-in roles do not write files.
      void pruneRunRecords(runRecordsDirectory(), rootState.maxRunRecords).catch(() => undefined);
      if (ctx.hasUI) {
        ctx.ui.setStatus(STATUS_KEY, undefined);
        ctx.ui.setStatus(BG_STATUS_KEY, undefined);
      }
      updateExternalModeStatus(ctx);
    });

    pi.on("session_shutdown", async (_event, ctx) => {
      const sessionId = ctx.sessionManager.getSessionId();
      inAgentTurn = false;
      clearWakeTimer();
      pendingWakeBySession.delete(sessionId);
      if (activeSessionId === sessionId) {
        activeSessionId = undefined;
        activeUiCtx = undefined;
      }
      for (const controller of readinessControllers) controller.abort(new Error('Session shutting down'));
      const cleanup = await rootState.registry.shutdownSession(sessionId);
      if (ctx.hasUI) {
        ctx.ui.setStatus(BG_STATUS_KEY, undefined);
        ctx.ui.setStatus(EXTERNAL_MODE_STATUS_KEY, undefined);
      }
      if (cleanup.pending.length && ctx.hasUI) {
        const shown = cleanup.pending.slice(0, 10);
        ctx.ui.notify(`External run cleanup could not be confirmed for ${shown.join(", ")}${cleanup.pending.length > shown.length ? ` and ${cleanup.pending.length - shown.length} more` : ""}; their evidence is interrupted or uncertain.`, "warning");
      }
    });

    pi.on("before_agent_start", (event, ctx) => {
      if (!activeSessionId) rememberSessionContext(ctx);
      const modePrompt = EXTERNAL_MODE_PROMPTS[getExternalMode(ctx)];
      if (!modePrompt) return;
      if (!pi.getAllTools().some((tool) => tool.name === EXTERNAL_DELEGATE_TOOL)) return;
      return { systemPrompt: `${event.systemPrompt}\n\n${modePrompt}` };
    });
  };
}

export const createFlowExtension = createSubagentExtension;

export default createFlowExtension();
