import { mkdirSync, readFileSync } from "node:fs";
import { rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { ThinkingLevel as SdkThinkingLevel } from "@earendil-works/pi-agent-core";

/**
 * The pinned SDK exposes its thinking-level union only as a TypeScript type,
 * not a runtime-exported constant array, so this list is hand-maintained here
 * and re-checked against @earendil-works/pi-agent-core's ThinkingLevel type at
 * upgrade time (see docs/plans/pi-named-configurations-design.md §4.2).
 */
export const VALID_THINKING_LEVELS: readonly SdkThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

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
  /** Ownership tag, stamped by the profile creator; never touched by profile clean-up. */
  owner?: string;
}

export function harnessesPath(agentDir: string): string {
  return join(agentDir, "pi-flow-external", "harnesses.json");
}

export interface LoadedHarnessConfigs {
  harnesses: Map<string, HarnessConfig>;
  diagnostics: string[];
}

function parseHarnessEntry(name: string, value: unknown): HarnessConfig | undefined {
  if (!isValidHarnessName(name)) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.model !== "string" || !record.model.trim()) return undefined;
  const thinking = record.thinking === undefined ? "off" : record.thinking;
  if (!isValidThinkingLevel(thinking)) return undefined;
  const owner = typeof record.owner === "string" && record.owner.trim() ? record.owner.trim() : undefined;
  return { model: record.model.trim(), thinking, ...(owner ? { owner } : {}) };
}

/**
 * Migrate-on-read, never-fatal: a missing file yields an empty map with no
 * diagnostic; malformed JSON yields an empty map with one diagnostic; a bad
 * individual entry (invalid key shape, missing/invalid model, or an
 * unsupported thinking value) is dropped with a diagnostic while the rest of
 * the file loads normally. Mirrors src/settings.ts's parseSettings idiom.
 */
export function loadHarnessConfigs(agentDir: string): LoadedHarnessConfigs {
  const path = harnessesPath(agentDir);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { harnesses: new Map(), diagnostics: [] };
    }
    return { harnesses: new Map(), diagnostics: [`Could not read ${path}: ${error instanceof Error ? error.message : String(error)}`] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { harnesses: new Map(), diagnostics: [`${path} is not valid JSON.`] };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { harnesses: new Map(), diagnostics: [`${path} must be a JSON object.`] };
  }
  const record = parsed as Record<string, unknown>;
  const rawHarnesses = record.harnesses;
  if (rawHarnesses === undefined) {
    return { harnesses: new Map(), diagnostics: [] };
  }
  if (!rawHarnesses || typeof rawHarnesses !== "object" || Array.isArray(rawHarnesses)) {
    return { harnesses: new Map(), diagnostics: [`${path}: "harnesses" must be a JSON object.`] };
  }
  const harnesses = new Map<string, HarnessConfig>();
  const diagnostics: string[] = [];
  for (const [name, value] of Object.entries(rawHarnesses as Record<string, unknown>)) {
    const config = parseHarnessEntry(name, value);
    if (config) {
      harnesses.set(name, config);
    } else if (!isValidHarnessName(name)) {
      diagnostics.push(`Harness "${name}" ignored: name must match ${HARNESS_NAME_PATTERN}.`);
    } else {
      diagnostics.push(`Harness "${name}" ignored: model must be a non-empty "<provider>/<id>" string and thinking, if present, must be one of ${VALID_THINKING_LEVELS.join(", ")}.`);
    }
  }
  return { harnesses, diagnostics };
}

export function getConfiguredHarnessNames(agentDir: string): Set<string> {
  return new Set(loadHarnessConfigs(agentDir).harnesses.keys());
}

function serializeHarnesses(harnesses: Map<string, HarnessConfig>): string {
  const record: Record<string, HarnessConfig> = {};
  for (const [name, config] of [...harnesses].sort(([a], [b]) => a.localeCompare(b))) {
    record[name] = config;
  }
  return `${JSON.stringify({ version: 1, harnesses: record }, null, 2)}\n`;
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

/**
 * Stage/smoke-test/atomically-commit a new harnesses.json entry, mirroring
 * installProfileWithSmokeTest's posture (real backend smoke test, no silent
 * overwrite, rollback on any failure) but against the single shared
 * harnesses.json file instead of one-file-per-profile.
 *
 * Concurrency semantics:
 * - Filesystem integrity: same-directory atomic rename ensures readers never see
 *   a missing, corrupt, or partially-written file; process crashes leave either
 *   the previous file or the new file fully intact.
 * - Multi-process race: without an inter-process file lock, concurrent writers
 *   adding distinct names follow last-writer-wins and can lose an update. If two
 *   processes concurrently load the registry, smoke-test, and write their new
 *   snapshot, whichever process renames last overwrites harnesses.json without
 *   the other's newly-added entry. This is not a transactional multi-writer DB.
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

  const dir = join(agentDir, "pi-flow-external");
  const finalPath = harnessesPath(agentDir);
  mkdirSync(dir, { recursive: true });
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
  // harnesses.json has no inter-process lock, so concurrent writers with
  // distinct names follow last-writer-wins and can lose an update.
  const current = loadHarnessConfigs(agentDir).harnesses;
  if (current.has(name)) {
    throw new Error(`Harness "${name}" already exists.`);
  }
  const next = new Map(current);
  next.set(name, { model: model.trim(), thinking, ...(owner ? { owner } : {}) });

  const stagedPath = join(dir, `.harnesses.${process.pid}.${randomUUID()}.staged`);
  await writeFile(stagedPath, serializeHarnesses(next), { encoding: "utf8", mode: 0o600 });
  try {
    signal?.throwIfAborted();
    // Same-directory rename is the atomic replace: it guarantees filesystem
    // integrity (the file either fully lands or fully fails, with no window
    // where harnesses.json is missing, corrupt, or partially written). Note
    // that this protects against crashes and partial writes, but does not
    // prevent concurrent distinct-name writers from overwriting each other's
    // updates under last-writer-wins without an inter-process file lock.
    await rename(stagedPath, finalPath);
  } catch (error) {
    try {
      await unlink(stagedPath);
    } catch {
      // best-effort cleanup of the staged file
    }
    throw error;
  }

  const installed = loadHarnessConfigs(agentDir).harnesses;
  if (!installed.has(name)) {
    throw new Error("Installed harness was not discovered by the runtime loader.");
  }
  return finalPath;
}
