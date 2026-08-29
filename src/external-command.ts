import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { filterExternalAgentProfiles, getSubagentProfiles } from "./profiles.ts";
import type { LoadedExternalSettings } from "./settings.ts";
import { pruneRunRecords, runRecordsDirectory } from "./core/retention.ts";
import { listSavedWorkflows } from "./workflow/registry.ts";

const COMMANDS = [
  { value: "doctor", description: "Check configured external harnesses" },
  { value: "settings", description: "Show effective extension settings" },
  { value: "profiles", description: "List external agent profiles" },
  { value: "profile create", description: "Create an external profile" },
  { value: "workflows", description: "List saved workflows" },
  { value: "runs", description: "Summarize recent external receipts" },
  { value: "help", description: "Show this reference" },
] as const;

const FIELD_REPORT_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "field-report.mjs");

type RuntimeSettings = { maxConcurrentSubagents: number; subagentTimeoutMs: number };
export type ExternalCommandOptions = {
  settings: LoadedExternalSettings;
  getRuntimeSettings: () => RuntimeSettings;
  getMaxRunRecords: () => number;
  startProfileInterview: (ctx: ExtensionCommandContext) => Promise<void>;
};

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

function settingsText(options: ExternalCommandOptions): string {
  const effective = options.getRuntimeSettings();
  const settings = options.settings.settings;
  return [
    `maxConcurrentSubagents: ${effective.maxConcurrentSubagents}`,
    `subagentTimeoutMs: ${effective.subagentTimeoutMs}`,
    `defaultPermission: ${settings.defaultPermission}`,
    `defaultMaxBudgetUsd: ${settings.defaultMaxBudgetUsd === null ? "unlimited" : settings.defaultMaxBudgetUsd}`,
    `maxRunRecords: ${settings.maxRunRecords}${settings.maxRunRecords === 0 ? " (keep forever)" : ""}`,
    `Settings: ${options.settings.path}`,
    ...(options.settings.diagnostics.length ? ["Warnings:", ...options.settings.diagnostics.map((item) => `- ${item}`)] : []),
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
        ctx.ui.notify(`${profiles.size} external profile(s) · ${workflows(ctx).length} saved workflow(s)\n${settingsText(options)}`, "info");
      } else if (action === "doctor") {
        ctx.ui.notify(await doctorText(pi, options), "info");
      } else if (action === "settings") {
        ctx.ui.notify(settingsText(options), options.settings.diagnostics.length ? "warning" : "info");
      } else if (action === "profiles") {
        ctx.ui.notify(profilesText(), "info");
      } else if (action === "profile create") {
        await options.startProfileInterview(ctx);
      } else if (action === "workflows") {
        const saved = workflows(ctx);
        ctx.ui.notify(saved.length ? saved.map((workflow) => `${workflow.name}: ${workflow.description}`).join("\n") : "No saved workflows.", "info");
      } else if (action === "runs" || action === "runs --prune") {
        let pruneLine = "";
        if (action === "runs --prune") {
          const { pruned, kept } = await pruneRunRecords(runRecordsDirectory(), options.getMaxRunRecords());
          pruneLine = `\nPruned: ${pruned.length} record(s) · kept: ${kept} completed`;
        }
        ctx.ui.notify(`${await runsText(pi)}${pruneLine}`, "info");
      } else if (action === "help") {
        ctx.ui.notify(helpText(), "info");
      } else {
        ctx.ui.notify("Usage: /external [doctor|settings|profiles|profile create|workflows|runs|runs --prune|help]", "warning");
      }
    },
  });
}
