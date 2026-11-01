import { ExpectedFlowError } from "./core/errors.ts";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { EXTERNAL_HARNESSES, type ExternalHarness, type SubagentBackend, type SubagentProfile, type ThinkingLevel } from "./types.ts";
import { loadExternalSettings } from "./settings.ts";
import { bindingKey, loadV5Catalog } from './catalog-v5.ts';

const NO_PI_HARNESSES: ReadonlySet<string> = new Set();

const VALID_PROFILE_NAME = /^[a-z0-9][a-z0-9-]*$/;

export function isValidSubagentName(name: string): boolean {
  return VALID_PROFILE_NAME.test(name) && name !== 'constructor' && name !== 'prototype';
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
  if (['model', 'thinking'].some(key => parsed.frontmatter[key] !== undefined && parsed.frontmatter[key] !== null && typeof parsed.frontmatter[key] !== 'string')) return undefined;
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

export function getSubagentProfiles(agentDir = getAgentDir()): Map<string, SubagentProfile> {
  const catalog = loadExternalCatalog(agentDir);
  if (catalog.blocked) throw new Error(catalog.diagnostics.join(" "));
  return catalog.profiles;
}

/**
 * OpenCode 2 takes `--model provider/model#variant`. Variant names are
 * model-specific, and OpenCode rejects an unknown one before the prompt runs
 * (core/src/model-resolver.ts "Variant unavailable"). A pinned thinking level is
 * therefore forwarded as that model's variant, which is only possible when the
 * model itself is pinned. The inherited Pi thinking level is never forwarded.
 */
export function opencodeProfileProblem(profile: SubagentProfile): string | undefined {
  if (profile.backend !== "opencode") return undefined;
  if (profile.model !== undefined && !/^[^/\s]+\/\S+$/.test(profile.model)) {
    return `OpenCode profile "${profile.name}" pins model "${profile.model}". Use the provider/model form, such as anthropic/claude-sonnet-4-5.`;
  }
  if (profile.thinking !== undefined && profile.model === undefined) {
    return `OpenCode profile "${profile.name}" pins thinking "${profile.thinking}" without a model. OpenCode variants are model-specific; pin model provider/model too, or remove thinking.`;
  }
  if (profile.thinking !== undefined && profile.model?.includes("#")) {
    return `OpenCode profile "${profile.name}" pins both a #variant in model "${profile.model}" and thinking "${profile.thinking}". Keep one.`;
  }
  return undefined;
}

/** Actionable rejection for a disabled harness. Selection never substitutes another harness. */
export function disabledHarnessMessage(harness: string, isDefault = false): string {
  return isDefault
    ? `Default harness "${harness}" is disabled in settings.json. Pass another harness explicitly, choose a new default with /external config harness default <harness>, or enable it with /external config harness enable ${harness}.`
    : `Harness "${harness}" is disabled in settings.json. Enable it with /external config harness enable ${harness}, or choose another harness.`;
}

export type ExternalCatalog = ReturnType<typeof loadV5Catalog>;

/** The one catalog source. Settings version 4 is blocked until explicit conversion. */
export function loadExternalCatalog(agentDir = getAgentDir()): ExternalCatalog {
  const loaded = loadExternalSettings(agentDir);
  if (loaded.settings.version === 4) return { profiles: new Map<string, SubagentProfile>(), diagnostics: [...loaded.diagnostics, 'Settings version 4 requires explicit conversion. Run /external config convert.'], blocked: true, harnessConfigs: new Map(Object.entries(loaded.settings.harnesses ?? {})), disabledHarnesses: new Set(loaded.settings.disabledHarnesses ?? []) };
  return loadV5Catalog(agentDir, loaded);
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

/** Canonical role of a binding; exact compatibility records have none. */
export function externalProfileRole(profile: SubagentProfile): string | undefined {
  return profile.role;
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

export interface ResolveExternalProfileOptions {
  /** All legitimate selector names: EXTERNAL_HARNESSES plus registered pi-* harnesses. */
  configuredHarnessNames?: ReadonlySet<string>;
  /** Harnesses disabled in settings; selecting one fails without fallback. */
  disabledHarnesses?: ReadonlySet<string>;
}

const DEFAULT_RESOLVE_OPTIONS: Required<ResolveExternalProfileOptions> = {
  configuredHarnessNames: new Set(EXTERNAL_HARNESSES),
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
  const role = selection.role?.trim();
  const harness = selection.harness?.trim();
  const subagentType = selection.subagentType?.trim();

  if (subagentType) {
    if (role || harness) {
      throw new ExpectedFlowError("selection_invalid", "Choose either role (with optional harness) or legacy subagent_type; do not combine them.");
    }
    const matches = [...profiles.values()].filter(p => p.configVersion === 5 && p.role && `${selectorHarness(p)}-${p.role}` === subagentType);
    if (!profiles.has(subagentType) && matches.length > 1) throw new ExpectedFlowError("selection_invalid", `Ambiguous legacy selector "${subagentType}"; use role and harness explicitly.`);
    const profile = profiles.get(subagentType) ?? matches[0];
    if (!profile) {
      throw new ExpectedFlowError("selection_invalid", unknownExternalProfileMessage(subagentType, profiles.keys()));
    }
    if (profile.configurationError) throw new ExpectedFlowError("selection_invalid", profile.configurationError);
    return profile;
  }

  if (!role) {
    throw new ExpectedFlowError("selection_invalid", harness
      ? "role is required when harness is provided; otherwise provide role or legacy subagent_type."
      : "Either role or legacy subagent_type is required.");
  }
  const selectedHarness = harness || defaultHarness;
  if (!configuredHarnessNames.has(selectedHarness)) {
    throw new ExpectedFlowError("selection_invalid", `Unknown external harness "${selectedHarness}". Choose one of: ${[...configuredHarnessNames].join(", ") || "none"}.`);
  }
  if ((options.disabledHarnesses ?? DEFAULT_RESOLVE_OPTIONS.disabledHarnesses).has(selectedHarness)) {
    throw new ExpectedFlowError("selection_invalid", disabledHarnessMessage(selectedHarness, !harness));
  }

  const binding = profiles.get(bindingKey(selectedHarness, role));
  if (binding) {
    if (binding.configurationError) throw new ExpectedFlowError("selection_invalid", binding.configurationError);
    return binding;
  }

  const availability = externalRoleAvailability(profiles);
  const supported = availability.get(role);
  if (supported?.length) {
    throw new ExpectedFlowError("selection_invalid",
      `Role "${role}" is unavailable for harness "${selectedHarness}". Supported harnesses for this role: ${supported.join(", ")}. Choose one of those harnesses or add profile "${selectedHarness}-${role}".`,
    );
  }
  throw new ExpectedFlowError("selection_invalid",
    `Unknown external role "${role}". Available roles: ${[...availability.keys()].join(", ") || "none"}. Nonstandard profile names must be selected with legacy subagent_type.`,
  );
}
