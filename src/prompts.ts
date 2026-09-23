import type { SavedWorkflow } from "./workflow/registry.ts";
import { EXTERNAL_HARNESSES, type SubagentProfile } from "./types.ts";
import { externalProfileRole, externalRoleAvailability } from "./profiles.ts";

export const AGENT_PROMPT_SNIPPET =
  "Delegate one task to an external Claude Code, Codex CLI, Antigravity, Grok CLI, Muse Code, or registered Pi harness role.";

export const WORKFLOW_PROMPT_SNIPPET =
  "Run requested multi-agent orchestration with external roles; use external_help for syntax and saved workflows.";

export const EXTERNAL_HELP_PROMPT_SNIPPET =
  "Show external role details, permission behavior, or workflow guidance on demand.";

export const EXTERNAL_RUNS_PROMPT_SNIPPET =
  "List, inspect (single or batch summary via runIds, up to 20), wait for, or cancel session-owned external runs; follow cursors for complete output. view: final returns only a verified terminal answer, empty until one exists.";

// Only elide the "(harness only)" suffix when every configured harness
// carries the role; a role available on all configured CLIs but no pi harness
// still gets the suffix, so callers see the true availability rather than
// a stale "no suffix means universal" assumption.
function roleLabel(role: string, harnesses: string[], configuredHarnesses: readonly string[]): string {
  return `${role}${harnesses.length === configuredHarnesses.length ? "" : ` (${harnesses.join(", ")} only)`}`;
}

export function formatExternalRoleCatalog(
  profiles: Map<string, SubagentProfile>,
  defaultHarness: string,
  configuredHarnessNames: readonly string[] = EXTERNAL_HARNESSES,
): string {
  const roles = [...externalRoleAvailability(profiles)].map(([role, harnesses]) => roleLabel(role, harnesses, configuredHarnessNames));
  const exactProfiles = [...profiles.values()]
    .filter((profile) => !profile.configurationError && !externalProfileRole(profile))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((profile) => `${profile.name} (${profile.harness ?? profile.backend})`);
  return [
    `Harnesses: ${configuredHarnessNames.map((harness) => harness === defaultHarness ? `${harness} (default)` : harness).join(", ")}.`,
    `Roles: ${roles.join(", ") || "none"}.`,
    ...(exactProfiles.length ? [`Exact-only profiles: ${exactProfiles.join(", ")}.`] : []),
  ].join("\n");
}

export function formatExternalRoleHelp(
  profiles: Map<string, SubagentProfile>,
  defaultHarness: string,
  harness?: string,
): string {
  const selectedProfiles = [...profiles.values()]
    .filter((profile) => !harness || (profile.harness ?? profile.backend) === harness)
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
    .filter((profile) => !profile.configurationError && !externalProfileRole(profile))
    .map((profile) => `- ${profile.name} (${profile.harness ?? profile.backend}): ${profile.description}`);
  return [
    `External roles${harness ? ` on ${harness}` : ""}. Default harness: ${defaultHarness}.`,
    roleLines.join("\n") || "- none",
    ...(exactLines.length ? ["Exact-only profiles (use legacy subagent_type):", exactLines.join("\n")] : []),
    "Availability reflects built-in and authored roles, not CLI installation or authentication.",
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

export function buildCoordinatorPrompt(
  profiles: Map<string, SubagentProfile>,
  defaultHarness: string,
  configuredHarnessNames: readonly string[] = EXTERNAL_HARNESSES,
): string {
  return `# External delegation

${formatExternalRoleCatalog(profiles, defaultHarness, configuredHarnessNames)}

Catalog availability reflects built-in and authored roles, not CLI installation or authentication. External delegation tools use external CLIs and registered Pi harnesses; use native Pi subagents for Pi-backed work. Give each child a clear task, absolute paths, and read-only/edit intent; nested agents may start elsewhere. Share parent context explicitly when a child needs it: context: {mode:"recent", turns:N} for the last N user turns (including the current turn), {mode:"full"} for available post-compaction conversation, or omit it for independent tasks. Prefer the smallest sufficient snapshot; snapshots exclude thinking/system instructions and pending calls, fail on images or over 1 MiB, and may contain sensitive data sent to the external harness. Use resume to follow up on an existing child; never combine it with sharing. This is text transfer, not a native session clone or guaranteed cache reuse. Blocking by default; set background:true only when the parent can proceed before completion, then use external_runs on the returned run ID. Parallel same-harness work shares one maxConcurrentSubagents cap: use parallel([() => agent(...), ...]) or separate background Agent calls in one turn; sequential awaits stay serial. External CLIs have host access, and agy always runs unsandboxed (readonly/edit are advisory). Role selection never falls back. Do not retry failed runs: agy alone may make one disclosed infrastructure retry. Use external_help for role descriptions, permission details, workflow syntax, supervision syntax, and saved workflows.`;
}
