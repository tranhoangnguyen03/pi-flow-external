import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { filterExternalAgentProfiles, getSubagentProfiles } from "./profiles.ts";
import { archiveProfiles, findRetiredDefaultProfiles } from "./defaults.ts";
import { projectExternalSettingsPath, resolveCtxDefaultHarness, type LoadedExternalSettings } from "./settings.ts";
import { pruneRunRecords, runRecordsDirectory } from "./core/retention.ts";
import { createExternalRunsTool, type ExternalRunsParams } from "./external-runs.ts";
import { listSavedWorkflows } from "./workflow/registry.ts";

const COMMANDS = [
  { value: "doctor", description: "Check configured external harnesses" },
  { value: "settings", description: "Show effective extension settings" },
  { value: "profiles", description: "List configured external agent profiles" },
  { value: "profile create", description: "Create an external profile" },
  { value: "profile clean-up", description: "Archive retired pi-flow default profiles" },
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

function settingsText(options: ExternalCommandOptions, ctx: CommandContextLike): string {
  const effective = options.getRuntimeSettings();
  const settings = options.settings.settings;
  const harness = resolveCtxDefaultHarness(settings.defaultHarness, ctx);
  const harnessSource = harness.source === "project"
    ? ` (project: ${harness.projectPath})`
    : " (global)";
  const warnings = [...options.settings.diagnostics, ...harness.diagnostics];
  return [
    `maxConcurrentSubagents: ${effective.maxConcurrentSubagents}`,
    `subagentTimeoutMs: ${effective.subagentTimeoutMs}`,
    `defaultHarness: ${harness.harness}${harnessSource}`,
    `defaultPermission: ${settings.defaultPermission}`,
    `defaultMaxBudgetUsd: ${settings.defaultMaxBudgetUsd === null ? "unlimited" : settings.defaultMaxBudgetUsd}`,
    `maxRunRecords: ${settings.maxRunRecords}${settings.maxRunRecords === 0 ? " (keep forever)" : ""}`,
    `Settings: ${options.settings.path}`,
    `Project override: ${projectExternalSettingsPath(ctx.cwd)} (trusted projects only; defaultHarness only)`,
    ...(warnings.length ? ["Warnings:", ...warnings.map((item) => `- ${item}`)] : []),
    "Edit the file, then run /reload. CLI flags override file values.",
  ].join("\n");
}

async function doctorText(pi: ExtensionAPI, options: ExternalCommandOptions): Promise<string> {
  const profiles = filterExternalAgentProfiles(getSubagentProfiles(getAgentDir()));
  const backends = [...new Set([...profiles.values()].map((profile) => profile.backend))];
  const settingsErrors = options.settings.diagnostics.filter((message) => !message.startsWith("Unknown setting"));
  const lines = [
    settingsErrors.length
      ? `✗ Settings: ${settingsErrors.join(" ")}`
      : options.settings.diagnostics.length
        ? `⚠ Settings: ${options.settings.diagnostics.join(" ")}`
        : "✓ Settings: valid",
    profiles.size ? `✓ Profiles: ${profiles.size} external` : "✗ Profiles: none configured",
  ];
  for (const backend of backends) {
    const result = await pi.exec(backend, ["--version"], { timeout: 10_000 });
    const version = (result.stdout || result.stderr).trim().split(/\r?\n/, 1)[0];
    lines.push(result.code === 0 && !result.killed
      ? `✓ ${backend}: ${version || "available"} (authentication unverified)`
      : `✗ ${backend}: unavailable`);
  }
  return lines.join("\n");
}

function profilesText(): string {
  const profiles = filterExternalAgentProfiles(getSubagentProfiles(getAgentDir()));
  if (!profiles.size) return "No external profiles. Run /external profile create.";
  return [...profiles.values()].map((profile) =>
    `${profile.name}: ${profile.backend} · ${profile.model ?? "default model"} · ${profile.thinking ?? "inherited thinking"}`,
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

async function showPages(options: ExternalCommandOptions, runId: string, view: "output" | "diagnostics", ctx: ExtensionCommandContext): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await runAction(options, { action: "inspect", runId, view, ...(cursor ? { cursor } : {}) }, ctx);
    await ctx.ui.editor(`${view} ${runId}`, pageText(page));
    const next = typeof page.details.nextCursor === "string" ? page.details.nextCursor : undefined;
    if (!next || await ctx.ui.select(`${view} ${runId}`, ["Next page", "Back"]) !== "Next page") return;
    cursor = next;
  } while (cursor);
}

async function navigateRun(options: ExternalCommandOptions, runId: string, ctx: ExtensionCommandContext): Promise<void> {
  const summary = await readSummary(options, runId, ctx);
  const children = Array.isArray(summary.children) ? summary.children.map(object).filter((child) => typeof child.runId === "string") : [];
  const state = object(summary.state);
  const childChoices = children.map((child) => `Child ${String(child.runId)}${child.label ? ` · ${String(child.label)}` : ""}`);
  const actions = ["Summary", "Output", "Diagnostics", ...childChoices, ...(state.status === "running" || state.status === "queued" ? ["Cancel run"] : []), "Back"];
  while (true) {
    const choice = await ctx.ui.select(`Run ${runId}`, actions);
    if (!choice || choice === "Back") return;
    if (choice === "Summary") await ctx.ui.editor(`summary ${runId}`, JSON.stringify(summary, null, 2));
    else if (choice === "Output" || choice === "Diagnostics") await showPages(options, runId, choice.toLowerCase() as "output" | "diagnostics", ctx);
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
      ...(pageKind !== "runs" && Array.isArray(details.workflows) ? details.workflows.map((item: unknown) => ({ kind: "Workflow", item: object(item) })) : []),
      ...(pageKind !== "workflows" && Array.isArray(details.runs) ? details.runs.map((item: unknown) => ({ kind: "Run", item: object(item) })) : []),
    ].filter(({ item }) => typeof item.runId === "string");
    const choices = entries.map(({ kind, item }) => `${kind} ${String(item.runId)} · ${String(object(item.state).status ?? item.status ?? "unknown")}`);
    if (pageKind !== "workflows") nextRunCursor = typeof details.nextCursor === "string" ? details.nextCursor : undefined;
    if (pageKind !== "runs") nextWorkflowCursor = typeof details.nextWorkflowCursor === "string" ? details.nextWorkflowCursor : undefined;
    if (nextWorkflowCursor) choices.push("Next workflow page");
    if (nextRunCursor) choices.push("Next run page");
    if (!choices.length) {
      ctx.ui.notify("No external runs are available in this session and project.", "info");
      return;
    }
    choices.push("Back");
    const choice = await ctx.ui.select("External runs", choices);
    if (!choice || choice === "Back") return;
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
        const profiles = filterExternalAgentProfiles(getSubagentProfiles(getAgentDir()));
        ctx.ui.notify(`${profiles.size} external profile(s) · ${workflows(ctx).length} saved workflow(s)\n${settingsText(options, ctx)}`, "info");
      } else if (action === "doctor") {
        ctx.ui.notify(await doctorText(pi, options), "info");
      } else if (action === "settings") {
        const warnings = options.settings.diagnostics.length || resolveCtxDefaultHarness(options.settings.settings.defaultHarness, ctx).diagnostics.length;
        ctx.ui.notify(settingsText(options, ctx), warnings ? "warning" : "info");
      } else if (action === "profiles") {
        ctx.ui.notify(profilesText(), "info");
      } else if (action === "profile create") {
        await options.startProfileInterview(ctx);
      } else if (action === "profile clean-up") {
        const retired = findRetiredDefaultProfiles(getAgentDir());
        if (!retired.length) {
          ctx.ui.notify("No retired pi-flow default profiles found. Clean-up only archives defaults this extension shipped and later retired (e.g. the debugger role); native Pi profiles and your own profiles are never touched.", "info");
          return;
        }
        const listing = retired.map((profile) => `${profile.name} (${profile.backend})`).join("\n");
        if (!ctx.hasUI) {
          ctx.ui.notify(`Retired pi-flow default profiles found (nothing changed; rerun interactively to archive):\n${listing}`, "info");
          return;
        }
        const confirmed = await ctx.ui.confirm(
          "Archive retired pi-flow default profiles?",
          `${listing}\n\nThese were shipped by pi-flow and later retired. Moved to subagents/archive/ — never deleted, and existing archive files are never overwritten. Native Pi profiles and profiles you created yourself are never touched.`,
          {},
        );
        if (!confirmed) {
          ctx.ui.notify("Clean-up cancelled. No profiles were changed.", "info");
          return;
        }
        const { archived, skipped } = archiveProfiles(getAgentDir(), retired.map((profile) => profile.name));
        const skippedLine = skipped.length ? ` · skipped: ${skipped.join(", ")}` : "";
        ctx.ui.notify(`${archived.length ? `Archived: ${archived.join(", ")}` : "Nothing archived"}${skippedLine}`, "info");
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
        ctx.ui.notify("Usage: /external [doctor|settings|profiles|profile create|profile clean-up|workflows|runs|runs summary|runs --prune|help]", "warning");
      }
    },
  });
}
