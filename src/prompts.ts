import type { SavedWorkflow } from "./workflow/registry.ts";
import type { ExternalMode } from "./external-mode.ts";
import type { PermissionTier, SubagentProfile } from "./types.ts";
import { externalProfileRole, externalRoleAvailability } from "./profiles.ts";

export const AGENT_PROMPT_SNIPPET =
  "Delegate one independent assignment to a configured external CLI or named Pi harness; use several direct calls for unrelated jobs.";

export const WORKFLOW_PROMPT_SNIPPET =
  "Coordinate related assignments and dependencies through JavaScript orchestration; the pi-flow-orchestration skill offers optional recipes. Use external_help for precise syntax.";

export const EXTERNAL_HELP_PROMPT_SNIPPET =
  "Show the delegation playbook, role details, permission behavior, workflow guidance, public contracts, or harness capabilities on demand.";

export const EXTERNAL_RUNS_PROMPT_SNIPPET =
  "Supervise session-owned external runs (supply only fields for the chosen action): list (optional workflowRunId, limit, cursor, workflowCursor), inspect (runIds: 1 ID with any view, or 2-20 IDs for summary batch), wait (runIds 1-100, optional mode/limitBytes), or cancel (runIds: 1 ID, optional reason). view: final returns only a verified terminal answer, empty until one exists.";

export const ORCHESTRATOR_MODE_PROMPT = `# Orchestrator Mode

You are the coordinator, not the default worker, for substantial tasks.

Proactively seek opportunities to use \`external_delegate\` and \`external_workflow\`, even when you could do the work yourself. Favor early, focused delegation whenever it can improve speed, quality, coverage, or independent judgment. Do not wait for the user to request subagents.

Own the overall outcome: assign clear goals, integrate results, and verify the final work. Handle simple tasks directly and avoid delegation when it adds little value.

For nontrivial coordination, consult the \`pi-flow-orchestration\` skill on demand. Use \`external_help\` for technical details only when needed.

Respect existing permissions and user approvals.`;

// Both mode prompts are behavioral nudges. Detailed methods stay on demand.
export const FRONTLINE_WORKER_MODE_PROMPT = `# Frontline Worker Mode

You are the hands-on executor, not the default coordinator, for substantial tasks.

Proactively take ownership of investigation, implementation, and verification. Favor direct execution using your own tools and capabilities, even when delegation is available. Do not default to assigning work to subagents when you can carry it out effectively yourself.

Own the overall outcome: investigate thoroughly, make sound decisions, execute the work, and verify your results. Avoid unnecessary orchestration, task splitting, and coordination overhead.

Remain willing to use \`external_delegate\` or \`external_workflow\` when specialized expertise, independent judgment, or parallel execution offers a meaningful advantage. Consult the \`pi-flow-orchestration\` skill and \`external_help\` on demand when needed.

Respect existing permissions and user approvals.`;

export const EXTERNAL_MODE_PROMPTS: Record<ExternalMode, string | undefined> = {
  normal: undefined,
  orchestrator: ORCHESTRATOR_MODE_PROMPT,
  "frontline-worker": FRONTLINE_WORKER_MODE_PROMPT,
};

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
      const profile = profiles.get(`${availableHarness}/${role}`) ?? profiles.get(`${availableHarness}-${role}`);
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


export interface UsageAgentExample {
  description: string;
  prompt: string;
  role: string;
  harness: string;
  /** Omit on ordinary calls so defaultPermission applies. Set only to confine the tier. */
  permission?: PermissionTier;
  background?: boolean;
  resume?: string;
  context?: { mode: "none" } | { mode: "recent"; turns: number } | { mode: "full" };
}

/** One self-contained external_delegate call. Valid against the external_delegate tool schema. Permission stays omitted. */
export const USAGE_ONE_AGENT: UsageAgentExample = {
  description: "Map the repository",
  prompt: "Map /absolute/repo. Read only. Return the important files and how they fit together. Do not edit.",
  role: "explorer",
  harness: "claude",
};

export const USAGE_WORKFLOW_CALLS: { prompt: string; options: { description: string; role: string; harness: string; permission?: PermissionTier } }[] = [
  {
    prompt: "Map /absolute/repo read-only. Return important paths. Do not edit.",
    options: { description: "map", role: "explorer", harness: "claude" },
  },
  {
    prompt: "Review /absolute/repo read-only. Report defects with paths. Do not edit.",
    options: { description: "review", role: "reviewer", harness: "codex" },
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
    'export const meta = { apiVersion: 1, name: "parallel-review", description: "Review in parallel and keep a sibling failure", phases: [{ title: "Review", detail: "Claude maps the repository while Codex reviews concurrency; neither is assigned to edit files." }, { title: "Collect", detail: "Return both findings, including any failed check." }] };',
    'phase("Review");',
    "const settled = await parallel([",
    branches.join(",\n"),
    "]);",
    'phase("Collect");',
    "return { settled };",
    "",
  ].join("\n");
}

function jsonBlock(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/** Worked playbook served by external_help topic "usage". Examples are the exported constants. */

export function formatUsagePlaybook(): string {
  return `# Flow: delegate work, use results, keep moving

**Choose by the work.** Work directly when useful. Use external_delegate for an independent assignment (several independent assignments may use several direct calls). Use external_workflow when jobs depend on each other, share one plan, or need a grouped result. No compulsory pattern name, team size, or planning stage.

**Brief and launch.** Give the child a goal, relevant context, what it may change and what it should return. Prefer the configured default harness if suitable; use a specialist role when it helps, otherwise worker. Roles give instructions, not permissions: an omitted permission uses the configured default (which may be danger). Omit parent history unless useful; choose fresh context for independent critique and pass selected evidence explicitly for dependent steps.

**Use the result.** Foreground is simplest when the next action needs the answer. Background is for useful independent parent work or a user-requested deferred run; collect through external_runs when needed. Inspect the result (inline or refs.final), make sense of missing checks, integrate findings, and choose the next action. Operation success is not task acceptance.

One independent assignment (select a working harness for your environment):
${jsonBlock(USAGE_ONE_AGENT)}

One grouped parallel workflow (pass as external_workflow script; this is illustrative rather than a required method):
${usageWorkflowScript()}

**Need something more specific?** Read the installed pi-flow-orchestration skill for patterns and adaptable recipe files, or call external_help with:
- topic: "workflow" for script helpers, saved workflows, failure handling, background supervision and replay;
- topic: "contracts" (optionally tool: "external_workflow" or "external_delegate") for exact arguments, result envelopes and paging;
- topic: "capabilities" for current harness constraints, tools and availability limitations;
- topic: "roles" or "permissions" when a role or permission tier needs explanation.

Bundled skill recipes are examples, not registered saved-workflow names. Use them as inline scripts or copy into an allowed workflow directory. A user's existing authorization determines what children may change. The parent remains responsible for finishing the original task.`;
}
