import { StringEnum } from "@earendil-works/pi-ai";
import {
  defineTool,
  getAgentDir,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { filterProfilesForModelRegistry } from "./core/model.ts";
import { loadExternalCatalog } from "./profiles.ts";
import { loadHarnessConfigs } from "./harnesses.ts";
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
  harness: Type.Optional(Type.String({
    description: "Optional harness filter for roles or permissions: agy, claude, codex, grok, muse, or a registered pi-* harness. Workflows orchestrate across harnesses.",
  })),
});

type ExternalHelpParams = Static<typeof externalHelpParameters>;

export interface CreateExternalHelpToolOptions {
  getDefaultHarness: (ctx: ExtensionContext) => string;
  workflowEnabled: boolean;
}

function isProjectTrusted(ctx: ExtensionContext): boolean {
  try {
    return ctx.isProjectTrusted();
  } catch {
    return false;
  }
}

const PERMISSION_HELP_BY_BACKEND: Record<ExternalHarness | "pi", string> = {
  agy: "agy: every run uses --dangerously-skip-permissions and is unsandboxed; readonly/edit are advisory profile instructions, not an enforced boundary.",
  claude: "claude: readonly uses --permission-mode plan, edit uses --permission-mode acceptEdits, and danger uses --dangerously-skip-permissions (--permission-mode auto under effective UID 0). Headless readonly/edit deny Bash; execution roles requested at edit are elevated to danger.",
  codex: "codex: readonly, edit, and danger map to read-only, workspace-write, and danger-full-access sandboxes. This governs model-generated shell commands, not MCP/plugins/hooks.",
  grok: "grok: readonly uses --sandbox read-only, edit uses --sandbox workspace, and danger uses --sandbox off, always alongside --permission-mode bypassPermissions. Enforced by a kernel sandbox, but network blocking is Linux-only; edit limits writes to the workspace. No execution-lane danger floor, since edit already permits shell.",
  muse: "muse: readonly uses --disable-approval --disable-write --disable-shell (approval, non-shell writes, and shell execution all disabled), edit uses --disable-approval alone (the sandbox stays enabled by default; writes and shell remain available within it), and danger uses --yolo, which disables approval and the sandbox and additionally trusts this workspace (loads its skills/rules) for this run — a broader grant than an unsandboxed run alone. No execution-lane danger floor, since edit already permits shell within the sandbox. Native provider retries (up to 10 attempts) are disclosed via activity narration, not performed by this extension.",
  pi: "pi-* (named Pi harness configs): run in-process, not as a CLI. Tiers gate a curated built-in tool set (read/bash/edit/write/grep/find/ls) — no project extensions, skills, or MCP tools load into the child. Execution roles requested at edit are elevated to danger, same reasoning as claude. Retry is disabled per child regardless of Pi's own settings, honoring this extension's no-auto-retry contract.",
};

/** Resolve a requested, already-validated harness name to its permission-semantics backend. */
function permissionHelpBackend(harness: string, configuredPiHarnesses: ReadonlySet<string>): ExternalHarness | "pi" {
  if ((EXTERNAL_HARNESSES as readonly string[]).includes(harness)) return harness as ExternalHarness;
  // Callers only reach here after validateHarnessFilter, so any name that is
  // not one of the external harnesses is guaranteed to be a registered
  // pi-* harness at this point — never an unrecognized string silently
  // treated as "pi".
  return "pi";
}

function permissionHelp(harness: string | undefined, configuredPiHarnesses: ReadonlySet<string>): string {
  const backends: (ExternalHarness | "pi")[] = harness
    ? [permissionHelpBackend(harness, configuredPiHarnesses)]
    : [...EXTERNAL_HARNESSES, ...(configuredPiHarnesses.size ? (["pi"] as const) : [])];
  return [
    "External CLIs and pi-* harnesses run with host access; use them only in trusted repositories. A role's permission is a floor (or the global default when absent); a call can raise it, never lower it. Backend execution-lane floors also apply.",
    ...backends.map((name) => PERMISSION_HELP_BY_BACKEND[name]),
    "Failed or aborted runs are not silently retried. Only agy may retry once for an infrastructure-classified auth, eligibility, or network failure, and the receipt discloses it.",
  ].join("\n\n");
}

/**
 * Reject an unknown harness filter up front, listing the live configured
 * set, rather than letting it silently fall through to "pi" (permissions)
 * or an empty catalog (roles). "Configured" means what a caller could
 * actually select today: the external CLIs plus any registered
 * pi-* harness — never a raw guess at what might exist.
 */
function validateHarnessFilter(harness: string | undefined, configuredPiHarnesses: ReadonlySet<string>): void {
  if (harness === undefined) return;
  if ((EXTERNAL_HARNESSES as readonly string[]).includes(harness) || configuredPiHarnesses.has(harness)) return;
  const configured = [...EXTERNAL_HARNESSES, ...configuredPiHarnesses].sort();
  throw new Error(
    `Unknown harness "${harness}". Configured harnesses: ${configured.join(", ") || "none"}.`,
  );
}

function workflowHelp(workflowsEnabled: boolean, workflows: ReturnType<typeof listSavedWorkflows>): string {
  const availability = workflowsEnabled ? "The workflow tool is enabled." : "The workflow tool is disabled for this extension instance.";
  return `${availability} It runs trusted JavaScript, not a sandbox.

Provide exactly one workflow source: name, scriptPath, or script. Every script starts with the literal current declaration export const meta = { apiVersion: 1, name, description }, calls agent() at least once, awaits every started call, and returns JSON-serializable data. Missing/unsupported API versions fail before any child launches. Project .pi/workflows are visible only when the project is trusted.

APIs: agent(prompt, { description, label, role, harness, subagent_type, permission, max_budget_usd, resume, context, schema, phase }); parallel(thunks); pipeline(items, ...stages); phase(title); log(message). Globals: args and cwd. Agent options other than the profile selector are optional. "description" is the common task-name option shared with the direct Agent tool; "label" is a compatible alias — set only one, or both to the same value. Choose role/harness or legacy exact subagent_type, never both. Use unique descriptions/labels and clear task prompts. An agent() succeeds with its value or throws ChildRunError { runId, outcome, message, outputRef, diagnosticsRef }; catch optional failures explicitly. Uncaught failures terminate the workflow and drain siblings. Helpers never convert failures to null. Context options: {mode:"none"} (default), {mode:"recent",turns:N} (positive integer, includes current user turn), or {mode:"full"} (available context after compaction). All children share invocation-time context/settings; earlier child results must still be passed explicitly. Context excludes thinking/system instructions and pending calls; images and snapshots over 1 MiB fail without truncation. Context sharing cannot be combined with resume. Use schema for results that control branching or aggregation. Imports, filesystem globals, Date APIs, and Math.random() are unavailable.

Background and supervision: blocking by default — an ordinary call waits for its child and returns the result, run everything this way unless the parent has other work to do first. Set background:true only when the parent can proceed before completion, then use external_runs on the returned stable run ID while session-owned work continues. Parallel same-harness work (e.g. three agy workers) runs concurrently under the shared maxConcurrentSubagents cap: call parallel([() => agent(...), ...]) in a workflow, or issue separate Agent calls with background:true in one turn, then external_runs wait/inspect/cancel. Awaiting agent() calls sequentially stays serial by construction. external_runs actions are list (optional workflowRunId/cursor/workflowCursor/limit), inspect (runId, view summary|output|diagnostics, optional opaque cursor/limitBytes), wait (runId or runIds, mode any|all), and cancel (runId, optional reason). Follow nextCursor/nextWorkflowCursor for complete results. Wait returns selected terminal outcomes and pending IDs, never cancels pending work, and returns an unsuccessful workflow early; interrupting wait stops only the wait. Cancelling a workflow stops active children, while cancelling one child is a catchable workflow error. Blocking-call interruption cancels that call; background work survives tool return but is cancelled on orderly owning-session shutdown. It is not a daemon: crashes leave unfinished evidence interrupted/uncertain, restart does not adopt work, and live steering is unavailable.

Replay: resumeFromRunId works only with persisted scriptPath and starts an explicit new attempt. It reuses the longest unchanged prefix of successful child calls; the first changed/failed/cancelled/timed-out call and its suffix run again. Script recomposition is cheap, but child reruns can cost money or repeat side effects. There is no automatic repaired-script replay.

Background is a workflow tool call parameter ({ script, background: true }), never a meta field — meta.background is silently ignored and does not run the workflow in the background.

Background example (same script as below; call the workflow tool with background:true):
export const meta = { apiVersion: 1, name: "review", description: "Map and review a repository" };
const [map, review] = await parallel([
  () => agent("Map /absolute/repo read-only.", { label: "map", role: "explorer" }),
  () => agent("Review /absolute/repo read-only.", { label: "review", role: "reviewer", harness: "codex" }),
]);
return { map, review };

Foreground example:
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
): ToolDefinition<typeof externalHelpParameters, { topic: ExternalHelpParams["topic"]; harness?: string }> {
  return defineTool({
    name: "external_help",
    label: "External Help",
    description: "Read-only help on demand for external roles, permission behavior, and workflow usage (including background runs, external_runs supervision syntax, and replay) or saved-workflow discovery.",
    promptSnippet: EXTERNAL_HELP_PROMPT_SNIPPET,
    parameters: externalHelpParameters,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      // A schema-conversion layer downstream of this tool's declaration may
      // present `harness` as required (#62); treat a blank/whitespace
      // placeholder as omitted. Furthermore, do not reject an explicit
      // harness on topic "workflow": workflows orchestrate across all
      // harnesses, so passing a harness filter gracefully returns workflow
      // guidance without error.
      const harness = params.harness?.trim() ? params.harness.trim() : undefined;
      let text: string;
      const catalog = loadExternalCatalog(getAgentDir());
      const harnessConfigs = catalog.harnessConfigs;
      const configuredPiHarnesses = new Set(harnessConfigs.keys());
      if (params.topic !== "workflow") {
        validateHarnessFilter(harness, configuredPiHarnesses);
      }
      if (params.topic === "roles") {
        text = catalog.blocked ? catalog.diagnostics.join(" ") : formatExternalRoleHelp(catalog.profiles, options.getDefaultHarness(ctx), harness);
      } else if (params.topic === "permissions") {
        text = permissionHelp(harness, configuredPiHarnesses);
      } else {
        const wfText = workflowHelp(options.workflowEnabled, listSavedWorkflows({
          agentDir: getAgentDir(),
          cwd: ctx.cwd,
          projectTrusted: isProjectTrusted(ctx),
        }));
        text = harness
          ? `${wfText}\n\nNote: Workflows orchestrate across multiple harnesses (including "${harness}"); workflow syntax is uniform across backends.`
          : wfText;
      }
      return {
        content: [{ type: "text" as const, text }],
        details: { topic: params.topic, ...(harness ? { harness } : {}) },
      };
    },
  });
}
