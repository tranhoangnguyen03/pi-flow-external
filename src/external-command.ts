import { existsSync, mkdirSync, readFileSync, writeFileSync, linkSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { isValidSubagentName, loadExternalCatalog } from "./profiles.ts";
import { isValidHarnessName, loadHarnessConfigs } from "./harnesses.ts";
import { saveExternalSettings } from "./settings.ts";
import { projectExternalSettingsPath, resolveCtxDefaultHarness, type LoadedExternalSettings } from "./settings.ts";
import { compileProfile } from "./profile-creator.ts";
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

const COMMANDS = [
  { value: "doctor", description: "Validate config/catalog and report runtime readiness" },
  { value: "settings", description: "Show effective extension settings" },
  { value: "settings edit", description: "Edit and validate canonical settings with the standard editor" },
  { value: "settings convert", description: "Preview and apply the one-time v4 configuration conversion" },
  { value: "harnesses", description: "List CLI and named Pi harnesses" },
  { value: "harness create", description: "Register a named Pi harness" },
  { value: "roles", description: "List built-in and user roles" },
  { value: "role create", description: "Author a reusable role" },
  { value: "role inspect", description: "Show effective instructions for a role" },
  { value: "role override", description: "Materialize one intentional full override" },
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

function helpText(): string {
  return [
    "External harness commands:",
    "/external — show status",
    ...COMMANDS.map((command) => `/external ${command.value} — ${command.description}`),
  ].join("\n");
}

function usageText(): string {
  return `Usage: ${COMMANDS.map((command) => `/external ${command.value}`).join(" | ")}`;
}

export function loadCatalogSnapshot(agentDir: string, options?: Pick<ExternalCommandOptions, "getCatalog">): ExternalCatalog {
  if (options?.getCatalog) {
    return options.getCatalog(agentDir);
  }
  return loadExternalCatalog(agentDir);
}

function knownHarnessNames(agentDir: string): string[] {
  const { harnesses } = loadHarnessConfigs(agentDir);
  return [...EXTERNAL_HARNESSES_LIST as readonly string[], ...harnesses.keys()];
}

function roleSuffix(profileName: string, harnessName: string): string | undefined {
  const prefix = `${harnessName}-`;
  return profileName.startsWith(prefix) && profileName.length > prefix.length
    ? profileName.slice(prefix.length)
    : undefined;
}

function groupByRole(profiles: ReadonlyMap<string, SubagentProfile>, harnessNames: readonly string[]): Map<string, { harnesses: string[]; profiles: SubagentProfile[] }> {
  const groups = new Map<string, { harnesses: string[]; profiles: SubagentProfile[] }>();
  for (const profile of profiles.values()) {
    const candidates = [profile.harness, profile.backend, ...harnessNames].filter((name): name is string => Boolean(name));
    let role: string | undefined;
    let usedHarness = "";
    for (const harness of candidates) {
      const suffix = roleSuffix(profile.name, harness);
      if (suffix) {
        role = suffix;
        usedHarness = profile.harness ?? (harness === profile.backend ? harness : profile.backend);
        break;
      }
    }
    const key = role ?? profile.name;
    const harnessLabel = usedHarness || profile.harness || profile.backend;
    const group = groups.get(key) ?? { harnesses: [], profiles: [] };
    if (!group.harnesses.includes(harnessLabel)) group.harnesses.push(harnessLabel);
    group.profiles.push(profile);
    groups.set(key, group);
  }
  return groups;
}

function formatHarnessesLine(harnessConfigs: ReadonlyMap<string, import("./harnesses.ts").HarnessConfig>): string {
  if (harnessConfigs.size === 0) return "Pi harnesses: none configured";
  const entries = [...harnessConfigs]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, config]) => `${name} (${config.model} · ${config.thinking === "off" ? "default thinking" : config.thinking})`);
  return `Pi harnesses: ${entries.join(", ")}`;
}

function catalogProblems(catalog: ExternalCatalog): string[] {
  return catalog.blocked
    ? [`Configuration is blocked: ${catalog.diagnostics.join(" ") || "the external catalog could not be composed."}`]
    : [...catalog.diagnostics];
}

function settingsText(options: ExternalCommandOptions, ctx: CommandContextLike): string {
  const effective = options.getRuntimeSettings();
  const settings = options.settings.settings;
  const harness = resolveCtxDefaultHarness(settings.defaultHarness, ctx);
  const harnessSource = harness.source === "project"
    ? ` (project: ${harness.projectPath})`
    : " (global)";
  const catalog = loadCatalogSnapshot(getAgentDir(), options);
  const harnessConfigs = catalog.harnessConfigs ?? loadHarnessConfigs(getAgentDir()).harnesses;
  const staleDefault = !(EXTERNAL_HARNESSES_LIST as readonly string[]).includes(harness.harness) && ![...catalog.profiles.values()].some((profile) => (profile.harness ?? profile.backend) === harness.harness) && !harnessConfigs.has(harness.harness)
    ? [`Configured default harness "${harness.harness}" is not currently registered.`]
    : [];
  const upgradePlan = planConfigUpgrade(getAgentDir());
  const upgradeHint = upgradePlan.status === "ready"
    ? ["A one-time configuration conversion is ready: run /external settings convert to preview it."]
    : upgradePlan.status === "blocked"
      ? ["Configuration conversion is blocked:", ...upgradePlan.diagnostics.map((item) => `- ${item}`)]
      : [];
  const warnings = [...options.settings.diagnostics, ...harness.diagnostics, ...catalogProblems(catalog), ...staleDefault, ...upgradeHint];
  return [
    `maxConcurrentSubagents: ${effective.maxConcurrentSubagents}`,
    `subagentTimeoutMs: ${effective.subagentTimeoutMs}`,
    `defaultHarness: ${harness.harness}${harnessSource}`,
    `defaultPermission: ${settings.defaultPermission}`,
    `defaultMaxBudgetUsd: ${settings.defaultMaxBudgetUsd === null ? "unlimited" : settings.defaultMaxBudgetUsd}`,
    `maxRunRecords: ${settings.maxRunRecords}${settings.maxRunRecords === 0 ? " (keep forever)" : ""}`,
    formatHarnessesLine(harnessConfigs),
    `Settings: ${options.settings.path}`,
    `Project override: ${projectExternalSettingsPath(ctx.cwd)} (trusted projects only; defaultHarness only)`,
    ...(warnings.length ? ["Warnings:", ...warnings.map((item) => `- ${item}`)] : []),
    "Edit via /external settings edit, then run /reload. CLI flags override file values.",
  ].join("\n");
}

function overviewText(options: ExternalCommandOptions, ctx: CommandContextLike): string {
  const settings = options.settings.settings;
  const harness = resolveCtxDefaultHarness(settings.defaultHarness, ctx);
  const harnessSource = harness.source === "project" ? "project" : "global";
  const agentDir = getAgentDir();
  const catalog = loadCatalogSnapshot(agentDir, options);
  const harnesses = catalog.harnessConfigs ?? loadHarnessConfigs(agentDir).harnesses;
  const groups = groupByRole(catalog.profiles, knownHarnessNames(agentDir));
  const problems = [...options.settings.diagnostics, ...harness.diagnostics, ...catalogProblems(catalog)];
  return [
    "External agents",
    `Default: ${harness.harness} (${harnessSource})`,
    `Roles: ${groups.size} known${problems.length ? " · configuration has warnings (see /external doctor)" : ""}`,
    `Harnesses: ${EXTERNAL_HARNESSES_LIST.length} CLI · ${harnesses.size} named Pi`,
    `Settings: ${options.settings.path}`,
    ...(problems.length ? ["Problems:", ...problems.map((item) => `- ${item}`)] : []),
  ].join("\n");
}

function harnessesText(options: ExternalCommandOptions): string {
  const catalog = loadCatalogSnapshot(getAgentDir(), options);
  const harnessConfigs = catalog.harnessConfigs ?? loadHarnessConfigs(getAgentDir()).harnesses;
  const lines = [
    `CLI harnesses: ${(EXTERNAL_HARNESSES_LIST as readonly string[]).join(", ")} (readiness is separate; see /external doctor)`,
    formatHarnessesLine(harnessConfigs),
  ];
  if (catalog.diagnostics.length) lines.push("Warnings:", ...catalog.diagnostics.map((item) => `- ${item}`));
  return lines.join("\n");
}

function rolesText(options: ExternalCommandOptions): string {
  const agentDir = getAgentDir();
  const catalog = loadCatalogSnapshot(agentDir, options);
  if (catalog.blocked) {
    return `Roles are unavailable: ${catalog.diagnostics.join(" ") || "the external catalog could not be composed."}`;
  }
  if (!catalog.profiles.size) return "No roles are available. Run /external role create to author one.";
  const groups = groupByRole(catalog.profiles, knownHarnessNames(agentDir));
  const lines = [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([role, group]) => `${role}: ${group.harnesses.length} harness(es) (${[...group.harnesses].sort((a, b) => a.localeCompare(b)).join(", ")})`);
  if (catalog.diagnostics.length) lines.push("Warnings:", ...catalog.diagnostics.map((item) => `- ${item}`));
  return lines.join("\n");
}

/** Real execution boundary per backend (AGENTS.md): advisory tiers are never presented as enforcement. */
function backendAuthority(backend: string, permission: string | undefined): string {
  if (backend === "agy") {
    return "agy runs unsandboxed (--dangerously-skip-permissions); readonly/edit are advisory profile-body instructions, not a boundary. Run only in trusted repositories.";
  }
  if (backend === "pi") {
    return `Pi SDK child · host access · curated tools · requested tier ${permission ?? "inherited"}; danger-tier bash is as exposed as on any external CLI.`;
  }
  if (backend === "claude") {
    return `Claude headless permission mode · requested tier ${permission ?? "inherited"}; execution lanes (implementer, qa, worker) keep a danger floor so shell authority is not handcuffed.`;
  }
  if (backend === "codex") {
    return `Codex --sandbox axis · requested tier ${permission ?? "inherited"}; never automatically retried by this extension.`;
  }
  if (backend === "grok") {
    return `Grok --sandbox axis (read-only/workspace/off) + bypassPermissions · requested tier ${permission ?? "inherited"}; readonly network-blocking is Linux-only.`;
  }
  return `Muse exec approvals bypassed headless · requested tier ${permission ?? "inherited"}; readonly adds --disable-write --disable-shell, danger uses --yolo (also trusts the workspace).`;
}

function findRoleCandidates(catalog: ExternalCatalog, role: string, harnessNames: readonly string[]): SubagentProfile[] {
  return [...catalog.profiles.values()].filter((profile) => {
    const candidates = [profile.harness, profile.backend, ...harnessNames].filter((name): name is string => Boolean(name));
    return candidates.some((harness) => roleSuffix(profile.name, harness) === role);
  });
}

function roleInspectText(options: ExternalCommandOptions, ctx: CommandContextLike, roleArg: string, harnessArg: string | undefined): string {
  const agentDir = getAgentDir();
  const catalog = loadCatalogSnapshot(agentDir, options);
  if (catalog.blocked) {
    return `Role inspection is unavailable: ${catalog.diagnostics.join(" ") || "the external catalog could not be composed."}`;
  }
  const role = roleArg.trim();
  if (!role) return "Usage: /external role inspect <role> [harness]";
  const harness = harnessArg?.trim() || resolveCtxDefaultHarness(options.settings.settings.defaultHarness, ctx).harness;
  const exact = catalog.profiles.get(`${harness}-${role}`);
  if (!exact) {
    const candidates = findRoleCandidates(catalog, role, knownHarnessNames(agentDir));
    if (candidates.length) {
      const names = candidates.map((profile) => profile.name).sort((a, b) => a.localeCompare(b)).join(", ");
      return `Role "${role}" is not bound to harness "${harness}". Available bindings: ${names}. Try /external role inspect ${role} <harness>.`;
    }
    return `Unknown role "${role}" on harness "${harness}". See /external roles (${catalog.profiles.size} execution identities known).`;
  }
  const instructions = (exact.systemPrompt ?? "").trim() || "(no authored instructions)";
  const bounded = instructions.length > 4000 ? `${instructions.slice(0, 4000)}\n… (truncated; full instructions are the stored profile body)` : instructions;
  return [
    `${exact.name}: ${exact.description}`,
    `Source: ${exact.source ?? "built-in"}`,
    ...(exact.configurationError ? [`Configuration error: ${exact.configurationError}`] : []),
    `Harness: ${exact.harness ?? exact.backend} · backend ${exact.backend}`,
    `Model: ${exact.model ?? "harness default"} · thinking ${exact.thinking ?? "inherited"} · permission floor ${exact.permission ?? "inherited"}`,
    backendAuthority(exact.backend === "pi" ? "pi" : exact.backend, exact.permission),
    "",
    bounded,
  ].join("\n");
}

function roleOverride(options: ExternalCommandOptions, roleArg: string, harnessArg: string | undefined): string {
  const agentDir = getAgentDir();
  const catalog = loadCatalogSnapshot(agentDir, options);
  if (catalog.blocked) {
    return `Role override is unavailable: ${catalog.diagnostics.join(" ") || "the external catalog could not be composed."}`;
  }
  const role = roleArg?.trim();
  const harness = harnessArg?.trim();
  if (!role || !harness) return "Usage: /external role override <role> <harness>";
  if (!isValidSubagentName(role)) return `Invalid role name ${JSON.stringify(role)}: use lowercase letters, numbers, and hyphens.`;
  if (!(EXTERNAL_HARNESSES_LIST as readonly string[]).includes(harness) && !isValidHarnessName(harness)) {
    return `Unknown harness ${JSON.stringify(harness)}: use one of ${(EXTERNAL_HARNESSES_LIST as readonly string[]).join(", ")}, or a registered pi-* harness.`;
  }
  const exact = catalog.profiles.get(`${harness}-${role}`);
  if (!exact) {
    return `Cannot materialize ${harness}-${role}: no effective role "${role}" is bound to harness "${harness}". See /external role inspect ${role}.`;
  }
  const dir = join(agentDir, "pi-flow-external", "overrides");
  const finalPath = join(dir, `${harness}-${role}.md`);
  if (existsSync(finalPath)) {
    return `Override ${harness}-${role} already exists at ${finalPath}; edit it directly. The existing override was not changed.`;
  }
  mkdirSync(dir, { recursive: true });
  if (existsSync(finalPath)) {
    return `Override ${harness}-${role} already exists at ${finalPath}; edit it directly. The existing override was not changed.`;
  }
  let content: string;
  try {
    content = compileProfile({ ...exact, name: `${harness}-${role}`, systemPrompt: (exact.systemPrompt ?? "").trim() || exact.description });
  } catch (error) {
    return `Cannot materialize ${harness}-${role}: ${error instanceof Error ? error.message : String(error)}`;
  }
  const stagedPath = `${finalPath}.${process.pid}.staged`;
  try {
    writeFileSync(stagedPath, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    linkSync(stagedPath, finalPath);
  } finally {
    if (existsSync(stagedPath)) unlinkSync(stagedPath);
  }
  return `Override ${harness}-${role} materialized at ${finalPath} as a complete replacement (not a merge). Values apply from the next invocation; frozen workflows keep their prior snapshot.`;
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
  const edited = await ctx.ui.editor("external settings", current);
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
  // /external settings convert, not the editor.
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
  const preserved = Object.keys(plan.preservedFields);
  if (preserved.length) lines.push(`Preserved unknown fields: ${preserved.join(", ")}`);
  return lines.join("\n");
}

async function settingsConvert(ctx: ExtensionCommandContext): Promise<void> {
  const agentDir = getAgentDir();
  const plan = planConfigUpgrade(agentDir);
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
    ctx.ui.notify(`${summarizeUnknown(preview, 4000)}\n\nConversion needs interactive confirmation; rerun /external settings convert with UI.`, "warning");
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
        `Conversion applied: ${result.settingsPath} is now version 4.`,
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
  const backends = [...new Set([...profiles.values()].map((profile) => profile.backend))].filter((backend) => backend !== "pi");
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
    description: "Inspect and configure external Claude, Codex, Agy, Grok, and Muse harnesses",
    getArgumentCompletions: (prefix) => {
      const normalized = prefix.trim().toLowerCase();
      const matches = COMMANDS.filter((command) => command.value.startsWith(normalized));
      return matches.length ? matches.map((command) => ({ ...command, label: command.value })) : null;
    },
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase();
      if (!action) {
        ctx.ui.notify(overviewText(options, ctx), "info");
      } else if (action === "doctor") {
        ctx.ui.notify(await doctorText(pi, options, ctx), "info");
      } else if (action === "settings") {
        const catalog = loadCatalogSnapshot(getAgentDir(), options);
        const warnings = options.settings.diagnostics.length || resolveCtxDefaultHarness(options.settings.settings.defaultHarness, ctx).diagnostics.length || catalog.diagnostics.length || catalog.blocked;
        ctx.ui.notify(settingsText(options, ctx), warnings ? "warning" : "info");
      } else if (action === "settings edit") {
        await settingsEdit(options, ctx);
      } else if (action === "settings convert") {
        await settingsConvert(ctx);
      } else if (action === "harnesses") {
        ctx.ui.notify(harnessesText(options), "info");
      } else if (action === "harness create") {
        await options.startHarnessInterview(ctx);
      } else if (action === "roles") {
        ctx.ui.notify(rolesText(options), "info");
      } else if (action === "role create") {
        await options.startRoleInterview(ctx);
      } else if (action === "role inspect" || action.startsWith("role inspect ")) {
        const rest = args.trim().slice("role inspect".length).trim().split(/\s+/).filter(Boolean);
        ctx.ui.notify(roleInspectText(options, ctx, rest[0] ?? "", rest[1]), "info");
      } else if (action === "role override" || action.startsWith("role override ")) {
        const rest = args.trim().slice("role override".length).trim().split(/\s+/).filter(Boolean);
        const message = roleOverride(options, rest[0] ?? "", rest[1]);
        ctx.ui.notify(message, message.startsWith("Override ") && message.includes("materialized") ? "info" : "warning");
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
