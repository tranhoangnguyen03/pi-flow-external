import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { getRunRecord, inspectRun, listRunRecords, type RunInspectionView, type RunRecordListItem } from "./core/run-inspection.ts";
import { RunRegistry, type RegisteredRunEntry, type RegisteredRunOutcome } from "./core/run-registry.ts";
import { EXTERNAL_RUNS_PROMPT_SNIPPET } from "./prompts.ts";
import type { WorkflowToolDetails } from "./types.ts";
import { getSessionWorkflowDir, listWorkflowJournals, loadWorkflowJournal, type LoadedWorkflowJournal } from "./workflow/journal.ts";

const RUN_ID = /^(?:run|wf)_[A-Za-z0-9_-]{1,128}$/;
const WORKFLOW_ID = /^wf_[A-Za-z0-9_-]{1,128}$/;
const MAX_TARGETS = 100;

const externalRunsParameters = Type.Object({
  action: StringEnum(["list", "inspect", "wait", "cancel"] as const),
  runId: Type.Optional(Type.String()),
  runIds: Type.Optional(Type.Array(Type.String(), { minItems: 1, maxItems: MAX_TARGETS })),
  view: Type.Optional(StringEnum(["summary", "output", "diagnostics"] as const)),
  mode: Type.Optional(StringEnum(["any", "all"] as const)),
  cursor: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  limitBytes: Type.Optional(Type.Integer({ minimum: 4, maximum: 65536 })),
  workflowRunId: Type.Optional(Type.String()),
  reason: Type.Optional(Type.String({ maxLength: 512 })),
});

type ExternalRunsParams = Static<typeof externalRunsParameters>;
type ExternalRunsDetails = Record<string, unknown>;

export interface CreateExternalRunsToolOptions {
  registry: RunRegistry;
  runsDirectory: () => string;
}

function result(text: string, details: ExternalRunsDetails) {
  return { content: [{ type: "text" as const, text }], details };
}

function scope(ctx: ExtensionContext): { sessionId: string; project: string } {
  const sessionId = ctx.sessionManager?.getSessionId?.();
  if (!sessionId) throw new Error("external_runs requires a persisted originating session");
  return { sessionId, project: ctx.cwd };
}

function assertRunId(runId: unknown): asserts runId is string {
  if (typeof runId !== "string" || !RUN_ID.test(runId)) throw new Error("Invalid run ID");
}

function assertOwned(entry: Pick<RegisteredRunEntry, "sessionId" | "project">, sessionId: string, project: string): void {
  if (entry.sessionId !== sessionId || entry.project !== project) throw new Error("Run is unknown or unavailable in this session");
}

function assertOwnedRecord(item: RunRecordListItem | undefined, sessionId: string, project: string): asserts item is RunRecordListItem {
  if (!item || item.parentSessionId !== sessionId || item.project !== project) throw new Error("Run is unknown or unavailable in this session");
}

function terminalRecord(item: RunRecordListItem): RegisteredRunOutcome | undefined {
  if (item.integrity !== "complete") return undefined;
  const status = item.status === "done" ? "done" : item.status === "aborted" ? "aborted" : "error";
  return { runId: item.runId, kind: "agent", status, settledAt: Date.now() };
}

function clip(value: string | undefined): string | undefined {
  return value && value.length > 512 ? `${value.slice(0, 511)}…` : value;
}

function liveSummary(entry: RegisteredRunEntry): { runId: string; [key: string]: unknown } {
  if (entry.kind === "workflow") {
    const observation = entry.observation as WorkflowToolDetails | undefined;
    return {
      runId: entry.runId,
      kind: entry.kind,
      workflowRunId: entry.workflowRunId,
      task: observation ? { name: clip(observation.name), source: observation.source } : undefined,
      state: {
        status: entry.state === "running" ? "running" : entry.outcome?.status,
        error: entry.outcome?.error,
        agentCount: observation?.agentCount,
      },
      output: { available: entry.outcome?.result !== undefined, status: entry.state === "running" ? "preliminary" : entry.outcome?.status === "done" ? "final" : "interrupted" },
      children: observation?.agents.slice(0, 50).map((agent) => ({ runId: agent.externalRunId, label: clip(agent.label), status: agent.status })),
    };
  }
  return { runId: entry.runId, kind: entry.kind, observation: entry.observation, state: entry.state, outcome: entry.outcome };
}

function journalSummary(journal: LoadedWorkflowJournal) {
  return {
    runId: journal.runId,
    kind: "workflow",
    task: { name: clip(journal.name), source: journal.source },
    state: { status: journal.status, error: journal.error, agentCount: journal.children.length },
    output: { available: journal.result !== undefined, status: journal.status === "running" ? "preliminary" : journal.status === "done" ? "final" : "interrupted" },
    children: journal.children.slice(0, 50).map((child) => ({ runId: child.runId, label: clip(child.label), status: child.failed ? "error" : "done" })),
  };
}

function encodeWorkflowCursor(runId: string, view: RunInspectionView, offset: number): string {
  return Buffer.from(JSON.stringify({ v: 1, kind: "workflow-inspect", runId, view, offset })).toString("base64url");
}

function decodeWorkflowCursor(value: string, runId: string, view: RunInspectionView): number {
  if (!value || value.length > 4096) throw new Error("Invalid cursor");
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
    const keys = Object.keys(parsed).sort().join(",");
    if (keys !== "kind,offset,runId,v,view" || parsed.v !== 1 || parsed.kind !== "workflow-inspect" || parsed.runId !== runId || parsed.view !== view || !Number.isSafeInteger(parsed.offset) || (parsed.offset as number) < 0) throw new Error();
    return parsed.offset as number;
  } catch {
    throw new Error("Invalid cursor");
  }
}

function utf8Page(text: string, offset: number, limit: number): { text: string; nextOffset?: number } {
  if ((offset >= text.length && offset !== 0) || (offset > 0 && /[\uD800-\uDBFF]/.test(text[offset - 1]!) && /[\uDC00-\uDFFF]/.test(text[offset]!))) throw new Error("Cursor points outside available workflow content");
  let end = offset;
  let bytes = 0;
  for (const character of text.slice(offset)) {
    const size = Buffer.byteLength(character);
    if (bytes + size > limit) break;
    bytes += size;
    end += character.length;
  }
  return { text: text.slice(offset, end), ...(end < text.length ? { nextOffset: end } : {}) };
}

async function previewOutcome(outcome: RegisteredRunOutcome, runsDirectory: string): Promise<Record<string, unknown>> {
  let preview: string | undefined;
  if (outcome.result !== undefined) {
    preview = typeof outcome.result === "string" ? outcome.result : JSON.stringify(outcome.result);
  } else if (outcome.kind === "agent") {
    const page = await inspectRun({ runsDirectory, runId: outcome.runId, view: "output", limitBytes: 512 });
    preview = page.items.map((item) => item.text).join("") || undefined;
  }
  return {
    runId: outcome.runId,
    kind: outcome.kind,
    status: outcome.status,
    settledAt: outcome.settledAt,
    ...(outcome.error ? { error: clip(outcome.error) } : {}),
    ...(preview ? { preview: preview.length > 512 ? `${preview.slice(0, 511)}…` : preview } : {}),
    outputRef: { runId: outcome.runId, view: "output" },
    diagnosticsRef: { runId: outcome.runId, view: "diagnostics" },
  };
}

export function createExternalRunsTool(
  options: CreateExternalRunsToolOptions,
): ToolDefinition<typeof externalRunsParameters, ExternalRunsDetails> {
  return defineTool({
    name: "external_runs",
    label: "External Runs",
    description: "List, inspect, wait for, or cancel session-owned external runs.",
    promptSnippet: EXTERNAL_RUNS_PROMPT_SNIPPET,
    parameters: externalRunsParameters,
    async execute(_toolCallId, params: ExternalRunsParams, signal, _onUpdate, ctx) {
      const { sessionId, project } = scope(ctx);
      const runsDirectory = options.runsDirectory();

      if (params.action === "list") {
        if (params.workflowRunId !== undefined && !WORKFLOW_ID.test(params.workflowRunId)) throw new Error("Invalid workflow run ID");
        const page = await listRunRecords({
          runsDirectory,
          sessionId,
          project,
          workflowRunId: params.workflowRunId,
          limit: params.limit,
          cursor: params.cursor,
        });
        const workflowDir = getSessionWorkflowDir(ctx);
        const historical = !params.cursor && !params.workflowRunId && workflowDir
          ? await listWorkflowJournals(workflowDir, project, params.limit)
          : [];
        const current = params.cursor || params.workflowRunId
          ? []
          : options.registry.list(sessionId, project).filter((entry) => entry.kind === "workflow").map(liveSummary);
        const currentIds = new Set(current.map((entry) => entry.runId));
        const workflows = [...current, ...historical.filter((journal) => !currentIds.has(journal.runId)).map(journalSummary)];
        return result(JSON.stringify({ workflows, runs: page.items, nextCursor: page.nextCursor }), { workflows, runs: page.items, nextCursor: page.nextCursor });
      }

      if (params.action === "inspect") {
        assertRunId(params.runId);
        const view = params.view ?? "summary";
        const entry = options.registry.get(params.runId);
        if (entry) assertOwned(entry, sessionId, project);
        const workflowDir = getSessionWorkflowDir(ctx);
        const historical = !entry && WORKFLOW_ID.test(params.runId) && workflowDir
          ? await loadWorkflowJournal(workflowDir, params.runId)
          : undefined;
        if (historical && historical.project !== project) throw new Error("Run is unknown or unavailable in this session");
        if (entry?.kind === "workflow" || historical) {
          const source = view === "summary"
            ? entry ? liveSummary(entry) : journalSummary(historical!)
            : view === "output"
              ? { runId: params.runId, result: entry?.outcome?.result ?? historical?.result }
              : { runId: params.runId, status: entry?.outcome?.status ?? historical?.status ?? "running", error: entry?.outcome?.error ?? historical?.error };
          const text = JSON.stringify(source);
          const offset = params.cursor ? decodeWorkflowCursor(params.cursor, params.runId, view) : 0;
          const page = utf8Page(text, offset, Math.max(4, Math.min(65536, params.limitBytes ?? 32768)));
          const nextCursor = page.nextOffset === undefined ? undefined : encodeWorkflowCursor(params.runId, view, page.nextOffset);
          return result(page.text, { runId: params.runId, view, text: page.text, nextCursor });
        }
        const durable = await getRunRecord(runsDirectory, params.runId);
        if (!entry) assertOwnedRecord(durable, sessionId, project);
        const page = await inspectRun({ runsDirectory, runId: params.runId, view, limitBytes: params.limitBytes, cursor: params.cursor });
        const text = page.items.map((item) => item.text).join("\n");
        return result(text || `No ${view} is available for ${params.runId}.`, { ...page });
      }

      if (params.action === "cancel") {
        assertRunId(params.runId);
        const entry = options.registry.get(params.runId);
        if (entry) {
          assertOwned(entry, sessionId, project);
          const status = options.registry.cancel(params.runId, params.reason ?? "cancelled by external_runs");
          return result(status === "requested" ? `Cancellation requested for ${params.runId}.` : `${params.runId} is already terminal.`, { runId: params.runId, status });
        }
        const workflowDir = getSessionWorkflowDir(ctx);
        const historicalWorkflow = WORKFLOW_ID.test(params.runId) && workflowDir ? await loadWorkflowJournal(workflowDir, params.runId) : undefined;
        if (historicalWorkflow) {
          if (historicalWorkflow.project !== project) throw new Error("Run is unknown or unavailable in this session");
          if (historicalWorkflow.status !== "running") return result(`${params.runId} is already terminal.`, { runId: params.runId, status: "terminal" });
          throw new Error("Run is no longer live in this session; cancellation cannot be confirmed");
        }
        const durable = await getRunRecord(runsDirectory, params.runId);
        assertOwnedRecord(durable, sessionId, project);
        if (terminalRecord(durable)) return result(`${params.runId} is already terminal.`, { runId: params.runId, status: "terminal" });
        throw new Error("Run is no longer live in this session; cancellation cannot be confirmed");
      }

      const runIds = [...new Set(params.runIds ?? (params.runId ? [params.runId] : []))];
      if (runIds.length === 0 || runIds.length > MAX_TARGETS) throw new Error(`wait requires 1-${MAX_TARGETS} run IDs`);
      for (const runId of runIds) assertRunId(runId);
      const known = await Promise.all(runIds.map(async (runId) => {
        const entry = options.registry.get(runId);
        if (entry) {
          assertOwned(entry, sessionId, project);
          return { runId, kind: entry.kind, terminal: entry.outcome };
        }
        const workflowDir = getSessionWorkflowDir(ctx);
        const historicalWorkflow = WORKFLOW_ID.test(runId) && workflowDir ? await loadWorkflowJournal(workflowDir, runId) : undefined;
        if (historicalWorkflow) {
          if (historicalWorkflow.project !== project) throw new Error("Run is unknown or unavailable in this session");
          if (historicalWorkflow.status === "running") throw new Error(`Run ${runId} is unavailable for live waiting`);
          return {
            runId,
            kind: "workflow" as const,
            terminal: {
              runId,
              kind: "workflow" as const,
              status: historicalWorkflow.status === "done" ? "done" as const : "error" as const,
              settledAt: Date.now(),
              result: historicalWorkflow.result,
              error: historicalWorkflow.error,
            },
          };
        }
        const durable = await getRunRecord(runsDirectory, runId);
        assertOwnedRecord(durable, sessionId, project);
        const terminal = terminalRecord(durable);
        if (!terminal) throw new Error(`Run ${runId} is unavailable for live waiting`);
        return { runId, kind: "agent" as const, terminal };
      }));

      const mode = params.mode ?? "all";
      const outcomes = known.flatMap((target) => target.terminal ? [target.terminal] : []);
      let pending = known.filter((target) => !target.terminal);
      const shouldReturn = () =>
        (mode === "any" && outcomes.length > 0)
        || pending.length === 0
        || outcomes.some((outcome) => outcome.status !== "done" && known.some((target) => target.kind === "workflow" && target.runId === outcome.runId));
      while (!shouldReturn()) {
        const waited = await options.registry.wait(pending.map((target) => target.runId), "any", signal);
        for (const outcome of waited.terminal) if (!outcomes.some((item) => item.runId === outcome.runId)) outcomes.push(outcome);
        pending = pending.filter((target) => !outcomes.some((outcome) => outcome.runId === target.runId));
      }
      const projected = await Promise.all(outcomes.map((outcome) => previewOutcome(outcome, runsDirectory)));
      return result(JSON.stringify({ outcomes: projected, pending: pending.map((target) => target.runId) }), {
        mode,
        outcomes: projected,
        pending: pending.map((target) => target.runId),
      });
    },
  });
}
