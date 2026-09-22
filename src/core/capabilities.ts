import { readFileSync } from "node:fs";
import { DefaultResourceLoader, SettingsManager, type PromptTemplate, type Skill } from "@earendil-works/pi-coding-agent";
import { hashStableValue } from "../workflow/replay-cache.ts";
import type { PiCapabilitySet } from "../settings.ts";

export interface CapabilitySelection {
  set: string;
  skills: string[];
  promptTemplates: string[];
}

/** A resolved selection plus a content fingerprint, for workflow freeze/replay invalidation. */
export interface FrozenCapabilitySelection extends CapabilitySelection {
  /** sha256 over the selected SKILL.md/template raw file bytes plus resource identity/trust (scope). */
  contentHash: string;
}

export interface ResolveCapabilitySelectionParams {
  cwd: string;
  agentDir: string;
  /** Real project-trust decision (ctx.isProjectTrusted()); gates project-scope skill/prompt directories. */
  projectTrusted: boolean;
  /** Name of the capabilitySet being resolved, for error messages. */
  set: string;
  capabilitySet: PiCapabilitySet;
}

/** Exact selected resource names, already validated once (freeze) or about to be re-validated (actual load). */
export interface CapabilityNames {
  skills: readonly string[];
  promptTemplates: readonly string[];
}

export interface LoadCapabilityResourcesParams {
  cwd: string;
  agentDir: string;
  settingsManager: SettingsManager;
  /** Name of the capabilitySet being loaded, for error messages. */
  set: string;
  names: CapabilityNames;
  /** Threaded through to the child's resourceLoader when building it for an actual session (spawn.ts). */
  appendSystemPromptOverride?: (base: string[]) => string[];
}

export interface LoadedCapabilityResources {
  /** Already-reloaded loader, ready to hand to createAgentSession as-is. */
  loader: DefaultResourceLoader;
  skills: Skill[];
  prompts: PromptTemplate[];
  /**
   * sha256 fingerprint over the actually-loaded selection's raw file bytes
   * plus resource identity/trust (scope), computed identically to
   * {@link resolveCapabilitySelection}'s frozen contentHash so a caller
   * holding an earlier-frozen hash can detect drift between resolution and
   * this load.
   */
  contentHash: string;
}

/**
 * Shared fingerprint formula for a loaded skill/prompt-template selection.
 * Hashes raw on-disk bytes at filePath rather than the SDK's own .content
 * field: skills carry no content field at all (Skill has no `content`
 * property in this SDK layer), and PromptTemplate.content may already have
 * frontmatter stripped, which would hide a frontmatter-only edit from the
 * fingerprint.
 */
function hashCapabilitySelection(
  projectTrusted: boolean,
  skills: readonly Skill[],
  prompts: readonly PromptTemplate[],
): string {
  const skillEntries = [...skills]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((skill) => ({
      name: skill.name,
      filePath: skill.filePath,
      scope: skill.sourceInfo.scope,
      content: readFileSync(skill.filePath, "utf8"),
    }));
  const promptEntries = [...prompts]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((prompt) => ({
      name: prompt.name,
      filePath: prompt.filePath,
      scope: prompt.sourceInfo.scope,
      content: readFileSync(prompt.filePath, "utf8"),
    }));
  return hashStableValue({ projectTrusted, skills: skillEntries, prompts: promptEntries });
}

/**
 * Authoritative single construct+load+validate step for a capabilitySet's
 * exact resolved skill/prompt-template names, reusing the installed SDK's own
 * resource discovery (DefaultResourceLoader) instead of reimplementing
 * directory scanning. Extensions/MCP/themes never load (noExtensions/noThemes
 * stay true always); discovery for skills/prompts only turns on for the
 * resource kind actually selected, and is immediately post-filtered to
 * exactly those names via skillsOverride/promptsOverride — nothing else
 * discovered is kept.
 *
 * This is the single source of truth for capabilitySet resource loading,
 * used both by {@link resolveCapabilitySelection} (up-front freeze/dry-run
 * validation) and by core/spawn.ts (the actual pi child resource loading at
 * spawn time) — so a resource that disappeared between freeze and spawn
 * fails loudly here instead of a second, unvalidated ad hoc loader silently
 * loading fewer resources than declared.
 *
 * Fails before any prompt/session exists when a selected name is not
 * discoverable, naming exactly what's missing (SDK name collisions are left
 * to the SDK's own first-wins-by-name + collision diagnostic behavior; this
 * loader does not second-guess that).
 */
export async function loadCapabilityResources(params: LoadCapabilityResourcesParams): Promise<LoadedCapabilityResources> {
  const { cwd, agentDir, settingsManager, set, names } = params;
  const selectedSkills = new Set(names.skills);
  const selectedPrompts = new Set(names.promptTemplates);

  let foundSkills: Skill[] = [];
  let foundPrompts: PromptTemplate[] = [];
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noThemes: true,
    noSkills: selectedSkills.size === 0,
    noPromptTemplates: selectedPrompts.size === 0,
    skillsOverride: (base) => {
      foundSkills = base.skills.filter((skill) => selectedSkills.has(skill.name));
      return { skills: foundSkills, diagnostics: base.diagnostics };
    },
    promptsOverride: (base) => {
      foundPrompts = base.prompts.filter((prompt) => selectedPrompts.has(prompt.name));
      return { prompts: foundPrompts, diagnostics: base.diagnostics };
    },
    ...(params.appendSystemPromptOverride ? { appendSystemPromptOverride: params.appendSystemPromptOverride } : {}),
  });
  await loader.reload();

  const missingSkills = [...selectedSkills].filter((name) => !foundSkills.some((skill) => skill.name === name));
  const missingPrompts = [...selectedPrompts].filter((name) => !foundPrompts.some((prompt) => prompt.name === name));
  if (missingSkills.length || missingPrompts.length) {
    const parts = [
      ...missingSkills.map((name) => `skill "${name}"`),
      ...missingPrompts.map((name) => `prompt template "${name}"`),
    ];
    throw new Error(
      `capabilitySet "${set}" is not fully resolvable: ${parts.join(", ")} ${parts.length === 1 ? "is" : "are"} not discoverable ` +
      `(checked global skills/prompts directories, plus project ones only because this project ${settingsManager.isProjectTrusted() ? "is" : "is not"} trusted). ` +
      "Fix the set in settings.json, or remove/correct the profile's capabilitySet selection.",
    );
  }

  const contentHash = hashCapabilitySelection(settingsManager.isProjectTrusted(), foundSkills, foundPrompts);
  return { loader, skills: foundSkills, prompts: foundPrompts, contentHash };
}

/**
 * Up-front freeze/dry-run validation: resolves and content-hashes a
 * capabilitySet's exact selection without needing a live session, via the
 * same authoritative {@link loadCapabilityResources} used at actual spawn
 * time. Project trust is threaded explicitly: settingsManager.setProjectTrusted
 * is called with the caller's real ctx.isProjectTrusted() decision before
 * reload(), since SettingsManager otherwise defaults to trusted on its own.
 */
export async function resolveCapabilitySelection(params: ResolveCapabilitySelectionParams): Promise<FrozenCapabilitySelection> {
  const { cwd, agentDir, projectTrusted, set, capabilitySet } = params;

  const settingsManager = SettingsManager.create(cwd, agentDir);
  settingsManager.setProjectTrusted(projectTrusted);

  const { skills: foundSkills, prompts: foundPrompts, contentHash } = await loadCapabilityResources({
    cwd,
    agentDir,
    settingsManager,
    set,
    names: capabilitySet,
  });

  return {
    set,
    skills: [...foundSkills].sort((a, b) => a.name.localeCompare(b.name)).map((skill) => skill.name),
    promptTemplates: [...foundPrompts].sort((a, b) => a.name.localeCompare(b.name)).map((prompt) => prompt.name),
    contentHash,
  };
}
