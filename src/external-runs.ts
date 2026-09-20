import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { deriveRunTiming, getRunRecord, inspectRun, listRunRecords, type RunInspectionView, type RunRecordListItem, type RunTiming } from "./core/run-inspection.ts";
import { RunRegistry, type RegisteredRunEntry, type RegisteredRunOutcome } from "./core/run-registry.ts";
import { EXTERNAL_RUNS_PROMPT_SNIPPET } from "./prompts.ts";
import type { WorkflowToolDetails } from "./types.ts";
import { getSessionWorkflowDir, listWorkflowJournals, loadWorkflowJournal, type LoadedWorkflowJournal } from "./workflow/journal.ts";

const RUN_ID = /^(?:run|wf)_[A-Za-z0-9_-]{1,128}$/;
const WORKFLOW_ID = /^wf_[A-Za-z0-9_-]{1,128}$/;
const MAX_TARGETS = 100;
/**
 * Cap for `inspect`'s batch `runIds` mode. Intentionally lower than `wait`'s
 * MAX_TARGETS (100): batch inspection returns full projections and may touch
 * live evidence reads per target, so it stays cheap by staying small.
 */
const MAX_BATCH_INSPECT_TARGETS = 20;

const externalRunsParameters = Type.Object({
  action: StringEnum(["list", "inspect", "wait", "cancel"] as const, {
    description: "list: page runs/workflows; inspect: read one run; wait: block until selected terminal outcomes; cancel: stop one run.",
  }),
  runId: Type.Optional(Type.String({
    description: "Target run ID (run_... agent, wf_... workflow). Required for inspect/cancel/wait of a single run.",
  })),
  runIds: Type.Optional(Type.Array(Type.String(), {
    minItems: 1,
    maxItems: MAX_TARGETS,
    description: "wait: target set for mode any|all, up to 100, deduplicated; already-terminal targets return immediately. inspect: batch summary target set, up to 20, deduplicated, order preserved; cannot combine with runId, and view must stay summary.",
  })),
  view: Type.Optional(StringEnum(["summary", "output", "diagnostics", "final"] as const, {
    description: "inspect view: summary (state/timing/freshness/refs, default), output (assistant text plus canonical result, partial or final), diagnostics (tool activity/errors), final (only the verified canonical terminal answer, empty until a successful terminal boundary exists). Batch inspect (runIds) only supports summary.",
  })),
  mode: Type.Optional(StringEnum(["any", "all"] as const, {
    description: "wait mode: any returns on the first terminal outcome; all waits for every target. Neither cancels pending work; an unsuccessful selected workflow returns early even in all mode.",
  })),
  cursor: Type.Optional(Type.String({
    description: "Opaque continuation cursor from a prior response; pass back verbatim to page. Stale/reused cursors fail with an actionable error.",
  })),
  workflowCursor: Type.Optional(Type.String({
    description: "Opaque cursor paging the workflow-roots listing (list action); pass back verbatim. Not used when workflowRunId filters to one workflow's children.",
  })),
  limit: Type.Optional(Type.Integer({
    minimum: 1,
    maximum: 100,
    description: "Max entries per list/children page.",
  })),
  limitBytes: Type.Optional(Type.Integer({
    minimum: 4,
    maximum: 65536,
    description: "Max bytes per inspect page, including the summary view; follow nextCursor for the remainder.",
  })),
  workflowRunId: Type.Optional(Type.String({
    description: "list filter: children of this wf_... workflow only.",
  })),
  reason: Type.Optional(Type.String({
    maxLength: 512,
    description: "Optional cancellation reason recorded with the run evidence.",
  })),
});

export type ExternalRunsParams = Static<typeof externalRunsParameters>;
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
  return { sessionId, project: resolve(ctx.cwd) };
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
  return {
    runId: item.runId,
    kind: "agent",
    status,
    outcome: item.outcome ?? (status === "done" ? "succeeded" : status === "aborted" ? "cancelled" : "failed"),
    ...(item.settledAt !== undefined ? { settledAt: item.settledAt } : {}),
    ...(item.error ? { error: item.error } : {}),
  };
}

function clip(value: string | undefined): string | undefined {
  return value && value.length > 512 ? `${value.slice(0, 511)}…` : value;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/**
 * `entry` is a live RunRegistry entry (resolved via `registry.get(runId)`),
 * so — unlike anything read through `run-inspection.ts`'s durable-evidence
 * readers — it is independently confirmed by the registry, not merely a
 * record whose status field happens to read "running". This is the ONLY
 * condition under which `deriveRunTiming`'s `live: true` (now-relative
 * elapsedMs/activityAgeMs) may be used.
 */
function liveEntryFinalAvailable(entry: RegisteredRunEntry): boolean {
  return entry.outcome?.status === "done" && entry.outcome?.result !== undefined;
}

function liveEntryTiming(entry: RegisteredRunEntry, observation: Record<string, unknown> | undefined): RunTiming {
  return deriveRunTiming({
    queuedAt: numberValue(observation?.queuedAt),
    executionStartedAt: numberValue(observation?.executionStartedAt),
    processStartedAt: numberValue(observation?.processStartedAt),
    firstActivityAt: numberValue(observation?.firstActivityAt),
    lastActivityAt: numberValue(observation?.lastActivityAt),
    finishedAt: entry.outcome?.settledAt,
  }, entry.state === "running");
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function liveAgentSummary(entry: RegisteredRunEntry) {
  const observation = record(entry.observation);
  const assistantOutput = record(observation?.assistantOutput);
  return {
    runId: entry.runId,
    kind: "agent",
    live: entry.state === "running",
    task: { description: clip(typeof observation?.description === "string" ? observation.description : undefined), backend: observation?.backend },
    state: {
      // A settled entry.outcome is the registry's own authoritative
      // conclusion, set exactly once by RunRegistry.settle(); prefer it over
      // observation.status (an ambient, unvalidated `unknown`-typed passthrough
      // that could in principle lag behind or diverge from the settled result)
      // whenever it exists, falling back to observation.status only pre-settlement.
      status: entry.outcome?.status ?? (typeof observation?.status === "string" ? observation.status : "running"),
      outcome: entry.outcome?.outcome,
      queuedAt: observation?.queuedAt,
      startedAt: observation?.startedAt,
      processStartedAt: observation?.processStartedAt,
      firstActivityAt: observation?.firstActivityAt,
      lastActivityAt: observation?.lastActivityAt,
      activityCount: observation?.activityCount,
      endedAt: observation?.endedAt,
      error: clip(entry.outcome?.error ?? (typeof observation?.error === "string" ? observation.error : undefined)),
    },
    timing: liveEntryTiming(entry, observation),
    output: {
      available: entry.outcome?.result !== undefined || Array.isArray(assistantOutput?.messages),
      status: entry.state === "running" ? "preliminary" : entry.outcome?.outcome === "succeeded" ? "final" : "interrupted",
      finalAvailable: liveEntryFinalAvailable(entry),
    },
  };
}

function listedAgent(entry: RegisteredRunEntry) {
  const observation = record(entry.observation);
  return {
    runId: entry.runId,
    status: entry.outcome?.status ?? (typeof observation?.status === "string" ? observation.status : "running"),
    outcome: entry.outcome?.outcome,
    description: clip(typeof observation?.description === "string" ? observation.description : undefined),
    outputAvailable: entry.outcome?.result !== undefined || record(observation?.assistantOutput) !== undefined,
    finalAvailable: liveEntryFinalAvailable(entry),
    timing: liveEntryTiming(entry, observation),
    live: entry.state === "running",
    ...(entry.outcome?.settledAt !== undefined ? { settledAt: entry.outcome.settledAt } : {}),
    ...(entry.outcome?.error ? { error: clip(entry.outcome.error) } : {}),
    ...(entry.workflowRunId ? { workflowRunId: entry.workflowRunId } : {}),
  };
}

function historicalAgent(item: RunRecordListItem) {
  return {
    ...item,
    status: item.integrity === "complete" ? item.status : "interrupted_or_uncertain",
    live: false,
  };
}

/**
 * Verified-final-result state for a workflow, shared by `liveSummary`,
 * `journalSummary`, the single-run `inspect` workflow branch, and the batch
 * resolver. `done` requires an actually-settled/completed status (not merely
 * "not running"), and `finalAvailable` uses an explicit `result !== undefined`
 * check — not `??`/truthiness — so an intentional JSON `null` result still
 * counts as available while a genuinely absent result does not.
 */
function workflowFinalState(entry: RegisteredRunEntry | undefined, journal: LoadedWorkflowJournal | undefined): { done: boolean; result: unknown; finalAvailable: boolean } {
  const done = entry ? entry.outcome?.status === "done" : journal?.status === "done";
  const result = entry ? entry.outcome?.result : journal?.result;
  return { done: Boolean(done), result, finalAvailable: Boolean(done) && result !== undefined };
}

function liveSummary(entry: RegisteredRunEntry, allChildren = false): { runId: string; [key: string]: unknown } {
  if (entry.kind === "workflow") {
    const observation = entry.observation as WorkflowToolDetails | undefined;
    return {
      runId: entry.runId,
      kind: entry.kind,
      workflowRunId: entry.workflowRunId,
      task: observation ? { name: clip(observation.name), source: observation.source } : undefined,
      state: {
        status: entry.state === "running" ? "running" : entry.outcome?.status,
        outcome: entry.outcome?.outcome ?? observation?.outcome,
        error: entry.outcome?.error,
        agentCount: observation?.agentCount,
      },
      output: {
        available: entry.outcome?.result !== undefined,
        status: entry.state === "running" ? "preliminary" : entry.outcome?.status === "done" ? "final" : "interrupted",
        finalAvailable: workflowFinalState(entry, undefined).finalAvailable,
      },
      children: (allChildren ? observation?.agents : observation?.agents.slice(0, 50))?.map((agent) => ({ runId: agent.externalRunId, label: clip(agent.label), status: agent.status })),
    };
  }
  return { runId: entry.runId, kind: entry.kind, observation: entry.observation, state: entry.state, outcome: entry.outcome };
}

function journalSummary(journal: LoadedWorkflowJournal, allChildren = false) {
  const status = journal.status === "running" ? "interrupted_or_uncertain" : journal.status;
  return {
    runId: journal.runId,
    kind: "workflow",
    task: { name: clip(journal.name), source: journal.source },
    state: { status, outcome: journal.outcome, error: journal.error, agentCount: journal.children.length },
    output: {
      available: journal.result !== undefined,
      status: journal.status === "done" ? "final" : "interrupted",
      finalAvailable: workflowFinalState(undefined, journal).finalAvailable,
    },
    children: (allChildren ? journal.children : journal.children.slice(0, 50)).map((child) => ({
      runId: child.runId,
      label: clip(child.label),
      status: journal.status === "running" && child.status === "queued" ? "interrupted_or_uncertain" : child.status,
    })),
  };
}

function projectionRevision(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

/**
 * Resolve one batch-inspect target into the shared, normalized shape
 * `{runId, kind, live, task, state, timing, output, outputRef,
 * diagnosticsRef}` regardless of whether the target is a live agent, a
 * durable/historical agent, a live workflow, or a historical workflow —
 * `historicalAgent`'s own flat `RunRecordListItem` shape is unwrapped into
 * the same nested `task`/`state`/`output` grouping `liveAgentSummary` and the
 * two workflow summary builders already use, so batch callers never have to
 * branch on which underlying kind/liveness produced an entry.
 *
 * Workflow entries deliberately omit `children` (unbounded — up to the full
 * agent roster) in favor of `outputRef`/`diagnosticsRef` and this same
 * `runId`, which single-run `inspect(view: "summary")` on that workflow ID
 * already returns in full; batch stays a cheap, bounded projection.
 *
 * Throws (via `assertOwned`/`assertOwnedRecord`, or explicitly for an
 * unresolvable `wf_...` ID) when the target is unknown or does not belong to
 * this session/project, so batch callers can validate every requested ID up
 * front before any page is returned.
 */
async function resolveRunSummaryEntry(
  runId: string,
  options: CreateExternalRunsToolOptions,
  ctx: ExtensionContext,
  sessionId: string,
  project: string,
  runsDirectory: string,
): Promise<Record<string, unknown>> {
  const entry = options.registry.get(runId);
  if (entry) assertOwned(entry, sessionId, project);
  const isWorkflowId = WORKFLOW_ID.test(runId);
  const workflowDir = getSessionWorkflowDir(ctx);
  const historical = !entry && isWorkflowId && workflowDir
    ? await loadWorkflowJournal(workflowDir, runId)
    : undefined;
  if (historical && historical.project !== project) throw new Error("Run is unknown or unavailable in this session");
  const refs = { outputRef: { runId, view: "output" }, diagnosticsRef: { runId, view: "diagnostics" } };

  if (entry?.kind === "workflow" || historical) {
    const observation = entry ? entry.observation as WorkflowToolDetails | undefined : undefined;
    const status = entry
      ? (entry.state === "running" ? "running" : entry.outcome?.status)
      : (historical!.status === "running" ? "interrupted_or_uncertain" : historical!.status);
    const { finalAvailable } = workflowFinalState(entry, historical);
    return {
      runId,
      kind: "workflow",
      live: entry ? entry.state === "running" : false,
      task: compact({ name: entry ? observation?.name : historical!.name, source: entry ? observation?.source : historical!.source }),
      state: compact({
        status,
        outcome: entry ? (entry.outcome?.outcome ?? observation?.outcome) : historical!.outcome,
        error: entry ? entry.outcome?.error : historical!.error,
        agentCount: entry ? observation?.agentCount : historical!.children.length,
      }),
      timing: {},
      output: {
        available: entry ? entry.outcome?.result !== undefined : historical!.result !== undefined,
        finalAvailable,
      },
      ...refs,
    };
  }
  // A wf_... ID that failed to resolve (no live entry, no journal) is
  // definitely unknown — RUN_ID_PATTERN in run-inspection.ts only ever
  // matches run_... IDs, so letting this fall through to getRunRecord below
  // would misreport it as an invalid-format ID rather than "unknown".
  if (isWorkflowId) throw new Error("Run is unknown or unavailable in this session");

  if (entry) return { ...liveAgentSummary(entry), ...refs };
  const durable = await getRunRecord(runsDirectory, runId);
  assertOwnedRecord(durable, sessionId, project);
  return {
    runId,
    kind: "agent",
    live: false,
    task: compact({ description: durable.description, backend: durable.backend, project: durable.project, parentSessionId: durable.parentSessionId, workflowRunId: durable.workflowRunId }),
    state: compact({
      status: durable.integrity === "complete" ? durable.status : "interrupted_or_uncertain",
      outcome: durable.outcome,
      queuedAt: durable.queuedAt,
      settledAt: durable.settledAt,
      error: durable.error,
      integrity: durable.integrity,
    }),
    timing: durable.timing,
    output: { available: durable.outputAvailable, finalAvailable: durable.finalAvailable },
    ...refs,
  };
}

function batchCursorScope(sessionId: string, project: string): string {
  return JSON.stringify({ sessionId, project });
}

function encodeBatchCursor(scope: string, runIds: string[], nextIndex: number): string {
  return Buffer.from(JSON.stringify({ v: 1, kind: "batch-inspect", scope, runIds, nextIndex })).toString("base64url");
}

/**
 * Bound to the ordered target set and session/project scope, but deliberately
 * NOT to any per-target content revision: batch entries are always served
 * whole (never mid-entry byte-sliced across a page boundary), so a target's
 * live record changing between pages has nothing to corrupt and does not
 * invalidate the cursor.
 */
function decodeBatchCursor(value: string, scope: string, runIds: string[]): number {
  if (!value || value.length > 8192) throw new Error("Invalid cursor");
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new Error("Invalid cursor");
  }
  if (
    !parsed ||
    parsed.v !== 1 ||
    parsed.kind !== "batch-inspect" ||
    typeof parsed.scope !== "string" ||
    !Array.isArray(parsed.runIds) ||
    !Number.isSafeInteger(parsed.nextIndex)
  ) {
    throw new Error("Invalid cursor");
  }
  if (parsed.scope !== scope) throw new Error("Run is unknown or unavailable in this session");
  if (JSON.stringify(parsed.runIds) !== JSON.stringify(runIds)) {
    throw new Error("Batch cursor does not match the requested run IDs; repeat the identical runIds array to continue paging");
  }
  const nextIndex = parsed.nextIndex as number;
  if (nextIndex < 0 || nextIndex > runIds.length) throw new Error("Invalid cursor");
  return nextIndex;
}

function encodeProjectionCursor(runId: string, view: RunInspectionView, offset: number, text: string): string {
  return Buffer.from(JSON.stringify({ v: 1, kind: "projection-inspect", runId, view, offset, revision: projectionRevision(text) })).toString("base64url");
}

function decodeProjectionCursor(value: string, runId: string, view: RunInspectionView, text: string): number {
  if (!value || value.length > 4096) throw new Error("Invalid cursor");
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
    const keys = Object.keys(parsed).sort().join(",");
    if (keys !== "kind,offset,revision,runId,v,view" || parsed.v !== 1 || parsed.kind !== "projection-inspect" || parsed.runId !== runId || parsed.view !== view || !Number.isSafeInteger(parsed.offset) || (parsed.offset as number) < 0 || typeof parsed.revision !== "string") throw new Error();
    if (parsed.revision !== projectionRevision(text)) throw new Error("stale");
    return parsed.offset as number;
  } catch (error) {
    if (error instanceof Error && error.message === "stale") throw new Error("Run changed while paging; restart inspection without a cursor");
    throw new Error("Invalid cursor");
  }
}

function isProjectionCursor(value: string | undefined): boolean {
  if (!value || value.length > 4096) return false;
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8"))?.kind === "projection-inspect";
  } catch {
    return false;
  }
}

function liveAgentOutput(entry: RegisteredRunEntry): string | undefined {
  if (entry.outcome?.result !== undefined) return typeof entry.outcome.result === "string" ? entry.outcome.result : JSON.stringify(entry.outcome.result);
  const messages = record(record(entry.observation)?.assistantOutput)?.messages;
  if (!Array.isArray(messages)) return undefined;
  const text = messages.flatMap((message) => typeof record(message)?.text === "string" ? [record(message)!.text as string] : []).join("\n");
  return text || undefined;
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
    outcome: outcome.outcome,
    ...(outcome.settledAt !== undefined ? { settledAt: outcome.settledAt } : {}),
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
    description: "List, inspect (single or batched summaries), wait for, or cancel session-owned external runs.",
    promptSnippet: EXTERNAL_RUNS_PROMPT_SNIPPET,
    parameters: externalRunsParameters,
    async execute(_toolCallId, params: ExternalRunsParams, signal, _onUpdate, ctx) {
      const { sessionId, project } = scope(ctx);
      const runsDirectory = options.runsDirectory();

      if (params.action === "list") {
        if (params.workflowRunId !== undefined && !WORKFLOW_ID.test(params.workflowRunId)) throw new Error("Invalid workflow run ID");
        const page = params.workflowCursor && !params.cursor
          ? { items: [] }
          : await listRunRecords({
              runsDirectory,
              sessionId,
              project,
              workflowRunId: params.workflowRunId,
              limit: params.limit,
              cursor: params.cursor,
            });
        const workflowDir = getSessionWorkflowDir(ctx);
        const historical = !params.workflowRunId && workflowDir
          ? await listWorkflowJournals(workflowDir, project, params.limit, params.workflowCursor)
          : { items: [] };
        const current = params.cursor || params.workflowCursor || params.workflowRunId
          ? []
          : options.registry.list(sessionId, project).filter((entry) => entry.kind === "workflow").map((entry) => liveSummary(entry));
        const currentIds = new Set(current.map((entry) => entry.runId));
        const workflows = [...current, ...historical.items.filter((journal) => !currentIds.has(journal.runId)).map((journal) => journalSummary(journal))];
        const liveAgents = params.cursor || params.workflowCursor ? [] : options.registry.list(sessionId, project)
          .filter((entry) => entry.kind === "agent" && (params.workflowRunId === undefined || entry.workflowRunId === params.workflowRunId))
          .map(listedAgent);
        const liveIds = new Set(liveAgents.map((entry) => entry.runId));
        const runs = [...liveAgents, ...page.items.filter((entry) => !liveIds.has(entry.runId)).map(historicalAgent)];
        const list = { workflows, runs, nextCursor: page.nextCursor, nextWorkflowCursor: historical.nextCursor };
        return result(JSON.stringify(list), list);
      }

      if (params.action === "inspect" && params.runIds !== undefined) {
        if (params.runId !== undefined) throw new Error("inspect accepts either runId or runIds, not both");
        if (params.view !== undefined && params.view !== "summary") throw new Error('Batch inspect (runIds) only supports view: "summary"');
        const runIds = [...new Set(params.runIds)];
        if (runIds.length === 0 || runIds.length > MAX_BATCH_INSPECT_TARGETS) {
          throw new Error(`inspect runIds requires 1-${MAX_BATCH_INSPECT_TARGETS} run IDs`);
        }
        for (const runId of runIds) assertRunId(runId);
        const scope = batchCursorScope(sessionId, project);
        const startIndex = params.cursor ? decodeBatchCursor(params.cursor, scope, runIds) : 0;
        // Resolve (and thereby validate ownership of) every requested target
        // before returning any page — an invalid or cross-session/project
        // target anywhere in the set fails the whole request, not just the
        // page that would eventually reach it.
        const entries = await Promise.all(
          runIds.map((runId) => resolveRunSummaryEntry(runId, options, ctx, sessionId, project, runsDirectory)),
        );
        const limit = Math.max(4, Math.min(65536, params.limitBytes ?? 32768));
        // Size the FULL candidate response text — the `{entries, nextCursor}`
        // envelope, not just the sum of each entry's own JSON — since array
        // separators, the wrapper object, and the cursor string itself all
        // count against the caller's byte budget. Smallest simple approach:
        // actually build and measure each candidate payload (at most
        // MAX_BATCH_INSPECT_TARGETS whole-payload stringifies per request)
        // rather than approximating overhead.
        const served: Record<string, unknown>[] = [];
        let index = startIndex;
        for (; index < entries.length; index++) {
          const candidateServed = [...served, entries[index]!];
          const candidateCursor = index + 1 < entries.length ? encodeBatchCursor(scope, runIds, index + 1) : undefined;
          const candidateText = JSON.stringify({ entries: candidateServed, ...(candidateCursor ? { nextCursor: candidateCursor } : {}) });
          if (Buffer.byteLength(candidateText) > limit) {
            // Every entry is already the compact, normalized batch shape (no
            // unbounded fields — see resolveRunSummaryEntry). If even one
            // entry plus its pagination envelope cannot fit within
            // limitBytes, do not silently drop it and do not serve a page
            // that exceeds the caller's own byte budget (never overflow, and
            // never a zero-entry page that fails to advance) — fail loudly
            // and actionably instead, naming the run and what to do about it.
            if (served.length === 0) {
              throw new Error(
                `Batch summary for ${runIds[index]} does not fit within limitBytes (${limit}) including the pagination envelope; increase limitBytes or inspect this run individually with { action: "inspect", runId: "${runIds[index]}" }.`,
              );
            }
            break;
          }
          served.push(entries[index]!);
        }
        const nextCursor = index < entries.length ? encodeBatchCursor(scope, runIds, index) : undefined;
        const payload = { entries: served, ...(nextCursor ? { nextCursor } : {}) };
        return result(JSON.stringify(payload), payload);
      }

      if (params.action === "inspect") {
        assertRunId(params.runId);
        const view = params.view ?? "summary";
        const entry = options.registry.get(params.runId);
        if (entry) assertOwned(entry, sessionId, project);
        const isWorkflowId = WORKFLOW_ID.test(params.runId);
        const workflowDir = getSessionWorkflowDir(ctx);
        const historical = !entry && isWorkflowId && workflowDir
          ? await loadWorkflowJournal(workflowDir, params.runId)
          : undefined;
        if (historical && historical.project !== project) throw new Error("Run is unknown or unavailable in this session");
        if (entry?.kind === "workflow" || historical) {
          const { result: workflowResult, finalAvailable } = workflowFinalState(entry, historical);
          if (view === "final") {
            // Its own branch (not left to fall through into the diagnostics-
            // shaped {status, error} response below): a legitimately settled
            // `null`/object result reads as available:true and is returned
            // as JSON exactly like every other view. An unavailable final
            // answer is a bounded EMPTY page with finalAvailable:false —
            // going through the same cursor/limitBytes validation as every
            // other page, never a synthesized explanation baked into the
            // tool's response text. The tool's final projection stays a
            // clean, narration-free canonical-answer surface; turning
            // finalAvailable:false into a human-readable message is the
            // UI layer's job (src/external-command.ts's showPages), not
            // this tool's.
            if (!finalAvailable) {
              const status = entry ? (entry.state === "running" ? "running" : entry.outcome?.status) : historical!.status;
              const text = "";
              const offset = params.cursor ? decodeProjectionCursor(params.cursor, params.runId, view, text) : 0;
              const page = utf8Page(text, offset, Math.max(4, Math.min(65536, params.limitBytes ?? 32768)));
              const nextCursor = page.nextOffset === undefined ? undefined : encodeProjectionCursor(params.runId, view, page.nextOffset, text);
              return result(page.text, { runId: params.runId, view, text: page.text, finalAvailable: false, status: status ?? "running", nextCursor });
            }
            const text = JSON.stringify({ runId: params.runId, result: workflowResult, finalAvailable: true });
            const offset = params.cursor ? decodeProjectionCursor(params.cursor, params.runId, view, text) : 0;
            const page = utf8Page(text, offset, Math.max(4, Math.min(65536, params.limitBytes ?? 32768)));
            const nextCursor = page.nextOffset === undefined ? undefined : encodeProjectionCursor(params.runId, view, page.nextOffset, text);
            return result(page.text, { runId: params.runId, view, text: page.text, finalAvailable: true, nextCursor });
          }
          const source = view === "summary"
            ? entry ? liveSummary(entry, true) : journalSummary(historical!, true)
            : view === "output"
              // Ternary, not ??: entry and historical are mutually exclusive, but a
              // `??` chain would treat an intentional `null` workflowResult from
              // entry.outcome.result as absent and incorrectly fall through.
              ? { runId: params.runId, result: entry ? entry.outcome?.result : historical?.result }
              : { runId: params.runId, status: entry?.outcome?.status ?? historical?.status ?? "running", error: entry?.outcome?.error ?? historical?.error };
          const text = JSON.stringify(source);
          const offset = params.cursor ? decodeProjectionCursor(params.cursor, params.runId, view, text) : 0;
          const page = utf8Page(text, offset, Math.max(4, Math.min(65536, params.limitBytes ?? 32768)));
          const nextCursor = page.nextOffset === undefined ? undefined : encodeProjectionCursor(params.runId, view, page.nextOffset, text);
          return result(page.text, { runId: params.runId, view, text: page.text, nextCursor });
        }
        // A wf_... ID that resolved to neither a live nor a historical
        // workflow is definitely unknown, not an agent: run-inspection.ts's
        // own RUN_ID_PATTERN only matches run_... IDs, so falling through to
        // getRunRecord below would misreport it as an invalid-format ID.
        if (isWorkflowId) throw new Error("Run is unknown or unavailable in this session");
        const durable = await getRunRecord(runsDirectory, params.runId);
        if (!entry) assertOwnedRecord(durable, sessionId, project);
        if (view === "summary") {
          const source = entry ? liveAgentSummary(entry) : historicalAgent(durable!);
          const text = JSON.stringify(source);
          const offset = params.cursor ? decodeProjectionCursor(params.cursor, params.runId, view, text) : 0;
          const portion = utf8Page(text, offset, Math.max(4, Math.min(65536, params.limitBytes ?? 32768)));
          const nextCursor = portion.nextOffset === undefined ? undefined : encodeProjectionCursor(params.runId, view, portion.nextOffset, text);
          return result(portion.text, { runId: params.runId, view, text: portion.text, nextCursor });
        }
        if (view === "output" && entry?.kind === "agent" && (!params.cursor || isProjectionCursor(params.cursor))) {
          const text = liveAgentOutput(entry);
          if (text !== undefined) {
            const offset = params.cursor ? decodeProjectionCursor(params.cursor, params.runId, view, text) : 0;
            const portion = utf8Page(text, offset, Math.max(4, Math.min(65536, params.limitBytes ?? 32768)));
            const nextCursor = portion.nextOffset === undefined ? undefined : encodeProjectionCursor(params.runId, view, portion.nextOffset, text);
            return result(portion.text, { runId: params.runId, view, text: portion.text, outputStatus: entry.state === "running" ? "preliminary" : entry.outcome?.outcome === "succeeded" ? "final" : "interrupted", nextCursor });
          }
        }
        const page = await inspectRun({ runsDirectory, runId: params.runId, view, limitBytes: params.limitBytes, cursor: params.cursor });
        const text = page.items.map((item) => item.text).join("\n");
        // view: "final" stays a clean, narration-free canonical-answer
        // surface — a bounded empty page (finalAvailable:false) when
        // unavailable, matching the workflow branch above — rather than a
        // synthesized "no X available" sentence baked into the response
        // text. output/diagnostics keep that convenience fallback; they are
        // not the verified-final-answer projection.
        return result(view === "final" ? text : (text || `No ${view} is available for ${params.runId}.`), { ...page });
      }

      if (params.action === "cancel") {
        assertRunId(params.runId);
        const entry = options.registry.get(params.runId);
        if (entry) {
          assertOwned(entry, sessionId, project);
          const status = options.registry.cancel(params.runId, params.reason ?? "cancelled by external_runs");
          return result(status === "requested" ? `Cancellation requested for ${params.runId}.` : `${params.runId} is already terminal.`, { runId: params.runId, status });
        }
        const isWorkflowId = WORKFLOW_ID.test(params.runId);
        const workflowDir = getSessionWorkflowDir(ctx);
        const historicalWorkflow = isWorkflowId && workflowDir ? await loadWorkflowJournal(workflowDir, params.runId) : undefined;
        if (historicalWorkflow) {
          if (historicalWorkflow.project !== project) throw new Error("Run is unknown or unavailable in this session");
          if (historicalWorkflow.status !== "running") return result(`${params.runId} is already terminal.`, { runId: params.runId, status: "terminal" });
          throw new Error("Run is no longer live in this session; cancellation cannot be confirmed");
        }
        // An unresolved wf_... ID is unknown, not an unowned agent record.
        if (isWorkflowId) throw new Error("Run is unknown or unavailable in this session");
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
        const isWorkflowId = WORKFLOW_ID.test(runId);
        const workflowDir = getSessionWorkflowDir(ctx);
        const historicalWorkflow = isWorkflowId && workflowDir ? await loadWorkflowJournal(workflowDir, runId) : undefined;
        if (historicalWorkflow) {
          if (historicalWorkflow.project !== project) throw new Error("Run is unknown or unavailable in this session");
          if (historicalWorkflow.status === "running") throw new Error(`Run ${runId} is unavailable for live waiting`);
          return {
            runId,
            kind: "workflow" as const,
            terminal: {
              runId,
              kind: "workflow" as const,
              status: historicalWorkflow.status === "done" ? "done" as const : historicalWorkflow.outcome === "cancelled" || historicalWorkflow.outcome === "timed_out" ? "aborted" as const : "error" as const,
              outcome: historicalWorkflow.outcome ?? (historicalWorkflow.status === "done" ? "succeeded" as const : "failed" as const),
              result: historicalWorkflow.result,
              error: historicalWorkflow.error,
            },
          };
        }
        // An unresolved wf_... ID is unknown, not an unowned agent record.
        if (isWorkflowId) throw new Error("Run is unknown or unavailable in this session");
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
