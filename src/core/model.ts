import type { ExtensionContext, ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { SubagentProfile } from "../types.ts";

export function usesPiBackend(profile: SubagentProfile): boolean {
  return profile.backend === "pi";
}

export function findProfileModel(profile: SubagentProfile, modelRegistry: ModelRegistry): ExtensionContext["model"] {
  if (!usesPiBackend(profile) || !profile.model) {
    return undefined;
  }
  const separator = profile.model.indexOf("/");
  if (separator === -1) {
    return undefined;
  }
  return modelRegistry.find(profile.model.slice(0, separator), profile.model.slice(separator + 1));
}

export function resolveProfileModel(profile: SubagentProfile, ctx: ExtensionContext): ExtensionContext["model"] {
  if (!usesPiBackend(profile)) {
    return undefined;
  }
  // A legitimate pi profile always pins a model (either declared directly or
  // inherited from its registered harness at resolution time), so there is no
  // "fall back to the parent's own model" case here: an admitted pi profile
  // with no resolvable model is a real error, surfaced by describeMissingModel.
  return profile.model ? findProfileModel(profile, ctx.modelRegistry) : undefined;
}

/**
 * Distinguish "profile pins no parseable model string" from "profile pins a
 * parseable model that isn't in the registry" so callers can surface the two
 * distinct failures from design §7.1 instead of one generic message.
 */
export function describeMissingModel(profile: SubagentProfile, modelRegistry: ModelRegistry): string {
  if (!profile.model) {
    return "No model is selected";
  }
  const separator = profile.model.indexOf("/");
  if (separator === -1) {
    return `Profile "${profile.name}" pins no resolvable model (expected "<provider>/<id>", got ${JSON.stringify(profile.model)}).`;
  }
  const provider = profile.model.slice(0, separator);
  const id = profile.model.slice(separator + 1);
  if (modelRegistry.find(provider, id)) {
    return "No model is selected";
  }
  return `Profile "${profile.name}" pins model "${profile.model}", which was not found in the registry.`;
}

export function filterProfilesForModelRegistry(
  profiles: Map<string, SubagentProfile>,
  _modelRegistry: ModelRegistry | undefined,
): Map<string, SubagentProfile> {
  return profiles;
}
