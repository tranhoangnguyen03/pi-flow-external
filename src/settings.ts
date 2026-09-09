import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EXTERNAL_HARNESSES, type ExternalHarness, type PermissionTier, type SubagentExtensionOptions } from "./types.ts";

export const DEFAULT_EXTERNAL_SETTINGS = {
  version: 3,
  defaultHarness: "agy" as ExternalHarness,
  maxConcurrentSubagents: 12,
  subagentTimeoutMs: 2 * 60 * 60 * 1000,
  defaultPermission: "danger" as PermissionTier,
  defaultMaxBudgetUsd: null as number | null,
  maxRunRecords: 200,
} as const;

export type ExternalSettings = {
  version: 3;
  defaultHarness: ExternalHarness;
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
};

const KNOWN_SETTING_KEYS = [
  "version",
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
  if (isExternalHarness(record.defaultHarness)) {
    settings.defaultHarness = record.defaultHarness;
  } else if (record.defaultHarness !== undefined) {
    diagnostics.push("defaultHarness must be agy, claude, or codex.");
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
  harness: ExternalHarness;
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
    .filter((key) => key !== "defaultHarness")
    .map((key) => `Unknown project setting "${key}". Only defaultHarness is supported in project settings.`);
  return { record, path, diagnostics };
}

export function resolveDefaultHarness(
  global: ExternalHarness,
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
  if (isExternalHarness(requested)) {
    return { harness: requested, source: "project", projectPath: project.path, diagnostics };
  }
  diagnostics.push(`Project defaultHarness must be one of: ${EXTERNAL_HARNESSES.join(", ")}. Using the global default.`);
  return { harness: global, source: "global", projectPath: project.path, diagnostics };
}

let lastResolvedDefaultHarness: { cwd: string; value: EffectiveDefaultHarness } | undefined;

/** Resolve with a live extension context and remember it for render paths. */
export function resolveCtxDefaultHarness(
  global: ExternalHarness,
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
export function renderDefaultHarness(global: ExternalHarness, cwd: string): ExternalHarness {
  return lastResolvedDefaultHarness?.cwd === cwd ? lastResolvedDefaultHarness.value.harness : global;
}
