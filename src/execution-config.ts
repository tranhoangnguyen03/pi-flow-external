import type { SubagentProfile } from './types.ts';

/** Resolve inheritance sentinels once before adapters inspect either profile or effort. */
export function resolveExecutionProfile(profile: SubagentProfile, parentThinking?: string, defaultBudget?: number): SubagentProfile {
 return {
  ...profile,
  model: profile.model === 'native' ? undefined : profile.model,
  thinking: profile.thinking === 'native' ? undefined : profile.thinking === 'parent' ? parentThinking : profile.thinking ?? (profile.configVersion === 5 || profile.backend === 'opencode' ? undefined : profile.backend === 'pi' ? 'off' : parentThinking),
  maxBudgetUsd: profile.maxBudgetUsd ?? defaultBudget,
 };
}
