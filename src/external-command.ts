import { openConfigHub } from './config-hub.ts';
import { planV5Upgrade, applyV5Upgrade } from './config-v5-upgrade.ts';
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { disabledHarnessMessage, loadExternalCatalog } from "./profiles.ts";
import { loadHarnessConfigs } from "./harnesses.ts";
import { loadExternalSettings, saveExternalSettings, type ExternalSettings } from "./settings.ts";
import { projectExternalSettingsPath, resolveCtxDefaultHarness, type LoadedExternalSettings } from "./settings.ts";
import { bindingKey } from "./catalog-v5.ts";
import { cliHarness } from "./config-v5.ts";
import { roleDefinition } from "./default-roles.ts";
import {
  LifecycleError,
  applyHarnessDelete,
  applyHarnessReset,
  applyRoleDelete,
  applyRoleReset,
  compileInstructionMarkdown,
  createPiHarness,
  createRole,
  harnessDisabled,
  overrideFile,
  planHarnessDelete,
  planHarnessReset,
  planRoleDelete,
  planRoleReset,
  readInstructionText,
  readV5Settings,
  registeredHarnesses,
  remainingGates,
  replaceHarnessEntry,
  resetHarnessFields,
  roleFile,
  roleInventory,
  setBindingFields,
  setDefaultHarness,
  setHarnessEnabled,
  setHarnessFields,
  setRoleEnabled,
  writeInstructions,
  type BindingField,
  type HarnessField,
} from "./config-lifecycle.ts";
import {
  applyConfigUpgrade,
  planConfigUpgrade,
  planLegacyPurge,
  purgeLegacyFiles,
  type LegacyPurgeCandidate,
} from "./config-upgrade.ts";
import { EXTERNAL_HARNESSES as EXTERNAL_HARNESSES_LIST } from "./types.ts";
import type { SubagentProfile } from "./types.ts";
import { pruneRunRecords, runRecordsDirectory } from "./core/retention.ts";
import { createExternalRunsTool, type ExternalRunsParams } from "./external-runs.ts";
import { formatDurationMs, formatRunRow } from "./core/run-render.ts";
import { listSavedWorkflows } from "./workflow/registry.ts";
import { diagnoseCli, usageLimitHistory } from "./doctor.ts";

const COMMANDS = [
  { value: "doctor", description: "Validate config/catalog and report runtime readiness" },
  { value: "config", description: "Open guided settings (text without UI)" },
  { value: "config text", description: "Show configuration details as text in any mode" },
  { value: "config edit", description: "Edit and validate settings, including named Pi harnesses, with the standard editor" },
  { value: "config convert", description: "Preview and confirm conversion to v5 (pre-v4 installs convert in two steps)" },
  { value: "config harness list", description: "List harnesses with model, effort, enabled, and default state" },
  { value: "config harness inspect", description: "Show one harness's effective defaults, exceptions, and gates" },
  { value: "config harness create", description: "Register a named Pi harness: create pi-NAME --model provider/model" },
  { value: "config harness edit", description: "Edit one harness entry in the editor" },
  { value: "config harness enable", description: "Enable a harness" },
  { value: "config harness disable", description: "Disable a harness without deleting it" },
  { value: "config harness set", description: "Set harness defaults: --model, --effort, --preset" },
  { value: "config harness reset", description: "Reset selected harness fields, or all after confirmation" },
  { value: "config harness delete", description: "Delete a named Pi harness after an impact preview" },
  { value: "config harness default", description: "Set the global default harness" },
  { value: "config harness test", description: "Explicit readiness check for one harness" },
  { value: "config harness assist", description: "Assisted Pi harness interview with a smoke test" },
  { value: "config role list", description: "List roles with source, enabled state, and harness exceptions" },
  { value: "config role inspect", description: "Show a role, or one binding with --harness" },
  { value: "config role create", description: "Author a role in the editor (no model needed)" },
  { value: "config role edit", description: "Edit shared instructions, or one harness's with --harness" },
  { value: "config role enable", description: "Enable a role, or one binding with --harness" },
  { value: "config role disable", description: "Disable a role, or one binding with --harness" },
  { value: "config role set", description: "Set binding values: --harness NAME --model/--effort/--budget/--tools" },
  { value: "config role reset", description: "Reset selected fields or instructions, or all after confirmation" },
  { value: "config role delete", description: "Delete a custom role after an impact preview" },
  { value: "config role assist", description: "Assisted role-authoring interview" },
  { value: "[danger]purge-old-files", description: "Delete obsolete extension files (explicit maintenance)" },
  { value: "workflows", description: "List saved workflows" },
  { value: "runs", description: "Browse session runs and their complete paged output" },
  { value: "runs summary", description: "Summarize durable receipts" },
  { value: "runs --prune", description: "Prune eligible completed receipts" },
  { value: "help", description: "Show this reference" },
] as const;

const FIELD_REPORT_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "field-report.mjs");

/** Canonical catalog snapshot composed by loadExternalCatalog
 * (one composition for Agent, workflows, help, roles, and doctor). Optional
 * injection via options.getCatalog takes precedence so tests can supply a
 * snapshot without touching the filesystem. */
export type ExternalCatalog = ReturnType<typeof loadExternalCatalog>;

type RuntimeSettings = { maxConcurrentSubagents: number; subagentTimeoutMs: number };
export type ExternalCommandOptions = {
  settings: LoadedExternalSettings;
  getRuntimeSettings: () => RuntimeSettings;
  getMaxRunRecords: () => number;
  startRoleInterview: (ctx: ExtensionCommandContext) => Promise<void>;
  startHarnessInterview: (ctx: ExtensionCommandContext) => Promise<void>;
  externalRuns: ReturnType<typeof createExternalRunsTool>;
  /** Canonical catalog override for isolated command tests. */
  getCatalog?: (agentDir: string) => ExternalCatalog;
  /** Explicit readonly smoke test for a named Pi harness. Without it, `config harness test` reports registry/auth state only and says no model was tested. */
  testHarness?: (ctx: ExtensionCommandContext, harness: string, signal?: AbortSignal) => Promise<{ ok: true; detail?: string } | { ok: false; error: string }>;
  getThinkingLevel?: () => string | undefined;
  /** Validated writer override for isolated command tests. */
  saveSettings?: (agentDir: string, record: unknown, options?: { repair?: boolean }) => string;
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

/** Removed routes and their replacements. Shown in help only; the old spellings are not aliases. */
const MOVED_COMMANDS = [
  ["config harnesses", "config harness list"],
  ["config enable|disable|default <harness>", "config harness enable|disable|default <harness>"],
  ["config harness create (interview)", "config harness create pi-NAME --model provider/model, or config harness assist"],
  ["roles", "config role list"],
  ["role create", "config role create NAME, or config role assist"],
  ["role inspect <role> [harness]", "config role inspect <role> [--harness NAME]"],
  ["role override <role> <harness>", "config role edit <role> --harness NAME"],
] as const;

function helpText(): string {
  return [
    "External harness commands:",
    "/external — open guided settings (overview without UI)",
    ...COMMANDS.map((command) => `/external ${command.value} — ${command.description}`),
    "Replaced commands (old spellings no longer run):",
    ...MOVED_COMMANDS.map(([old, current]) => `/external ${old} → /external ${current}`),
  ].join("\n");
}

function usageText(): string {
  return `Usage: ${COMMANDS.map((command) => `/external ${command.value}`).join(" | ")}\nSee /external help for replaced commands.`;
}

export function loadCatalogSnapshot(agentDir: string, options?: Pick<ExternalCommandOptions, "getCatalog">): ExternalCatalog {
  if (options?.getCatalog) {
    return options.getCatalog(agentDir);
  }
  return loadExternalCatalog(agentDir);
}

function completionRoleNames(): string[] {
  try {
    const agentDir = getAgentDir();
    return [...roleInventory(agentDir, loadExternalSettings(agentDir).settings).keys()].sort();
  } catch {
    return [];
  }
}

function knownHarnessNames(agentDir: string): string[] {
  const { harnesses } = loadHarnessConfigs(agentDir);
  return [...EXTERNAL_HARNESSES_LIST as readonly string[], ...harnesses.keys()];
}

function groupByRole(profiles: ReadonlyMap<string, SubagentProfile>, harnessNames: readonly string[]): Set<string> {
  const roles = new Set<string>();
  for (const profile of profiles.values()) {
    if (profile.role) { roles.add(profile.role); continue; }
    const harness = [profile.harness, profile.backend, ...harnessNames].find((name) => name && profile.name.startsWith(`${name}-`));
    roles.add(harness ? profile.name.slice(harness.length + 1) : profile.name);
  }
  return roles;
}

function disabledHarnessSet(catalog: ExternalCatalog): ReadonlySet<string> {
  return catalog.disabledHarnesses ?? new Set();
}

/** One row per known harness plus preserved unknown disabled names. */
function harnessStateLines(catalog: ExternalCatalog, defaultHarness: string, settings: ExternalSettings): string[] {
  const disabled = disabledHarnessSet(catalog);
  const harnessConfigs = catalog.harnessConfigs ?? new Map();
  const row = (name: string, kind: string) => `- ${name} · ${kind} · ${disabled.has(name) ? "disabled" : "enabled"}${name === defaultHarness ? " · default" : ""}`;
  const named = [...harnessConfigs].sort(([a], [b]) => a.localeCompare(b))
    .map(([name, config]) => row(name, `Pi (${config.model} · ${settings.harnessSettings?.[name]?.thinking ?? config.thinking} · ${config.preset ?? "minimal"})`));
  const known = new Set<string>([...EXTERNAL_HARNESSES_LIST, ...harnessConfigs.keys()]);
  const unknown = [...disabled].filter((name) => !known.has(name)).sort()
    .map((name) => `- ${name} · unknown · disabled (kept; not a known harness)`);
  return [
    ...(EXTERNAL_HARNESSES_LIST as readonly string[]).map((name) => row(name, "CLI")),
    ...(named.length ? named : ["- no named Pi harnesses (/external config harness create pi-NAME --model provider/model)"]),
    ...unknown,
  ];
}

function defaultHarnessProblems(catalog: ExternalCatalog, harness: string): string[] {
  const harnessConfigs = catalog.harnessConfigs ?? new Map();
  if (!(EXTERNAL_HARNESSES_LIST as readonly string[]).includes(harness) && !harnessConfigs.has(harness)) {
    return [`Configured default harness "${harness}" is not currently registered.`];
  }
  return disabledHarnessSet(catalog).has(harness) ? [disabledHarnessMessage(harness, true)] : [];
}

function catalogProblems(catalog: ExternalCatalog): string[] {
  return catalog.blocked
    ? [`Configuration is blocked: ${catalog.diagnostics.join(" ") || "the external catalog could not be composed."}`]
    : [...catalog.diagnostics];
}

function configText(options: ExternalCommandOptions, ctx: CommandContextLike): { text: string; warn: boolean } {
  const effective = options.getRuntimeSettings();
  const settings = options.settings.settings;
  const harness = resolveCtxDefaultHarness(settings.defaultHarness, ctx);
  const harnessSource = harness.source === "project"
    ? ` (project: ${harness.projectPath})`
    : " (global)";
  const catalog = loadCatalogSnapshot(getAgentDir(), options);
  const upgradePlan = planConfigUpgrade(getAgentDir());
  const upgradeHint = upgradePlan.status === "ready"
    ? ["A one-time configuration conversion is ready: run /external config convert to preview it."]
    : upgradePlan.status === "blocked"
      ? ["Configuration conversion is blocked:", ...upgradePlan.diagnostics.map((item) => `- ${item}`)]
      : [];
  const warnings = [...options.settings.diagnostics, ...harness.diagnostics, ...catalogProblems(catalog), ...defaultHarnessProblems(catalog, harness.harness), ...upgradeHint];
  const text = [
    `defaultHarness: ${harness.harness}${harnessSource}`,
    "Harnesses:",
    ...harnessStateLines(catalog, harness.harness, loadExternalSettings(getAgentDir()).settings),
    `maxConcurrentSubagents: ${effective.maxConcurrentSubagents}`,
    `subagentTimeoutMs: ${effective.subagentTimeoutMs}`,
    `defaultPermission: ${settings.defaultPermission}`,
    `defaultMaxBudgetUsd: ${settings.defaultMaxBudgetUsd === null ? "unlimited" : settings.defaultMaxBudgetUsd}`,
    `maxRunRecords: ${settings.maxRunRecords}${settings.maxRunRecords === 0 ? " (keep forever)" : ""}`,
    `Settings: ${options.settings.path}`,
    `Project override: ${projectExternalSettingsPath(ctx.cwd)} (trusted projects only; defaultHarness only)`,
    ...(warnings.length ? ["Warnings:", ...warnings.map((item) => `- ${item}`)] : []),
    "Change: /external config harness list|inspect|set|reset|enable|disable|default|create|delete · /external config role list|inspect|create|edit|set|reset|enable|disable|delete · /external config edit (whole file). Values apply from the next invocation; CLI flags override file values.",
  ].join("\n");
  return { text, warn: warnings.length > 0 };
}

function overviewText(options: ExternalCommandOptions, ctx: CommandContextLike): string {
  const settings = options.settings.settings;
  const harness = resolveCtxDefaultHarness(settings.defaultHarness, ctx);
  const harnessSource = harness.source === "project" ? "project" : "global";
  const agentDir = getAgentDir();
  const catalog = loadCatalogSnapshot(agentDir, options);
  const harnesses = catalog.harnessConfigs ?? loadHarnessConfigs(agentDir).harnesses;
  const disabled = disabledHarnessSet(catalog);
  const groups = groupByRole(catalog.profiles, knownHarnessNames(agentDir));
  const problems = [...options.settings.diagnostics, ...harness.diagnostics, ...catalogProblems(catalog), ...defaultHarnessProblems(catalog, harness.harness)];
  return [
    "External agents",
    `Default: ${harness.harness} (${harnessSource})`,
    `Roles: ${groups.size} known${problems.length ? " · configuration has warnings (see /external doctor)" : ""}`,
    `Harnesses: ${EXTERNAL_HARNESSES_LIST.length} CLI · ${harnesses.size} named Pi${disabled.size ? ` · ${disabled.size} disabled` : ""} (see /external config)`,
    `Settings: ${options.settings.path}`,
    ...(problems.length ? ["Problems:", ...problems.map((item) => `- ${item}`)] : []),
  ].join("\n");
}

/** Real execution boundary per backend. A role's instructions are intent, not this boundary. */
function backendAuthority(backend: string, permission: string): string {
  if (backend === "agy") {
    return `agy accepts only autonomous danger (--dangerously-skip-permissions) and rejects ${permission === "danger" ? "readonly and edit" : permission}. The call uses ${permission}. Run only in trusted repositories.`;
  }
  if (backend === "pi") {
    return `Pi SDK child · host access · curated tools · call tier ${permission}. The tool list is not an OS sandbox; danger-tier bash is as exposed as on any external CLI. The harness preset is minimal (skills stay unloaded) or skills (installed skills load; project skills require a trusted project). Extensions and prompt templates stay unloaded.`;
  }
  if (backend === "claude") {
    return `Claude headless permission mode · call tier ${permission}. readonly and edit deny Bash headlessly. Role names do not raise the tier.`;
  }
  if (backend === "codex") {
    return `Codex --sandbox axis · call tier ${permission}; never automatically retried by this extension.`;
  }
  if (backend === "grok") {
    return `Grok --sandbox axis (read-only/workspace/off) + bypassPermissions · call tier ${permission}; readonly network-blocking is Linux-only.`;
  }
  if (backend === "opencode") {
    return `OpenCode 2 standalone run · permission rules · call tier ${permission}; readonly/edit use an injected deny-by-default agent (not an OS sandbox; plugins and MCP servers still load), danger uses --auto.`;
  }
  return `Muse exec approvals bypassed headless · call tier ${permission}; readonly adds --disable-write --disable-shell, danger uses --yolo (also trusts the workspace).`;
}

type Notice = { message: string; level: "info" | "warning" | "error" };
type EffectiveDefault = ReturnType<typeof resolveCtxDefaultHarness>;
const LATER = "Applies from the next invocation; active children and running workflows keep their snapshot.";

/** Quote-aware argument splitting so descriptions and model ids pass through unchanged. */
export function tokenizeArgs(args: string): string[] {
  const tokens: string[] = [];
  const pattern = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  for (const match of args.matchAll(pattern)) tokens.push(match[1] !== undefined ? match[1].replace(/\\(.)/g, "$1") : match[2] ?? match[3]!);
  return tokens;
}

type ParsedFlags = { positional: string[]; values: Map<string, string>; bools: Set<string>; problems: string[] };
function parseFlags(tokens: string[], valueFlags: readonly string[], boolFlags: readonly string[] = []): ParsedFlags {
  const parsed: ParsedFlags = { positional: [], values: new Map(), bools: new Set(), problems: [] };
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (!token.startsWith("--")) { parsed.positional.push(token); continue; }
    const flag = token.slice(2);
    if (parsed.values.has(flag) || parsed.bools.has(flag)) { parsed.problems.push(`--${flag} was given more than once.`); continue; }
    if (valueFlags.includes(flag)) {
      const value = tokens[index + 1];
      if (value === undefined || value.startsWith("--")) parsed.problems.push(`--${flag} needs a value.`);
      else { parsed.values.set(flag, value); index++; }
    } else if (boolFlags.includes(flag)) parsed.bools.add(flag);
    else parsed.problems.push(`Unknown option --${flag}. Supported: ${[...valueFlags, ...boolFlags].map((item) => `--${item}`).join(", ") || "none"}.`);
  }
  return parsed;
}

function failure(error: unknown): Notice {
  return { message: error instanceof Error ? error.message : String(error), level: error instanceof LifecycleError ? "warning" : "error" };
}

function freshSettings(): ExternalSettings {
  return loadExternalSettings(getAgentDir()).settings;
}

function harnessKind(name: string): string {
  return cliHarness(name) ? "CLI" : "Pi";
}

function describeValue(value: unknown, fallback: string): string {
  if (value === undefined) return fallback;
  if (value === "native") return "native (backend's own default)";
  return Array.isArray(value) ? value.join(", ") : String(value);
}

export const HARNESS_VERBS = ["list", "inspect", "create", "edit", "enable", "disable", "set", "reset", "delete", "default", "test", "assist"] as const;
export const ROLE_VERBS = ["list", "inspect", "create", "edit", "enable", "disable", "set", "reset", "delete", "assist"] as const;

function harnessUsage(): string {
  return [
    "Harness commands:",
    "/external config harness list",
    "/external config harness inspect NAME",
    "/external config harness create pi-NAME --model provider/model [--effort LEVEL] [--preset minimal|skills]",
    "/external config harness edit NAME — edit its settings entry in the editor",
    "/external config harness enable|disable NAME",
    "/external config harness set NAME [--model VALUE] [--effort VALUE] [--preset minimal|skills]",
    "/external config harness reset NAME [--model] [--effort] [--preset] — no field flags resets all execution fields after confirmation",
    "/external config harness delete pi-NAME",
    "/external config harness default NAME",
    "/external config harness test NAME — explicit readiness check",
    "/external config harness assist — assisted Pi harness interview with a smoke test",
  ].join("\n");
}

function roleUsage(): string {
  return [
    "Role commands:",
    "/external config role list",
    "/external config role inspect NAME [--harness NAME]",
    "/external config role create NAME — description and instructions in the editor",
    "/external config role edit NAME [--harness NAME] — shared instructions, or one harness's replacement",
    "/external config role enable|disable NAME [--harness NAME]",
    "/external config role set NAME --harness NAME [--model VALUE] [--effort VALUE] [--budget USD] [--tools a,b]",
    "/external config role reset NAME [--harness NAME] [--model] [--effort] [--budget] [--tools] [--instructions]",
    "/external config role delete NAME",
    "/external config role assist — assisted role-authoring interview",
  ].join("\n");
}

/** Readable one-line harness row from v5 settings plus the catalog's gate view. */
function harnessRow(settings: ExternalSettings, name: string, defaultHarness: string): string {
  const entry = settings.harnessSettings?.[name] ?? {};
  const legacy = settings.harnesses?.[name];
  const model = entry.model ?? legacy?.model;
  const details = [
    `model ${describeValue(model, cliHarness(name) ? "native" : "(missing)")}`,
    `effort ${describeValue(entry.thinking ?? legacy?.thinking, cliHarness(name) ? "native" : "off")}`,
    ...(cliHarness(name) ? [] : [`preset ${entry.preset ?? legacy?.preset ?? "minimal"}`]),
    ...(Object.keys(entry.roles ?? {}).length ? [`${Object.keys(entry.roles ?? {}).length} role exception(s)`] : []),
  ];
  return `- ${name} · ${harnessKind(name)} (${details.join(" · ")}) · ${harnessDisabled(settings, name) ? "disabled" : "enabled"}${name === defaultHarness ? " · default" : ""}`;
}

function harnessListText(ctx: CommandContextLike): string {
  const settings = freshSettings();
  const effective = resolveCtxDefaultHarness(settings.defaultHarness, ctx).harness;
  const names = [...new Set([...registeredHarnesses(settings), ...Object.keys(settings.harnesses ?? {})])];
  const unknown = (settings.disabledHarnesses ?? []).filter((name) => !names.includes(name)).sort();
  return [
    "Harnesses (readiness is separate; see /external config harness test NAME):",
    ...names.map((name) => harnessRow(settings, name, effective)),
    ...(names.some((name) => !cliHarness(name)) ? [] : ["- no named Pi harnesses (/external config harness create pi-NAME --model provider/model)"]),
    ...unknown.map((name) => `- ${name} · unknown · disabled (kept; not a known harness)`),
  ].join("\n");
}

function harnessInspectText(ctx: CommandContextLike, name: string): string {
  const settings = freshSettings();
  if (!registeredHarnesses(settings).includes(name) && !settings.harnesses?.[name]) {
    return `Unknown harness "${name}". Choose one of: ${registeredHarnesses(settings).join(", ")}.`;
  }
  const effective = resolveCtxDefaultHarness(settings.defaultHarness, ctx);
  const entry = settings.harnessSettings?.[name] ?? {};
  const origin = (value: unknown) => value === undefined ? "backend default" : `settings harnesses.${name}`;
  const overridesDir = join(getAgentDir(), "pi-flow-external", "overrides", name);
  const overrides = existsSync(overridesDir) ? readdirSync(overridesDir).filter((file) => file.endsWith(".md")).sort() : [];
  const exceptions = Object.entries(entry.roles ?? {}).map(([role, patch]) => `- ${role}: ${Object.entries(patch).map(([key, value]) => `${key} ${describeValue(value, "")}`).join(" · ")}`);
  const gates = remainingGates(settings, { harness: name });
  return [
    `Harness ${name} · ${harnessKind(name)} · ${harnessDisabled(settings, name) ? "disabled" : "enabled"}${name === effective.harness ? ` · default (${effective.source})` : ""}`,
    `Model: ${describeValue(entry.model ?? settings.harnesses?.[name]?.model, "native (backend's own default)")} · ${origin(entry.model)}`,
    `Effort: ${describeValue(entry.thinking, cliHarness(name) ? "native (backend's own default)" : "off")} · ${origin(entry.thinking)}`,
    ...(cliHarness(name) ? [] : [`Preset: ${entry.preset ?? "minimal"} · ${origin(entry.preset)}`]),
    ...(exceptions.length ? ["Role exceptions:", ...exceptions] : ["Role exceptions: none"]),
    overrides.length ? `Instruction overrides (${overridesDir}): ${overrides.join(", ")}` : "Instruction overrides: none",
    ...(gates.length ? ["Gates:", ...gates.map((gate) => `- ${gate}`)] : []),
    `Readiness: not checked here. Run /external config harness test ${name}.`,
  ].join("\n");
}

async function harnessCreate(ctx: ExtensionCommandContext, parsed: ParsedFlags): Promise<Notice> {
  const name = parsed.positional[0];
  if (!name) return { message: "Usage: /external config harness create pi-NAME --model provider/model [--effort LEVEL] [--preset minimal|skills]", level: "warning" };
  let model = parsed.values.get("model");
  if (!model && ctx.hasUI && typeof ctx.ui.input === "function" && !cliHarness(name)) model = (await ctx.ui.input(`Model for ${name}`, "provider/model"))?.trim();
  if (!model && !cliHarness(name)) return { message: `Harness "${name}" was not created: a named Pi harness needs --model provider/model.`, level: "warning" };
  try {
    const path = createPiHarness(getAgentDir(), name, { model: model!, thinking: parsed.values.get("effort"), preset: parsed.values.get("preset") });
    return { message: `Harness "${name}" saved to ${path}. The six built-in roles and your shared roles are now available on it. No readiness check was run; test it with /external config harness test ${name}. ${LATER}`, level: "info" };
  } catch (error) {
    return failure(error);
  }
}

async function harnessEdit(ctx: ExtensionCommandContext, name: string): Promise<Notice> {
  if (!ctx.hasUI || typeof ctx.ui.editor !== "function") return { message: "Harness editing requires interactive or RPC UI with an editor. Use /external config harness set instead.", level: "error" };
  let settings: ExternalSettings;
  try { settings = readV5Settings(getAgentDir()); } catch (error) { return failure(error); }
  if (!registeredHarnesses(settings).includes(name)) return { message: `Unknown harness "${name}". Choose one of: ${registeredHarnesses(settings).join(", ")}.`, level: "warning" };
  const current = `${JSON.stringify(settings.harnessSettings?.[name] ?? {}, null, 2)}\n`;
  const edited = await ctx.ui.editor(`harness ${name}`, current);
  if (edited === undefined) return { message: "Harness edit cancelled. Nothing was saved.", level: "info" };
  if (edited === current) return { message: "Harness unchanged.", level: "info" };
  let entry: unknown;
  try { entry = JSON.parse(edited); } catch (error) { return { message: `Harness not saved: edited text is not valid JSON (${error instanceof Error ? error.message : String(error)}).`, level: "error" }; }
  try {
    replaceHarnessEntry(getAgentDir(), name, entry, resolveCtxDefaultHarness(freshSettings().defaultHarness, ctx));
    return { message: `Harness "${name}" saved. ${LATER}`, level: "info" };
  } catch (error) {
    return failure(error);
  }
}

function harnessToggle(ctx: CommandContextLike, name: string, enabled: boolean): Notice {
  const agentDir = getAgentDir();
  try {
    const effective = resolveCtxDefaultHarness(freshSettings().defaultHarness, ctx);
    const result = setHarnessEnabled(agentDir, name, enabled, effective);
    const gates = remainingGates(readV5Settings(agentDir), { harness: name });
    const remaining = enabled && gates.length ? ` Still blocked: ${gates.join("; ")}.` : "";
    if (result.alreadyInState) return { message: `Harness "${name}" is already ${enabled ? "enabled" : "disabled"}.${remaining}`, level: "info" };
    return enabled
      ? { message: `Harness "${name}" enabled. ${LATER}${remaining}`, level: remaining ? "warning" : "info" }
      : { message: `Harness "${name}" disabled. Its settings, role exceptions, and overrides stay in place; calls selecting it fail without fallback. ${LATER} Re-enable with /external config harness enable ${name}.`, level: "info" };
  } catch (error) {
    return failure(error);
  }
}

function harnessDefault(ctx: CommandContextLike, name: string): Notice {
  try {
    setDefaultHarness(getAgentDir(), name);
  } catch (error) {
    return failure(error);
  }
  const effective = resolveCtxDefaultHarness(name, ctx);
  const shadowed = effective.source === "project" && effective.harness !== name ? ` This project still uses "${effective.harness}" from ${effective.projectPath}.` : "";
  return { message: `Global default harness set to "${name}". ${LATER}${shadowed}`, level: shadowed ? "warning" : "info" };
}

function harnessSet(name: string, parsed: ParsedFlags): Notice {
  const fields: Partial<Record<HarnessField, string>> = {};
  for (const field of ["model", "effort", "preset"] as const) if (parsed.values.has(field)) fields[field] = parsed.values.get(field)!;
  try {
    setHarnessFields(getAgentDir(), name, fields);
    return { message: `Harness "${name}" updated: ${Object.entries(fields).map(([key, value]) => `${key} ${value}`).join(", ")}. Enabled state unchanged. ${LATER}`, level: "info" };
  } catch (error) {
    return failure(error);
  }
}

function previewText(title: string, plan: { settingsFields: string[]; files: string[]; kept?: string[] }): string {
  return [
    title,
    ...(plan.settingsFields.length ? ["Settings fields removed:", ...plan.settingsFields.map((item) => `- ${item}`)] : []),
    ...(plan.files.length ? ["Files deleted:", ...plan.files.map((item) => `- ${item}`)] : []),
    ...(plan.kept?.length ? ["Kept:", ...plan.kept.map((item) => `- ${item}`)] : []),
    "Run receipts and native CLI configuration are never touched.",
  ].join("\n");
}

async function confirmPreview(ctx: ExtensionCommandContext, title: string, preview: string, command: string): Promise<true | Notice> {
  if (!ctx.hasUI || typeof ctx.ui.confirm !== "function") return { message: `${preview}\n\nThis needs interactive confirmation; rerun ${command} with UI. Nothing was changed.`, level: "warning" };
  return await ctx.ui.confirm(title, preview) ? true : { message: "Cancelled. Nothing was changed.", level: "info" };
}

async function harnessReset(ctx: ExtensionCommandContext, name: string, parsed: ParsedFlags): Promise<Notice> {
  const agentDir = getAgentDir();
  const fields = (["model", "effort", "preset"] as const).filter((field) => parsed.bools.has(field));
  try {
    if (fields.length) {
      resetHarnessFields(agentDir, name, fields);
      return { message: `Harness "${name}" reset: ${fields.join(", ")} now inherit${remainingGates(readV5Settings(agentDir), { harness: name }).length ? "; gates are unchanged" : ""}. Enabled state unchanged. ${LATER}`, level: "info" };
    }
    const plan = planHarnessReset(agentDir, name);
    if (!plan.settingsFields.length) return { message: `Harness "${name}" has no execution fields to reset.`, level: "info" };
    const confirmed = await confirmPreview(ctx, `Reset harness ${name}?`, previewText(`Reset every execution field on ${name}:`, plan), `/external config harness reset ${name}`);
    if (confirmed !== true) return confirmed;
    applyHarnessReset(agentDir, plan);
    return { message: `Harness "${name}" reset. Enabled gates and instruction overrides were kept. ${LATER}`, level: "info" };
  } catch (error) {
    return failure(error);
  }
}

async function harnessDelete(ctx: ExtensionCommandContext, name: string): Promise<Notice> {
  const agentDir = getAgentDir();
  try {
    const plan = planHarnessDelete(agentDir, name, resolveCtxDefaultHarness(freshSettings().defaultHarness, ctx));
    if (plan.blockers.length) return { message: `Harness "${name}" was not deleted: ${plan.blockers.join(" ")}`, level: "warning" };
    const confirmed = await confirmPreview(ctx, `Delete harness ${name}?`, previewText(`Delete harness ${name}:`, plan), `/external config harness delete ${name}`);
    if (confirmed !== true) return confirmed;
    const result = applyHarnessDelete(agentDir, plan, resolveCtxDefaultHarness(freshSettings().defaultHarness, ctx));
    return { message: [result.message, ...result.failed.map((item) => `- ${item.path}: ${item.reason}`)].join("\n"), level: result.complete ? "info" : "error" };
  } catch (error) {
    const notice = failure(error);
    return { ...notice, message: `Harness "${name}" was not deleted: ${notice.message}` };
  }
}

async function harnessTest(pi: ExtensionAPI, options: ExternalCommandOptions, ctx: ExtensionCommandContext, name: string): Promise<Notice> {
  const settings = freshSettings();
  if (!registeredHarnesses(settings).includes(name)) return { message: `Unknown harness "${name}". Choose one of: ${registeredHarnesses(settings).join(", ")}.`, level: "warning" };
  const disabled = harnessDisabled(settings, name) ? `\nNote: "${name}" is disabled; readiness does not change that.` : "";
  if (cliHarness(name)) {
    const report = await diagnoseCli(pi.exec.bind(pi), name);
    return { message: `${report}\nNo model request was made: this checks CLI presence and reported login only, not account or model compatibility.${disabled}`, level: "info" };
  }
  const config = settings.harnesses?.[name];
  if (options.testHarness) {
    const result = await options.testHarness(ctx, name);
    return result.ok
      ? { message: `✓ ${name}: readonly smoke test passed${result.detail ? ` (${result.detail})` : ""}.${disabled}`, level: "info" }
      : { message: `✗ ${name}: readonly smoke test failed: ${result.error}${disabled}`, level: "error" };
  }
  const separator = config?.model.indexOf("/") ?? -1;
  const model = config && separator > 0 ? ctx.modelRegistry.find(config.model.slice(0, separator), config.model.slice(separator + 1)) : undefined;
  const lines = !model
    ? [`✗ ${name}: model "${config?.model ?? "(missing)"}" not found in the Pi model registry`]
    : [ctx.modelRegistry.hasConfiguredAuth(model) ? `✓ ${name}: ${config!.model} resolves (auth configured)` : `⚠ ${name}: ${config!.model} resolves (no credentials configured)`];
  lines.push("No model test: no request was sent; provider authentication and routing were not exercised.");
  return { message: `${lines.join("\n")}${disabled}`, level: model ? "info" : "warning" };
}

async function harnessCommand(pi: ExtensionAPI, options: ExternalCommandOptions, ctx: ExtensionCommandContext, tokens: string[]): Promise<Notice | undefined> {
  const verb = tokens[0]?.toLowerCase();
  const valueFlags = verb === "create" || verb === "set" ? ["model", "effort", "preset"] : [];
  const boolFlags = verb === "reset" ? ["model", "effort", "preset"] : [];
  const parsed = parseFlags(tokens.slice(1), valueFlags, boolFlags);
  if (!verb || !(HARNESS_VERBS as readonly string[]).includes(verb)) return { message: harnessUsage(), level: verb ? "warning" : "info" };
  const extra = parsed.positional.slice(verb === "list" || verb === "assist" ? 0 : 1);
  if (extra.length) parsed.problems.push(`Unexpected argument${extra.length > 1 ? "s" : ""}: ${extra.join(" ")}.`);
  if (parsed.problems.length) return { message: `${parsed.problems.join(" ")}\n\n${harnessUsage()}`, level: "warning" };
  if (verb === "list") return { message: harnessListText(ctx), level: "info" };
  if (verb === "assist") { await options.startHarnessInterview(ctx); return undefined; }
  if (verb === "create") return harnessCreate(ctx, parsed);
  const name = parsed.positional[0];
  if (!name) return { message: `Usage: /external config harness ${verb} NAME`, level: "warning" };
  if (verb === "inspect") return { message: harnessInspectText(ctx, name), level: "info" };
  if (verb === "edit") return harnessEdit(ctx, name);
  if (verb === "enable" || verb === "disable") return harnessToggle(ctx, name, verb === "enable");
  if (verb === "default") return harnessDefault(ctx, name);
  if (verb === "set") return harnessSet(name, parsed);
  if (verb === "reset") return harnessReset(ctx, name, parsed);
  if (verb === "delete") return harnessDelete(ctx, name);
  return harnessTest(pi, options, ctx, name);
}

// ---- Roles ----------------------------------------------------------------

function catalogBinding(catalog: ExternalCatalog, harness: string, role: string): SubagentProfile | undefined {
  return catalog.profiles.get(bindingKey(harness, role));
}

function roleListText(options: ExternalCommandOptions): string {
  const settings = freshSettings();
  const inventory = roleInventory(getAgentDir(), settings);
  const catalog = loadCatalogSnapshot(getAgentDir(), options);
  const lines = [...inventory.values()].sort((a, b) => a.name.localeCompare(b.name)).map((entry) => {
    const kind = entry.builtIn ? (entry.file ? "built-in (customized)" : "built-in") : entry.settingsOnly ? "settings only (no definition)" : "custom";
    const exceptions = new Set([...entry.exceptions, ...entry.overrides.map((path) => basename(dirname(path)))]);
    return `- ${entry.name} · ${kind} · ${settings.roles?.[entry.name]?.enabled === false ? "disabled" : "enabled"}${exceptions.size ? ` · exceptions on ${[...exceptions].sort().join(", ")}` : ""}`;
  });
  return [
    "Roles (one definition serves every harness; harness exceptions are sparse):",
    ...lines,
    ...Object.entries(settings.exact ?? {}).map(([name, entry]) => `- ${name} · compatibility exact selector · harness ${entry.harness} · ${catalog.profiles.get(name)?.configurationError ?? 'available'} · inspect with config role inspect ${name}; edit/remove under config edit → exact`),
    ...(catalog.diagnostics.length ? ["Warnings:", ...catalog.diagnostics.map((item) => `- ${item}`)] : []),
  ].join("\n");
}

function roleInspectText(options: ExternalCommandOptions, role: string, harness: string | undefined): string {
  const agentDir = getAgentDir();
  const settings = freshSettings();
  const entry = roleInventory(agentDir, settings).get(role);
  const catalog = loadCatalogSnapshot(agentDir, options);
  if (catalog.blocked) return `Role inspection is unavailable: ${catalog.diagnostics.join(" ") || "the external catalog could not be composed."}`;
  if (!entry && !harness && settings.exact?.[role]) {
    const exact = settings.exact[role];
    return [`Compatibility selector ${role}`, `Harness: ${exact.harness}`, `Availability: ${catalog.profiles.get(role)?.configurationError ?? 'available'}`, `Configuration: ${JSON.stringify(exact, null, 2)}`, 'This preserved legacy record is not a shared role. Edit or remove its exact entry with /external config edit; binding operations do not own it.'].join('\n');
  }
  if (!entry || entry.settingsOnly) return `Unknown role "${role}". See /external config role list.`;
  const harnesses = registeredHarnesses(settings);
  if (!harness) {
    const shared = catalogBinding(catalog, harnesses[0]!, role);
    return [
      `Role ${role} · ${entry.builtIn ? "built-in" : "custom"} · ${settings.roles?.[role]?.enabled === false ? "disabled everywhere" : "enabled"}`,
      `Shared instructions: ${entry.file ?? "built-in"}`,
      ...(shared ? [`Description: ${shared.description}`] : []),
      "Bindings:",
      ...harnesses.map((name) => {
        const profile = catalogBinding(catalog, name, role);
        if (!profile) return `- ${name}: not available`;
        const custom = profile.source && profile.source.includes(`${sep}overrides${sep}`) ? " · instruction override" : "";
        return `- ${name}: ${profile.configurationError ? `blocked (${profile.configurationError.split("\n").join("; ")})` : "available"} · model ${profile.model ?? "native"} · effort ${profile.thinking ?? "native"}${custom}`;
      }),
      `Details: /external config role inspect ${role} --harness NAME`,
    ].join("\n");
  }
  const profile = catalogBinding(catalog, harness, role);
  if (!profile) return `Role "${role}" is not bound to harness "${harness}". Known harnesses: ${harnesses.join(", ")}.`;
  const origins = profile.origins ?? {};
  const instructions = (profile.systemPrompt ?? "").trim() || "(empty instructions)";
  const bounded = instructions.length > 4000 ? `${instructions.slice(0, 4000)}\n… (truncated; full instructions are in ${origins.instructions ?? profile.source ?? "the definition"})` : instructions;
  const permission = settings.defaultPermission;
  return [
    `${harness}/${role}: ${profile.description}`,
    `Instructions: ${origins.instructions ?? profile.source ?? "built-in"}`,
    `Model: ${profile.model ?? "native"} · ${origins.model ?? "backend default"}`,
    `Reasoning effort: ${profile.thinking === 'parent' ? `parent → ${options.getThinkingLevel?.() ?? 'unavailable outside session'}` : profile.thinking ?? 'native'} · ${origins.thinking ?? 'backend default'}`,
    `Adapter: ${profile.backend === 'opencode' ? (profile.thinking === 'native' ? 'native model variant; no effort override' : `model variant ${profile.thinking}`) : profile.backend === 'agy' ? 'minimal → low; xhigh/max → high; off omits effort' : profile.backend === 'grok' ? 'off/minimal → low' : profile.backend === 'pi' ? 'SDK may clamp effort to model capabilities; recorded at launch' : 'explicit effort forwarded; native omits the override'}`,
    'Readiness: not tested here; configuration validity does not prove account/model access.',
    `Budget: ${profile.maxBudgetUsd ?? settings.defaultMaxBudgetUsd ?? 'unlimited'}${profile.maxBudgetUsd !== undefined || settings.defaultMaxBudgetUsd !== null ? ' USD' : ''} · ${profile.maxBudgetUsd !== undefined ? origins.max_budget_usd ?? 'binding' : 'global default'}`,
    ...(profile.tools ? [`Tools: ${profile.tools.join(", ")} · ${origins.tools ?? ""}`] : []),
    ...(profile.backend === "pi" ? [`Preset: ${profile.preset ?? "minimal"} · harness ${harness}`] : []),
    profile.configurationError ? `Blocked:\n${profile.configurationError.split("\n").map((line) => `- ${line}`).join("\n")}` : "State: available",
    `Permission: call permission, otherwise ${permission}; roles never grant or limit authority.`,
    backendAuthority(profile.backend, permission),
    "",
    bounded,
  ].join("\n");
}

const ROLE_TEMPLATE = "---\ndescription: \"One line: when to select this role\"\n---\nInstructions for the external agent.\n";

async function roleCreate(ctx: ExtensionCommandContext, role: string | undefined, harness: string | undefined): Promise<Notice> {
  if (!role) return { message: "Usage: /external config role create NAME", level: "warning" };
  if (harness) return { message: `Role creation defines a role for every harness. To customize one harness, use /external config role edit ${role} --harness ${harness} or role set ${role} --harness ${harness}.`, level: "warning" };
  if (!ctx.hasUI || typeof ctx.ui.editor !== "function") return { message: "Role creation requires interactive or RPC UI with an editor. For an assisted interview use /external config role assist.", level: "error" };
  try { readV5Settings(getAgentDir()); } catch (error) { return failure(error); }
  const edited = await ctx.ui.editor(`role ${role}`, ROLE_TEMPLATE);
  if (edited === undefined || edited === ROLE_TEMPLATE) return { message: "Role creation cancelled. Nothing was saved.", level: "info" };
  try {
    const path = createRole(getAgentDir(), role, edited);
    return { message: `Role "${role}" saved to ${path}. It is available on every enabled harness. No backend was contacted. ${LATER}`, level: "info" };
  } catch (error) {
    return failure(error);
  }
}

async function roleEdit(options: ExternalCommandOptions, ctx: ExtensionCommandContext, role: string, harness: string | undefined): Promise<Notice> {
  if (!ctx.hasUI || typeof ctx.ui.editor !== "function") return { message: "Role editing requires interactive or RPC UI with an editor.", level: "error" };
  const agentDir = getAgentDir();
  let settings: ExternalSettings;
  try { settings = readV5Settings(agentDir); } catch (error) { return failure(error); }
  const entry = roleInventory(agentDir, settings).get(role);
  if (!entry || entry.settingsOnly) return { message: `Unknown role "${role}". Create it with /external config role create ${role}.`, level: "warning" };
  if (harness && !registeredHarnesses(settings).includes(harness)) return { message: `Unknown harness "${harness}". Choose one of: ${registeredHarnesses(settings).join(", ")}.`, level: "warning" };
  const path = harness ? overrideFile(agentDir, harness, role) : roleFile(agentDir, role);
  let current: string | undefined;
  try { current = readInstructionText(path); } catch (error) { return failure(error); }
  if (current === undefined) {
    const builtIn = roleDefinition(role);
    const profile = harness ? catalogBinding(loadCatalogSnapshot(agentDir, options), harness, role) : undefined;
    current = compileInstructionMarkdown(profile?.description ?? builtIn?.description ?? role, profile?.systemPrompt ?? builtIn?.body ?? "");
  }
  const edited = await ctx.ui.editor(harness ? `role ${role} on ${harness}` : `role ${role}`, current);
  if (edited === undefined) return { message: "Role edit cancelled. Nothing was saved.", level: "info" };
  if (edited === current && existsSync(path)) return { message: "Role unchanged.", level: "info" };
  try {
    const saved = writeInstructions(agentDir, role, edited, harness);
    const scope = harness ? `Replacement instructions for ${harness}/${role}` : `Shared instructions for "${role}"`;
    const undo = harness ? `/external config role reset ${role} --harness ${harness} --instructions` : entry.builtIn ? `/external config role reset ${role} --instructions` : undefined;
    return { message: `${scope} saved to ${saved}.${undo ? ` Undo with ${undo}.` : ""} ${LATER}`, level: "info" };
  } catch (error) {
    return failure(error);
  }
}

function roleToggle(role: string, harness: string | undefined, enabled: boolean): Notice {
  const agentDir = getAgentDir();
  try {
    const result = setRoleEnabled(agentDir, role, enabled, harness);
    const scope = harness ? `Binding ${harness}/${role}` : `Role "${role}"`;
    const gates = remainingGates(readV5Settings(agentDir), { harness, role }).filter((gate) => harness ? !gate.startsWith("binding") : !gate.startsWith("role"));
    const remaining = enabled && gates.length ? ` Still blocked: ${gates.join("; ")}.` : "";
    if (result.alreadyInState) return { message: `${scope} is already ${enabled ? "enabled" : "disabled"}.${remaining}`, level: "info" };
    return { message: `${scope} ${enabled ? "enabled" : `disabled${harness ? "" : " on every harness"}; its definition stays in place`}. ${LATER}${remaining}`, level: remaining ? "warning" : "info" };
  } catch (error) {
    return failure(error);
  }
}

function roleSet(role: string, harness: string | undefined, parsed: ParsedFlags): Notice {
  if (!harness) return { message: `model, effort, budget, and tools are per-harness settings. Use /external config role set ${role} --harness NAME ... (harness-wide defaults: /external config harness set NAME).`, level: "warning" };
  const fields: Partial<Record<BindingField, string | number | string[]>> = {};
  if (parsed.values.has("model")) fields.model = parsed.values.get("model")!;
  if (parsed.values.has("effort")) fields.effort = parsed.values.get("effort")!;
  if (parsed.values.has("budget")) fields.budget = Number(parsed.values.get("budget"));
  if (parsed.values.has("tools")) fields.tools = parsed.values.get("tools")!.split(",").map((item) => item.trim()).filter(Boolean);
  try {
    setBindingFields(getAgentDir(), role, harness, fields);
    return { message: `Binding ${harness}/${role} updated: ${Object.keys(fields).join(", ")}. Instructions and enabled state unchanged. ${LATER}`, level: "info" };
  } catch (error) {
    return failure(error);
  }
}

async function roleReset(ctx: ExtensionCommandContext, role: string, harness: string | undefined, parsed: ParsedFlags): Promise<Notice> {
  const agentDir = getAgentDir();
  const fields = (["model", "effort", "budget", "tools", "instructions"] as const).filter((field) => parsed.bools.has(field));
  const scope = harness ? `${harness}/${role}` : role;
  try {
    const plan = planRoleReset(agentDir, role, harness, [...fields]);
    if (!plan.settingsFields.length && !plan.files.length) return { message: `Nothing to reset on ${scope}: it already inherits those values.`, level: "info" };
    if (!fields.length) {
      const confirmed = await confirmPreview(ctx, `Reset ${scope}?`, previewText(`Reset every customization on ${scope}:`, plan), `/external config role reset ${role}${harness ? ` --harness ${harness}` : ""}`);
      if (confirmed !== true) return confirmed;
    }
    const result = applyRoleReset(agentDir, plan);
    if (result.failed.length) return { message: [`Reset of ${scope} was incomplete; scalar settings were kept. Some instruction files may have been removed. Preview again to retry:`, ...result.failed.map((item) => `- ${item.path}: ${item.reason}`)].join("\n"), level: "error" };
    return { message: `Reset ${scope}: ${[...plan.settingsFields, ...plan.files].join(", ")}. Enabled gates unchanged. ${LATER}`, level: "info" };
  } catch (error) {
    return failure(error);
  }
}

async function roleDelete(ctx: ExtensionCommandContext, role: string, harness: string | undefined): Promise<Notice> {
  if (harness) return { message: `Deleting removes a role everywhere. To remove one harness's customization use /external config role reset ${role} --harness ${harness}.`, level: "warning" };
  const agentDir = getAgentDir();
  try {
    const plan = planRoleDelete(agentDir, role);
    if (plan.blockers.length) return { message: `Role "${role}" was not deleted: ${plan.blockers.join(" ")}`, level: "warning" };
    const confirmed = await confirmPreview(ctx, `Delete role ${role}?`, previewText(`Delete role ${role} on every harness:`, plan), `/external config role delete ${role}`);
    if (confirmed !== true) return confirmed;
    const result = applyRoleDelete(agentDir, plan);
    return { message: [result.message, ...result.failed.map((item) => `- ${item.path}: ${item.reason}`)].join("\n"), level: result.complete ? "info" : "error" };
  } catch (error) {
    const notice = failure(error);
    return { ...notice, message: `Role "${role}" was not deleted: ${notice.message}` };
  }
}

async function roleCommand(options: ExternalCommandOptions, ctx: ExtensionCommandContext, tokens: string[]): Promise<Notice | undefined> {
  const verb = tokens[0]?.toLowerCase();
  const valueFlags = ["harness", ...(verb === "set" ? ["model", "effort", "budget", "tools"] : [])];
  const boolFlags = verb === "reset" ? ["model", "effort", "budget", "tools", "instructions"] : [];
  const parsed = parseFlags(tokens.slice(1), verb === "list" || verb === "assist" ? [] : valueFlags, boolFlags);
  if (!verb || !(ROLE_VERBS as readonly string[]).includes(verb)) return { message: roleUsage(), level: verb ? "warning" : "info" };
  const extra = parsed.positional.slice(verb === "list" || verb === "assist" ? 0 : 1);
  if (extra.length) parsed.problems.push(`Unexpected argument${extra.length > 1 ? "s" : ""}: ${extra.join(" ")}.`);
  if (parsed.problems.length) return { message: `${parsed.problems.join(" ")}\n\n${roleUsage()}`, level: "warning" };
  if (verb === "list") return { message: roleListText(options), level: "info" };
  if (verb === "assist") { await options.startRoleInterview(ctx); return undefined; }
  const role = parsed.positional[0];
  const harness = parsed.values.get("harness");
  if (verb === "create") return roleCreate(ctx, role, harness);
  if (!role) return { message: `Usage: /external config role ${verb} NAME${verb === "set" ? " --harness NAME" : " [--harness NAME]"}`, level: "warning" };
  if (verb === "inspect") return { message: roleInspectText(options, role, harness), level: "info" };
  if (verb === "edit") return roleEdit(options, ctx, role, harness);
  if (verb === "enable" || verb === "disable") return roleToggle(role, harness, verb === "enable");
  if (verb === "set") return roleSet(role, harness, parsed);
  if (verb === "reset") return roleReset(ctx, role, harness, parsed);
  return roleDelete(ctx, role, harness);
}

function summarizeUnknown(value: unknown, limit = 2000): string {
  try {
    const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
    return text.length > limit ? `${text.slice(0, limit)}\n… (truncated)` : text;
  } catch {
    return String(value);
  }
}

async function settingsEdit(options: ExternalCommandOptions, ctx: ExtensionCommandContext): Promise<void> {
  if (!ctx.hasUI || typeof ctx.ui.editor !== "function") {
    ctx.ui.notify("Settings editing requires interactive or RPC UI with an editor.", "error");
    return;
  }
  const agentDir = getAgentDir();
  let current: string;
  try {
    current = readFileSync(options.settings.path, "utf8");
  } catch {
    current = `${JSON.stringify(options.settings.settings, null, 2)}\n`;
  }
  const edited = await ctx.ui.editor("external config", current);
  if (edited === undefined) {
    ctx.ui.notify("Settings edit cancelled. Nothing was saved.", "info");
    return;
  }
  if (edited === current) {
    ctx.ui.notify("Settings unchanged.", "info");
    return;
  }
  let record: unknown;
  try {
    record = JSON.parse(edited);
  } catch (error) {
    ctx.ui.notify(`Settings not saved: edited text is not valid JSON (${error instanceof Error ? error.message : String(error)}).`, "error");
    return;
  }
  // Explicit editor repair: a guided full replacement may overwrite a
  // malformed or v4-invalid current file. Valid pre-v4 installations and
  // future versions are still rejected — those go through
  // /external config convert, not the editor.
  const save = options.saveSettings ?? saveExternalSettings;
  try {
    const path = save(agentDir, record, { repair: true });
    ctx.ui.notify(`Settings saved to ${path}. Values apply from the next invocation; frozen workflows keep their prior snapshot. Concurrency changes wait for active/queued runs to drain.`, "info");
  } catch (error) {
    ctx.ui.notify(`Settings not saved: ${error instanceof Error ? error.message : String(error)}`, "error");
  }
}

function formatUpgradePreview(plan: ReturnType<typeof planConfigUpgrade>): string {
  if (plan.status !== "ready" || !plan.settings) return plan.diagnostics.join(" ");
  const lines = [
    "Configuration conversion preview (one-time; original files stay in place as the recovery copy):",
    `Settings: ${plan.settingsPath}`,
    JSON.stringify(plan.settings, null, 2),
  ];
  const list = (title: string, items: string[]) => {
    if (!items.length) return;
    lines.push(`${title} (${items.length}):`);
    const shown = items.slice(0, 20);
    for (const item of shown) lines.push(`- ${item}`);
    if (items.length > shown.length) lines.push(`- … and ${items.length - shown.length} more`);
  };
  list("Override copies", plan.overrides.map((override) => `${override.name} (${override.reason})`));
  list("Disabled seeded identities", plan.disabledProfiles);
  list("Unchanged defaults (no copy needed)", plan.unchangedDefaults);
  list("Excluded native/contradictory profiles", plan.excludedProfiles);
  list("Notes", plan.notes);
  const preserved = Object.keys(plan.preservedFields);
  if (preserved.length) lines.push(`Preserved unknown fields: ${preserved.join(", ")}`);
  return lines.join("\n");
}

async function settingsConvert(ctx: ExtensionCommandContext): Promise<void> {
  const agentDir = getAgentDir();
  const v5 = planV5Upgrade(agentDir);
  if (v5.status === 'ready') {
    const preview = [`Settings v4 → v5: ${v5.settingsPath}`, JSON.stringify(v5.settings, null, 2), 'Instruction copies:', ...v5.copies.map(f => `${f.sourcePath} → ${f.destinationPath}`), 'Original snapshot:', ...v5.backups.map(f => f.destinationPath), ...v5.notes, ...v5.diagnostics].join('\n');
    if (!ctx.hasUI || typeof ctx.ui.confirm !== 'function') { ctx.ui.notify(`${preview}\nConversion requires interactive confirmation. Nothing was changed.`, 'warning'); return; }
    if (!await ctx.ui.confirm('Apply v5 configuration conversion?', preview)) { ctx.ui.notify('Conversion cancelled. Nothing was changed.', 'info'); return; }
    const result = applyV5Upgrade(agentDir, v5.sourceDigest);
    ctx.ui.notify(result.status === 'applied' ? 'Converted to v5. Originals preserved; new calls use the new configuration. Running workflows keep their snapshot.' : `Conversion not activated: ${result.diagnostics.join(' ')}`, result.status === 'applied' ? 'info' : 'error');
    return;
  }
  if (v5.status === 'current') { ctx.ui.notify('Configuration is already version 5. Nothing to convert.', 'info'); return; }
  const plan = planConfigUpgrade(agentDir);
  if (v5.status === 'blocked' && (plan.status === 'current' || plan.status === 'empty')) { ctx.ui.notify(`v5 conversion blocked: ${v5.diagnostics.join(' ')}`, 'error'); return; }
  if (plan.status === "current") {
    ctx.ui.notify("Configuration is already version 4. Nothing to convert.", "info");
    return;
  }
  if (plan.status === "empty") {
    ctx.ui.notify("No legacy configuration found. Nothing to convert.", "info");
    return;
  }
  if (plan.status === "blocked" || !plan.settings) {
    ctx.ui.notify(`Configuration conversion is blocked:\n${plan.diagnostics.map((item) => `- ${item}`).join("\n")}`, "error");
    return;
  }
  const preview = formatUpgradePreview(plan);
  if (!ctx.hasUI || typeof ctx.ui.confirm !== "function") {
    ctx.ui.notify(`${summarizeUnknown(preview, 4000)}\n\nConversion needs interactive confirmation; rerun /external config convert with UI.`, "warning");
    return;
  }
  const confirmed = await ctx.ui.confirm(
    "Apply configuration conversion?",
    `${summarizeUnknown(preview, 4000)}\n\nOverride copies land first; settings.json version 4 activates last. Originals stay in place.`,
  );
  if (!confirmed) {
    ctx.ui.notify("Conversion cancelled. Nothing was written.", "info");
    return;
  }
  const result = applyConfigUpgrade(agentDir);
  if (result.status === "applied") {
    ctx.ui.notify(
      [
        `Conversion applied (legacy step): ${result.settingsPath} is now version 4. Run /external config convert again to preview the final v5 conversion.`,
        `Overrides installed: ${result.overridesInstalled.length}`,
        result.disabledProfiles.length ? `Disabled seeded identities: ${result.disabledProfiles.length}` : undefined,
        "Values apply from the next invocation; frozen workflows keep their prior snapshot.",
      ].filter((line): line is string => Boolean(line)).join("\n"),
      "info",
    );
    return;
  }
  ctx.ui.notify(
    `Conversion did not apply (${result.status}). Nothing was activated:\n${result.diagnostics.map((item) => `- ${item}`).join("\n")}`,
    result.status === "blocked" ? "error" : "warning",
  );
}

function formatPurgeCandidate(candidate: LegacyPurgeCandidate): string {
  return `${candidate.relativePath} · ${candidate.kind}${candidate.copied ? " · copied to overrides" : " · NOT copied to overrides"}`;
}

async function purgeOldFiles(ctx: ExtensionCommandContext): Promise<void> {
  const agentDir = getAgentDir();
  const plan = planLegacyPurge(agentDir);
  if (plan.status === "blocked") {
    ctx.ui.notify(`Purge is blocked:\n${plan.diagnostics.map((item) => `- ${item}`).join("\n")}`, "warning");
    return;
  }
  if (!plan.candidates.length) {
    ctx.ui.notify("No legacy files to purge. Repeat invocation is harmless.", "info");
    return;
  }
  // Nonstandard exact-only names stay out of the default inventory and are
  // listed separately for explicit selection, never blanket deletion.
  const inventory = plan.candidates.filter((candidate) => candidate.inventory);
  const nonstandard = plan.candidates.filter((candidate) => !candidate.inventory);
  const byPath = new Map(plan.candidates.map((candidate) => [candidate.path, candidate]));
  const describe = (title: string, items: LegacyPurgeCandidate[]): string => {
    if (!items.length) return "";
    return `${title}:\n${items.map((candidate) => `- ${formatPurgeCandidate(candidate)}`).join("\n")}`;
  };
  const listing = [describe("Purge inventory", inventory), describe("Nonstandard names (select explicitly)", nonstandard)]
    .filter(Boolean)
    .join("\n");
  if (!ctx.hasUI || typeof ctx.ui.select !== "function" || typeof ctx.ui.confirm !== "function") {
    ctx.ui.notify(`${listing}\n\nPurge needs interactive selection and confirmation; rerun /external [danger]purge-old-files with UI. Nothing was deleted.`, "warning");
    return;
  }
  // Explicit individual selection: nothing is preselected and there is no
  // select-all shortcut. Toggle entries one at a time, then delete.
  const selected = new Set<string>();
  while (true) {
    const toggleChoices = plan.candidates.map((candidate) =>
      `${selected.has(candidate.path) ? "✓" : "○"} ${formatPurgeCandidate(candidate)}`);
    const choice = await ctx.ui.select("Purge old files", [...toggleChoices, `Delete ${selected.size} selected`, "Back"]);
    if (!choice || choice === "Back") {
      ctx.ui.notify("Purge cancelled. Nothing was deleted.", "info");
      return;
    }
    if (choice.startsWith("Delete ")) {
      break;
    }
    const index = toggleChoices.indexOf(choice);
    const candidate = index === -1 ? undefined : plan.candidates[index];
    if (!candidate) continue;
    if (selected.has(candidate.path)) selected.delete(candidate.path);
    else selected.add(candidate.path);
  }
  if (!selected.size) {
    ctx.ui.notify("No files selected. Nothing was deleted.", "info");
    return;
  }
  const selection = [...selected].map((path) => ({ path, fingerprint: byPath.get(path)!.fingerprint }));
  const confirmed = await ctx.ui.confirm(
    `Delete ${selection.length} obsolete file(s)?`,
    `${selection.map((item) => `- ${byPath.get(item.path)!.relativePath}`).join("\n")}\n\nFiles changed since preview are skipped, never forced. Repeat invocation is harmless.`,
  );
  if (!confirmed) {
    ctx.ui.notify("Purge cancelled. Nothing was deleted.", "info");
    return;
  }
  const result = purgeLegacyFiles(agentDir, selection);
  const lines = [
    `Deleted: ${result.deleted.length}`,
    ...result.deleted.map((path) => `- ${path}`),
    ...result.skipped.map((item) => `Skipped ${item.path} (${item.reason})`),
    ...result.failed.map((item) => `Failed ${item.path}: ${item.reason}`),
    ...result.diagnostics.map((item) => `- ${item}`),
  ];
  ctx.ui.notify(lines.join("\n"), result.failed.length || result.status === "blocked" ? "warning" : "info");
}

async function doctorText(pi: ExtensionAPI, options: ExternalCommandOptions, ctx: ExtensionCommandContext): Promise<string> {
  const catalog = loadCatalogSnapshot(getAgentDir(), options);
  const harnessConfigs = catalog.harnessConfigs ?? loadHarnessConfigs(getAgentDir()).harnesses;
  const profiles = catalog.profiles;
  const disabled = disabledHarnessSet(catalog);
  const backends = [...new Set([...profiles.values()].map((profile) => profile.backend))].filter((backend) => backend !== "pi" && !disabled.has(backend));
  const defaultHarness = resolveCtxDefaultHarness(options.settings.settings.defaultHarness, ctx).harness;
  const defaultProblems = catalog.blocked ? [] : defaultHarnessProblems(catalog, defaultHarness);
  const settingsErrors = catalog.blocked
    ? [...options.settings.diagnostics, ...catalog.diagnostics]
    : [...options.settings.diagnostics.filter((message) => !message.startsWith("Unknown setting")), ...catalog.diagnostics];
  const lines = [
    settingsErrors.length
      ? `${catalog.blocked ? "✗" : "✗"} Settings/catalog: ${settingsErrors.join(" ")}`
      : options.settings.diagnostics.length
        ? `⚠ Settings: ${options.settings.diagnostics.join(" ")}`
        : "✓ Settings/catalog: valid",
    profiles.size ? `✓ Roles: ${profiles.size} execution identities` : "✗ Roles: none configured",
    ...defaultProblems.map((problem) => `✗ Default harness: ${problem}`),
  ];
  for (const backend of backends) {
    lines.push(await diagnoseCli(pi.exec.bind(pi), backend));
  }
  // Pi harnesses run in-process, not as a CLI: there is no subprocess to exec.
  // Confirm the registered model resolves and report configured auth instead.
  for (const [name, config] of harnessConfigs) {
    if (disabled.has(name)) continue;
    const separator = config.model.indexOf("/");
    const model = separator === -1 ? undefined : ctx.modelRegistry.find(config.model.slice(0, separator), config.model.slice(separator + 1));
    if (!model) {
      lines.push(`✗ ${name}: model "${config.model}" not found in the registry`);
      continue;
    }
    const preset = config.preset ?? "minimal";
    lines.push(ctx.modelRegistry.hasConfiguredAuth(model)
      ? `✓ ${name}: ${config.model} · ${preset} (auth configured)`
      : `⚠ ${name}: ${config.model} · ${preset} (no credentials configured)`);
    lines.push("  Requests not tested; provider authentication/routing follows Pi configuration.", "  Remaining allowance: unavailable (no quota request made)");
  }
  for (const name of [...disabled].sort()) lines.push(`○ ${name}: disabled (readiness not checked)`);
  lines.push(await usageLimitHistory(runRecordsDirectory(), ctx.cwd));
  return lines.join("\n");
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
type ExternalRunsResult = { content: Array<{ type: string; text?: string }>; details: JsonObject; structuredContent: JsonObject; isError?: boolean };

/** A returned external_runs failure, raised with its code so callers recover by code, never by message. */
class RunsActionError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

function object(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function pageText(value: ExternalRunsResult): string {
  return value.content.flatMap((item) => item.type === "text" && typeof item.text === "string" ? [item.text] : []).join("\n");
}

/** Reads the same public contract a script reads; a returned failure becomes a coded RunsActionError. */
async function runAction(options: ExternalCommandOptions, params: ExternalRunsParams, ctx: ExtensionCommandContext): Promise<JsonObject> {
  const result = await options.externalRuns.execute("external-command", params, undefined, undefined, ctx) as ExternalRunsResult;
  const contract = object(result.structuredContent);
  if (contract.ok !== true) {
    const error = object(contract.error);
    throw new RunsActionError(String(error.code ?? "failed"), String(error.message ?? pageText(result)));
  }
  return object(contract.data);
}

function isStale(error: unknown): boolean {
  return error instanceof RunsActionError && error.code === "cursor_stale";
}

/** Concatenates one cursor sequence of summary pages; a stale cursor restarts once from page 1. */
async function readSummary(options: ExternalCommandOptions, runId: string, ctx: ExtensionCommandContext, restarted = false): Promise<JsonObject> {
  let text = "";
  let cursor: string | undefined;
  const seen = new Set<string>();
  try {
    do {
      const page = object((await runAction(options, { action: "inspect", runId, view: "summary", ...(cursor ? { cursor } : {}) }, ctx)).page);
      text += typeof page.text === "string" ? page.text : "";
      cursor = typeof page.nextCursor === "string" ? page.nextCursor : undefined;
      if (cursor && seen.has(cursor)) throw new Error("Run inspection returned a repeated cursor");
      if (cursor) seen.add(cursor);
    } while (cursor);
  } catch (error) {
    if (!restarted && cursor && isStale(error)) return readSummary(options, runId, ctx, true);
    throw error;
  }
  return object(JSON.parse(text));
}

async function showPages(options: ExternalCommandOptions, runId: string, view: "output" | "diagnostics" | "final" | "launch", ctx: ExtensionCommandContext): Promise<void> {
  let cursor: string | undefined;
  do {
    let data: JsonObject;
    try {
      data = await runAction(options, { action: "inspect", runId, view, ...(cursor ? { cursor } : {}) }, ctx);
    } catch (error) {
      if (!cursor || !isStale(error)) throw error;
      ctx.ui.notify("Run changed while reading. Reopening the latest snapshot from page 1.", "info");
      cursor = undefined;
      data = await runAction(options, { action: "inspect", runId, view }, ctx);
    }
    // The tool's `final` projection is deliberately a clean, narration-free
    // canonical-answer surface: unavailable is a bounded EMPTY page with
    // finalAvailable:false (true for both an agent run and a workflow — see
    // src/external-runs.ts), not a synthesized sentence in the page text.
    // Turning that into a human-readable notice belongs here, at the UI
    // boundary, for both run kinds alike — otherwise this would open an
    // editor with nothing informative in it.
    if (view === "final" && data.finalAvailable !== true) {
      ctx.ui.notify(`No verified final answer is available yet for ${runId}.`, "info");
      return;
    }
    const page = object(data.page);
    const text = typeof page.text === "string" ? page.text : "";
    await ctx.ui.editor(`${view} ${runId}`, text || `No ${view} is available for ${runId}.`);
    const next = typeof page.nextCursor === "string" ? page.nextCursor : undefined;
    if (!next || await ctx.ui.select(`${view} ${runId}`, ["Next page", "Back"]) !== "Next page") return;
    cursor = next;
  } while (cursor);
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
  let summary: JsonObject;
  try {
    summary = await readSummary(options, runId, ctx);
  } catch (error) {
    if (!(error instanceof RunsActionError)) throw error;
    ctx.ui.notify(`Could not inspect ${runId}: ${error.message}`, "warning");
    return;
  }
  const observedAt = new Date().toISOString();
  const children = Array.isArray(summary.children) ? summary.children.map(object).filter((child) => typeof child.runId === "string") : [];
  const state = object(summary.state);
  const childChoices = children.map((child) => `Child ${String(child.runId)}${child.label ? ` · ${String(child.label)}` : ""}`);
  const actions = ["Refresh", "Launch", "Summary", "Output", "Final", "Diagnostics", ...childChoices, ...(state.status === "running" || state.status === "queued" ? ["Cancel run"] : []), "Back"];
  while (true) {
    const choice = await ctx.ui.select(`Run ${runId}`, actions);
    if (!choice || choice === "Back") return;
    if (choice === "Refresh") return navigateRun(options, runId, ctx);
    if (choice === "Summary") await ctx.ui.editor(`summary ${runId}`, `Snapshot ${observedAt} · Refresh for current state\n${formatSummaryHeader(summary)}\n\n${JSON.stringify(summary, null, 2)}`);
    else if (choice === "Launch" || choice === "Output" || choice === "Final" || choice === "Diagnostics") {
      try {
        await showPages(options, runId, choice.toLowerCase() as "output" | "final" | "diagnostics" | "launch", ctx);
      } catch (error) {
        if (!(error instanceof RunsActionError)) throw error;
        ctx.ui.notify(`Could not read ${choice.toLowerCase()} for ${runId}: ${error.message}`, "warning");
      }
    } else if (choice === "Cancel run") {
      if (await ctx.ui.confirm("Cancel external run?", `${runId}\n\nStopping execution does not roll back side effects.`)) {
        try {
          const result = await runAction(options, { action: "cancel", runId, reason: "cancelled from /external runs" }, ctx);
          ctx.ui.notify(result.status === "requested" ? `Cancellation requested for ${runId}.` : `${runId} is already terminal.`, "info");
        } catch (error) {
          if (!(error instanceof RunsActionError)) throw error;
          ctx.ui.notify(`Could not cancel ${runId}: ${error.message}`, "warning");
        }
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
    const details = await runAction(options, {
      action: "list",
      limit: 50,
      ...(pageKind === "runs" && cursor ? { cursor } : {}),
      ...(pageKind === "workflows" && workflowCursor ? { workflowCursor } : {}),
    }, ctx);
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
    description: "Inspect external roles and runs; configure CLI and named Pi harnesses",
    getArgumentCompletions: (prefix) => {
      const normalized = prefix.trimStart().toLowerCase();
      const nameArg = /^config (harness|role) (\S+) (\S*)$/.exec(normalized);
      if (nameArg && nameArg[2] !== "list" && nameArg[2] !== "assist") {
        const names = nameArg[1] === "harness" ? knownHarnessNames(getAgentDir()) : completionRoleNames();
        const matches = names.filter((name) => name.startsWith(nameArg[3]!));
        return matches.length ? matches.map((name) => ({ value: `config ${nameArg[1]} ${nameArg[2]} ${name}`, label: name })) : null;
      }
      const matches = COMMANDS.filter((command) => command.value.startsWith(normalized.trim()));
      return matches.length ? matches.map((command) => ({ ...command, label: command.value })) : null;
    },
    handler: async function handleExternal(args, ctx) {
      const action = args.trim().toLowerCase();
      const tokens = tokenizeArgs(args.trim());
      if ((!action || action === 'config') && ctx.hasUI && (ctx.mode === 'tui' || ctx.mode === 'rpc')) {
        await openConfigHub(pi, ctx, { getThinkingLevel: options.getThinkingLevel, testHarness: options.testHarness, runCommand: handleExternal });
      } else if (!action) {
        ctx.ui.notify(overviewText(options, ctx), "info");
      } else if (action === "doctor") {
        ctx.ui.notify(await doctorText(pi, options, ctx), "info");
      } else if (action === "config" || action === 'config text') {
        const config = configText(options, ctx);
        ctx.ui.notify(config.text, config.warn ? "warning" : "info");
      } else if (action === "config edit") {
        await settingsEdit(options, ctx);
      } else if (action === "config convert") {
        await settingsConvert(ctx);
      } else if (tokens[0]?.toLowerCase() === "config" && (tokens[1]?.toLowerCase() === "harness" || tokens[1]?.toLowerCase() === "role")) {
        const notice = tokens[1].toLowerCase() === "harness"
          ? await harnessCommand(pi, options, ctx, tokens.slice(2))
          : await roleCommand(options, ctx, tokens.slice(2));
        if (notice) ctx.ui.notify(notice.message, notice.level);
      } else if (action === "[danger]purge-old-files") {
        await purgeOldFiles(ctx);
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
        ctx.ui.notify(usageText(), "warning");
      }
    },
  });
}
