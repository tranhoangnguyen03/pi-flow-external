import type { SavedWorkflow } from "./workflow/registry.ts";
import { EXTERNAL_HARNESSES, type PermissionTier, type SubagentProfile } from "./types.ts";
import { externalProfileRole, externalRoleAvailability } from "./profiles.ts";

export const AGENT_PROMPT_SNIPPET =
  "Delegate one task to an external Claude Code, Codex CLI, Antigravity, Grok CLI, Muse Code, or registered Pi harness role.";

export const WORKFLOW_PROMPT_SNIPPET =
  "Run requested multi-agent orchestration with external roles; use external_help for syntax and saved workflows.";

export const EXTERNAL_HELP_PROMPT_SNIPPET =
  "Show the delegation playbook, role details, permission behavior, or workflow guidance on demand.";

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

Own the result and verify it yourself. Do the work directly unless a separate harness, a fresh context, or a bounded parallel review earns the overhead. A role is the job. A harness (agy, claude, codex, grok, muse, or a registered pi-* name) is the environment. Select both through Agent or workflow. Follow the user's own approval policy before widening a delegation. This extension has no fixed multi-agent approval threshold.

Give every child an objective, the context it needs, the changes it may make, a deliverable, and the check you will run. Use absolute paths and say whether the task is read-only or may edit. Permission is the call's tier, otherwise defaultPermission (danger unless changed). A danger tier still has to stay inside the authorization the user gave you. agy accepts only danger and rejects readonly and edit.

Choose a fresh child or resume on purpose. Omit context for independent work. context {mode:"recent", turns:N} shares the last N user turns, including the current turn; {mode:"full"} shares the available post-compaction conversation. Snapshots drop thinking, system instructions, and pending calls, reject images and payloads over 1 MiB, and are sent to that harness. resume continues the same CLI child and cannot be combined with sharing. A named pi-* harness has no persisted session. Prefer resume for the same task and a new child for an independent review.

Calls block unless background:true. Then supervise with external_runs and judge view "final" yourself. Same-harness parallel work shares one maxConcurrentSubagents cap: parallel([() => agent(...), ...]) or separate background Agent calls in one turn. Sequential awaits stay serial. Report milestones. Do not retry a failed run or switch model or harness on your own. agy alone may make one disclosed infrastructure retry. Nested agents may start in another workspace.

Catalog availability reflects built-in and authored roles, not CLI installation or authentication. Role selection never falls back. external_help topic usage is the playbook; roles, permissions, and workflow are the references.`;
}

export interface UsageAgentExample {
  description: string;
  prompt: string;
  role: string;
  harness: string;
  permission: PermissionTier;
  background?: boolean;
  resume?: string;
  context?: { mode: "none" } | { mode: "recent"; turns: number } | { mode: "full" };
}

/** One self-contained Agent call. Valid against the Agent tool schema. */
export const USAGE_ONE_AGENT: UsageAgentExample = {
  description: "Map the repository",
  prompt: "Map /absolute/repo. Read only. Return the important files and how they fit together. Do not edit.",
  role: "explorer",
  harness: "claude",
  permission: "readonly",
};

/** Fresh reviewer. No shared history and no resume, so the review is independent. */
export const USAGE_INDEPENDENT_REVIEW: UsageAgentExample = {
  description: "Independent review",
  prompt: "Review /absolute/repo read-only. Report defects with file paths. Do not edit.",
  role: "reviewer",
  harness: "codex",
  permission: "readonly",
  context: { mode: "none" },
};

/** Returns after registration. The parent reads the verified answer through external_runs. */
export const USAGE_BACKGROUND_AGENT: UsageAgentExample = {
  description: "Background map",
  prompt: "Map /absolute/repo read-only and return a short file list. Do not edit.",
  role: "explorer",
  harness: "claude",
  permission: "readonly",
  background: true,
};

/** Single-id batch inspect. The executor accepts runIds with view final for one id. */
export const USAGE_RUNS_FINAL = {
  action: "inspect" as const,
  runIds: ["run_example"],
  view: "final" as const,
};

/** Continues a CLI child that stored a session id. Named pi-* harnesses cannot resume. */
export const USAGE_RESUME_AGENT: UsageAgentExample = {
  description: "Continue the map",
  prompt: "Continue the map of /absolute/repo. Add the missing test entry points you already found. Do not expand scope.",
  role: "explorer",
  harness: "claude",
  permission: "readonly",
  resume: "run_example",
};

export const USAGE_WORKFLOW_CALLS: { prompt: string; options: { description: string; role: string; harness: string; permission: PermissionTier } }[] = [
  {
    prompt: "Map /absolute/repo read-only. Return important paths. Do not edit.",
    options: { description: "map", role: "explorer", harness: "claude", permission: "readonly" },
  },
  {
    prompt: "Review /absolute/repo read-only. Report defects with paths. Do not edit.",
    options: { description: "review", role: "reviewer", harness: "codex", permission: "readonly" },
  },
];

/** Parallel workflow whose branches catch ChildRunError so one failure does not drain the other. */
export function usageWorkflowScript(): string {
  const branches = USAGE_WORKFLOW_CALLS.map((call) => `  async () => {
    try {
      return { ok: true, value: await agent(${JSON.stringify(call.prompt)}, ${JSON.stringify(call.options)}) };
    } catch (error) {
      return { ok: false, runId: error.runId, outcome: error.outcome, message: error.message };
    }
  }`);
  return [
    'export const meta = { apiVersion: 1, name: "parallel-review", description: "Review in parallel and keep a sibling failure" };',
    "const settled = await parallel([",
    branches.join(",\n"),
    "]);",
    "return { settled };",
    "",
  ].join("\n");
}

function jsonBlock(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/** Worked playbook served by external_help topic "usage". Examples are the exported constants. */
export function formatUsagePlaybook(): string {
  const script = usageWorkflowScript();
  return `Practical delegation playbook. A role is the work. A harness is the environment: ${EXTERNAL_HARNESSES.join(", ")}, or a registered pi-* name. Agent and workflow select every one of those harnesses the same way. Do the task directly unless a separate environment, an independent context, or bounded parallel work is worth the coordination. You still own the outcome: read the result and check the deliverable. Follow the user's approval policy before widening a delegation. There is no fixed team-size threshold here.

Tell each child the objective, the context it needs, what it may change, the deliverable, and how you will verify it. Use absolute paths. Say read-only or edit in the prompt. Pass permission when the call should differ from defaultPermission (danger unless changed). A danger tier stays inside the authorization the user already gave. Antigravity accepts only danger. Topic permissions is the harness-boundary reference. Topic roles lists descriptions. Topic workflow is the syntax and saved-workflow reference.

Choose fresh context or resume deliberately. Omit context, or pass {"mode":"none"}, for independent work such as a review. {"mode":"recent","turns":N} and {"mode":"full"} share parent conversation and cannot be combined with resume. resume continues one prior CLI run that recorded a session id, on the same backend: claude, codex, agy, grok, or muse. A named pi-* harness has no persisted session, so resume does not continue it. Prefer resume for the same task and a new child when you want an independent judgment.

Calls block until the child finishes. background true returns a run id while the originating session still owns the work. Use external_runs to wait, then read view final, and judge that answer yourself. A failed or aborted run stays failed. Do not automatically retry it, and do not switch model or harness to get past the failure. agy may make one disclosed infrastructure retry; that exception is not yours to extend.

One Agent call:
${jsonBlock(USAGE_ONE_AGENT)}

Independent review. Fresh context, a reviewer role, no resume:
${jsonBlock(USAGE_INDEPENDENT_REVIEW)}

Background work, then the verified final answer. A one-element runIds list is valid for view final:
${jsonBlock(USAGE_BACKGROUND_AGENT)}
${jsonBlock(USAGE_RUNS_FINAL)}

Parallel workflow. Catch the child error inside each branch so one failure does not drain its sibling. Pass this string as the workflow tool's script:
${script}
Resume, only for the same task on a CLI harness that stored a session id. Do not combine it with context:
${jsonBlock(USAGE_RESUME_AGENT)}`;
}
