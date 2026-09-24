import { existsSync, readdirSync, readFileSync, lstatSync } from "node:fs";
import { basename, join } from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { EXTERNAL_HARNESSES, type ExternalHarness, type SubagentBackend, type SubagentProfile, type ThinkingLevel } from "./types.ts";
import { defaultRoleNames, roleDefinition } from "./default-roles.ts";
import type { HarnessConfig } from "./harnesses.ts";
import { loadExternalSettings } from "./settings.ts";

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
  if (backend === "pi" || backend === "codex" || backend === "claude" || backend === "agy" || backend === "grok" || backend === "muse" || backend === "opencode") {
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
  const maxBudgetUsd = parseMaxBudgetUsd(parsed.frontmatter.max_budget_usd);
  const owner = optionalString(parsed.frontmatter.owner);

  if (
    !description ||
    tools === "invalid" ||
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
  const catalog = loadExternalCatalog(agentDir);
  if (catalog.blocked) throw new Error(catalog.diagnostics.join(" "));
  return catalog.profiles;
}

/**
 * OpenCode takes `--model provider/model`. Its `--variant` names are
 * model-specific, and it ignores an unknown one without an error
 * (session/llm/request.ts), so a pinned thinking level is refused instead of
 * being passed where it might silently do nothing.
 */
export function opencodeProfileProblem(profile: SubagentProfile): string | undefined {
  if (profile.backend !== "opencode") return undefined;
  if (profile.model !== undefined && !/^[^/\s]+\/\S+$/.test(profile.model)) {
    return `OpenCode profile "${profile.name}" pins model "${profile.model}". Use the provider/model form, such as anthropic/claude-sonnet-4-5.`;
  }
  if (profile.thinking !== undefined) {
    return `OpenCode profile "${profile.name}" pins thinking "${profile.thinking}". OpenCode variants are model-specific and an unknown one is ignored, so thinking is not supported on opencode. Remove it; the model's own default variant applies.`;
  }
  return undefined;
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

/** Actionable rejection for a disabled harness. Selection never substitutes another harness. */
export function disabledHarnessMessage(harness: string, isDefault = false): string {
  return isDefault
    ? `Default harness "${harness}" is disabled in settings.json. Pass another harness explicitly, choose a new default with /external config default <harness>, or enable it with /external config enable ${harness}.`
    : `Harness "${harness}" is disabled in settings.json. Enable it with /external config enable ${harness}, or choose another harness.`;
}

export function loadExternalCatalog(agentDir = getAgentDir()): { profiles: Map<string, SubagentProfile>; diagnostics: string[]; blocked: boolean; harnessConfigs: Map<string, HarnessConfig>; disabledHarnesses: Set<string> } {
  const loaded = loadExternalSettings(agentDir);
  const diagnostics = [...loaded.diagnostics];
  const profiles = new Map<string, SubagentProfile>();
  const harnesses = new Map(Object.entries(loaded.settings.harnesses ?? {}));
  const disabledHarnesses = new Set(loaded.settings.disabledHarnesses ?? []);
  if (loaded.blocked) return { profiles, diagnostics, blocked: true, harnessConfigs: harnesses, disabledHarnesses };
  const names = [...EXTERNAL_HARNESSES, ...harnesses.keys()];
  for (const name of disabledHarnesses) {
    if (!names.includes(name)) diagnostics.push(`disabledHarnesses entry "${name}" is not a known harness. It is kept and applies if that harness appears; remove it with /external config enable ${name}.`);
  }
  const labels: Record<string, string> = { agy: "Antigravity", claude: "Claude Code", codex: "Codex CLI", grok: "Grok CLI", muse: "Muse Code", opencode: "OpenCode" };
  const bind = (role: string, definition: { description: string; systemPrompt?: string; configurationError?: string }, source: string) => {
    for (const harness of names) {
      const config = harnesses.get(harness);
      profiles.set(`${harness}-${role}`, { ...definition, name: `${harness}-${role}`, description: definition.description.replaceAll("${backendLabel}", labels[harness] ?? harness), backend: config ? "pi" : harness as ExternalHarness, ...(config ? { harness, ...piHarnessBinding(config) } : {}), source });
    }
  };
  for (const role of defaultRoleNames()) {
    const definition = roleDefinition(role)!;
    bind(role, { description: definition.description, systemPrompt: definition.body }, "built-in");
  }
  for (const kind of ["roles", "overrides"] as const) {
    const dir = join(agentDir, "pi-flow-external", kind);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith(".md")) continue;
      const name = basename(entry, ".md");
      if (!isValidSubagentName(name)) continue;
      const path = join(dir, entry);
      let profile: SubagentProfile | undefined;
      let error: string | undefined;
      try {
        if (!lstatSync(path).isFile()) throw new Error("must be a regular file");
        const content = readFileSync(path, "utf8");
        profile = parseSubagentProfileContent(content, name, { requireBody: kind === "roles" });
        if (!profile) throw new Error("invalid role metadata or instructions");
        if (kind === "roles") {
          const { frontmatter } = parseFrontmatter<Record<string, unknown>>(content);
          const obsolete = ["permission", "capabilitySet"].filter((key) => Object.prototype.hasOwnProperty.call(frontmatter, key));
          if (obsolete.length) {
            throw new Error(`obsolete metadata ${obsolete.join(", ")} does not grant authority. Remove it. A role describes intent; pass permission on the Agent or workflow call, or set defaultPermission. Pi skills follow the harness preset.`);
          }
          if (Object.keys(frontmatter).some((key) => key !== "description")) throw new Error("shared roles support description only; use an exact override for execution settings");
        } else {
          const { frontmatter } = parseFrontmatter<Record<string, unknown>>(content);
          const obsolete = ["permission", "capabilitySet"].filter((key) => Object.prototype.hasOwnProperty.call(frontmatter, key));
          if (obsolete.length) {
            throw new Error(`obsolete metadata ${obsolete.join(", ")} is not an authority floor or a capability selection. Remove it. Pass permission on the call, or set defaultPermission. Pi skills follow the harness preset.`);
          }
          if (!isExternalAgentProfile(profile, new Set(harnesses.keys()))) throw new Error("override must declare an external backend or registered Pi harness");
          const opencodeProblem = opencodeProfileProblem(profile);
          if (opencodeProblem) throw new Error(opencodeProblem);
        }
      } catch (cause) { error = `Invalid ${kind === "roles" ? "role" : "override"} ${path}: ${cause instanceof Error ? cause.message : String(cause)}`; diagnostics.push(error); }
      if (kind === "roles") bind(name, { description: profile?.description ?? name, systemPrompt: profile?.systemPrompt, ...(error ? { configurationError: error } : {}) }, path);
      else {
        const prior = profiles.get(name);
        const harness = [...names].sort((a, b) => b.length - a.length).find(h => name.startsWith(`${h}-`));
        const fallback = prior ?? { name, description: name, backend: harnesses.has(harness ?? "") ? "pi" as const : (harness ?? "agy") as ExternalHarness, ...(harnesses.has(harness ?? "") ? { harness } : {}) };
        profiles.set(name, { ...(profile ?? fallback), source: path, ...(error ? { configurationError: error } : {}) });
      }
    }
  }
  for (const name of loaded.settings.disabledProfiles ?? []) {
    const profile = profiles.get(name);
    if (profile) profiles.set(name, { ...profile, configurationError: `Execution identity "${name}" is disabled in settings.json.` });
  }
  const merged = mergeSynthesizedPiProfiles(profiles, harnesses);
  for (const [name, profile] of merged) {
    const harness = selectorHarness(profile);
    if (disabledHarnesses.has(harness)) merged.set(name, { ...profile, configurationError: disabledHarnessMessage(harness) });
  }
  return { profiles: merged, diagnostics, blocked: false, harnessConfigs: harnesses, disabledHarnesses };
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
    if (profile.configurationError) continue;
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

/** Model, thinking, and resource preset copied from a named Pi registration. */
function piHarnessBinding(config: HarnessConfig): Pick<SubagentProfile, "model" | "thinking" | "preset"> {
  return { model: config.model, thinking: config.thinking, preset: config.preset };
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
    ...piHarnessBinding(harnessConfig),
    systemPrompt: definition.body,
  };
}

/**
 * Core reconciliation rule shared by the throwing (resolution-time) and
 * non-throwing (merge-time) call sites below: the harness registry stays
 * authoritative for model, thinking, and resource preset. A file that omits
 * model or thinking inherits the registry's values; a file that declares the
 * same values is redundant-but-consistent; a file that declares a *different*
 * model or thinking is a configuration conflict. Preset is registration state,
 * not role metadata, so the registry value is always stamped.
 */
export function computeReconciledPiProfile(
  profile: SubagentProfile,
  harnessConfigs: ReadonlyMap<string, HarnessConfig>,
): { profile: SubagentProfile; conflict?: string } {
  if (profile.backend !== "pi") {
    return { profile };
  }
  if (!profile.harness) return { profile };
  const harnessConfig = harnessConfigs.get(profile.harness);
  if (!harnessConfig) {
    return {
      profile,
      conflict: `Harness "${profile.harness}" is not registered. Create it first via /external config harness create.`,
    };
  }
  if (profile.model !== undefined && profile.model !== harnessConfig.model) {
    return {
      profile,
      conflict: `Profile "${profile.name}" declares harness "${profile.harness}" but pins model "${profile.model}", which conflicts with "${profile.harness}"'s registered model "${harnessConfig.model}". Remove the override or update settings.json.`,
    };
  }
  if (profile.thinking !== undefined && profile.thinking !== harnessConfig.thinking) {
    return {
      profile,
      conflict: `Profile "${profile.name}" declares harness "${profile.harness}" but pins thinking "${profile.thinking}", which conflicts with "${profile.harness}"'s registered thinking "${harnessConfig.thinking}". Remove the override or update settings.json.`,
    };
  }
  return { profile: { ...profile, ...piHarnessBinding(harnessConfig) } };
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
  /** Harnesses disabled in settings; selecting one fails without fallback. */
  disabledHarnesses?: ReadonlySet<string>;
}

const DEFAULT_RESOLVE_OPTIONS: Required<ResolveExternalProfileOptions> = {
  configuredHarnessNames: new Set(EXTERNAL_HARNESSES),
  harnessConfigs: NO_HARNESS_CONFIGS,
  disabledHarnesses: NO_PI_HARNESSES,
};

/** Unknown exact identity. Directs the caller back to role plus harness, including a registered pi-* name. */
export function unknownExternalProfileMessage(subagentType: string, names: Iterable<string>): string {
  const available = [...names].join(", ") || "none";
  return `Unknown external subagent_type "${subagentType}". Available external profiles: ${available}. Select role and an optional harness (agy, claude, codex, grok, muse, opencode, or a registered pi-* name).`;
}

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
      throw new Error(unknownExternalProfileMessage(subagentType, profiles.keys()));
    }
    if (profile.configurationError) throw new Error(profile.configurationError);
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
  if ((options.disabledHarnesses ?? DEFAULT_RESOLVE_OPTIONS.disabledHarnesses).has(selectedHarness)) {
    throw new Error(disabledHarnessMessage(selectedHarness, !harness));
  }

  const exact = profiles.get(`${selectedHarness}-${role}`);
  if (exact) {
    if (exact.configurationError) throw new Error(exact.configurationError);
    if (selectorHarness(exact) !== selectedHarness || externalProfileRole(exact) !== role) throw new Error(`Override "${exact.name}" does not match selected harness "${selectedHarness}".`);
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
