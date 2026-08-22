import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SubagentExtensionOptions } from "./types.ts";

export const DEFAULT_EXTERNAL_SETTINGS = {
  version: 1,
  maxConcurrentSubagents: 12,
  subagentTimeoutMs: 2 * 60 * 60 * 1000,
} as const;

export type ExternalSettings = {
  version: 1;
  maxConcurrentSubagents: number;
  subagentTimeoutMs: number;
};

export type LoadedExternalSettings = {
  path: string;
  settings: ExternalSettings;
  diagnostics: string[];
};

export function externalSettingsPath(agentDir: string): string {
  return join(agentDir, "pi-flow-external", "settings.json");
}

function defaults(): ExternalSettings {
  return { ...DEFAULT_EXTERNAL_SETTINGS };
}

function parseSettings(value: unknown): { settings: ExternalSettings; diagnostics: string[] } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { settings: defaults(), diagnostics: ["Settings must be a JSON object."] };
  }
  const record = value as Record<string, unknown>;
  const diagnostics = Object.keys(record)
    .filter((key) => !["version", "maxConcurrentSubagents", "subagentTimeoutMs"].includes(key))
    .map((key) => `Unknown setting "${key}".`);
  if (record.version !== 1) diagnostics.push("version must be 1.");
  if (!Number.isInteger(record.maxConcurrentSubagents) || Number(record.maxConcurrentSubagents) < 1) {
    diagnostics.push("maxConcurrentSubagents must be a positive integer.");
  }
  if (!Number.isInteger(record.subagentTimeoutMs) || Number(record.subagentTimeoutMs) < 0) {
    diagnostics.push("subagentTimeoutMs must be a non-negative integer.");
  }
  const invalid = diagnostics.some((message) => !message.startsWith("Unknown setting"));
  return {
    settings: invalid ? defaults() : {
      version: 1,
      maxConcurrentSubagents: record.maxConcurrentSubagents as number,
      subagentTimeoutMs: record.subagentTimeoutMs as number,
    },
    diagnostics,
  };
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
