import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HARNESS_NAME_PATTERN } from "./harnesses.ts";
import { EXTERNAL_HARNESSES, type ExternalHarness, type PermissionTier, type SubagentExtensionOptions } from "./types.ts";

/**
 * A reusable, named selection of skills/prompt templates that a profile can
 * opt into via its `capabilitySet: <name>` frontmatter field (see
 * src/profiles.ts). Entries are exact resource names only — no booleans, no
 * wildcards, no arbitrary paths — so the set is always a closed, auditable
 * list rather than a generic "load everything" toggle. Absent from a profile
 * entirely, the default (builtins-only pi child, see src/core/spawn.ts) is
 * unchanged.
 */
export interface PiCapabilitySet {
  skills: string[];
  promptTemplates: string[];
}

export const DEFAULT_EXTERNAL_SETTINGS = {
  version: 3,
  defaultHarness: "agy" as string,
  maxConcurrentSubagents: 12,
  subagentTimeoutMs: 2 * 60 * 60 * 1000,
  defaultPermission: "danger" as PermissionTier,
  defaultMaxBudgetUsd: null as number | null,
  maxRunRecords: 200,
  piCapabilitySets: {} as Record<string, PiCapabilitySet>,
} as const;

export type ExternalSettings = {
  version: 3;
  /** One of EXTERNAL_HARNESSES, or a `pi-*` name (shape-validated here; live registry membership is checked at delegation time, not here). */
  defaultHarness: string;
  maxConcurrentSubagents: number;
  subagentTimeoutMs: number;
  defaultPermission: PermissionTier;
  defaultMaxBudgetUsd: number | null;
  maxRunRecords: number;
  /** Named skill/prompt-template selections, keyed by set name. See PiCapabilitySet. */
  piCapabilitySets: Record<string, PiCapabilitySet>;
};

export type LoadedExternalSettings = {
  path: string;
  settings: ExternalSettings;
  diagnostics: string[];
};

const KNOWN_SETTING_KEYS = [
  "version",
  "defaultHarness",
  "maxConcurrentSubagents",
  "subagentTimeoutMs",
  "defaultPermission",
  "defaultMaxBudgetUsd",
  "maxRunRecords",
  "piCapabilitySets",
];

const CAPABILITY_SET_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const CAPABILITY_SET_ENTRY_KEYS = new Set(["skills", "promptTemplates"]);

function parseResourceNameList(value: unknown): string[] | "invalid" {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return "invalid";
  const names: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string" || !item.trim()) return "invalid";
    const name = item.trim();
    if (seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

interface ParsedPiCapabilitySets {
  result: Record<string, PiCapabilitySet>;
  /** Names present in the input whose entry failed validation and was dropped, keyed as attempted (not necessarily pattern-valid). */
  invalidNames: Set<string>;
}

/**
 * Parse the `piCapabilitySets` record: named, closed selections of exact
 * skill/prompt-template resource names (never booleans, never wildcards).
 * Migrate-on-read like the rest of this file — an invalid individual entry is
 * dropped with a diagnostic rather than rejecting the whole settings file.
 * `invalidNames` lets a project-scope caller (resolveCapabilitySets) tell "no
 * override requested" apart from "an override was requested but malformed",
 * so a malformed same-named override can shadow rather than silently fall
 * through to a same-named global set.
 */
function parsePiCapabilitySets(value: unknown, diagnostics: string[]): ParsedPiCapabilitySets {
  if (value === undefined) return { result: {}, invalidNames: new Set() };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    diagnostics.push('piCapabilitySets must be a JSON object mapping set names to { skills, promptTemplates }.');
    return { result: {}, invalidNames: new Set() };
  }
  const result: Record<string, PiCapabilitySet> = {};
  const invalidNames = new Set<string>();
  for (const [name, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!CAPABILITY_SET_NAME_PATTERN.test(name)) {
      diagnostics.push(`piCapabilitySets entry "${name}" ignored: name must match ${CAPABILITY_SET_NAME_PATTERN.source}.`);
      invalidNames.add(name);
      continue;
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      diagnostics.push(`piCapabilitySets entry "${name}" ignored: must be an object with "skills" and/or "promptTemplates" arrays of exact names.`);
      invalidNames.add(name);
      continue;
    }
    const record = entry as Record<string, unknown>;
    const unknownKeys = Object.keys(record).filter((key) => !CAPABILITY_SET_ENTRY_KEYS.has(key));
    if (unknownKeys.length) {
      diagnostics.push(`piCapabilitySets entry "${name}" ignored: unknown field(s) ${unknownKeys.join(", ")}. Only "skills" and "promptTemplates" are supported.`);
      invalidNames.add(name);
      continue;
    }
    const skills = parseResourceNameList(record.skills);
    const promptTemplates = parseResourceNameList(record.promptTemplates);
    if (skills === "invalid" || promptTemplates === "invalid") {
      diagnostics.push(`piCapabilitySets entry "${name}" ignored: "skills" and "promptTemplates" must be arrays of non-empty exact resource name strings (no booleans, no wildcards).`);
      invalidNames.add(name);
      continue;
    }
    result[name] = { skills, promptTemplates };
  }
  return { result, invalidNames };
}

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

/**
 * Migrate-on-read: never reject the whole file. Defaults are filled first and
 * each recognized key (from v1, v2, or v3) overrides when valid; invalid values
 * fall back per-key with a diagnostic. Unknown keys are reported, not fatal.
 */
function parseSettings(value: unknown): { settings: ExternalSettings; diagnostics: string[] } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { settings: defaults(), diagnostics: ["Settings must be a JSON object."] };
  }
  const record = value as Record<string, unknown>;
  const diagnostics: string[] = [];
  if (record.version !== 1 && record.version !== 2 && record.version !== 3) {
    diagnostics.push("version must be 1, 2, or 3.");
  }
  for (const key of Object.keys(record)) {
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
  settings.piCapabilitySets = parsePiCapabilitySets(record.piCapabilitySets, diagnostics).result;

  return { settings, diagnostics };
}

export function loadExternalSettings(agentDir: string): LoadedExternalSettings {
  const path = externalSettingsPath(agentDir);
  try {
    mkdirSync(join(agentDir, "pi-flow-external"), { recursive: true });
    try {
      writeFileSync(path, `${JSON.stringify(DEFAULT_EXTERNAL_SETTINGS, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    try {
      return { path, ...parseSettings(JSON.parse(readFileSync(path, "utf8"))) };
    } catch (error) {
      if (error instanceof SyntaxError) {
        return { path, settings: defaults(), diagnostics: ["Settings file is not valid JSON."] };
      }
      throw error;
    }
  } catch (error) {
    return {
      path,
      settings: defaults(),
      diagnostics: [`Could not read or create settings: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
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
  const diagnostics = Object.keys(record)
    .filter((key) => key !== "defaultHarness" && key !== "piCapabilitySets")
    .map((key) => `Unknown project setting "${key}". Only defaultHarness and piCapabilitySets are supported in project settings.`);
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

export interface EffectiveCapabilitySets {
  sets: Map<string, PiCapabilitySet>;
  projectPath?: string;
  diagnostics: string[];
}

/**
 * Merge global `piCapabilitySets` with a trusted project's own
 * `piCapabilitySets` (same `.pi/pi-flow-external/settings.json` project file
 * `resolveDefaultHarness` reads). A project entry *replaces* the global entry
 * of the same name wholesale — it never merges the `skills`/`promptTemplates`
 * arrays — so a project can't silently widen a global set by appending to it
 * from a possibly-less-trusted location; it can only fully own the set by
 * name. Untrusted or missing project files behave exactly like
 * resolveDefaultHarness: global-only, with a diagnostic when a project file
 * exists but is ignored for lack of trust.
 */
export function resolveCapabilitySets(
  global: Record<string, PiCapabilitySet>,
  cwd: string,
  projectTrusted: boolean,
): EffectiveCapabilitySets {
  const sets = new Map(Object.entries(global));
  const path = projectExternalSettingsPath(cwd);
  if (!existsSync(path)) {
    return { sets, diagnostics: [] };
  }
  if (!projectTrusted) {
    return { sets, diagnostics: [`Project settings found at ${path} but ignored: project is not trusted.`] };
  }
  const project = parseProjectSettings(cwd);
  const diagnostics = [...project.diagnostics];
  const requested = project.record?.piCapabilitySets;
  if (requested !== undefined) {
    const { result, invalidNames } = parsePiCapabilitySets(requested, diagnostics);
    // A malformed named override must shadow/block any same-named global
    // set rather than silently falling through to it: the project explicitly
    // attempted to own this name, so an invalid attempt fails the name
    // instead of quietly inheriting global behavior the project never asked for.
    for (const name of invalidNames) {
      sets.delete(name);
    }
    for (const [name, set] of Object.entries(result)) {
      sets.set(name, set);
    }
  }
  return { sets, projectPath: project.path, diagnostics };
}

let lastResolvedCapabilitySets: { cwd: string; value: EffectiveCapabilitySets } | undefined;

/** Resolve with a live extension context and remember it for render paths (mirrors resolveCtxDefaultHarness). */
export function resolveCtxCapabilitySets(
  global: Record<string, PiCapabilitySet>,
  ctx: { cwd: string; isProjectTrusted?: () => boolean },
): EffectiveCapabilitySets {
  let trusted = false;
  try {
    trusted = ctx.isProjectTrusted?.() ?? false;
  } catch {
    trusted = false;
  }
  const value = resolveCapabilitySets(global, ctx.cwd, trusted);
  lastResolvedCapabilitySets = { cwd: ctx.cwd, value };
  return value;
}

/** Render-path counterpart to renderDefaultHarness: no trust signal available, so recall the last ctx-resolved value for that cwd. */
export function renderCapabilitySets(global: Record<string, PiCapabilitySet>, cwd: string): EffectiveCapabilitySets {
  return lastResolvedCapabilitySets?.cwd === cwd
    ? lastResolvedCapabilitySets.value
    : { sets: new Map(Object.entries(global)), diagnostics: [] };
}
