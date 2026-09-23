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
  if (backend === "pi" || backend === "codex" || backend === "claude" || backend === "agy" || backend === "grok" || backend === "muse") {
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

interface ParsedCapabilitySet {
  value?: string;
  error?: string;
}

/**
 * Unlike the other `parse*` helpers above, a malformed result here does not
 * drop the whole profile (see the capabilitySetError field on SubagentProfile
 * for why): it is threaded through as an error string instead of an "invalid"
 * sentinel so the caller can keep the rest of the profile intact.
 */
function parseCapabilitySet(value: unknown): ParsedCapabilitySet {
  if (typeof value === "string" && value.trim()) {
    return { value: value.trim() };
  }
  return { error: `capabilitySet must be a non-empty string naming a piCapabilitySets entry (got ${JSON.stringify(value)}).` };
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
  const capabilitySet = Object.prototype.hasOwnProperty.call(parsed.frontmatter, "capabilitySet")
    ? parseCapabilitySet(parsed.frontmatter.capabilitySet)
    : undefined;

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
    ...(capabilitySet?.value ? { capabilitySet: capabilitySet.value } : {}),
    ...(capabilitySet?.error ? { capabilitySetError: capabilitySet.error } : {}),
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
 * Literal `harness:` value marking a shared custom Pi role template: a
 * `backend: pi` profile authored once and applied across every registered
 * `pi-*` harness, instead of being duplicated per harness. This string is
 * deliberately not a valid registered harness name (`isValidHarnessName`
 * rejects the `*`), so a shared template can never satisfy
 * `isExternalAgentProfile`'s registry-membership check and is never admitted
 * as a directly-selectable native profile — it only exists as a template
 * that `mergeSynthesizedPiProfiles` materializes into concrete
 * `<harness>-<role>` entries.
 */
export const SHARED_PI_HARNESS_MARKER = "pi-*";

/** File/selector convention for a shared template: `pi-<role>.md`. */
const SHARED_PI_ROLE_PREFIX = "pi-";

export function isSharedPiRoleTemplate(profile: SubagentProfile): boolean {
  return profile.backend === "pi" && profile.harness === SHARED_PI_HARNESS_MARKER;
}

/** Extract the `<role>` suffix from a shared template's `pi-<role>` name. */
export function sharedPiRoleName(name: string): string | undefined {
  return name.startsWith(SHARED_PI_ROLE_PREFIX) && name.length > SHARED_PI_ROLE_PREFIX.length
    ? name.slice(SHARED_PI_ROLE_PREFIX.length)
    : undefined;
}

export interface SharedPiRoleTemplates {
  /** Valid shared templates, keyed by role name. */
  templates: Map<string, SubagentProfile>;
  /** Human-readable reasons a candidate file was ignored. */
  diagnostics: string[];
}

/**
 * Scan an *unfiltered* profiles map (i.e. before `filterExternalAgentProfiles`
 * has removed shared templates as non-selectable) for `harness: "pi-*"`
 * profiles and validate them. A shared template must be named `pi-<role>.md`
 * matching its marker, and must not pin `model`/`thinking`: the whole point
 * is to run under whichever harness's own registered model/thinking
 * materializes it, so a pinned value here would silently misapply one
 * harness's model to every other harness. Invalid candidates are dropped
 * with a diagnostic rather than failing the whole roster, mirroring
 * `loadHarnessConfigs`'s migrate-on-read posture.
 */
export function extractSharedPiRoleProfiles(profiles: Map<string, SubagentProfile>): SharedPiRoleTemplates {
  const templates = new Map<string, SubagentProfile>();
  const diagnostics: string[] = [];
  for (const profile of profiles.values()) {
    if (!isSharedPiRoleTemplate(profile)) continue;
    const role = sharedPiRoleName(profile.name);
    if (!role) {
      diagnostics.push(`Shared Pi role profile "${profile.name}" ignored: file must be named "pi-<role>.md" to match its "harness: ${SHARED_PI_HARNESS_MARKER}" marker.`);
      continue;
    }
    if (profile.model !== undefined || profile.thinking !== undefined) {
      diagnostics.push(`Shared Pi role profile "${profile.name}" ignored: it must not pin model or thinking — every registered pi-* harness supplies its own. Remove the override(s).`);
      continue;
    }
    templates.set(role, profile);
  }
  return { templates, diagnostics };
}

/** Materialize a shared role template into a concrete `<harness>-<role>` profile pinned to that harness's registered model/thinking. */
export function materializeSharedPiRoleProfile(role: string, harness: string, harnessConfig: HarnessConfig, template: SubagentProfile): SubagentProfile {
  return {
    name: `${harness}-${role}`,
    description: template.description,
    backend: "pi",
    harness,
    model: harnessConfig.model,
    thinking: harnessConfig.thinking,
    tools: template.tools,
    systemPrompt: template.systemPrompt,
    permission: template.permission,
    maxBudgetUsd: template.maxBudgetUsd,
    owner: template.owner,
    capabilitySet: template.capabilitySet,
    capabilitySetError: template.capabilitySetError,
  };
}

const NO_SHARED_TEMPLATES: ReadonlyMap<string, SubagentProfile> = new Map();

/**
 * Core reconciliation rule shared by the throwing (resolution-time) and
 * non-throwing (merge-time) call sites below: the harness registry stays
 * authoritative for model/thinking. A file that omits them inherits the
 * registry's values; a file that declares the same values is
 * redundant-but-consistent; a file that declares a *different* value is a
 * configuration conflict. Also rejects a `capabilitySet` declared on a
 * non-pi-backend profile as a conflict: it is a pi-only mechanism that an
 * external CLI backend would silently ignore. And rejects a profile whose
 * `capabilitySet` frontmatter was malformed (`capabilitySetError`, set by
 * parseSubagentProfileContent) as a conflict too: that profile was
 * deliberately kept in the roster instead of being dropped whole, so this is
 * the one place its bad configuration actually blocks something, rather than
 * silently vanishing and letting canonical/shared-template synthesis fill the
 * role in behind its back.
 */
export function computeReconciledPiProfile(
  profile: SubagentProfile,
  harnessConfigs: ReadonlyMap<string, HarnessConfig>,
): { profile: SubagentProfile; conflict?: string } {
  if (profile.capabilitySetError) {
    return {
      profile,
      conflict: `Profile "${profile.name}" declares an invalid capabilitySet: ${profile.capabilitySetError} Fix the profile's frontmatter capabilitySet field, or remove it.`,
    };
  }
  if (profile.backend !== "pi") {
    // capabilitySet is a pi-only mechanism (skills/prompt templates resolved
    // for an in-process pi child); an external CLI backend has no way to load
    // it and would silently ignore the selection, so a declared capabilitySet
    // on a non-pi profile is a configuration conflict, not a no-op.
    if (profile.capabilitySet) {
      return {
        profile,
        conflict: `Profile "${profile.name}" declares backend "${profile.backend}" and capabilitySet "${profile.capabilitySet}", but capabilitySet only applies to backend "pi" (in-process, curated-tools) profiles — the ${profile.backend} CLI has no mechanism to load skills/prompt templates and would silently ignore the selection. Remove capabilitySet from this profile or change its backend to "pi" with a registered harness.`,
      };
    }
    return { profile };
  }
  if (!profile.harness) return { profile };
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
 * `sharedRoleTemplates` (see `extractSharedPiRoleProfiles`) adds a middle
 * precedence tier between a real on-disk override and canonical synthesis:
 * for each registered harness and each role — canonical or custom — that
 * harness doesn't already have its own `<harness>-<role>.md` file for, a
 * shared `pi-<role>.md` template is materialized into a concrete profile
 * pinned to that harness's model/thinking before falling back to the
 * built-in canonical body. Precedence: harness-specific on-disk file >
 * shared template > synthesized canonical.
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
  sharedRoleTemplates: ReadonlyMap<string, SubagentProfile> = NO_SHARED_TEMPLATES,
): Map<string, SubagentProfile> {
  if (harnessConfigs.size === 0) return profiles;
  const merged = new Map<string, SubagentProfile>();
  for (const [name, profile] of profiles) {
    merged.set(name, computeReconciledPiProfile(profile, harnessConfigs).profile);
  }
  const roles = new Set<string>([...defaultRoleNames(), ...sharedRoleTemplates.keys()]);
  for (const [harness, harnessConfig] of harnessConfigs) {
    for (const role of roles) {
      const key = `${harness}-${role}`;
      if (merged.has(key)) continue;
      const template = sharedRoleTemplates.get(role);
      const synthesized = template
        ? materializeSharedPiRoleProfile(role, harness, harnessConfig, template)
        : synthesizePiRoleProfile(role, harness, harnessConfig);
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
