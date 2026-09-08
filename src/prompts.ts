import type { SavedWorkflow } from "./workflow/registry.ts";
import { EXTERNAL_HARNESSES, type ExternalHarness, type SubagentProfile } from "./types.ts";
import { externalProfileRole, externalRoleAvailability } from "./profiles.ts";

export const AGENT_PROMPT_SNIPPET =
  "Delegate one task to an external Claude Code, Codex CLI, or Antigravity role.";

export const WORKFLOW_PROMPT_SNIPPET =
  "Run requested multi-agent orchestration with external roles; use external_help for syntax and saved workflows.";

export const EXTERNAL_HELP_PROMPT_SNIPPET =
  "Show external role details, permission behavior, or workflow guidance on demand.";

function roleLabel(role: string, harnesses: ExternalHarness[]): string {
  return `${role}${harnesses.length === EXTERNAL_HARNESSES.length ? "" : ` (${harnesses.join(", ")} only)`}`;
}

export function formatExternalRoleCatalog(
  profiles: Map<string, SubagentProfile>,
  defaultHarness: ExternalHarness,
): string {
  const roles = [...externalRoleAvailability(profiles)].map(([role, harnesses]) => roleLabel(role, harnesses));
  const exactProfiles = [...profiles.values()]
    .filter((profile) => !externalProfileRole(profile))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((profile) => `${profile.name} (${profile.backend})`);
  return [
    `Harnesses: ${EXTERNAL_HARNESSES.map((harness) => harness === defaultHarness ? `${harness} (default)` : harness).join(", ")}.`,
    `Roles: ${roles.join(", ") || "none"}.`,
    ...(exactProfiles.length ? [`Exact-only profiles: ${exactProfiles.join(", ")}.`] : []),
  ].join("\n");
}

export function formatExternalRoleHelp(
  profiles: Map<string, SubagentProfile>,
  defaultHarness: ExternalHarness,
  harness?: ExternalHarness,
): string {
  const selectedProfiles = [...profiles.values()]
    .filter((profile) => !harness || profile.backend === harness)
    .sort((a, b) => a.name.localeCompare(b.name));
  const roles = externalRoleAvailability(new Map(selectedProfiles.map((profile) => [profile.name, profile])));
  const roleLines = [...roles].flatMap(([role, harnesses]) => [
    `- ${role} (${harnesses.join(", ")})`,
    ...harnesses.map((availableHarness) => {
      const profile = profiles.get(`${availableHarness}-${role}`);
      return `  - ${profile?.name}: ${profile?.description ?? role}`;
    }),
  ]);
  const exactLines = selectedProfiles
    .filter((profile) => !externalProfileRole(profile))
    .map((profile) => `- ${profile.name} (${profile.backend}): ${profile.description}`);
  return [
    `External roles${harness ? ` on ${harness}` : ""}. Default harness: ${defaultHarness}.`,
    roleLines.join("\n") || "- none",
    ...(exactLines.length ? ["Exact-only profiles (use legacy subagent_type):", exactLines.join("\n")] : []),
    "Availability reflects configured profiles, not CLI installation or authentication.",
    "Role selection never falls back to another harness.",
  ].join("\n\n");
}

function truncateWorkflowText(text: string, maxLength = 180): string {
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

export function formatSavedWorkflows(workflows: SavedWorkflow[], maxItems = 20): string {
  if (workflows.length === 0) return "Saved workflows: none.";
  const shown = workflows.slice(0, maxItems);
  const lines = shown.map(
    (workflow) => `- ${workflow.name} (${workflow.scope}): ${truncateWorkflowText(workflow.description)}`,
  );
  if (workflows.length > shown.length) {
    lines.push(`- … ${workflows.length - shown.length} more saved workflow(s) not shown.`);
  }
  return `Saved workflows:\n${lines.join("\n")}`;
}

export function buildCoordinatorPrompt(profiles: Map<string, SubagentProfile>, defaultHarness: ExternalHarness): string {
  return `# External delegation

${formatExternalRoleCatalog(profiles, defaultHarness)}

Catalog availability reflects configured profiles, not CLI installation or authentication. External delegation tools use external CLIs only; use native Pi subagents for Pi-backed work. Give each child a clear task, absolute paths, and read-only/edit intent; nested agents may start elsewhere. For Agent and workflow agent(), use context: {mode:"recent", turns:N} to share the last N user turns (including the current turn), {mode:"full"} for all available post-compaction conversation, or omit context for independent tasks. Prefer the smallest sufficient context; supply missing older decisions in the prompt. Snapshots exclude thinking/system instructions and pending calls, reject images or more than 1 MiB, and may contain sensitive data sent to the external harness. Use resume for an existing child's follow-up; do not combine resume with sharing. This is text transfer, not a native session clone or guaranteed cache reuse. External CLIs have host access, and agy always runs unsandboxed (readonly/edit are advisory). Role selection never falls back. Do not retry failed runs: agy alone may make one disclosed infrastructure retry. Use external_help for role descriptions, permission details, workflow syntax, and saved workflows.`;
}
