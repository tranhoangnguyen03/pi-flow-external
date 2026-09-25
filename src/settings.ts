import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, readdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { HARNESS_NAME_PATTERN, parseHarnessEntry, VALID_THINKING_LEVELS, type HarnessConfig } from "./harnesses.ts";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { EXTERNAL_HARNESSES, PI_RESOURCE_PRESETS, type ExternalHarness, type PermissionTier, type SubagentExtensionOptions } from "./types.ts";

export const DEFAULT_EXTERNAL_SETTINGS = {
  version: 4,
  defaultHarness: "agy" as string,
  maxConcurrentSubagents: 12,
  subagentTimeoutMs: 2 * 60 * 60 * 1000,
  defaultPermission: "danger" as PermissionTier,
  defaultMaxBudgetUsd: null as number | null,
  maxRunRecords: 200,
} as const;

export type ExternalSettings = {
  version: 4;
  harnesses?: Record<string, HarnessConfig>;
  disabledProfiles?: string[];
  /** Harness names (CLI or `pi-*`) excluded from selection. Definitions stay in place; unknown names are preserved. */
  disabledHarnesses?: string[];
  /** One of EXTERNAL_HARNESSES, or a `pi-*` name (shape-validated here; live registry membership is checked at delegation time, not here). */
  defaultHarness: string;
  maxConcurrentSubagents: number;
  subagentTimeoutMs: number;
  defaultPermission: PermissionTier;
  defaultMaxBudgetUsd: number | null;
  maxRunRecords: number;
};

export type LoadedExternalSettings = {
  path: string;
  settings: ExternalSettings;
  diagnostics: string[];
  blocked?: boolean;
  upgradeRequired?: boolean;
};

const KNOWN_SETTING_KEYS = [
  "version",
  "harnesses",
  "disabledProfiles",
  "disabledHarnesses",
  "defaultHarness",
  "maxConcurrentSubagents",
  "subagentTimeoutMs",
  "defaultPermission",
  "defaultMaxBudgetUsd",
  "maxRunRecords",
];

const PERMISSION_TIERS: PermissionTier[] = ["readonly", "edit", "danger"];
export function externalSettingsPath(agentDir: string): string {
  return join(agentDir, "pi-flow-external", "settings.json");
}

function defaults(): ExternalSettings {
  return { ...DEFAULT_EXTERNAL_SETTINGS };
}

function isPermissionTier(value: unknown): value is PermissionTier {
  return typeof value === "string" && PERMISSION_TIERS.includes(value as PermissionTier);
}

function isExternalHarness(value: unknown): value is ExternalHarness {
  return typeof value === "string" && EXTERNAL_HARNESSES.includes(value as ExternalHarness);
}

/**
 * Shape-only validation for a `defaultHarness` selector: one of the five
 * external CLI harnesses, or a `pi-*` name matching the named-Pi-harness
 * registry's key pattern. This is pure and synchronous, matching
 * parseSettings's existing contract; whether a named `pi-*` harness is
 * actually registered is a live-registry question resolved at delegation
 * time by the caller, not here.
 */
function isValidHarnessSelectorShape(value: unknown): value is string {
  return isExternalHarness(value) || (typeof value === "string" && HARNESS_NAME_PATTERN.test(value));
}

/** Parse the canonical v4 shape. Diagnostics retain defaults for inspection;
 * the loader blocks execution on invalid global settings. Reads never convert files.
 */
export function parseSettings(value: unknown): { settings: ExternalSettings; diagnostics: string[] } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { settings: defaults(), diagnostics: ["Settings must be a JSON object."] };
  }
  const record = value as Record<string, unknown>;
  const diagnostics: string[] = [];
  if (record.version !== 4) {
    diagnostics.push("Settings require version 4. Run /external config convert for an older installation.");
  }
  for (const key of Object.keys(record)) {
    if (key === "piCapabilitySets") {
      diagnostics.push('Obsolete setting "piCapabilitySets" is ignored. Named capability sets are not used. Pi skills follow the harness preset (minimal or skills).');
      continue;
    }
    if (!KNOWN_SETTING_KEYS.includes(key)) {
      diagnostics.push(`Unknown setting "${key}".`);
    }
  }

  const settings = defaults();
  if (isValidHarnessSelectorShape(record.defaultHarness)) {
    settings.defaultHarness = record.defaultHarness;
  } else if (record.defaultHarness !== undefined) {
    diagnostics.push(`defaultHarness must be one of: ${EXTERNAL_HARNESSES.join(", ")}, or a registered pi-* harness name.`);
  }
  if (Number.isInteger(record.maxConcurrentSubagents) && Number(record.maxConcurrentSubagents) >= 1) {
    settings.maxConcurrentSubagents = record.maxConcurrentSubagents as number;
  } else if (record.maxConcurrentSubagents !== undefined) {
    diagnostics.push("maxConcurrentSubagents must be a positive integer.");
  }
  if (Number.isInteger(record.subagentTimeoutMs) && Number(record.subagentTimeoutMs) >= 0) {
    settings.subagentTimeoutMs = record.subagentTimeoutMs as number;
  } else if (record.subagentTimeoutMs !== undefined) {
    diagnostics.push("subagentTimeoutMs must be a non-negative integer.");
  }
  if (isPermissionTier(record.defaultPermission)) {
    settings.defaultPermission = record.defaultPermission;
  } else if (record.defaultPermission !== undefined) {
    diagnostics.push("defaultPermission must be readonly, edit, or danger.");
  }
  if (record.defaultMaxBudgetUsd === null || record.defaultMaxBudgetUsd === undefined) {
    // default: unlimited
  } else if (typeof record.defaultMaxBudgetUsd === "number" && record.defaultMaxBudgetUsd > 0) {
    settings.defaultMaxBudgetUsd = record.defaultMaxBudgetUsd;
  } else {
    diagnostics.push("defaultMaxBudgetUsd must be null or a positive number.");
  }
  if (Number.isInteger(record.maxRunRecords) && Number(record.maxRunRecords) >= 0) {
    settings.maxRunRecords = record.maxRunRecords as number;
  } else if (record.maxRunRecords !== undefined) {
    diagnostics.push("maxRunRecords must be a non-negative integer (0 keeps records forever).");
  }

  if (record.harnesses !== undefined) {
    if (!record.harnesses || typeof record.harnesses !== "object" || Array.isArray(record.harnesses)) diagnostics.push("harnesses must be an object.");
    else {
      settings.harnesses = {};
      for (const [name, raw] of Object.entries(record.harnesses)) {
        const config = parseHarnessEntry(name, raw);
        if (config) settings.harnesses[name] = config;
        else diagnostics.push(`Invalid harness "${name}" in settings.json: use a pi-* name, provider/model, thinking: ${VALID_THINKING_LEVELS.join(", ")}, and preset: ${PI_RESOURCE_PRESETS.join(" or ")}.`);
      }
    }
  }
  if (record.disabledProfiles !== undefined) {
    if (!Array.isArray(record.disabledProfiles) || record.disabledProfiles.some(v => typeof v !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(v))) diagnostics.push("disabledProfiles must be an array of execution identity names.");
    else settings.disabledProfiles = [...new Set(record.disabledProfiles as string[])];
  }
  if (record.disabledHarnesses !== undefined) {
    if (!Array.isArray(record.disabledHarnesses) || record.disabledHarnesses.some(v => typeof v !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(v))) diagnostics.push("disabledHarnesses must be an array of harness names.");
    else settings.disabledHarnesses = [...new Set(record.disabledHarnesses as string[])];
  }
  return { settings, diagnostics };
}

export function loadExternalSettings(agentDir: string): LoadedExternalSettings {
  const path = externalSettingsPath(agentDir);
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    const parsed = parseSettings(raw);
    return { path, ...parsed, blocked: parsed.diagnostics.some(d => !d.startsWith("Unknown setting") && !d.startsWith("Obsolete setting") && !d.startsWith("Invalid harness")), upgradeRequired: [1, 2, 3].includes(raw?.version) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      try {
        const legacyDir = join(agentDir, "subagents");
        const legacy = existsSync(join(agentDir, "pi-flow-external", "harnesses.json")) || (existsSync(legacyDir) && readdirSync(legacyDir).some(name => {
          if (/^\.pi-flow-defaults-seeded-v[123]$/.test(name)) return true;
          if (!name.endsWith(".md")) return false;
          try {
            const { frontmatter } = parseFrontmatter<Record<string, unknown>>(readFileSync(join(legacyDir, name), "utf8"));
            return EXTERNAL_HARNESSES.includes(frontmatter.backend as ExternalHarness) || (frontmatter.backend === "pi" && typeof frontmatter.harness === "string" && (frontmatter.harness === "pi-*" || name.startsWith(`${frontmatter.harness}-`)));
          } catch { return /^(agy|claude|codex|grok|muse)-/.test(name); }
        }));
        return { path, settings: defaults(), blocked: legacy, upgradeRequired: legacy, diagnostics: legacy ? ["Legacy configuration found. Run /external config convert."] : [] };
      } catch (probeError) {
        return { path, settings: defaults(), blocked: true, diagnostics: [`Could not inspect legacy configuration: ${String(probeError)}`] };
      }
    }
    return { path, settings: defaults(), blocked: true, diagnostics: [`Could not read settings: ${error instanceof SyntaxError ? "not valid JSON" : error instanceof Error ? error.message : String(error)}`] };
  }
}

/** One canonical private atomic writer. Unknown keys are retained by callers' read-modify-write. */
export function saveExternalSettings(agentDir: string, record: unknown, options: { repair?: boolean } = {}): string {
  const parsed = parseSettings(record);
  const errors = parsed.diagnostics.filter(d => !d.startsWith("Unknown setting"));
  if (errors.length) throw new Error(errors.join(" "));
  const current = loadExternalSettings(agentDir);
  if (current.blocked) {
    let existing: unknown;
    try { existing = JSON.parse(readFileSync(current.path, "utf8")); } catch { /* Explicit editor repair can replace malformed JSON. */ }
    const version = existing && typeof existing === "object" ? (existing as Record<string, unknown>).version : undefined;
    if (!options.repair || current.upgradeRequired || (version !== undefined && version !== 4)) throw new Error(current.diagnostics.join(" "));
  }
  const path = externalSettingsPath(agentDir);
  mkdirSync(join(agentDir, "pi-flow-external"), { recursive: true });
  const staged = `${path}.${randomUUID()}.staged`;
  try {
    writeFileSync(staged, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(staged, path);
  } finally {
    try { unlinkSync(staged); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return path;
}

/** Validated read-modify-write: unrelated fields are preserved; blocked, malformed, or future-version files are refused. */
export function updateExternalSettings(agentDir: string, mutate: (record: Record<string, unknown>) => Record<string, unknown>): string {
  const current = loadExternalSettings(agentDir);
  if (current.blocked) throw new Error(current.diagnostics.join(" "));
  const raw: Record<string, unknown> = existsSync(current.path) ? JSON.parse(readFileSync(current.path, "utf8")) : { ...DEFAULT_EXTERNAL_SETTINGS };
  return saveExternalSettings(agentDir, mutate(raw));
}

export function resolveExternalSettings(
  settings: ExternalSettings,
  options: Pick<SubagentExtensionOptions, "maxConcurrentSubagents" | "subagentTimeoutMs">,
): Pick<ExternalSettings, "maxConcurrentSubagents" | "subagentTimeoutMs"> {
  return {
    maxConcurrentSubagents: options.maxConcurrentSubagents ?? settings.maxConcurrentSubagents,
    subagentTimeoutMs: options.subagentTimeoutMs ?? settings.subagentTimeoutMs,
  };
}

/**
 * Trusted-project default-harness override (issue #26). The project file is
 * read-only for the extension, supports `defaultHarness` only, and is honored
 * only after Pi marks the project trusted. Precedence everywhere:
 * explicit call harness > trusted project default > global default.
 */
export const PROJECT_SETTINGS_RELATIVE_PATH = join(".pi", "pi-flow-external", "settings.json");

export function projectExternalSettingsPath(cwd: string): string {
  return join(cwd, PROJECT_SETTINGS_RELATIVE_PATH);
}

export interface EffectiveDefaultHarness {
  harness: string;
  source: "project" | "global";
  projectPath?: string;
  diagnostics: string[];
}

function parseProjectSettings(cwd: string): {
  record: Record<string, unknown> | undefined;
  path: string;
  diagnostics: string[];
} {
  const path = projectExternalSettingsPath(cwd);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { record: undefined, path, diagnostics: [] };
    }
    return {
      record: undefined,
      path,
      diagnostics: [`Could not read project settings ${path}: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { record: undefined, path, diagnostics: [`Project settings ${path} are not valid JSON.`] };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { record: undefined, path, diagnostics: [`Project settings ${path} must be a JSON object.`] };
  }
  const record = parsed as Record<string, unknown>;
  const diagnostics = Object.keys(record).flatMap((key) => {
    if (key === "defaultHarness") return [];
    if (key === "piCapabilitySets") {
      return [`Obsolete project setting "piCapabilitySets" at ${path} is ignored. Named capability sets are not used.`];
    }
    return [`Unknown project setting "${key}". Only defaultHarness is supported in project settings.`];
  });
  return { record, path, diagnostics };
}

export function resolveDefaultHarness(
  global: string,
  cwd: string,
  projectTrusted: boolean,
): EffectiveDefaultHarness {
  const path = projectExternalSettingsPath(cwd);
  if (!existsSync(path)) {
    return { harness: global, source: "global", diagnostics: [] };
  }
  if (!projectTrusted) {
    return {
      harness: global,
      source: "global",
      diagnostics: [`Project settings found at ${path} but ignored: project is not trusted.`],
    };
  }
  const project = parseProjectSettings(cwd);
  const diagnostics = [...project.diagnostics];
  const requested = project.record?.defaultHarness;
  if (requested === undefined) {
    return { harness: global, source: "global", projectPath: project.path, diagnostics };
  }
  if (isValidHarnessSelectorShape(requested)) {
    return { harness: requested, source: "project", projectPath: project.path, diagnostics };
  }
  diagnostics.push(`Project defaultHarness must be one of: ${EXTERNAL_HARNESSES.join(", ")}, or a registered pi-* harness name. Using the global default.`);
  return { harness: global, source: "global", projectPath: project.path, diagnostics };
}

let lastResolvedDefaultHarness: { cwd: string; value: EffectiveDefaultHarness } | undefined;

/** Resolve with a live extension context and remember it for render paths. */
export function resolveCtxDefaultHarness(
  global: string,
  ctx: { cwd: string; isProjectTrusted?: () => boolean },
): EffectiveDefaultHarness {
  let trusted = false;
  try {
    trusted = ctx.isProjectTrusted?.() ?? false;
  } catch {
    trusted = false;
  }
  const value = resolveDefaultHarness(global, ctx.cwd, trusted);
  lastResolvedDefaultHarness = { cwd: ctx.cwd, value };
  return value;
}

/**
 * Render contexts carry the cwd but no trust signal; recall the last
 * context-resolved value for that cwd (before_agent_start always resolves
 * before the first Agent render) and fall back to the global default.
 */
export function renderDefaultHarness(global: string, cwd: string): string {
  return lastResolvedDefaultHarness?.cwd === cwd ? lastResolvedDefaultHarness.value.harness : global;
}
