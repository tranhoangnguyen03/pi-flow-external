import type { SavedWorkflow } from "./workflow/registry.ts";
import type { SubagentProfile } from "./types.ts";

export const AGENT_PROMPT_SNIPPET =
  "Delegate to an external Claude Code, Codex CLI, or Antigravity agent when a backend-qualified profile matches the task.";

export const AGENT_PROMPT_GUIDELINES = [
  "Reach for Agent only when the user asks for Claude Code/Codex/Antigravity delegation or an available external profile matches the task.",
  "Every Agent call requires an explicit backend-qualified subagent_type.",
  "Agent profiles are external-only; use native Pi subagents for Pi-backed work.",
  "For a known file, symbol, or single fact, look it up directly instead of delegating.",
  "Launch independent Agent calls together when the user asks for parallel work.",
  "External agents start fresh; include all required context and absolute paths, and state whether edits are allowed.",
  "Relay the Agent result to the user; the external agent's final message is returned only to the driver.",
  "Do not automatically retry a failed or aborted external run; preserve its evidence and retry only when the user asks.",
  "Do not override permission to 'edit' on command-running lanes (implementer, debugger, qa, worker); external execution profiles maintain a danger floor because inspecting and validating work requires shell command access.",
  "Backend-native nested agents may use another workspace; include the absolute workspace path when requesting nested delegation.",
];

export const WORKFLOW_PROMPT_SNIPPET =
  "Run a saved or ad-hoc trusted JavaScript workflow that fans subagents out and synthesizes their results, when the user asks for a workflow or multi-agent orchestration.";

export const WORKFLOW_PROMPT_GUIDELINES = [
  "Use workflow only for explicit workflow, fan-out, saved-workflow, or genuinely multi-stage requests.",
  "Provide exactly one source: name for a saved workflow, scriptPath for a persisted workflow, or script for ad-hoc orchestration. Prefer saved workflows when one matches.",
  "Inline workflow scripts must start with a literal export const meta = { name, description }, call agent() at least once, and return JSON-serializable data.",
  "Every workflow agent() call needs a unique label, an explicit backend-qualified subagent_type, and a self-contained prompt.",
  "parallel() takes thunks; use pipeline() when each item has multiple dependent stages.",
  "Use a JSON Schema for agent results that control branching or aggregation.",
  "Workflow scripts are trusted plain JavaScript, not a sandbox: no imports, filesystem globals, Date APIs, or Math.random().",
  "Do not automatically rerun failed workflow branches; preserve the failure and retry only when the user asks.",
];

function formatAvailableAgents(profiles: Map<string, SubagentProfile>): string {
  return [...profiles.values()]
    .map((profile) => {
      const lane = [profile.backend, profile.permission].filter(Boolean).join(" · ");
      return `- ${profile.name}${lane ? ` (${lane})` : ""}: ${profile.description}`;
    })
    .join("\n");
}

function truncateWorkflowText(text: string, maxLength = 180): string {
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function formatSavedWorkflows(workflows: SavedWorkflow[], maxItems = 20): string {
  if (workflows.length === 0) {
    return "";
  }
  const shown = workflows.slice(0, maxItems);
  const lines = shown.map((workflow) => `- ${workflow.name}: ${truncateWorkflowText(workflow.description)}`);
  if (workflows.length > shown.length) {
    lines.push(`- … ${workflows.length - shown.length} more saved workflow(s) not shown.`);
  }
  return `\n\nSaved workflows:\n${lines.join("\n")}`;
}

export function buildWorkflowPrompt(profiles: Map<string, SubagentProfile>, savedWorkflows: SavedWorkflow[] = []): string {
  return `# External workflow roster

Profiles available to workflow agent() calls:
${formatAvailableAgents(profiles)}${formatSavedWorkflows(savedWorkflows)}

Every workflow child requires an explicit backend-qualified subagent_type. Use the workflow tool schema for invocation details.`;
}

export function buildCoordinatorPrompt(profiles: Map<string, SubagentProfile>): string {
  return `# External delegation roster

${formatAvailableAgents(profiles)}

Agent is for external Claude Code, Codex CLI, and Antigravity profiles only. Every call requires an explicit backend-qualified subagent_type and a self-contained prompt. Use native Pi subagents for Pi-backed work. Do not retry failed external runs unless the user asks.`;
}
