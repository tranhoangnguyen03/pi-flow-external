import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { EXTERNAL_HARNESSES, type ExternalHarness, type PermissionTier, type SubagentBackend, type SubagentProfile, type ThinkingLevel } from "./types.ts";
import { defaultRoleNames, roleDefinition } from "./default-roles.ts";
import type { HarnessConfig } from "./harnesses.ts";

const EXTERNAL_AGENT_BACKENDS: readonly SubagentBackend[] = EXTERNAL_HARNESSES;
const NO_PI_HARNESSES: ReadonlySet<string> = new Set();
const NO_HARNESS_CONFIGS: ReadonlyMap<string, HarnessConfig> = new Map();

const VALID_PROFILE_NAME = /^[a-z0-9][a-z0-9-]*$/;

export function isValidSubagentName(name: string): boolean {
  return VALID_PROFILE_NAME.test(name);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseThinking(value: unknown): ThinkingLevel | undefined {
  if (value === undefined || value === null || value === "inherit") {
    return undefined;
  }
  return optionalString(value);
}

function parseBackend(value: unknown): SubagentBackend | "invalid" {
  if (value === undefined || value === null || value === "inherit") {
    return "pi";
  }
  const backend = optionalString(value);
  if (backend === "pi" || backend === "codex" || backend === "claude" || backend === "agy") {
    return backend;
  }
  return "invalid";
}

function parseModel(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "inherit") {
    return undefined;
  }
  return optionalString(value);
}

function parseToolList(value: unknown): string[] | "invalid" {
  if (typeof value !== "string") {
    return "invalid";
  }
  const tools: string[] = [];
  const seen = new Set<string>();
  for (const rawValue of value.split(",")) {
    const tool = rawValue.trim();
    if (!tool || seen.has(tool)) {
      continue;
    }
    seen.add(tool);
    tools.push(tool);
  }
  return tools.length > 0 ? tools : "invalid";
}

function parsePermission(value: unknown): PermissionTier | "invalid" | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (value === "readonly" || value === "edit" || value === "danger") {
    return value;
  }
  return "invalid";
}

function parseMaxBudgetUsd(value: unknown): number | "invalid" | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value === "number" && value > 0) {
    return value;
  }
  return "invalid";
}

export function parseSubagentProfileContent(
  content: string,
  name: string,
  options: { requireBody: boolean } = { requireBody: false },
): SubagentProfile | undefined {
  let parsed: { frontmatter: Record<string, unknown>; body: string };
  try {
    parsed = parseFrontmatter<Record<string, unknown>>(content);
  } catch {
    return undefined;
  }

  const description = optionalString(parsed.frontmatter.description);
  const body = parsed.body.trim();
  const backend = parseBackend(parsed.frontmatter.backend);
  if (backend === "invalid") {
    return undefined;
  }
  const harness = optionalString(parsed.frontmatter.harness);
  const model = parseModel(parsed.frontmatter.model);
  const thinking = parseThinking(parsed.frontmatter.thinking);
  const tools = Object.prototype.hasOwnProperty.call(parsed.frontmatter, "tools")
    ? parseToolList(parsed.frontmatter.tools)
    : undefined;
  const permission = parsePermission(parsed.frontmatter.permission);
  const maxBudgetUsd = parseMaxBudgetUsd(parsed.frontmatter.max_budget_usd);
  const owner = optionalString(parsed.frontmatter.owner);

  if (
    !description ||
    tools === "invalid" ||
    permission === "invalid" ||
    maxBudgetUsd === "invalid" ||
    (options.requireBody && !body)
  ) {
    return undefined;
  }

  return {
    name,
    description,
    backend,
    ...(harness ? { harness } : {}),
    model,
    thinking,
    tools,
    systemPrompt: body || undefined,
    permission,
    maxBudgetUsd,
    owner,
  };
}

function parseProfileFile(filePath: string, name: string, options: { requireBody: boolean }): SubagentProfile | undefined {
  try {
    return parseSubagentProfileContent(readFileSync(filePath, "utf-8"), name, options);
  } catch {
    return undefined;
  }
}

export function loadCustomSubagentProfiles(agentDir = getAgentDir()): Map<string, SubagentProfile> {
  const dir = join(agentDir, "subagents");
  const profiles = new Map<string, SubagentProfile>();
  if (!existsSync(dir)) {
    return profiles;
  }

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return profiles;
  }

  for (const entry of entries) {
    if (!entry.endsWith(".md")) {
      continue;
    }
    const name = basename(entry, ".md");
    if (!isValidSubagentName(name)) {
      continue;
    }
    const profile = parseProfileFile(join(dir, entry), name, { requireBody: false });
    if (profile) {
      profiles.set(name, profile);
    }
  }

  return profiles;
}

export function getSubagentProfiles(agentDir = getAgentDir()): Map<string, SubagentProfile> {
  return loadCustomSubagentProfiles(agentDir);
}

/**
 * A `backend: "pi"` profile is external-delegation-eligible only when it also
 * declares `harness: <name>` for a name present in the live harness registry
 * (see src/harnesses.ts). This is the mechanical reason an ordinary native Pi
 * subagent file (no `harness:`, or one naming an unregistered config) can
 * never accidentally qualify: condition (2) requires a name that only this
 * extension's own harness registry can supply.
 */
export function isExternalAgentProfile(
  profile: SubagentProfile,
  configuredPiHarnesses: ReadonlySet<string> = NO_PI_HARNESSES,
): boolean {
  if (EXTERNAL_AGENT_BACKENDS.includes(profile.backend)) return true;
  return profile.backend === "pi" && profile.harness !== undefined && configuredPiHarnesses.has(profile.harness);
}

export function filterExternalAgentProfiles(
  profiles: Map<string, SubagentProfile>,
  configuredPiHarnesses: ReadonlySet<string> = NO_PI_HARNESSES,
): Map<string, SubagentProfile> {
  return new Map([...profiles].filter(([, profile]) => isExternalAgentProfile(profile, configuredPiHarnesses)));
}

export interface ExternalAgentSelection {
  role?: string;
  harness?: string;
  subagentType?: string;
}

/**
 * The name a profile is selected by: an external harness, or a pi-* config.
 * Exported as the single authoritative "effective harness" resolution — the
 * same computation run-record metadata, live progress nodes, and workflow
 * child snapshots persist as `harness`, so that field is never reparsed or
 * guessed from a profile/subagentType name elsewhere.
 */
export function selectorHarness(profile: SubagentProfile): string {
  return profile.harness ?? profile.backend;
}

/**
 * Structural role-prefix extraction: `<harness>-<role>` for either an
 * external CLI profile (harness === backend) or a pi profile that declares a
 * harness (backend "pi", harness "pi-*"). This does not check registry
 * membership; callers work from an already-filtered profiles map.
 */
export function externalProfileRole(profile: SubagentProfile): string | undefined {
  const isShapedForRoleExtraction = EXTERNAL_AGENT_BACKENDS.includes(profile.backend)
    || (profile.backend === "pi" && profile.harness !== undefined);
  if (!isShapedForRoleExtraction) return undefined;
  const prefix = `${selectorHarness(profile)}-`;
  return profile.name.startsWith(prefix) && profile.name.length > prefix.length
    ? profile.name.slice(prefix.length)
    : undefined;
}

function compareHarnessNames(a: string, b: string): number {
  const ai = EXTERNAL_HARNESSES.indexOf(a as ExternalHarness);
  const bi = EXTERNAL_HARNESSES.indexOf(b as ExternalHarness);
  if (ai !== -1 && bi !== -1) return ai - bi;
  if (ai !== -1) return -1;
  if (bi !== -1) return 1;
  return a.localeCompare(b);
}

export function externalRoleAvailability(
  profiles: Map<string, SubagentProfile>,
): Map<string, string[]> {
  const roles = new Map<string, string[]>();
  for (const profile of profiles.values()) {
    const role = externalProfileRole(profile);
    if (!role) continue;
    const key = selectorHarness(profile);
    const harnesses = roles.get(role) ?? [];
    if (!harnesses.includes(key)) {
      harnesses.push(key);
      harnesses.sort(compareHarnessNames);
      roles.set(role, harnesses);
    }
  }
  return new Map([...roles].sort(([a], [b]) => a.localeCompare(b)));
}

/** Canonically synthesize `<harness>-<role>` for a registered pi-* harness. */
function synthesizePiRoleProfile(role: string, harness: string, harnessConfig: HarnessConfig): SubagentProfile | undefined {
  const definition = roleDefinition(role);
  if (!definition) return undefined;
  return {
    name: `${harness}-${role}`,
    description: definition.description.replaceAll("${backendLabel}", harness),
    backend: "pi",
    harness,
    model: harnessConfig.model,
    thinking: harnessConfig.thinking,
    systemPrompt: definition.body,
    permission: definition.permission,
  };
}

/**
 * Core reconciliation rule shared by the throwing (resolution-time) and
 * non-throwing (merge-time) call sites below: the harness registry stays
 * authoritative for model/thinking. A file that omits them inherits the
 * registry's values; a file that declares the same values is
 * redundant-but-consistent; a file that declares a *different* value is a
 * configuration conflict.
 */
export function computeReconciledPiProfile(
  profile: SubagentProfile,
  harnessConfigs: ReadonlyMap<string, HarnessConfig>,
): { profile: SubagentProfile; conflict?: string } {
  if (profile.backend !== "pi" || !profile.harness) return { profile };
  const harnessConfig = harnessConfigs.get(profile.harness);
  if (!harnessConfig) {
    return {
      profile,
      conflict: `Harness "${profile.harness}" is not registered. Create it first via the harness-declaration branch of /external profile create.`,
    };
  }
  if (profile.model !== undefined && profile.model !== harnessConfig.model) {
    return {
      profile,
      conflict: `Profile "${profile.name}" declares harness "${profile.harness}" but pins model "${profile.model}", which conflicts with "${profile.harness}"'s registered model "${harnessConfig.model}". Remove the override or update harnesses.json.`,
    };
  }
  if (profile.thinking !== undefined && profile.thinking !== harnessConfig.thinking) {
    return {
      profile,
      conflict: `Profile "${profile.name}" declares harness "${profile.harness}" but pins thinking "${profile.thinking}", which conflicts with "${profile.harness}"'s registered thinking "${harnessConfig.thinking}". Remove the override or update harnesses.json.`,
    };
  }
  return { profile: { ...profile, model: harnessConfig.model, thinking: harnessConfig.thinking } };
}

/**
 * Resolution-time reconciliation: throws on a genuine conflict or unregistered
 * harness, since this is called for one specific profile that is *actually
 * about to be selected or installed* — the whole point of the legitimacy rule
 * is that a declared harness's validated model is what makes the profile
 * trustworthy to execute, and a conflicting or unregistered harness must block
 * that execution, not be silently honored.
 */
export function reconcilePiProfileWithHarness(
  profile: SubagentProfile,
  harnessConfigs: ReadonlyMap<string, HarnessConfig>,
): SubagentProfile {
  const { profile: reconciled, conflict } = computeReconciledPiProfile(profile, harnessConfigs);
  if (conflict) throw new Error(conflict);
  return reconciled;
}

/**
 * Merge canonically-synthesized `<harness>-<role>` profiles for every
 * registered pi-* harness into an already-filtered external profiles map,
 * once, skipping any `<harness>-<role>` key that already has a real on-disk
 * entry (same override precedence resolveExternalProfile applies at
 * resolution time). This is the single shared merge every consumer that
 * needs a *complete* roster reuses: the Agent tool's catalog/help text, the
 * workflow tool's frozen per-run profile+model snapshot (so a workflow can
 * actually execute a synthesized pi role, not just resolve its name), and
 * /external's doctor/settings/profiles text. Real on-disk profiles are never
 * mutated; this returns a new map layering synthesized entries underneath.
 *
 * Every existing on-disk `backend: pi` entry is also reconciled against its
 * declared harness's registered model/thinking here — not just newly
 * synthesized entries — because this merged map is read directly (not
 * through resolveExternalProfile) by workflow execution's model lookup and
 * fingerprint descriptor. Without this, a branch-3 custom-role file that
 * omits `model`/`thinking` (the common case, inheriting from its harness)
 * would carry `model: undefined` into that map and fail with "no model
 * selected" even though the exact same profile resolves and runs fine
 * through the Agent tool's resolveExternalProfile path.
 *
 * A genuine conflict is deliberately *not* thrown here: this function runs
 * on every turn (coordinator prompt catalog) and at the top of every
 * workflow run, for the *whole* roster, not just the profile a caller is
 * about to use — throwing here would break an unrelated turn or workflow
 * over one stale, unrelated profile file. The conflicting entry is left
 * unreconciled (its own file's values, unchanged) and is still caught
 * authoritatively, before execution, by resolveExternalProfile's throwing
 * reconciliation the moment that specific profile is actually selected
 * (every workflow call resolves through resolveSubagentType first).
 */
export function mergeSynthesizedPiProfiles(
  profiles: Map<string, SubagentProfile>,
  harnessConfigs: ReadonlyMap<string, HarnessConfig>,
): Map<string, SubagentProfile> {
  if (harnessConfigs.size === 0) return profiles;
  const merged = new Map<string, SubagentProfile>();
  for (const [name, profile] of profiles) {
    merged.set(name, computeReconciledPiProfile(profile, harnessConfigs).profile);
  }
  for (const [harness, harnessConfig] of harnessConfigs) {
    for (const role of defaultRoleNames()) {
      const key = `${harness}-${role}`;
      if (merged.has(key)) continue;
      const synthesized = synthesizePiRoleProfile(role, harness, harnessConfig);
      if (synthesized) merged.set(key, synthesized);
    }
  }
  return merged;
}

export interface ResolveExternalProfileOptions {
  /** All legitimate selector names: EXTERNAL_HARNESSES plus registered pi-* harnesses. */
  configuredHarnessNames?: ReadonlySet<string>;
  /** Registered pi-* harness configs, used for canonical synthesis and model/thinking reconciliation. */
  harnessConfigs?: ReadonlyMap<string, HarnessConfig>;
}

const DEFAULT_RESOLVE_OPTIONS: Required<ResolveExternalProfileOptions> = {
  configuredHarnessNames: new Set(EXTERNAL_HARNESSES),
  harnessConfigs: NO_HARNESS_CONFIGS,
};

export function resolveExternalProfile(
  profiles: Map<string, SubagentProfile>,
  selection: ExternalAgentSelection,
  defaultHarness: string,
  options: ResolveExternalProfileOptions = {},
): SubagentProfile {
  const configuredHarnessNames = options.configuredHarnessNames ?? DEFAULT_RESOLVE_OPTIONS.configuredHarnessNames;
  const harnessConfigs = options.harnessConfigs ?? DEFAULT_RESOLVE_OPTIONS.harnessConfigs;
  const role = selection.role?.trim();
  const harness = selection.harness?.trim();
  const subagentType = selection.subagentType?.trim();

  if (subagentType) {
    if (role || harness) {
      throw new Error("Choose either role (with optional harness) or legacy subagent_type; do not combine them.");
    }
    const profile = profiles.get(subagentType);
    if (!profile) {
      throw new Error(
        `Unknown external subagent_type "${subagentType}". Available external profiles: ${[...profiles.keys()].join(", ") || "none"}. Use the native subagent system for Pi-backed agents.`,
      );
    }
    return reconcilePiProfileWithHarness(profile, harnessConfigs);
  }

  if (!role) {
    throw new Error(harness
      ? "role is required when harness is provided; otherwise provide role or legacy subagent_type."
      : "Either role or legacy subagent_type is required.");
  }
  const selectedHarness = harness || defaultHarness;
  if (!configuredHarnessNames.has(selectedHarness)) {
    throw new Error(`Unknown external harness "${selectedHarness}". Choose one of: ${[...configuredHarnessNames].join(", ") || "none"}.`);
  }

  const exact = profiles.get(`${selectedHarness}-${role}`);
  if (exact && selectorHarness(exact) === selectedHarness && externalProfileRole(exact) === role) {
    return reconcilePiProfileWithHarness(exact, harnessConfigs);
  }

  if (!EXTERNAL_HARNESSES.includes(selectedHarness as ExternalHarness)) {
    const harnessConfig = harnessConfigs.get(selectedHarness);
    if (harnessConfig) {
      const synthesized = synthesizePiRoleProfile(role, selectedHarness, harnessConfig);
      if (synthesized) return synthesized;
    }
  }

  const availability = externalRoleAvailability(profiles);
  const supported = availability.get(role);
  if (supported?.length) {
    throw new Error(
      `Role "${role}" is unavailable for harness "${selectedHarness}". Supported harnesses for this role: ${supported.join(", ")}. Choose one of those harnesses or add profile "${selectedHarness}-${role}".`,
    );
  }
  const knownRoles = new Set([...availability.keys(), ...(EXTERNAL_HARNESSES.includes(selectedHarness as ExternalHarness) ? [] : defaultRoleNames())]);
  throw new Error(
    `Unknown external role "${role}". Available roles: ${[...knownRoles].join(", ") || "none"}. Nonstandard profile names must be selected with legacy subagent_type.`,
  );
}
