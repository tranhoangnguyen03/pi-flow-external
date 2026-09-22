import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { extractSharedPiRoleProfiles, filterExternalAgentProfiles, getSubagentProfiles, mergeSynthesizedPiProfiles } from "./profiles.ts";
import { loadHarnessConfigs } from "./harnesses.ts";
import { projectExternalSettingsPath, resolveCtxCapabilitySets, resolveCtxDefaultHarness, type LoadedExternalSettings } from "./settings.ts";
import { EXTERNAL_HARNESSES as EXTERNAL_HARNESSES_LIST } from "./types.ts";
import { pruneRunRecords, runRecordsDirectory } from "./core/retention.ts";
import { createExternalRunsTool, type ExternalRunsParams } from "./external-runs.ts";
import { listSavedWorkflows } from "./workflow/registry.ts";

const COMMANDS = [
  { value: "doctor", description: "Check configured external harnesses" },
  { value: "settings", description: "Show effective extension settings" },
  { value: "profiles", description: "List configured external agent profiles" },
  { value: "profile create", description: "Create an external profile" },
  { value: "workflows", description: "List saved workflows" },
  { value: "runs", description: "Browse session runs and their complete paged output" },
  { value: "runs summary", description: "Summarize durable receipts" },
  { value: "runs --prune", description: "Prune eligible completed receipts" },
  { value: "help", description: "Show this reference" },
] as const;

const FIELD_REPORT_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "field-report.mjs");

type RuntimeSettings = { maxConcurrentSubagents: number; subagentTimeoutMs: number };
export type ExternalCommandOptions = {
  settings: LoadedExternalSettings;
  getRuntimeSettings: () => RuntimeSettings;
  getMaxRunRecords: () => number;
  startProfileInterview: (ctx: ExtensionCommandContext) => Promise<void>;
  externalRuns: ReturnType<typeof createExternalRunsTool>;
};

type CommandContextLike = { cwd: string; isProjectTrusted?: () => boolean };

function projectTrusted(ctx: ExtensionCommandContext): boolean {
  try {
    return ctx.isProjectTrusted();
  } catch {
    return false;
  }
}

function workflows(ctx: ExtensionCommandContext) {
  return listSavedWorkflows({ agentDir: getAgentDir(), cwd: ctx.cwd, projectTrusted: projectTrusted(ctx) });
}

function helpText(): string {
  return [
    "External harness commands:",
    "/external — show status",
    ...COMMANDS.map((command) => `/external ${command.value} — ${command.description}`),
  ].join("\n");
}

function formatHarnessesLine(harnessConfigs: ReadonlyMap<string, import("./harnesses.ts").HarnessConfig>): string {
  if (harnessConfigs.size === 0) return "Pi harnesses: none configured";
  const entries = [...harnessConfigs]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, config]) => `${name} (${config.model} · ${config.thinking === "off" ? "default thinking" : config.thinking})`);
  return `Pi harnesses: ${entries.join(", ")}`;
}

function formatCapabilitySetsLine(sets: ReadonlyMap<string, import("./settings.ts").PiCapabilitySet>): string {
  if (sets.size === 0) return "Pi capability sets: none configured";
  const entries = [...sets]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, set]) => `${name} (${set.skills.length} skill(s), ${set.promptTemplates.length} prompt template(s))`);
  return `Pi capability sets: ${entries.join(", ")}`;
}

function settingsText(options: ExternalCommandOptions, ctx: CommandContextLike): string {
  const effective = options.getRuntimeSettings();
  const settings = options.settings.settings;
  const harness = resolveCtxDefaultHarness(settings.defaultHarness, ctx);
  const harnessSource = harness.source === "project"
    ? ` (project: ${harness.projectPath})`
    : " (global)";
  const { harnesses: harnessConfigs, diagnostics: harnessDiagnostics } = loadHarnessConfigs(getAgentDir());
  const staleDefault = !(EXTERNAL_HARNESSES_LIST as readonly string[]).includes(harness.harness) && !harnessConfigs.has(harness.harness)
    ? [`Configured default harness "${harness.harness}" is not currently registered.`]
    : [];
  const capabilitySets = resolveCtxCapabilitySets(settings.piCapabilitySets, ctx);
  const warnings = [...options.settings.diagnostics, ...harness.diagnostics, ...harnessDiagnostics, ...staleDefault, ...capabilitySets.diagnostics];
  return [
    `maxConcurrentSubagents: ${effective.maxConcurrentSubagents}`,
    `subagentTimeoutMs: ${effective.subagentTimeoutMs}`,
    `defaultHarness: ${harness.harness}${harnessSource}`,
    `defaultPermission: ${settings.defaultPermission}`,
    `defaultMaxBudgetUsd: ${settings.defaultMaxBudgetUsd === null ? "unlimited" : settings.defaultMaxBudgetUsd}`,
    `maxRunRecords: ${settings.maxRunRecords}${settings.maxRunRecords === 0 ? " (keep forever)" : ""}`,
    formatHarnessesLine(harnessConfigs),
    formatCapabilitySetsLine(capabilitySets.sets),
    `Settings: ${options.settings.path}`,
    `Project override: ${projectExternalSettingsPath(ctx.cwd)} (trusted projects only; defaultHarness and piCapabilitySets only; a project set replaces the same-named global set)`,
    ...(warnings.length ? ["Warnings:", ...warnings.map((item) => `- ${item}`)] : []),
    "Edit the file, then run /reload. CLI flags override file values.",
  ].join("\n");
}

async function doctorText(pi: ExtensionAPI, options: ExternalCommandOptions, ctx: ExtensionCommandContext): Promise<string> {
  const { harnesses: harnessConfigs, diagnostics: harnessDiagnostics } = loadHarnessConfigs(getAgentDir());
  const allProfiles = getSubagentProfiles(getAgentDir());
  const profiles = filterExternalAgentProfiles(allProfiles, new Set(harnessConfigs.keys()));
  const { templates: sharedRoleTemplates, diagnostics: sharedRoleDiagnostics } = extractSharedPiRoleProfiles(allProfiles);
  const backends = [...new Set([...profiles.values()].map((profile) => profile.backend))].filter((backend) => backend !== "pi");
  const settingsErrors = [
    ...options.settings.diagnostics.filter((message) => !message.startsWith("Unknown setting")),
    ...harnessDiagnostics,
    ...sharedRoleDiagnostics,
  ];
  // Effective capability config: the same trust-aware global+project merge
  // settingsText already shows, plus a check that every profile/shared
  // template actually referencing a capabilitySet names one that exists in
  // that effective set — an unknown reference here would otherwise only
  // surface later, mid-delegation, as a per-call failure.
  const capabilitySets = resolveCtxCapabilitySets(options.settings.settings.piCapabilitySets, ctx);
  const capabilitySetRefs = new Map<string, string>();
  for (const profile of [...profiles.values(), ...sharedRoleTemplates.values()]) {
    if (profile.capabilitySet && !capabilitySetRefs.has(profile.capabilitySet)) {
      capabilitySetRefs.set(profile.capabilitySet, profile.name);
    }
  }
  const unknownCapabilitySetRefs = [...capabilitySetRefs].filter(([set]) => !capabilitySets.sets.has(set));
  // A profile kept in the roster with a malformed capabilitySet field (see
  // capabilitySetError on SubagentProfile) never silently vanishes back to
  // canonical/shared-template synthesis, but it also raises no error until
  // someone actually selects it — surface it here too, the same way a bad
  // shared-template filename or pinned model/thinking already is.
  const invalidCapabilitySetProfiles = [...profiles.values(), ...sharedRoleTemplates.values()]
    .filter((profile) => profile.capabilitySetError)
    .map((profile) => `"${profile.name}" has an invalid capabilitySet: ${profile.capabilitySetError}`);
  const capabilitySetIssues = [
    ...unknownCapabilitySetRefs.map(([set, profile]) => `"${set}" referenced by "${profile}" is not configured`),
    ...invalidCapabilitySetProfiles,
  ];
  const lines = [
    settingsErrors.length
      ? `✗ Settings: ${settingsErrors.join(" ")}`
      : options.settings.diagnostics.length
        ? `⚠ Settings: ${options.settings.diagnostics.join(" ")}`
        : "✓ Settings: valid",
    profiles.size ? `✓ Profiles: ${profiles.size} external` : "✗ Profiles: none configured",
    capabilitySetIssues.length
      ? `✗ Capability sets: ${capabilitySetIssues.join("; ")}`
      : capabilitySets.sets.size
        ? `✓ Capability sets: ${capabilitySets.sets.size} configured`
        : "Capability sets: none configured",
    ...(capabilitySets.diagnostics.length ? [`⚠ Capability sets: ${capabilitySets.diagnostics.join(" ")}`] : []),
  ];
  for (const backend of backends) {
    const result = await pi.exec(backend, ["--version"], { timeout: 10_000 });
    const version = (result.stdout || result.stderr).trim().split(/\r?\n/, 1)[0];
    lines.push(result.code === 0 && !result.killed
      ? `✓ ${backend}: ${version || "available"} (authentication unverified)`
      : `✗ ${backend}: unavailable`);
  }
  // Pi harnesses run in-process, not as a CLI: there is no subprocess to exec.
  // Confirm the registered model resolves and report configured auth instead.
  for (const [name, config] of harnessConfigs) {
    const separator = config.model.indexOf("/");
    const model = separator === -1 ? undefined : ctx.modelRegistry.find(config.model.slice(0, separator), config.model.slice(separator + 1));
    if (!model) {
      lines.push(`✗ ${name}: model "${config.model}" not found in the registry`);
      continue;
    }
    lines.push(ctx.modelRegistry.hasConfiguredAuth(model)
      ? `✓ ${name}: ${config.model} (auth configured)`
      : `⚠ ${name}: ${config.model} (no credentials configured)`);
  }
  return lines.join("\n");
}

function profilesText(): string {
  const { harnesses: harnessConfigs } = loadHarnessConfigs(getAgentDir());
  const allProfiles = getSubagentProfiles(getAgentDir());
  const profiles = mergeSynthesizedPiProfiles(
    filterExternalAgentProfiles(allProfiles, new Set(harnessConfigs.keys())),
    harnessConfigs,
    extractSharedPiRoleProfiles(allProfiles).templates,
  );
  if (!profiles.size) return "No external profiles. Run /external profile create.";
  return [...profiles.values()].map((profile) =>
    `${profile.name}: ${profile.harness ?? profile.backend} · ${profile.model ?? "default model"} · ${profile.thinking ?? "inherited thinking"}`,
  ).join("\n");
}

async function runsText(pi: ExtensionAPI): Promise<string> {
  const result = await pi.exec(process.execPath, [FIELD_REPORT_PATH, "--json"], { timeout: 10_000 });
  if (result.code !== 0 || result.killed) return `Could not read external receipts: ${result.stderr.trim() || "field report failed"}`;
  try {
    const report = JSON.parse(result.stdout) as {
      runs?: number;
      byStatus?: Record<string, number>;
      incompleteRecords?: number;
      recentFailures?: unknown[];
    };
    return [
      `Runs: ${report.runs ?? 0}`,
      `Status: ${Object.entries(report.byStatus ?? {}).map(([key, value]) => `${key}=${value}`).join(", ") || "none"}`,
      `Incomplete records: ${report.incompleteRecords ?? 0}`,
      `Recent failures: ${report.recentFailures?.length ?? 0}`,
    ].join("\n");
  } catch {
    return "Could not read external receipts: field report returned invalid JSON.";
  }
}

type JsonObject = Record<string, unknown>;
type ExternalRunsResult = { content: Array<{ type: string; text?: string }>; details: JsonObject };

function object(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function pageText(value: ExternalRunsResult): string {
  return value.content.flatMap((item) => item.type === "text" && typeof item.text === "string" ? [item.text] : []).join("\n");
}

async function runAction(options: ExternalCommandOptions, params: ExternalRunsParams, ctx: ExtensionCommandContext): Promise<ExternalRunsResult> {
  return await options.externalRuns.execute("external-command", params, undefined, undefined, ctx) as ExternalRunsResult;
}

async function readSummary(options: ExternalCommandOptions, runId: string, ctx: ExtensionCommandContext): Promise<JsonObject> {
  let text = "";
  let cursor: string | undefined;
  const seen = new Set<string>();
  do {
    const page = await runAction(options, { action: "inspect", runId, view: "summary", ...(cursor ? { cursor } : {}) }, ctx);
    text += pageText(page);
    cursor = typeof page.details.nextCursor === "string" ? page.details.nextCursor : undefined;
    if (cursor && seen.has(cursor)) throw new Error("Run inspection returned a repeated cursor");
    if (cursor) seen.add(cursor);
  } while (cursor);
  return object(JSON.parse(text));
}

async function showPages(options: ExternalCommandOptions, runId: string, view: "output" | "diagnostics" | "final", ctx: ExtensionCommandContext): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await runAction(options, { action: "inspect", runId, view, ...(cursor ? { cursor } : {}) }, ctx);
    // The tool's `final` projection is deliberately a clean, narration-free
    // canonical-answer surface: unavailable is a bounded EMPTY page with
    // finalAvailable:false (true for both an agent run and a workflow — see
    // src/external-runs.ts), not a synthesized sentence in the response
    // text. Turning that into a human-readable notice belongs here, at the
    // UI boundary, for both run kinds alike — otherwise this would open an
    // editor with nothing informative in it.
    if (view === "final" && page.details.finalAvailable !== true) {
      ctx.ui.notify(`No verified final answer is available yet for ${runId}.`, "info");
      return;
    }
    await ctx.ui.editor(`${view} ${runId}`, pageText(page));
    const next = typeof page.details.nextCursor === "string" ? page.details.nextCursor : undefined;
    if (!next || await ctx.ui.select(`${view} ${runId}`, ["Next page", "Back"]) !== "Next page") return;
    cursor = next;
  } while (cursor);
}

/** ~s/m/h duration label for a millisecond value, or undefined when absent/invalid. Human-readable only — never a second timing source. */
function formatDurationMs(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  if (value < 1_000) return `${Math.round(value)}ms`;
  const seconds = value / 1_000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${minutes.toFixed(1)}m`;
  return `${(minutes / 60).toFixed(1)}h`;
}

/** One-line, human-readable timing/output-availability header shown above the raw summary JSON, so a user does not need to interpret raw timestamps to tell whether a verified final answer exists yet. */
function formatSummaryHeader(summary: JsonObject): string {
  const state = object(summary.state);
  const status = String(state.status ?? summary.status ?? "unknown");
  const timing = object(summary.timing ?? state.timing);
  const output = object(summary.output);
  const finalAvailable = output.finalAvailable === true || summary.finalAvailable === true;
  const outputAvailable = output.available === true || summary.outputAvailable === true;
  const parts = [
    `status: ${status}`,
    typeof timing.queueDelayMs === "number" ? `queue delay ${formatDurationMs(timing.queueDelayMs)}` : undefined,
    typeof timing.elapsedMs === "number" ? `elapsed ${formatDurationMs(timing.elapsedMs)}` : undefined,
    typeof timing.activityAgeMs === "number" ? `last activity ${formatDurationMs(timing.activityAgeMs)} ago` : undefined,
    finalAvailable ? "final answer available" : outputAvailable ? "output available (no verified final answer yet)" : "no output yet",
  ].filter((part): part is string => Boolean(part));
  return parts.join(" · ");
}

async function navigateRun(options: ExternalCommandOptions, runId: string, ctx: ExtensionCommandContext): Promise<void> {
  const summary = await readSummary(options, runId, ctx);
  const children = Array.isArray(summary.children) ? summary.children.map(object).filter((child) => typeof child.runId === "string") : [];
  const state = object(summary.state);
  const childChoices = children.map((child) => `Child ${String(child.runId)}${child.label ? ` · ${String(child.label)}` : ""}`);
  const actions = ["Summary", "Output", "Final", "Diagnostics", ...childChoices, ...(state.status === "running" || state.status === "queued" ? ["Cancel run"] : []), "Back"];
  while (true) {
    const choice = await ctx.ui.select(`Run ${runId}`, actions);
    if (!choice || choice === "Back") return;
    if (choice === "Summary") await ctx.ui.editor(`summary ${runId}`, `${formatSummaryHeader(summary)}\n\n${JSON.stringify(summary, null, 2)}`);
    else if (choice === "Output" || choice === "Final" || choice === "Diagnostics") await showPages(options, runId, choice.toLowerCase() as "output" | "final" | "diagnostics", ctx);
    else if (choice === "Cancel run") {
      if (await ctx.ui.confirm("Cancel external run?", `${runId}\n\nStopping execution does not roll back side effects.`)) {
        const result = await runAction(options, { action: "cancel", runId, reason: "cancelled from /external runs" }, ctx);
        ctx.ui.notify(pageText(result), "info");
      }
      return;
    } else {
      const child = children[childChoices.indexOf(choice)];
      if (child) await navigateRun(options, String(child.runId), ctx);
    }
  }
}

/** One list-row label: kind, ID, short description, status, queue/elapsed duration, live activity age, and output/final availability — best-effort per field, since live (listedAgent/liveSummary), historical (historicalAgent/journalSummary), and workflow shapes each carry a different subset. */
function formatRunRow(kind: "Run" | "Workflow", item: JsonObject): string {
  const state = object(item.state);
  const status = String(state.status ?? item.status ?? "unknown");
  const task = object(item.task);
  const description = typeof item.description === "string" && item.description
    ? item.description
    : typeof task.description === "string" && task.description
      ? task.description
      : typeof task.name === "string" && task.name
        ? task.name
        : undefined;
  const timing = object(item.timing);
  // A still-queued row has no queueDelayMs yet (it only exists once execution
  // starts), so without this a genuinely queued row would show no duration at
  // all. Compute a live "how long has it been queued" age directly from the
  // existing queuedAt timestamp at render time — no new timer, no new
  // evidence field — and only for an entry the registry itself confirms is
  // still live (`item.live === true`, set by listedAgent/historicalAgent):
  // an orphaned durable row with a stale "queued"-looking status but no live
  // registry entry must never get a fabricated, ever-growing age.
  const queuedAtMs = typeof timing.queuedAt === "string" ? Date.parse(timing.queuedAt) : NaN;
  const queueAgeMs = item.live === true && status === "queued" && Number.isFinite(queuedAtMs)
    ? Math.max(0, Date.now() - queuedAtMs)
    : undefined;
  const timingLabel = typeof timing.elapsedMs === "number"
    ? `elapsed ${formatDurationMs(timing.elapsedMs)}`
    : queueAgeMs !== undefined
      ? `queued ${formatDurationMs(queueAgeMs)}`
      : typeof timing.queueDelayMs === "number"
        ? `queued ${formatDurationMs(timing.queueDelayMs)}`
        : undefined;
  const activityAge = typeof timing.activityAgeMs === "number" ? `active ${formatDurationMs(timing.activityAgeMs)} ago` : undefined;
  const output = object(item.output);
  const outputAvailable = item.outputAvailable === true || output.available === true;
  const finalAvailable = item.finalAvailable === true || output.finalAvailable === true;
  const outputLabel = finalAvailable ? "final ready" : outputAvailable ? "output available" : undefined;
  return [`${kind} ${String(item.runId)}`, description, status, timingLabel, activityAge, outputLabel]
    .filter((part): part is string => Boolean(part))
    .join(" · ");
}

async function navigateRuns(options: ExternalCommandOptions, ctx: ExtensionCommandContext): Promise<void> {
  let cursor: string | undefined;
  let workflowCursor: string | undefined;
  let pageKind: "all" | "runs" | "workflows" = "all";
  let nextRunCursor: string | undefined;
  let nextWorkflowCursor: string | undefined;
  while (true) {
    const page = await runAction(options, {
      action: "list",
      limit: 50,
      ...(pageKind === "runs" && cursor ? { cursor } : {}),
      ...(pageKind === "workflows" && workflowCursor ? { workflowCursor } : {}),
    }, ctx);
    const details = object(page.details);
    const entries = [
      ...(pageKind !== "runs" && Array.isArray(details.workflows) ? details.workflows.map((item: unknown) => ({ kind: "Workflow" as const, item: object(item) })) : []),
      ...(pageKind !== "workflows" && Array.isArray(details.runs) ? details.runs.map((item: unknown) => ({ kind: "Run" as const, item: object(item) })) : []),
    ].filter(({ item }) => typeof item.runId === "string");
    const choices = entries.map(({ kind, item }) => formatRunRow(kind, item));
    if (pageKind !== "workflows") nextRunCursor = typeof details.nextCursor === "string" ? details.nextCursor : undefined;
    if (pageKind !== "runs") nextWorkflowCursor = typeof details.nextWorkflowCursor === "string" ? details.nextWorkflowCursor : undefined;
    if (nextWorkflowCursor) choices.push("Next workflow page");
    if (nextRunCursor) choices.push("Next run page");
    if (!choices.length) {
      ctx.ui.notify("No external runs are available in this session and project.", "info");
      return;
    }
    // Manual only: never polls, waits, or changes execution. Re-reads from the
    // current page's start and resets stale list cursors, without navigating
    // into and back out of a run.
    choices.push("Refresh", "Back");
    const choice = await ctx.ui.select("External runs", choices);
    if (!choice || choice === "Back") return;
    if (choice === "Refresh") {
      cursor = undefined;
      workflowCursor = undefined;
      pageKind = "all";
      continue;
    }
    if (choice === "Next workflow page") {
      workflowCursor = nextWorkflowCursor;
      pageKind = "workflows";
      continue;
    }
    if (choice === "Next run page") {
      cursor = nextRunCursor;
      pageKind = "runs";
      continue;
    }
    const selected = entries[choices.indexOf(choice)];
    if (selected) await navigateRun(options, String(selected.item.runId), ctx);
  }
}

export function registerExternalCommand(pi: ExtensionAPI, options: ExternalCommandOptions): void {
  pi.registerCommand("external", {
    description: "Inspect and configure external Claude, Codex, and Agy harnesses",
    getArgumentCompletions: (prefix) => {
      const normalized = prefix.trim().toLowerCase();
      const matches = COMMANDS.filter((command) => command.value.startsWith(normalized));
      return matches.length ? matches.map((command) => ({ ...command, label: command.value })) : null;
    },
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase();
      if (!action) {
        const profiles = filterExternalAgentProfiles(getSubagentProfiles(getAgentDir()), new Set(loadHarnessConfigs(getAgentDir()).harnesses.keys()));
        ctx.ui.notify(`${profiles.size} external profile(s) · ${workflows(ctx).length} saved workflow(s)\n${settingsText(options, ctx)}`, "info");
      } else if (action === "doctor") {
        ctx.ui.notify(await doctorText(pi, options, ctx), "info");
      } else if (action === "settings") {
        const warnings = options.settings.diagnostics.length || resolveCtxDefaultHarness(options.settings.settings.defaultHarness, ctx).diagnostics.length;
        ctx.ui.notify(settingsText(options, ctx), warnings ? "warning" : "info");
      } else if (action === "profiles") {
        ctx.ui.notify(profilesText(), "info");
      } else if (action === "profile create") {
        await options.startProfileInterview(ctx);
      } else if (action === "workflows") {
        const saved = workflows(ctx);
        ctx.ui.notify(saved.length ? saved.map((workflow) => `${workflow.name}: ${workflow.description}`).join("\n") : "No saved workflows.", "info");
      } else if (action === "runs" && ctx.hasUI) {
        try {
          await navigateRuns(options, ctx);
        } catch (error) {
          ctx.ui.notify(`Could not inspect external runs: ${error instanceof Error ? error.message : String(error)}`, "error");
        }
      } else if (action === "runs" || action === "runs summary" || action === "runs --prune") {
        let pruneLine = "";
        if (action === "runs --prune") {
          const { pruned, kept } = await pruneRunRecords(runRecordsDirectory(), options.getMaxRunRecords());
          pruneLine = `\nPruned: ${pruned.length} record(s) · kept: ${kept} completed`;
        }
        ctx.ui.notify(`${await runsText(pi)}${pruneLine}`, "info");
      } else if (action === "help") {
        ctx.ui.notify(helpText(), "info");
      } else {
        ctx.ui.notify("Usage: /external [doctor|settings|profiles|profile create|workflows|runs|runs summary|runs --prune|help]", "warning");
      }
    },
  });
}
