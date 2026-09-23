import { readFileSync, existsSync } from "node:fs";
import { loadExternalSettings, saveExternalSettings, externalSettingsPath, DEFAULT_EXTERNAL_SETTINGS } from "./settings.ts";
import type { ThinkingLevel as SdkThinkingLevel } from "@earendil-works/pi-agent-core";

/**
 * The pinned SDK exposes its thinking-level union only as a TypeScript type,
 * not a runtime-exported constant array, so this list is hand-maintained here.
 * The `as const satisfies` + AssertNever guards below make drift a compile
 * error rather than a procedural "re-check at upgrade time" reminder: if the
 * SDK's ThinkingLevel union gains or loses a member, `npm run check` fails
 * until this list is updated.
 */
export const VALID_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const satisfies readonly SdkThinkingLevel[];

type AssertNever<T extends never> = T;
// Both directions must collapse to never: every SDK level is listed (no missing
// members) and every listed value is a real SDK level (no extras — also
// enforced by `satisfies`, but asserted symmetrically for clarity).
type _MissingThinkingLevels = AssertNever<Exclude<SdkThinkingLevel, (typeof VALID_THINKING_LEVELS)[number]>>;
type _ExtraThinkingLevels = AssertNever<Exclude<(typeof VALID_THINKING_LEVELS)[number], SdkThinkingLevel>>;

export function isValidThinkingLevel(value: unknown): value is SdkThinkingLevel {
  return typeof value === "string" && (VALID_THINKING_LEVELS as readonly string[]).includes(value);
}

export const HARNESS_NAME_PATTERN = /^pi-[a-z0-9][a-z0-9-]*$/;

export function isValidHarnessName(name: string): boolean {
  return HARNESS_NAME_PATTERN.test(name);
}

export interface HarnessConfig {
  /** "<provider>/<modelId>", resolved via ctx.modelRegistry.find(provider, id). */
  model: string;
  /** Always persisted explicitly; "off" when the creation interview collects nothing. */
  thinking: SdkThinkingLevel;
  /** Ownership tag, stamped by the profile creator. */
  owner?: string;
}

export function harnessesPath(agentDir: string): string {
  return externalSettingsPath(agentDir);
}

export interface LoadedHarnessConfigs {
  harnesses: Map<string, HarnessConfig>;
  diagnostics: string[];
}

export function parseHarnessEntry(name: string, value: unknown): HarnessConfig | undefined {
  if (!isValidHarnessName(name)) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.model !== "string" || !record.model.trim() || record.model.trim().indexOf("/") <= 0 || record.model.trim().endsWith("/")) return undefined;
  const thinking = record.thinking === undefined ? "off" : record.thinking;
  if (!isValidThinkingLevel(thinking)) return undefined;
  const owner = typeof record.owner === "string" && record.owner.trim() ? record.owner.trim() : undefined;
  return { model: record.model.trim(), thinking, ...(owner ? { owner } : {}) };
}

/** Project the named harness registry from the canonical settings loader. */
export function loadHarnessConfigs(agentDir: string): LoadedHarnessConfigs {
  const loaded = loadExternalSettings(agentDir);
  return { harnesses: loaded.blocked ? new Map() : new Map(Object.entries(loaded.settings.harnesses ?? {})), diagnostics: loaded.diagnostics };
}

export function getConfiguredHarnessNames(agentDir: string): Set<string> {
  return new Set(loadHarnessConfigs(agentDir).harnesses.keys());
}

export interface InstallHarnessConfigParams {
  agentDir: string;
  name: string;
  model: string;
  thinking?: SdkThinkingLevel;
  owner?: string;
  signal?: AbortSignal;
  smokeTest: () => Promise<{ ok: true } | { ok: false; error: string }>;
}

/** Smoke-test before committing through the canonical atomic settings writer.
 * Concurrent processes remain last-writer-wins; atomic replacement prevents torn files, not lost updates.
 */
export async function installHarnessConfigWithSmokeTest(params: InstallHarnessConfigParams): Promise<string> {
  const { agentDir, name, model, owner, signal, smokeTest } = params;
  if (!isValidHarnessName(name)) {
    throw new Error(`Harness name must match ${HARNESS_NAME_PATTERN.source} (e.g. pi-deepseek).`);
  }
  if (!model.trim() || model.indexOf("/") === -1) {
    throw new Error(`Harness model must be "<provider>/<id>", got ${JSON.stringify(model)}.`);
  }
  const thinking = params.thinking ?? "off";
  if (!isValidThinkingLevel(thinking)) {
    throw new Error(`Unsupported thinking level ${JSON.stringify(thinking)}; expected one of: ${VALID_THINKING_LEVELS.join(", ")}.`);
  }

  const finalPath = harnessesPath(agentDir);
  const loaded = loadExternalSettings(agentDir);
  if (loaded.blocked) throw new Error(loaded.diagnostics.join(" "));
  if (loadHarnessConfigs(agentDir).harnesses.has(name)) {
    throw new Error(`Harness "${name}" already exists.`);
  }

  const smoke = await smokeTest();
  if (!smoke.ok) {
    throw new Error(smoke.error);
  }
  signal?.throwIfAborted();

  // Re-read immediately before writing: this narrows, but cannot fully close,
  // the window against a concurrent creation racing the smoke test above —
  // settings.json has no inter-process lock, so concurrent writers with
  // distinct names follow last-writer-wins and can lose an update.
  const current = loadHarnessConfigs(agentDir).harnesses;
  if (current.has(name)) {
    throw new Error(`Harness "${name}" already exists.`);
  }
  const raw = existsSync(finalPath) ? JSON.parse(readFileSync(finalPath, "utf8")) : { ...DEFAULT_EXTERNAL_SETTINGS };
  signal?.throwIfAborted();
  saveExternalSettings(agentDir, { ...raw, harnesses: { ...raw.harnesses, [name]: { model: model.trim(), thinking, ...(owner ? { owner } : {}) } } });

  const installed = loadHarnessConfigs(agentDir).harnesses;
  if (!installed.has(name)) {
    throw new Error("Installed harness was not discovered by the runtime loader.");
  }
  return finalPath;
}
