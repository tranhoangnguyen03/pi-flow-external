import {
  defineTool,
  getAgentDir,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { withContract } from "./contract/envelope.ts";
import {
  buildContractIndex,
  buildToolContractDetail,
  EXTERNAL_HELP_TOOL,
  externalHelpOutputSchema,
  externalHelpParameters,
  formatContractIndex,
  formatToolContractDetail,
  PUBLIC_TOOL_NAMES,
  type ExternalHelpParams,
  type PublicToolName,
} from "./contract/help.ts";
import { formatExternalRunsActionGuidance } from "./contract/runs.ts";
import { formatWorkflowHelpersLine } from "./contract/workflow.ts";
import {
  buildCapabilityRecords,
  formatCapabilitiesIndex,
  formatCapabilityDetail,
  formatPermissionHelp,
} from "./core/capabilities.ts";
import { ExpectedFlowError, type FlowErrorCode } from "./core/errors.ts";
import { disabledHarnessMessage, loadExternalCatalog, retiredHarnessMessage } from "./profiles.ts";
import {
  EXTERNAL_HELP_PROMPT_SNIPPET,
  formatExternalRoleHelp,
  formatSavedWorkflows,
  formatUsagePlaybook,
} from "./prompts.ts";
import { listSavedWorkflows } from "./workflow/registry.ts";
import { EXTERNAL_HARNESSES, isRetiredHarness } from "./types.ts";

export { externalHelpParameters, type ExternalHelpParams } from "./contract/help.ts";

export type ExternalHelpDetails =
  | { topic: ExternalHelpParams["topic"]; harness?: string; tool?: string }
  | { error: string; code: FlowErrorCode };

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

/**
 * Reject an unknown harness filter up front, listing the live configured
 * set, rather than letting it silently fall through to "pi" (permissions)
 * or an empty catalog (roles). "Configured" means what a caller could
 * actually select today: the external CLIs plus any registered
 * pi-* harness — never a raw guess at what might exist.
 */
function validateHarnessFilter(harness: string | undefined, configuredPiHarnesses: ReadonlySet<string>): void {
  if (harness === undefined) return;
  if (isRetiredHarness(harness)) throw new ExpectedFlowError("selection_invalid", retiredHarnessMessage(harness));
  if ((EXTERNAL_HARNESSES as readonly string[]).includes(harness) || configuredPiHarnesses.has(harness)) return;
  const configured = [...EXTERNAL_HARNESSES, ...configuredPiHarnesses].sort();
  throw new ExpectedFlowError(
    "selection_invalid",
    `Unknown harness "${harness}". Configured harnesses: ${configured.join(", ") || "none"}.`,
  );
}

function validateToolFilter(tool: string | undefined): asserts tool is PublicToolName | undefined {
  if (tool === undefined) return;
  if ((PUBLIC_TOOL_NAMES as readonly string[]).includes(tool)) return;
  throw new ExpectedFlowError(
    "selection_invalid",
    `Unknown public tool "${tool}". Public tools: ${PUBLIC_TOOL_NAMES.join(", ")}.`,
  );
}

function workflowHelp(workflowsEnabled: boolean, workflows: ReturnType<typeof listSavedWorkflows>): string {
  const availability = workflowsEnabled ? "The external_workflow tool is enabled." : "The external_workflow tool is disabled for this extension instance.";
  return `${availability} It runs trusted JavaScript, not a sandbox. For choosing when and how to split work, read the installed pi-flow-orchestration skill and its recipes; docs/orchestration-playbook.md is the user guide. Simple tasks should use external_delegate rather than a workflow.

Provide exactly one workflow source: name, scriptPath, or script. Every script starts with the literal current declaration export const meta = { apiVersion: 1, name, description }, calls agent() at least once, awaits every started call, and returns JSON-serializable data. Missing/unsupported API versions fail before any child launches. Project .pi/workflows are visible only when the project is trusted.

Before calling external_workflow, explain the purpose, assignments, parallel/sequential order, allowed changes, and deliverable in plain language. Add the same roadmap as meta.phases: [{ title: "Review", detail: "Who checks what and whether files may change" }, ...], and call phase("Review") when that stage actually starts. Planned phases and details remain visible on the live card; they describe intent, while child states/activity show observed execution. Explain material plan changes and follow the user's existing approval policy. The briefing is an agent instruction, not a runtime-verified chat message; phases remain optional for existing saved scripts. Use external_runs inspect view launch to retrieve the recorded purpose and plan (also includes sensitive script/args); background receipts are not live monitors.

${formatWorkflowHelpersLine()} Agent options other than the profile selector are optional. "description" is the common task-name option shared with the direct external_delegate tool; "label" is a compatible alias — set only one, or both to the same value. Choose role/harness or legacy exact subagent_type, never both. Use unique descriptions/labels and clear task prompts. An agent() succeeds with its value or throws ChildRunError { runId, outcome, message, outputRef, diagnosticsRef }; catch optional failures explicitly. Uncaught failures terminate the workflow and drain siblings. Helpers never convert failures to null. Context options: {mode:"none"} (default), {mode:"recent",turns:N} (positive integer, includes current user turn), or {mode:"full"} (available context after compaction). All children share invocation-time context/settings; earlier child results must still be passed explicitly. Context excludes thinking/system instructions and pending calls; images and snapshots over 1 MiB fail without truncation. Context sharing cannot be combined with resume. Use schema for results that control branching or aggregation. Imports, filesystem globals, Date APIs, and Math.random() are unavailable.

Execution mode: foreground is blocking by default when you need the result next, including parallel workflows. Pass background:true when you have independent local work (read, edit, bash) that does not touch files the workflow may change, or on an explicit background request; do that independent work first and never launch background then immediately wait. Ending a turn does not stop a background run: if the user asks to leave the workflow running, switch tasks, or check back later, report the runId and work on the other task or end your turn without waiting; otherwise retain the ID and collect it after your independent work finishes. Both modes support parallel([() => agent(...), ...]) under the same maxConcurrentSubagents cap; sequential awaits stay serial. Background changes neither permissions nor budget enforcement. Its stable handle means accepted, not completed; the receipt is not a live monitor, though UI sessions show active background runs in the status bar and wake the session with a follow-up message when an uncollected background run settles across turns. Keep the session open: orderly shutdown requests cancellation with bounded cleanup; crashes leave uncertain evidence and restart does not adopt work. Collection instructions are in this workflow help topic; usage is the short orientation.

Supervision: check ok for the operation, then each completed run's outcome and data.pending. Skip wait when settlement is known. Use inline successful output when available; otherwise inspect final and follow data.page.nextCursor. Failures need diagnostics/output, not final. Foreground-call interruption cancels that call; wait never cancels pending work, even when interrupted. Use cancel to stop background work. Cancelling a workflow stops active children; cancelling one child is a catchable workflow error. There is no live steering.

${formatExternalRunsActionGuidance()}

Replay: resumeFromRunId works only with persisted scriptPath and starts an explicit new attempt. It reuses the longest unchanged prefix of successful child calls; the first changed/failed/cancelled/timed-out call and its suffix run again. Script recomposition is cheap, but child reruns can cost money or repeat side effects. There is no automatic repaired-script replay.

Background is an external_workflow tool call parameter ({ script, background: true }), never a meta field — meta.background is silently ignored and does not run the workflow in the background.

Example (blocking by default; pass background:true on the external_workflow call when doing independent local work first or on a background request):
export const meta = {
  apiVersion: 1, name: "review", description: "Map and review a repository",
  phases: [
    { title: "Check", detail: "Claude maps the repository while Codex reviews it; both run read-only." },
    { title: "Collect", detail: "Return both reports for the parent to compare." },
  ],
};
phase("Check");
const [map, review] = await parallel([
  () => agent("Map /absolute/repo read-only.", { label: "map", role: "explorer", harness: "claude", permission: "readonly" }),
  () => agent("Review /absolute/repo read-only.", { label: "review", role: "reviewer", harness: "codex", permission: "readonly" }),
]);
phase("Collect");
return { map, review };

${formatSavedWorkflows(workflows)}`;
}

export function createExternalHelpTool(
  options: CreateExternalHelpToolOptions,
): ToolDefinition<typeof externalHelpParameters, ExternalHelpDetails> {
  return defineTool({
    name: EXTERNAL_HELP_TOOL,
    label: "External Help",
    description: "Read-only help on demand: usage playbook, role details, permission behavior, workflow usage (including background runs, external_runs supervision syntax, and replay) or saved-workflow discovery, public tool contracts, and per-harness capabilities.",
    promptSnippet: EXTERNAL_HELP_PROMPT_SNIPPET,
    parameters: externalHelpParameters,
    outputSchema: externalHelpOutputSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return withContract<ExternalHelpDetails>({ tool: EXTERNAL_HELP_TOOL, action: "help", failureData: null }, async () => {
        // A schema-conversion layer downstream of this tool's declaration may
        // present `harness` or `tool` as required (#62); treat a blank/whitespace
        // placeholder as omitted. usage, workflow, and contracts describe every
        // harness, so an explicit harness is not a filter and does not error.
        const harness = params.harness?.trim() ? params.harness.trim() : undefined;
        const tool = params.tool?.trim() ? params.tool.trim() : undefined;
        if (params.topic === "contracts") {
          validateToolFilter(tool);
          if (!tool) {
            const index = buildContractIndex(options.workflowEnabled);
            const text = formatContractIndex(index);
            return {
              content: [{ type: "text" as const, text }],
              details: { topic: "contracts" as const },
              data: { topic: "contracts" as const, index },
            };
          }
          const contract = buildToolContractDetail(tool, options.workflowEnabled);
          const text = formatToolContractDetail(contract);
          return {
            content: [{ type: "text" as const, text }],
            details: { topic: "contracts" as const, tool },
            data: { topic: "contracts" as const, tool, contract },
          };
        }

        if (params.topic === "capabilities") {
          const harnesses = buildCapabilityRecords({
            agentDir: getAgentDir(),
            harness,
            projectTrusted: isProjectTrusted(ctx),
          });
          const text = harness ? formatCapabilityDetail(harnesses[0]!) : formatCapabilitiesIndex(harnesses);
          return {
            content: [{ type: "text" as const, text }],
            details: { topic: "capabilities" as const, ...(harness ? { harness } : {}) },
            data: { topic: "capabilities" as const, ...(harness ? { harness } : {}), harnesses },
          };
        }

        let text: string;
        const catalog = loadExternalCatalog(getAgentDir());
        const harnessConfigs = catalog.harnessConfigs;
        const configuredPiHarnesses = new Set(harnessConfigs.keys());
        // usage and workflow describe every harness. A supplied harness is not a
        // filter, including a blank placeholder forced by a downstream schema.
        if (params.topic === "roles" || params.topic === "permissions") {
          validateHarnessFilter(harness, configuredPiHarnesses);
        }
        if (params.topic === "usage") {
          text = formatUsagePlaybook();
        } else if (params.topic === "roles") {
          text = catalog.blocked ? catalog.diagnostics.join(" ")
            : harness && catalog.disabledHarnesses.has(harness) ? disabledHarnessMessage(harness)
            : formatExternalRoleHelp(catalog.profiles, options.getDefaultHarness(ctx), harness);
        } else if (params.topic === "permissions") {
          text = formatPermissionHelp(harness, configuredPiHarnesses);
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
          details: { topic: params.topic, ...(harness ? { harness } : {}), ...(tool ? { tool } : {}) },
          data: { topic: params.topic, ...(harness ? { harness } : {}), ...(tool ? { tool } : {}), text },
        };
      });
    },
  });
}
