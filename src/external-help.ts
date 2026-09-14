import { StringEnum } from "@earendil-works/pi-ai";
import {
  defineTool,
  getAgentDir,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { filterProfilesForModelRegistry } from "./core/model.ts";
import { filterExternalAgentProfiles, getSubagentProfiles } from "./profiles.ts";
import {
  EXTERNAL_HELP_PROMPT_SNIPPET,
  formatExternalRoleHelp,
  formatSavedWorkflows,
} from "./prompts.ts";
import { listSavedWorkflows } from "./workflow/registry.ts";
import { EXTERNAL_HARNESSES, type ExternalHarness } from "./types.ts";

const externalHelpParameters = Type.Object({
  topic: StringEnum(["roles", "permissions", "workflow"] as const, {
    description: "Help topic: role descriptions/configured profile availability, harness permissions, or workflow syntax and saved workflows.",
  }),
  harness: Type.Optional(StringEnum(EXTERNAL_HARNESSES, {
    description: "Optional harness filter for roles or permissions. Do not use with topic workflow.",
  })),
});

type ExternalHelpParams = Static<typeof externalHelpParameters>;

export interface CreateExternalHelpToolOptions {
  getDefaultHarness: (ctx: ExtensionContext) => ExternalHarness;
  workflowEnabled: boolean;
}

function isProjectTrusted(ctx: ExtensionContext): boolean {
  try {
    return ctx.isProjectTrusted();
  } catch {
    return false;
  }
}

function permissionHelp(harness?: ExternalHarness): string {
  const help: Record<ExternalHarness, string> = {
    agy: "agy: every run uses --dangerously-skip-permissions and is unsandboxed; readonly/edit are advisory profile instructions, not an enforced boundary.",
    claude: "claude: readonly uses --permission-mode plan, edit uses --permission-mode acceptEdits, and danger uses --dangerously-skip-permissions (--permission-mode auto under effective UID 0). Headless readonly/edit deny Bash; execution roles requested at edit are elevated to danger.",
    codex: "codex: readonly, edit, and danger map to read-only, workspace-write, and danger-full-access sandboxes. This governs model-generated shell commands, not MCP/plugins/hooks.",
  };
  return [
    "External CLIs run on the host; use them only in trusted repositories. Permission precedence is call override, then profile, then the global default; omit the override when unsure.",
    ...(harness ? [help[harness]] : EXTERNAL_HARNESSES.map((name) => help[name])),
    "Failed or aborted runs are not silently retried. Only agy may retry once for an infrastructure-classified auth, eligibility, or network failure, and the receipt discloses it.",
  ].join("\n\n");
}

function workflowHelp(workflowsEnabled: boolean, workflows: ReturnType<typeof listSavedWorkflows>): string {
  const availability = workflowsEnabled ? "The workflow tool is enabled." : "The workflow tool is disabled for this extension instance.";
  return `${availability} It runs trusted JavaScript, not a sandbox.

Provide exactly one workflow source: name, scriptPath, or script. Every script starts with the literal current declaration export const meta = { apiVersion: 1, name, description }, calls agent() at least once, awaits every started call, and returns JSON-serializable data. Missing/unsupported API versions fail before any child launches. Project .pi/workflows are visible only when the project is trusted.

APIs: agent(prompt, { label, role, harness, subagent_type, permission, max_budget_usd, resume, context, schema, phase }); parallel(thunks); pipeline(items, ...stages); phase(title); log(message). Globals: args and cwd. Agent options other than the profile selector are optional. Choose role/harness or legacy exact subagent_type, never both. Use unique labels and clear task prompts. An agent() succeeds with its value or throws ChildRunError { runId, outcome, message, outputRef, diagnosticsRef }; catch optional failures explicitly. Uncaught failures terminate the workflow and drain siblings. Helpers never convert failures to null. Context options: {mode:"none"} (default), {mode:"recent",turns:N} (positive integer, includes current user turn), or {mode:"full"} (available context after compaction). All children share invocation-time context/settings; earlier child results must still be passed explicitly. Context excludes thinking/system instructions and pending calls; images and snapshots over 1 MiB fail without truncation. Context sharing cannot be combined with resume. Use schema for results that control branching or aggregation. Imports, filesystem globals, Date APIs, and Math.random() are unavailable.

Background and supervision: set background:true on Agent or workflow to return a stable run ID while session-owned work continues. external_runs actions are list (optional workflowRunId/cursor/workflowCursor/limit), inspect (runId, view summary|output|diagnostics, optional opaque cursor/limitBytes), wait (runId or runIds, mode any|all), and cancel (runId, optional reason). Follow nextCursor/nextWorkflowCursor for complete results. Wait returns selected terminal outcomes and pending IDs, never cancels pending work, and returns an unsuccessful workflow early; interrupting wait stops only the wait. Cancelling a workflow stops active children, while cancelling one child is a catchable workflow error. Blocking-call interruption cancels that call; background work survives tool return but is cancelled on orderly owning-session shutdown. It is not a daemon: crashes leave unfinished evidence interrupted/uncertain, restart does not adopt work, and live steering is unavailable.

Replay: resumeFromRunId works only with persisted scriptPath and starts an explicit new attempt. It reuses the longest unchanged prefix of successful child calls; the first changed/failed/cancelled/timed-out call and its suffix run again. Script recomposition is cheap, but child reruns can cost money or repeat side effects. There is no automatic repaired-script replay.

Example:
export const meta = { apiVersion: 1, name: "review", description: "Map and review a repository" };
const [map, review] = await parallel([
  () => agent("Map /absolute/repo read-only.", { label: "map", role: "explorer" }),
  () => agent("Review /absolute/repo read-only.", { label: "review", role: "reviewer", harness: "codex" }),
]);
return { map, review };

${formatSavedWorkflows(workflows)}`;
}

export function createExternalHelpTool(
  options: CreateExternalHelpToolOptions,
): ToolDefinition<typeof externalHelpParameters, { topic: ExternalHelpParams["topic"]; harness?: ExternalHarness }> {
  return defineTool({
    name: "external_help",
    label: "External Help",
    description: "Read-only help on demand for external roles, permission behavior, and workflow usage (including background runs, external_runs supervision syntax, and replay) or saved-workflow discovery.",
    promptSnippet: EXTERNAL_HELP_PROMPT_SNIPPET,
    parameters: externalHelpParameters,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (params.topic === "workflow" && params.harness) {
        throw new Error("external_help harness is only valid for roles or permissions.");
      }
      let text: string;
      if (params.topic === "roles") {
        const profiles = filterExternalAgentProfiles(
          filterProfilesForModelRegistry(getSubagentProfiles(getAgentDir()), ctx.modelRegistry),
        );
        text = formatExternalRoleHelp(profiles, options.getDefaultHarness(ctx), params.harness);
      } else if (params.topic === "permissions") {
        text = permissionHelp(params.harness);
      } else {
        text = workflowHelp(options.workflowEnabled, listSavedWorkflows({
          agentDir: getAgentDir(),
          cwd: ctx.cwd,
          projectTrusted: isProjectTrusted(ctx),
        }));
      }
      return {
        content: [{ type: "text" as const, text }],
        details: { topic: params.topic, ...(params.harness ? { harness: params.harness } : {}) },
      };
    },
  });
}
