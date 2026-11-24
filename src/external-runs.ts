import { type ExtensionContext, type Theme, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { type Static } from "typebox";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { getRunRecord, inspectRun, listRunRecords, type RunInspectionView, type RunRecordListItem } from "./core/run-inspection.ts";
import { RunRegistry, type RegisteredRunEntry, type RegisteredRunOutcome } from "./core/run-registry.ts";
import { projectDurableAgent, projectLiveAgent, projectWorkflowRun } from "./core/run-projection.ts";
import { formatRunRow, formatWaitTargetRow } from "./core/run-render.ts";
import { renderOutputText } from "./core/subagent-render.ts";
import { SPINNER_INTERVAL_MS } from "./core/spinner.ts";
import { EXTERNAL_RUNS_PROMPT_SNIPPET } from "./prompts.ts";
import { envelope, INLINE_RESULT_BYTES, redactedText, withContract } from "./contract/envelope.ts";
import { durableAgentRun, journalWorkflowRun, liveAgentRun, liveWorkflowRun, unreadableWorkflowRun, type EvidenceIntegrity, type PublicRun } from "./contract/run.ts";
import {
  EXTERNAL_RUNS_ACTIONS,
  EXTERNAL_RUNS_EXAMPLES,
  externalRunsOutputSchema,
  externalRunsParameters,
  MAX_BATCH_INSPECT_TARGETS,
  MAX_WAIT_TARGETS,
  SINGLE_INSPECT_VIEWS,
  WAIT_MODES,
} from "./contract/runs.ts";
import { ExpectedFlowError } from "./core/errors.ts";
import { redactSecrets } from "./core/run-record.ts";
import type { WorkflowToolDetails } from "./types.ts";
import { getSessionWorkflowDir, listWorkflowJournals, loadWorkflowJournal, WorkflowJournalReadError, type LoadedWorkflowJournal, type UnreadableWorkflowJournal } from "./workflow/journal.ts";

const RUN_ID = /^(?:run|wf)_[A-Za-z0-9_-]{1,128}$/;
const WORKFLOW_ID = /^wf_[A-Za-z0-9_-]{1,128}$/;

export type ExternalRunsParams = Static<typeof externalRunsParameters> & {
  /** Legacy single-target selector; preserved for backwards-compatible programmatic/test callers. */
  runId?: string;
};
type ExternalRunsDetails = Record<string, unknown>;

interface WaitTarget {
  runId: string;
  kind: "agent" | "workflow";
  terminal?: RegisteredRunOutcome;
  /** Present for registry targets: the only source of a live projection. */
  entry?: RegisteredRunEntry;
  /** Present for durable targets, which are always delivered by reference. */
  durable?: PublicRun;
}

export interface CreateExternalRunsToolOptions {
  registry: RunRegistry;
  runsDirectory: () => string;
}

function result(text: string, details: ExternalRunsDetails) {
  return { content: [{ type: "text" as const, text }], details };
}

function scope(ctx: ExtensionContext): { sessionId: string; project: string } {
  const sessionId = ctx.sessionManager?.getSessionId?.();
  if (!sessionId) throw new ExpectedFlowError("session_unavailable", "external_runs requires a persisted originating session");
  return { sessionId, project: resolve(ctx.cwd) };
}

/** Unknown, other-session/project and retention-pruned runs are deliberately indistinguishable. */
function unavailable(): ExpectedFlowError {
  return new ExpectedFlowError("run_unavailable", "Run is unknown or unavailable in this session");
}

function invalid(message: string): ExpectedFlowError {
  return new ExpectedFlowError("request_invalid", message);
}

function notLive(message: string): ExpectedFlowError {
  return new ExpectedFlowError("run_not_live", message);
}

function assertRunId(runId: unknown, action: "inspect" | "wait" | "cancel" = "inspect"): asserts runId is string {
  if (typeof runId === "string" && RUN_ID.test(runId)) return;
  const example = action === "cancel"
    ? EXTERNAL_RUNS_EXAMPLES.cancel
    : action === "wait"
      ? EXTERNAL_RUNS_EXAMPLES.wait
      : EXTERNAL_RUNS_EXAMPLES.inspectSingle;
  throw invalid(
    `Invalid run ID for ${action}; pass a run_... or wf_... ID in runIds, e.g. ${JSON.stringify(example)}.`,
  );
}

function assertOwned(entry: Pick<RegisteredRunEntry, "sessionId" | "project">, sessionId: string, project: string): void {
  if (entry.sessionId !== sessionId || entry.project !== project) throw unavailable();
}

function assertOwnedRecord(item: RunRecordListItem | undefined, sessionId: string, project: string): asserts item is RunRecordListItem {
  if (!item || item.parentSessionId !== sessionId || item.project !== project) throw unavailable();
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
 * Legacy flat shape for `list`'s live-agent rows, kept for existing
 * consumers, built on the same shared `projectLiveAgent` single/batch
 * `inspect` already use — no independent field extraction from
 * `entry.observation` here anymore.
 */
function listedAgent(entry: RegisteredRunEntry) {
  const projection = projectLiveAgent(entry);
  return {
    ...projection,
    status: projection.state.status,
    outcome: projection.state.outcome,
    description: projection.task.description,
    outputAvailable: projection.output.available,
    finalAvailable: projection.output.finalAvailable,
    ...(projection.state.settledAt !== undefined ? { settledAt: projection.state.settledAt } : {}),
    ...(projection.state.error ? { error: projection.state.error } : {}),
    ...(entry.workflowRunId ? { workflowRunId: entry.workflowRunId } : {}),
  };
}

/**
 * Legacy flat `RunRecordListItem` fields (`status`, `outcome`, `description`,
 * ...) are kept at the top level for existing `list` consumers, but every
 * historical agent row now also carries the same nested `task`/`state`/
 * `output` shape a live one already has (`projectDurableAgent`, shared with
 * the durable branch of `resolveRunSummaryEntry` below) — the exact shape
 * drift the design calls out is gone, without breaking a caller reading the
 * flat fields.
 */
function historicalAgent(item: RunRecordListItem) {
  const projection = projectDurableAgent(item);
  return {
    ...item,
    ...projection,
    status: projection.state.status,
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
    const status = entry.state === "running" ? "running" : entry.outcome?.status ?? "error";
    const projection = projectWorkflowRun({
      runId: entry.runId,
      live: entry.state === "running",
      name: observation?.name,
      source: observation?.source,
      status,
      outcome: entry.outcome?.outcome ?? observation?.outcome,
      error: entry.outcome?.error,
      agentCount: observation?.agentCount,
      resultAvailable: entry.outcome?.result !== undefined,
      finalAvailable: workflowFinalState(entry, undefined).finalAvailable,
    });
    return {
      ...projection,
      workflowRunId: entry.workflowRunId,
      children: (allChildren ? observation?.agents : observation?.agents.slice(0, 50))?.map((agent) => ({ runId: agent.externalRunId, label: clip(agent.label), status: agent.status })),
    };
  }
  return { runId: entry.runId, kind: entry.kind, observation: entry.observation, state: entry.state, outcome: entry.outcome };
}

function journalSummary(journal: LoadedWorkflowJournal, allChildren = false) {
  const status = journal.status === "running" ? "interrupted_or_uncertain" : journal.status;
  const projection = projectWorkflowRun({
    runId: journal.runId,
    live: false,
    name: journal.name,
    source: journal.source,
    status,
    outcome: journal.outcome,
    error: journal.error,
    agentCount: journal.children.length,
    resultAvailable: journal.result !== undefined,
    finalAvailable: workflowFinalState(undefined, journal).finalAvailable,
  });
  return {
    ...projection,
    children: (allChildren ? journal.children : journal.children.slice(0, 50)).map((child) => ({
      runId: child.runId,
      label: clip(child.label),
      status: journal.status === "running" && child.status === "queued" ? "interrupted_or_uncertain" : child.status,
    })),
  };
}

/** A listed journal that could not be loaded: one uncertain row instead of a failed listing. */
function unreadableJournalSummary(journal: UnreadableWorkflowJournal) {
  return {
    ...projectWorkflowRun({
      runId: journal.runId,
      live: false,
      status: "interrupted_or_uncertain",
      error: clip(journal.unreadable),
      resultAvailable: false,
      finalAvailable: false,
    }),
    children: [],
  };
}

/** Mirrors the listing's own inclusion rule, so a journal is counted persisted exactly when some page lists it. */
async function hasWorkflowJournal(dir: string, runId: string, project: string): Promise<boolean> {
  try {
    return (await loadWorkflowJournal(dir, runId))?.project === project;
  } catch (error) {
    const owner = error instanceof WorkflowJournalReadError ? error.project : undefined;
    return owner === undefined || owner === project;
  }
}

function listScope(stream: "runs" | "workflows", sessionId: string, project: string, workflowRunId?: string): string {
  return JSON.stringify({ stream, sessionId, project, workflowRunId });
}

type UnpersistedBookmark = { after: string } | { persisted: true };

function encodeUnpersistedCursor(scope: string, bookmark: UnpersistedBookmark): string {
  return Buffer.from(JSON.stringify({ v: 1, kind: "unpersisted-list", scope, ...bookmark })).toString("base64url");
}

/** The bookmark of an unpersisted-stage cursor, or undefined for any other cursor (passed on to the persisted listing). */
function decodeUnpersistedCursor(value: string, scope: string): UnpersistedBookmark | undefined {
  let parsed: Record<string, unknown> | undefined;
  try {
    parsed = record(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
  } catch {
    return undefined;
  }
  if (parsed?.kind !== "unpersisted-list") return undefined;
  const keys = Object.keys(parsed).sort().join(",");
  const valid = parsed.v === 1 && ((keys === "after,kind,scope,v" && typeof parsed.after === "string" && RUN_ID.test(parsed.after)) || (keys === "kind,persisted,scope,v" && parsed.persisted === true));
  if (!valid) {
    throw cursorInvalid(
      `Invalid list cursor; pass nextCursor (${JSON.stringify(EXTERNAL_RUNS_EXAMPLES.listRunsNextPage)}) or nextWorkflowCursor (${JSON.stringify(EXTERNAL_RUNS_EXAMPLES.listWorkflowsNextPage)}), or restart with ${JSON.stringify(EXTERNAL_RUNS_EXAMPLES.list)}.`,
    );
  }
  if (parsed.scope !== scope) {
    throw cursorInvalid(
      `Cursor belongs to a different list scope for list; use cursor for runs (or workflowRunId children) and workflowCursor for unfiltered workflows, or restart with ${JSON.stringify(EXTERNAL_RUNS_EXAMPLES.list)}.`,
    );
  }
  return typeof parsed.after === "string" ? { after: parsed.after } : { persisted: true };
}

/**
 * One bounded list page: live runs with no persisted row first, then
 * persisted rows, all within `pageSize`. The unpersisted stage bookmarks the
 * last run it served, in registry order. Persisting a run never removes it
 * from the registry, so a later page always resumes after the same run and
 * none is skipped. If the bookmarked run has left the registry, continuation
 * fails as stale rather than guessing. A run persisted between pages may
 * appear in both stages; a run registered after the listing reached its
 * persisted stage appears in the next fresh listing.
 */
async function pageUnpersistedFirst<L extends { runId: string }, D>(
  scope: string,
  cursor: string | undefined,
  pageSize: number,
  candidates: L[],
  isUnpersisted: (candidate: L) => Promise<boolean>,
  persisted: (limit: number, cursor: string | undefined) => Promise<{ items: D[]; nextCursor?: string }>,
): Promise<{ live: L[]; items: D[]; nextCursor?: string }> {
  const bookmark = cursor === undefined ? undefined : decodeUnpersistedCursor(cursor, scope);
  if (cursor !== undefined && bookmark === undefined) {
    try {
      return { live: [], ...await persisted(pageSize, cursor) };
    } catch (error) {
      if (error instanceof ExpectedFlowError && error.code === "cursor_invalid") {
        throw cursorInvalid(
          `${error.message} for list; pass nextCursor (${JSON.stringify(EXTERNAL_RUNS_EXAMPLES.listRunsNextPage)}) or nextWorkflowCursor (${JSON.stringify(EXTERNAL_RUNS_EXAMPLES.listWorkflowsNextPage)}), or restart with ${JSON.stringify(EXTERNAL_RUNS_EXAMPLES.list)}.`,
        );
      }
      throw error;
    }
  }
  if (bookmark && "persisted" in bookmark) return { live: [], ...await persisted(pageSize, undefined) };
  let start = 0;
  if (bookmark) {
    const index = candidates.findIndex((candidate) => candidate.runId === bookmark.after);
    if (index < 0) throw new ExpectedFlowError("cursor_stale", "Run list changed while paging; restart the listing without a cursor");
    start = index + 1;
  }
  // Find one more than fits, to know whether the unpersisted stage continues.
  const live: L[] = [];
  for (let index = start; index < candidates.length && live.length <= pageSize; index++) {
    if (await isUnpersisted(candidates[index]!)) live.push(candidates[index]!);
  }
  if (live.length > pageSize) {
    const served = live.slice(0, pageSize);
    return { live: served, items: [], nextCursor: encodeUnpersistedCursor(scope, { after: served.at(-1)!.runId }) };
  }
  if (live.length === pageSize) return { live, items: [], nextCursor: encodeUnpersistedCursor(scope, { persisted: true }) };
  return { live, ...await persisted(pageSize - live.length, undefined) };
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
): Promise<{ legacy: Record<string, unknown>; run: PublicRun }> {
  const entry = options.registry.get(runId);
  if (entry) assertOwned(entry, sessionId, project);
  const isWorkflowId = WORKFLOW_ID.test(runId);
  const workflowDir = getSessionWorkflowDir(ctx);
  const historical = !entry && isWorkflowId ? await loadOwnedJournal(workflowDir, runId, project) : undefined;
  const refs = { outputRef: { runId, view: "output" }, diagnosticsRef: { runId, view: "diagnostics" } };

  if (entry?.kind === "workflow" || historical) {
    const observation = entry ? entry.observation as WorkflowToolDetails | undefined : undefined;
    const status = entry
      ? (entry.state === "running" ? "running" : entry.outcome?.status ?? "error")
      : (historical!.status === "running" ? "interrupted_or_uncertain" : historical!.status);
    const { finalAvailable } = workflowFinalState(entry, historical);
    const projection = projectWorkflowRun({
      runId,
      live: entry ? entry.state === "running" : false,
      name: entry ? observation?.name : historical!.name,
      source: entry ? observation?.source : historical!.source,
      status,
      outcome: entry ? (entry.outcome?.outcome ?? observation?.outcome) : historical!.outcome,
      error: entry ? entry.outcome?.error : historical!.error,
      agentCount: entry ? observation?.agentCount : historical!.children.length,
      resultAvailable: entry ? entry.outcome?.result !== undefined : historical!.result !== undefined,
      finalAvailable,
    });
    // Deliberately the SAME top-level key set as an agent projection
    // (runId/kind/live/task/state/timing/output plus refs) — no
    // `workflowRunId`, no unbounded `children` — so a batch caller consuming
    // a mixed live/durable/agent/workflow target set never has to branch on
    // which kind produced an entry (see the "same keyset across all four
    // kinds" contract test in test/run-contract.test.ts).
    const run = entry
      ? liveWorkflowRun(entry, { integrity: await settledJournalIntegrity(entry, workflowDir, project) }).run
      : journalWorkflowRun(historical!);
    return { legacy: { ...projection, ...refs }, run };
  }
  // A wf_... ID that failed to resolve (no live entry, no journal) is
  // definitely unknown — RUN_ID_PATTERN in run-inspection.ts only ever
  // matches run_... IDs, so letting this fall through to getRunRecord below
  // would misreport it as an invalid-format ID rather than "unknown".
  if (isWorkflowId) throw unavailable();

  if (entry) {
    const durable = entry.state === "running" ? undefined : await getRunRecord(runsDirectory, runId).catch(() => undefined);
    return { legacy: { ...projectLiveAgent(entry), ...refs }, run: liveAgentRun(entry, durable ? { integrity: durable.integrity } : {}).run };
  }
  const durable = await getRunRecord(runsDirectory, runId);
  assertOwnedRecord(durable, sessionId, project);
  return { legacy: { ...projectDurableAgent(durable), ...refs }, run: durableAgentRun(durable) };
}

/** A settled live workflow's journal integrity; running work is incomplete and an unreadable journal is unknown. */
async function settledJournalIntegrity(entry: RegisteredRunEntry, workflowDir: string | undefined, project: string): Promise<EvidenceIntegrity | undefined> {
  if (entry.state === "running") return undefined;
  try {
    return (await loadOwnedJournal(workflowDir, entry.runId, project))?.integrity ?? "unknown";
  } catch {
    return "unknown";
  }
}

/** Loads a session journal, reporting another project's journal (even an unreadable one) exactly like an unknown run. */
async function loadOwnedJournal(dir: string | undefined, runId: string, project: string): Promise<LoadedWorkflowJournal | undefined> {
  if (!dir) return undefined;
  let journal: LoadedWorkflowJournal | undefined;
  try {
    journal = await loadWorkflowJournal(dir, runId);
  } catch (error) {
    if (error instanceof WorkflowJournalReadError && error.project !== undefined && error.project !== project) throw unavailable();
    throw error;
  }
  if (journal && journal.project !== project) throw unavailable();
  return journal;
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
  const invalidBatch = () => cursorInvalid(
    `Invalid inspect batch cursor; pass nextCursor with the identical runIds array, or restart with ${JSON.stringify(EXTERNAL_RUNS_EXAMPLES.inspectBatch)}.`,
  );
  if (typeof value !== "string" || !value || value.length > 8192) throw invalidBatch();
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    throw invalidBatch();
  }
  if (
    !parsed ||
    parsed.v !== 1 ||
    parsed.kind !== "batch-inspect" ||
    typeof parsed.scope !== "string" ||
    !Array.isArray(parsed.runIds) ||
    !Number.isSafeInteger(parsed.nextIndex)
  ) {
    throw invalidBatch();
  }
  if (parsed.scope !== scope) {
    throw cursorInvalid(
      `Cursor belongs to a different session or project for inspect; restart with ${JSON.stringify(EXTERNAL_RUNS_EXAMPLES.inspectBatch)}.`,
    );
  }
  if (JSON.stringify(parsed.runIds) !== JSON.stringify(runIds)) {
    throw cursorInvalid(
      `Batch cursor does not match the requested run IDs for inspect; repeat the identical runIds array to continue paging, or restart with ${JSON.stringify(EXTERNAL_RUNS_EXAMPLES.inspectBatch)}.`,
    );
  }
  const nextIndex = parsed.nextIndex as number;
  if (nextIndex < 0 || nextIndex > runIds.length) throw invalidBatch();
  return nextIndex;
}

function cursorInvalid(message = "Invalid cursor"): ExpectedFlowError {
  return new ExpectedFlowError("cursor_invalid", message);
}

function cursorStale(): ExpectedFlowError {
  return new ExpectedFlowError("cursor_stale", "Run changed while paging; restart inspection without a cursor");
}

function encodeProjectionCursor(runId: string, view: RunInspectionView, offset: number, text: string): string {
  return Buffer.from(JSON.stringify({ v: 1, kind: "projection-inspect", runId, view, offset, revision: projectionRevision(text) })).toString("base64url");
}

function decodeProjectionCursor(value: string, runId: string, view: RunInspectionView, text: string): number {
  const invalidInspect = () => cursorInvalid(
    `Invalid inspect cursor; pass page.nextCursor with the same runId and view, or restart with ${JSON.stringify({ action: "inspect", runIds: [runId], view })}.`,
  );
  if (typeof value !== "string" || !value || value.length > 4096) throw invalidInspect();
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    throw invalidInspect();
  }
  const keys = parsed && typeof parsed === "object" ? Object.keys(parsed).sort().join(",") : "";
  if (keys !== "kind,offset,revision,runId,v,view" || parsed.v !== 1 || parsed.kind !== "projection-inspect" || parsed.runId !== runId || parsed.view !== view || !Number.isSafeInteger(parsed.offset) || (parsed.offset as number) < 0 || typeof parsed.revision !== "string") throw invalidInspect();
  if (parsed.revision !== projectionRevision(text)) throw cursorStale();
  return parsed.offset as number;
}

/** One bounded page of a single projection text, under a revision-bound cursor. */
function projectionPage(runId: string, view: RunInspectionView, text: string, cursor: string | undefined, limitBytes: number | undefined): { text: string; nextCursor?: string } {
  const offset = cursor ? decodeProjectionCursor(cursor, runId, view, text) : 0;
  const page = utf8Page(text, offset, pageLimit(limitBytes));
  return { text: page.text, ...(page.nextOffset === undefined ? {} : { nextCursor: encodeProjectionCursor(runId, view, page.nextOffset, text) }) };
}

function pageLimit(limitBytes: number | undefined): number {
  return Math.max(4, Math.min(65536, limitBytes ?? 32768));
}

function isProjectionCursor(value: string | undefined): boolean {
  if (!value || value.length > 4096) return false;
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8"))?.kind === "projection-inspect";
  } catch {
    return false;
  }
}

/** Memory-sourced, so redacted in full here, before any page is measured or sliced. */
function liveAgentOutput(entry: RegisteredRunEntry): string | undefined {
  if (entry.outcome?.result !== undefined) return redactedText(typeof entry.outcome.result === "string" ? entry.outcome.result : JSON.stringify(entry.outcome.result));
  const messages = record(record(entry.observation)?.assistantOutput)?.messages;
  if (!Array.isArray(messages)) return undefined;
  const text = messages.flatMap((message) => typeof record(message)?.text === "string" ? [record(message)!.text as string] : []).join("\n");
  return text ? redactedText(text) : undefined;
}

function utf8Page(text: string, offset: number, limit: number): { text: string; nextOffset?: number } {
  if ((offset >= text.length && offset !== 0) || (offset > 0 && /[\uD800-\uDBFF]/.test(text[offset - 1]!) && /[\uDC00-\uDFFF]/.test(text[offset]!))) throw cursorStale();
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

const DEFAULT_WAIT_RESULT_BUDGET = 32_768;

/** Items already carry their stream separators, so a page's text is their plain concatenation. */
function pageItemsText(page: { items: Array<{ text: string }> }): string {
  return page.items.map((item) => item.text).join("");
}

/**
 * Wait's collection budget is a single pool shared across every settled
 * outcome in one response, spent in REQUESTED order (the caller's `runId`/
 * `runIds` order — see `collectOutcomes`, which sorts settled outcomes back
 * into that order before spending), never the order targets happened to
 * settle in: two calls with the same targets and the same final states
 * spend the budget the same way regardless of which one raced to settle
 * first. A result that fits in what remains is returned complete; one that
 * does not is truncated to exactly what remains, and `resultTruncated: true`
 * plus the existing `outputRef`/`diagnosticsRef` name where to continue.
 */
async function collectOutcome(outcome: RegisteredRunOutcome, runsDirectory: string, remainingBudget: number): Promise<{ entry: Record<string, unknown>; spent: number }> {
  const base = {
    runId: outcome.runId,
    kind: outcome.kind,
    status: outcome.status,
    outcome: outcome.outcome,
    ...(outcome.settledAt !== undefined ? { settledAt: outcome.settledAt } : {}),
    ...(outcome.error ? { error: clip(outcome.error) } : {}),
    outputRef: { runId: outcome.runId, view: "output" },
    diagnosticsRef: { runId: outcome.runId, view: "diagnostics" },
  };
  let full: string | undefined;
  if (outcome.result !== undefined) {
    // Already in memory — free to compute regardless of remaining budget;
    // only the slicing/spend below is budget-gated. Redacted before slicing.
    full = redactedText(typeof outcome.result === "string" ? outcome.result : JSON.stringify(outcome.result));
  } else if (outcome.kind === "agent" && remainingBudget > 0) {
    // A disk read is real I/O: never perform one once the shared budget is
    // already exhausted, since its result could not be used anyway.
    const page = await inspectRun({ runsDirectory, runId: outcome.runId, view: "output", limitBytes: Math.min(65536, remainingBudget) });
    full = pageItemsText(page) || undefined;
    // inspectRun's own page can itself be a bounded prefix of more output on
    // disk (nextCursor) even though `full` came back no longer than
    // remainingBudget — that must still count as truncated, or a caller
    // would wrongly read `resultTruncated: false` as "this is everything".
    if (page.nextCursor !== undefined) {
      return { entry: { ...base, result: full ?? "", resultTruncated: true }, spent: full ? Buffer.byteLength(full) : 0 };
    }
  }
  if (full === undefined) {
    // An agent outcome with no in-memory result and no budget left to read
    // its evidence from disk is flagged truncated (not silently empty) so
    // the caller follows outputRef instead of assuming there is nothing.
    const skippedRead = outcome.kind === "agent" && outcome.result === undefined && remainingBudget <= 0;
    return { entry: skippedRead ? { ...base, resultTruncated: true } : base, spent: 0 };
  }
  if (remainingBudget <= 0) return { entry: { ...base, resultTruncated: true }, spent: 0 };
  const page = utf8Page(full, 0, remainingBudget);
  return { entry: { ...base, result: page.text, resultTruncated: page.nextOffset !== undefined }, spent: Buffer.byteLength(page.text) };
}

function waitBudget(limitBytes: number | undefined): number {
  return Math.max(4, Math.min(65536, limitBytes ?? DEFAULT_WAIT_RESULT_BUDGET));
}

/** Spends one shared byte budget across every settled outcome, in the caller's requested order (see `collectOutcome`). */
async function collectOutcomes(outcomes: RegisteredRunOutcome[], runsDirectory: string, limitBytes: number | undefined): Promise<Record<string, unknown>[]> {
  let remaining = waitBudget(limitBytes);
  const projected: Record<string, unknown>[] = [];
  for (const outcome of outcomes) {
    const { entry, spent } = await collectOutcome(outcome, runsDirectory, remaining);
    projected.push(entry);
    remaining -= spent;
  }
  return projected;
}

/**
 * A live, bounded snapshot of one wait target for `onUpdate` progress and the
 * final response's `targets` field alike — the same shape whether the target
 * has already settled or is still being observed, so a coordinating model
 * (or a renderer) never has to branch on which.
 */
function waitTargetSnapshot(target: { runId: string; kind: "agent" | "workflow"; terminal?: RegisteredRunOutcome }, registry: RunRegistry): Record<string, unknown> {
  if (target.terminal) {
    return { runId: target.runId, kind: target.kind, status: target.terminal.status, outcome: target.terminal.outcome };
  }
  const entry = registry.get(target.runId);
  const observation = record(entry?.observation);
  if (target.kind === "workflow") {
    const workflow = observation as unknown as { name?: unknown; agentCount?: unknown } | undefined;
    return compact({
      runId: target.runId,
      kind: "workflow",
      status: "running",
      description: typeof workflow?.name === "string" ? clip(workflow.name) : undefined,
      agentCount: typeof workflow?.agentCount === "number" ? workflow.agentCount : undefined,
    });
  }
  return compact({
    runId: target.runId,
    kind: "agent",
    status: typeof observation?.status === "string" ? observation.status : "running",
    description: clip(typeof observation?.description === "string" ? observation.description : undefined),
    lastActivityAt: typeof observation?.lastActivityAt === "number" ? observation.lastActivityAt : undefined,
    activity: Array.isArray(observation?.activity) ? observation.activity.slice(-1) : undefined,
  });
}

const MAX_RENDERED_ROWS = 8;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function textFromToolResult(toolResult: { content: Array<{ type: string; text?: string }> }): string {
  return toolResult.content.flatMap((item) => item.type === "text" && typeof item.text === "string" ? [item.text] : []).join("\n");
}

/**
 * `external_runs`'s own call/result renderer — this tool previously had none
 * (see docs/archive/plans/2026-09-21-unified-run-experience-design.md), so a host
 * that globally restyles unrendered tool output (e.g. installed ccstyle)
 * had nothing to preserve. Registering these hooks is necessary but not
 * sufficient by itself: a host with such an override must also be told to
 * keep hands off this tool (see README's host-integration section on
 * `excludeRenderers`).
 */
function renderExternalRunsCall(args: Record<string, unknown>, theme: Theme): Text {
  const action = typeof args.action === "string" ? args.action : "list";
  let detail: string;
  if (action === "wait") {
    const ids = Array.isArray(args.runIds) ? args.runIds : args.runId ? [args.runId] : [];
    detail = `waiting for ${ids.length} task(s) · mode ${typeof args.mode === "string" ? args.mode : "all"}`;
  } else if (action === "cancel") {
    const target = Array.isArray(args.runIds) && args.runIds.length ? args.runIds[0] : String(args.runId ?? "");
    detail = `cancel ${target}`;
  } else if (action === "inspect") {
    const target = Array.isArray(args.runIds)
      ? args.runIds.length === 1 ? args.runIds[0] : `${args.runIds.length} run(s) (batch)`
      : String(args.runId ?? "");
    detail = `inspect ${target} · ${typeof args.view === "string" ? args.view : "summary"}`;
  } else {
    detail = `list${typeof args.workflowRunId === "string" && args.workflowRunId.trim() !== "" ? ` · workflow ${args.workflowRunId.trim()}` : ""}`;
  }
  return new Text(`${theme.bold("External Runs")} ${theme.fg("dim", detail)}`, 0, 0);
}

function renderWaitResult(details: Record<string, unknown>, theme: Theme, expanded: boolean): Container {
  const container = new Container();
  const targets = Array.isArray(details.targets) ? details.targets.filter(isRecord) : [];
  const outcomes = Array.isArray(details.outcomes) ? details.outcomes.filter(isRecord) : [];
  const pending = Array.isArray(details.pending) ? details.pending : [];
  const live = details.live === true;
  const totalTargets = targets.length || outcomes.length + pending.length;
  const header = live
    ? `Waiting for ${pending.length} of ${totalTargets} task(s) · ${outcomes.length} complete`
    : `Wait complete · ${outcomes.length} settled${pending.length ? ` · ${pending.length} still pending` : ""}`;
  container.addChild(new Text(theme.bold(header), 0, 0));
  const rows = targets.length ? targets : outcomes;
  const shown = rows.slice(0, MAX_RENDERED_ROWS);
  for (const row of shown) container.addChild(new Text(`  ${theme.fg("muted", formatWaitTargetRow(row))}`, 0, 0));
  if (rows.length > shown.length) container.addChild(new Text(`  ${theme.fg("muted", `... ${rows.length - shown.length} more`)}`, 0, 0));
  if (expanded && !live) {
    for (const outcome of outcomes) {
      if (typeof outcome.result !== "string" || !outcome.result) continue;
      container.addChild(new Text(`  ${theme.bold(`Output · ${String(outcome.runId)}`)}`, 0, 0));
      container.addChild(renderOutputText(outcome.result, 2));
      if (outcome.resultTruncated) {
        container.addChild(new Text(`  ${theme.fg("dim", `Truncated · external_runs inspect ${String(outcome.runId)} for full output`)}`, 0, 0));
      }
    }
  }
  return container;
}

function renderListResult(details: Record<string, unknown>, theme: Theme, expanded: boolean): Container {
  const container = new Container();
  const workflows = Array.isArray(details.workflows) ? details.workflows.filter(isRecord) : [];
  const runs = Array.isArray(details.runs) ? details.runs.filter(isRecord) : [];
  container.addChild(new Text(theme.bold(`External runs · ${workflows.length} workflow(s) · ${runs.length} run(s)`), 0, 0));
  const rows = [...workflows.map((item) => formatRunRow("Workflow", item)), ...runs.map((item) => formatRunRow("Run", item))];
  const shown = expanded ? rows : rows.slice(0, MAX_RENDERED_ROWS);
  for (const row of shown) container.addChild(new Text(`  ${theme.fg("muted", row)}`, 0, 0));
  if (rows.length > shown.length) container.addChild(new Text(`  ${theme.fg("muted", `... ${rows.length - shown.length} more · /external runs`)}`, 0, 0));
  if (typeof details.nextCursor === "string" || typeof details.nextWorkflowCursor === "string") {
    container.addChild(new Text(`  ${theme.fg("dim", "More available · pass cursor/workflowCursor, or /external runs")}`, 0, 0));
  }
  return container;
}

function renderBatchInspectResult(details: Record<string, unknown>, theme: Theme): Container {
  const container = new Container();
  const entries = Array.isArray(details.entries) ? details.entries.filter(isRecord) : [];
  container.addChild(new Text(theme.bold(`Inspecting ${entries.length} run(s)`), 0, 0));
  for (const entry of entries) {
    container.addChild(new Text(`  ${theme.fg("muted", formatRunRow(entry.kind === "workflow" ? "Workflow" : "Run", entry))}`, 0, 0));
  }
  if (typeof details.nextCursor === "string") {
    container.addChild(new Text(`  ${theme.fg("dim", "More available · follow nextCursor")}`, 0, 0));
  }
  return container;
}

const PREVIEW_CHARS = 2_000;

function renderSingleInspectResult(details: Record<string, unknown>, theme: Theme, expanded: boolean): Container {
  const container = new Container();
  const runId = typeof details.runId === "string" ? details.runId : "run";
  const view = typeof details.view === "string" ? details.view : "summary";
  container.addChild(new Text(`${theme.bold(`Inspecting ${runId}`)} ${theme.fg("dim", view)}`, 0, 0));
  const items = Array.isArray(details.items) ? details.items.filter(isRecord) : undefined;
  const text = typeof details.text === "string"
    ? details.text
    : items?.map((item) => typeof item.text === "string" ? item.text : "").join("");
  if (text) {
    const preview = expanded || text.length <= PREVIEW_CHARS ? text : `${text.slice(0, PREVIEW_CHARS)}\n… ${text.length - PREVIEW_CHARS} more characters`;
    if (view === "output" || view === "final") {
      container.addChild(renderOutputText(preview, 2));
    } else {
      container.addChild(new Text(preview.split("\n").map((line) => `  ${line}`).join("\n"), 0, 0));
    }
  }
  if (view === "final" && details.finalAvailable === false) {
    container.addChild(new Text(`  ${theme.fg("muted", "No verified final answer is available yet.")}`, 0, 0));
  }
  if (typeof details.nextCursor === "string") {
    container.addChild(new Text(`  ${theme.fg("dim", "More available · follow nextCursor")}`, 0, 0));
  }
  return container;
}

function renderCancelResult(details: Record<string, unknown>, theme: Theme): Text {
  return new Text(`${theme.bold("External Runs")} ${theme.fg("muted", `${String(details.runId)} → ${String(details.status)}`)}`, 0, 0);
}

function renderExternalRunsResult(toolResult: { content: Array<{ type: string; text?: string }>; details: unknown }, theme: Theme, expanded: boolean) {
  const details = isRecord(toolResult.details) ? toolResult.details : {};
  if (Array.isArray(details.targets) || Array.isArray(details.outcomes)) return renderWaitResult(details, theme, expanded);
  if (Array.isArray(details.workflows) || Array.isArray(details.runs)) return renderListResult(details, theme, expanded);
  if (Array.isArray(details.entries)) return renderBatchInspectResult(details, theme);
  if (typeof details.view === "string") return renderSingleInspectResult(details, theme, expanded);
  if (typeof details.status === "string" && typeof details.runId === "string") return renderCancelResult(details, theme);
  return new Text(textFromToolResult(toolResult), 0, 0);
}

/**
 * Reconcile the `runId`/`runIds` selector pair for `inspect` only — the one
 * action that already hard-rejects supplying both (`wait` treats a stray
 * `runId` alongside `runIds` as a harmless one-element convenience, and
 * `cancel` never reads `runIds` at all, so neither gets a new conflict
 * check here). A schema-conversion layer downstream of this tool's
 * declaration may present both mutually exclusive optional selectors as
 * required (#62); a model forced to fill in the one it means to omit
 * typically sends a blank string or an empty array. Neither can name an
 * actual run, so treat that placeholder as omitted rather than a real
 * conflict — this is narrower than guessing between two genuinely
 * populated, disagreeing selectors, which still fails loudly exactly as
 * before (including when both name the very same run: inspect has always
 * rejected supplying the pair at all, on purpose).
 */
function normalizeInspectSelectors(params: ExternalRunsParams): ExternalRunsParams {
  const runId = params.runId === undefined || params.runId.trim() === "" ? undefined : params.runId;
  const runIds = runId !== undefined && (params.runIds === undefined || params.runIds.length === 0)
    ? undefined
    : params.runIds;
  if (runId !== undefined && runIds !== undefined && runIds.length > 0) {
    throw invalid(
      `inspect accepts either runId or runIds, not both; e.g. ${JSON.stringify(EXTERNAL_RUNS_EXAMPLES.inspectSingle)}.`,
    );
  }
  if (runId === params.runId && runIds === params.runIds) return params;
  return { ...params, runId, runIds };
}

// Commands and tools share this executor; it needs no tool-only host capabilities.
type ExternalRunsTool = Omit<ToolDefinition<typeof externalRunsParameters, ExternalRunsDetails>, "execute"> & {
  execute: (
    toolCallId: string, params: ExternalRunsParams, signal: AbortSignal | undefined,
    onUpdate: Parameters<ToolDefinition<typeof externalRunsParameters, ExternalRunsDetails>["execute"]>[3],
    ctx: ExtensionContext,
  ) => ReturnType<ToolDefinition<typeof externalRunsParameters, ExternalRunsDetails>["execute"]>;
};

export function createExternalRunsTool(
  options: CreateExternalRunsToolOptions,
): ExternalRunsTool {
  return {
    name: "external_runs",
    label: "External Runs",
    description: "List, inspect (single or batched summaries), wait for, or cancel session-owned external runs.",
    promptSnippet: EXTERNAL_RUNS_PROMPT_SNIPPET,
    parameters: externalRunsParameters,
    outputSchema: externalRunsOutputSchema,
    async execute(_toolCallId, params: ExternalRunsParams, signal, onUpdate, ctx: ExtensionContext) {
      const action = (params.action && (EXTERNAL_RUNS_ACTIONS as readonly string[]).includes(params.action)) ? params.action : "list";
      return await withContract({ tool: "external_runs", action, failureData: null }, async () => {
      if (params.action === "inspect") {
        if (
          params.limitBytes !== undefined &&
          (typeof params.limitBytes !== "number" || !Number.isSafeInteger(params.limitBytes) || params.limitBytes < 4 || params.limitBytes > 65536)
        ) {
          throw invalid(
            `Invalid limitBytes for inspect (must be an integer from 4 to 65536); e.g. ${JSON.stringify(EXTERNAL_RUNS_EXAMPLES.inspectSingle)}.`,
          );
        }
        params = normalizeInspectSelectors(params);
        if (params.runId === undefined && params.runIds !== undefined && params.runIds.length === 1 && params.view !== undefined && params.view !== "summary") {
          params = { ...params, runId: params.runIds[0], runIds: undefined };
        }
      }
      const { sessionId, project } = scope(ctx);
      const runsDirectory = options.runsDirectory();

      if (params.action === "list") {
        if (
          params.limit !== undefined &&
          (typeof params.limit !== "number" || !Number.isSafeInteger(params.limit) || params.limit < 1 || params.limit > 100)
        ) {
          throw invalid(
            `Invalid limit for list (must be an integer from 1 to 100); e.g. ${JSON.stringify(EXTERNAL_RUNS_EXAMPLES.list)}.`,
          );
        }
        if (
          params.workflowRunId !== undefined &&
          (typeof params.workflowRunId !== "string" || (params.workflowRunId.trim() !== "" && !WORKFLOW_ID.test(params.workflowRunId.trim())))
        ) {
          throw invalid(
            `Invalid workflow run ID for list; pass a wf_... ID (${JSON.stringify(EXTERNAL_RUNS_EXAMPLES.listWorkflowChildren)}) or omit workflowRunId (${JSON.stringify(EXTERNAL_RUNS_EXAMPLES.list)}).`,
          );
        }
        const workflowRunId = typeof params.workflowRunId === "string" && params.workflowRunId.trim() !== ""
          ? params.workflowRunId.trim()
          : undefined;
        if (
          workflowRunId !== undefined &&
          params.workflowCursor !== undefined &&
          (typeof params.workflowCursor !== "string" || params.workflowCursor.trim() !== "")
        ) {
          throw invalid(
            `workflowCursor is inapplicable when filtering list by workflowRunId; page child runs with cursor (${JSON.stringify(EXTERNAL_RUNS_EXAMPLES.listRunsNextPage)}) or omit workflowRunId to page workflow roots (${JSON.stringify(EXTERNAL_RUNS_EXAMPLES.listWorkflowsNextPage)}).`,
          );
        }
        if (
          workflowRunId === undefined &&
          params.workflowCursor !== undefined &&
          typeof params.workflowCursor !== "string"
        ) {
          throw cursorInvalid(
            `Invalid workflow list cursor for list; pass nextWorkflowCursor (${JSON.stringify(EXTERNAL_RUNS_EXAMPLES.listWorkflowsNextPage)}), or restart with ${JSON.stringify(EXTERNAL_RUNS_EXAMPLES.list)}.`,
          );
        }
        if (
          params.cursor !== undefined &&
          typeof params.cursor !== "string"
        ) {
          throw cursorInvalid(
            `Invalid cursor for list; pass nextCursor (${JSON.stringify(EXTERNAL_RUNS_EXAMPLES.listRunsNextPage)}) or nextWorkflowCursor (${JSON.stringify(EXTERNAL_RUNS_EXAMPLES.listWorkflowsNextPage)}), or restart with ${JSON.stringify(EXTERNAL_RUNS_EXAMPLES.list)}.`,
          );
        }
        const workflowCursor = typeof params.workflowCursor === "string" ? params.workflowCursor.trim() || undefined : undefined;
        const cursor = typeof params.cursor === "string" ? params.cursor.trim() || undefined : undefined;
        const workflowDir = getSessionWorkflowDir(ctx);
        // Live state overlays its persisted row on whichever page that row
        // falls, so a live run is never shown as interrupted or listed twice.
        // Live runs with no persisted row yet are paged first, inside the same
        // limit, before the persisted rows begin.
        const registered = new Map(options.registry.list(sessionId, project).map((entry) => [entry.runId, entry]));
        const runScope = listScope("runs", sessionId, project, workflowRunId);
        const page = workflowCursor && !cursor
          ? { live: [], items: [] }
          : await pageUnpersistedFirst(runScope, cursor, Math.max(1, Math.min(100, Math.floor(params.limit ?? 50))),
            [...registered.values()].filter((entry) => entry.kind === "agent" && (workflowRunId === undefined || entry.workflowRunId === workflowRunId)),
            async (entry) => {
              const persisted = await getRunRecord(runsDirectory, entry.runId);
              return !persisted || persisted.parentSessionId !== sessionId || persisted.project !== project
                || (workflowRunId !== undefined && persisted.workflowRunId !== workflowRunId);
            },
            (limit, c) => listRunRecords({ runsDirectory, sessionId, project, workflowRunId, limit, cursor: c }));
        const historical = workflowRunId
          ? { live: [], items: [] }
          : await pageUnpersistedFirst(listScope("workflows", sessionId, project), workflowCursor, Math.max(1, Math.min(100, Math.floor(params.limit ?? 100))),
            [...registered.values()].filter((entry) => entry.kind === "workflow"),
            async (entry) => !workflowDir || !await hasWorkflowJournal(workflowDir, entry.runId, project),
            async (limit, c) => workflowDir ? listWorkflowJournals(workflowDir, project, limit, c) : { items: [] });
        const workflowRows: Array<{ legacy: Record<string, unknown>; run: PublicRun }> = [
          ...historical.live.map((entry) => ({ legacy: liveSummary(entry), run: liveWorkflowRun(entry).run })),
          ...historical.items.map((journal) => {
            const live = registered.get(journal.runId);
            if (live?.kind === "workflow") return { legacy: liveSummary(live), run: liveWorkflowRun(live, live.state === "running" ? {} : { integrity: journal.integrity }).run };
            return "unreadable" in journal
              ? { legacy: unreadableJournalSummary(journal), run: unreadableWorkflowRun(journal) }
              : { legacy: journalSummary(journal), run: journalWorkflowRun(journal) };
          }),
        ];
        const runRows = [
          ...page.live.map((entry) => ({ legacy: listedAgent(entry), run: liveAgentRun(entry).run })),
          ...page.items.map((item) => {
            const live = registered.get(item.runId);
            return live?.kind === "agent"
              ? { legacy: listedAgent(live), run: liveAgentRun(live, live.state === "running" ? {} : { integrity: item.integrity }).run }
              : { legacy: historicalAgent(item), run: durableAgentRun(item) };
          }),
        ];
        const cursors = { nextCursor: page.nextCursor, nextWorkflowCursor: historical.nextCursor };
        const list = { workflows: workflowRows.map((row) => row.legacy), runs: runRows.map((row) => row.legacy), ...cursors };
        return {
          ...result(JSON.stringify(list), list),
          data: { runs: runRows.map((row) => row.run), workflows: workflowRows.map((row) => row.run), ...compact(cursors) },
        };
      }

      if (params.action === "inspect" && params.runIds !== undefined) {
        // normalizeInspectSelectors already guarantees runId is unset here.
        if (params.view !== undefined && params.view !== "summary") {
          throw invalid(
            `Batch inspect (runIds) only supports view: "summary"; use ${JSON.stringify(EXTERNAL_RUNS_EXAMPLES.inspectBatch)} for batch summary or ${JSON.stringify(EXTERNAL_RUNS_EXAMPLES.inspectSingle)} for a single run.`,
          );
        }
        const runIds = [...new Set(params.runIds)];
        if (runIds.length === 0 || runIds.length > MAX_BATCH_INSPECT_TARGETS) {
          throw invalid(
            `inspect runIds requires 1-${MAX_BATCH_INSPECT_TARGETS} run IDs; e.g. ${JSON.stringify(EXTERNAL_RUNS_EXAMPLES.inspectSingle)} or ${JSON.stringify(EXTERNAL_RUNS_EXAMPLES.inspectBatch)}.`,
          );
        }
        for (const runId of runIds) assertRunId(runId, "inspect");
        if (params.cursor !== undefined && typeof params.cursor !== "string") {
          throw cursorInvalid(
            `Invalid batch cursor; pass nextCursor verbatim with the identical runIds array, or restart with ${JSON.stringify(EXTERNAL_RUNS_EXAMPLES.inspectBatch)}.`,
          );
        }
        const cursor = typeof params.cursor === "string" ? params.cursor.trim() || undefined : undefined;
        const scope = batchCursorScope(sessionId, project);
        const startIndex = cursor ? decodeBatchCursor(cursor, scope, runIds) : 0;
        // Resolve (and thereby validate ownership of) every requested target
        // before returning any page — an invalid or cross-session/project
        // target anywhere in the set fails the whole request, not just the
        // page that would eventually reach it.
        const entries = await Promise.all(
          runIds.map((runId) => resolveRunSummaryEntry(runId, options, ctx, sessionId, project, runsDirectory)),
        );
        const limit = pageLimit(params.limitBytes);
        // Size BOTH full candidate responses — the legacy `{entries,
        // nextCursor}` text and the complete structured envelope — so the
        // human and machine channels always carry the same entries and one
        // cursor, each within the caller's byte budget.
        let index = startIndex;
        for (; index < entries.length; index++) {
          const candidate = entries.slice(startIndex, index + 1);
          const candidateCursor = index + 1 < entries.length ? encodeBatchCursor(scope, runIds, index + 1) : undefined;
          const legacyText = JSON.stringify({ entries: candidate.map((entry) => entry.legacy), ...(candidateCursor ? { nextCursor: candidateCursor } : {}) });
          const structuredText = JSON.stringify(envelope({ tool: "external_runs", action: "inspect", data: { mode: "batch", entries: candidate.map((entry) => entry.run), ...(candidateCursor ? { nextCursor: candidateCursor } : {}) } }));
          if (Buffer.byteLength(legacyText) > limit || Buffer.byteLength(structuredText) > limit) {
            // Never drop a target, overflow the budget, or return a page that
            // cannot advance: name the run and how to proceed.
            if (index === startIndex) {
              throw new ExpectedFlowError("page_too_small",
                `Batch summary for ${runIds[index]} does not fit within limitBytes (${limit}) including the pagination envelope; increase limitBytes or inspect paged output: ${JSON.stringify({ action: "inspect", runIds: [runIds[index]], view: "output" })}`,
              );
            }
            break;
          }
        }
        const served = entries.slice(startIndex, index);
        for (const entry of served) if (!entry.run.live) options.registry.markCollected(entry.run.runId);
        const nextCursor = index < entries.length ? encodeBatchCursor(scope, runIds, index) : undefined;
        const payload = { entries: served.map((entry) => entry.legacy), ...(nextCursor ? { nextCursor } : {}) };
        return { ...result(JSON.stringify(payload), payload), data: { mode: "batch", entries: served.map((entry) => entry.run), ...(nextCursor ? { nextCursor } : {}) } };
      }

      if (params.action === "inspect") {
        if (params.view !== undefined && !SINGLE_INSPECT_VIEWS.includes(params.view as any)) {
          throw invalid(
            `Invalid view ${JSON.stringify(params.view)} for inspect; choose ${SINGLE_INSPECT_VIEWS.join(", ")}, e.g. ${JSON.stringify(EXTERNAL_RUNS_EXAMPLES.inspectSingle)}.`,
          );
        }
        assertRunId(params.runId, "inspect");
        const runId = params.runId;
        const view = params.view ?? "summary";
        if (params.cursor !== undefined && typeof params.cursor !== "string") {
          throw cursorInvalid(
            `Invalid inspect cursor; pass page.nextCursor with the same runId and view, or restart with ${JSON.stringify({ action: "inspect", runIds: [runId], view })}.`,
          );
        }
        const cursor = typeof params.cursor === "string" ? params.cursor.trim() || undefined : undefined;
        const entry = options.registry.get(runId);
        if (entry) assertOwned(entry, sessionId, project);
        const single = (text: string, encoding: "json" | "text", details: Record<string, unknown>, extra: { finalAvailable?: boolean; outputStatus?: string } = {}, contentText = text) => {
          if (!entry || entry.state === "terminal") options.registry.markCollected(runId);
          return {
            ...result(contentText, details),
            data: { mode: "single", runId, view, page: { text, encoding, complete: typeof details.nextCursor !== "string", ...(typeof details.nextCursor === "string" ? { nextCursor: details.nextCursor } : {}) }, ...compact(extra) },
          };
        };
        const isWorkflowId = WORKFLOW_ID.test(runId);
        const workflowDir = getSessionWorkflowDir(ctx);
        const historical = !entry && isWorkflowId ? await loadOwnedJournal(workflowDir, runId, project) : undefined;
        if (entry?.kind === "workflow" || historical) {
          // Workflow views are built from memory or an unredacted journal, so
          // each source is redacted in full before it is serialized and paged.
          const { result: workflowResult, finalAvailable } = workflowFinalState(entry, historical);
          if (view === "final") {
            // Its own branch (not left to fall through into the diagnostics-
            // shaped {status, error} response below): a legitimately settled
            // `null`/object result reads as available:true and is returned
            // as JSON exactly like every other view. An unavailable final
            // answer is a bounded EMPTY page with finalAvailable:false —
            // never a synthesized explanation in the page text. Turning
            // finalAvailable:false into a human-readable message is the UI
            // layer's job (src/external-command.ts's showPages), not this tool's.
            if (!finalAvailable) {
              const status = entry ? (entry.state === "running" ? "running" : entry.outcome?.status) : historical!.status;
              const page = projectionPage(runId, view, "", cursor, params.limitBytes);
              return single(page.text, "json", { runId, view, text: page.text, finalAvailable: false, status: status ?? "running", nextCursor: page.nextCursor }, { finalAvailable: false });
            }
            const text = JSON.stringify(redactSecrets({ runId, result: workflowResult, finalAvailable: true }));
            const page = projectionPage(runId, view, text, cursor, params.limitBytes);
            return single(page.text, "json", { runId, view, text: page.text, finalAvailable: true, nextCursor: page.nextCursor }, { finalAvailable: true });
          }
          const source = view === "launch"
            ? { runId, launch: (entry?.observation as WorkflowToolDetails | undefined)?.launch ?? historical?.launch ?? "Not recorded" }
            : view === "summary"
            ? entry ? liveSummary(entry, true) : journalSummary(historical!, true)
            : view === "output"
              // Ternary, not ??: entry and historical are mutually exclusive, but a
              // `??` chain would treat an intentional `null` workflowResult from
              // entry.outcome.result as absent and incorrectly fall through.
              ? { runId, result: entry ? entry.outcome?.result : historical?.result }
              : { runId, status: entry?.outcome?.status ?? historical?.status ?? "running", error: entry?.outcome?.error ?? historical?.error };
          const text = JSON.stringify(redactSecrets(source));
          const page = projectionPage(runId, view, text, cursor, params.limitBytes);
          return single(page.text, "json", { runId, view, text: page.text, nextCursor: page.nextCursor });
        }
        // A wf_... ID that resolved to neither a live nor a historical
        // workflow is definitely unknown, not an agent: run-inspection.ts's
        // own RUN_ID_PATTERN only matches run_... IDs, so falling through to
        // getRunRecord below would misreport it as an invalid-format ID.
        if (isWorkflowId) throw unavailable();
        const durable = await getRunRecord(runsDirectory, runId);
        if (!entry) assertOwnedRecord(durable, sessionId, project);
        if (view === "summary") {
          const source = entry ? redactSecrets(projectLiveAgent(entry)) : historicalAgent(durable!);
          const page = projectionPage(runId, view, JSON.stringify(source), cursor, params.limitBytes);
          return single(page.text, "json", { runId, view, text: page.text, nextCursor: page.nextCursor });
        }
        // A settled successful result in the registry is the verified final
        // answer, so a final reference stays followable even when evidence
        // was never persisted.
        if (view === "final" && entry?.kind === "agent" && entry.outcome?.status === "done" && entry.outcome.result !== undefined && (!cursor || isProjectionCursor(cursor))) {
          const page = projectionPage(runId, view, liveAgentOutput(entry) ?? "", cursor, params.limitBytes);
          return single(page.text, "text", { runId, view, text: page.text, finalAvailable: true, outputStatus: "final", nextCursor: page.nextCursor }, { finalAvailable: true, outputStatus: "final" });
        }
        if (view === "output" && entry?.kind === "agent" && (!cursor || isProjectionCursor(cursor))) {
          const text = liveAgentOutput(entry);
          if (text !== undefined) {
            const page = projectionPage(runId, view, text, cursor, params.limitBytes);
            const outputStatus = entry.state === "running" ? "preliminary" : entry.outcome?.outcome === "succeeded" ? "final" : "interrupted";
            return single(page.text, "text", { runId, view, text: page.text, outputStatus, nextCursor: page.nextCursor }, { outputStatus });
          }
        }
        let page: Awaited<ReturnType<typeof inspectRun>>;
        try {
          page = await inspectRun({ runsDirectory, runId, view, limitBytes: params.limitBytes, cursor, live: entry?.state === "running" });
        } catch (error) {
          if (error instanceof ExpectedFlowError && error.code === "cursor_invalid") {
            throw cursorInvalid(
              `${error.message} for inspect; pass nextCursor with matching runId and view, or restart with ${JSON.stringify({ action: "inspect", runIds: [runId], view })}.`,
            );
          }
          throw error;
        }
        const text = pageItemsText(page);
        // view: "final" stays a clean, narration-free canonical-answer
        // surface — a bounded empty page (finalAvailable:false) when
        // unavailable, matching the workflow branch above. output/diagnostics
        // keep a human fallback sentence in `content` only; the page text
        // stays empty.
        const contentText = view === "final" ? text : (text || `No ${view} is available for ${runId}.`);
        return single(text, view === "launch" ? "json" : "text", { ...page }, { finalAvailable: page.finalAvailable, outputStatus: page.outputStatus }, contentText);
      }

      if (params.action === "cancel") {
        if (params.reason !== undefined && (typeof params.reason !== "string" || params.reason.length > 512)) {
          throw invalid(
            `Invalid reason for cancel (must be a string up to 512 characters); e.g. ${JSON.stringify(EXTERNAL_RUNS_EXAMPLES.cancelWithReason)}.`,
          );
        }
        const rawRunIds = params.runIds;
        if (rawRunIds?.length && params.runId?.trim()) {
          throw invalid(
            `cancel accepts either runId or runIds, not both; e.g. ${JSON.stringify(EXTERNAL_RUNS_EXAMPLES.cancel)}.`,
          );
        }
        if (rawRunIds && rawRunIds.length > 1) {
          throw invalid(
            `cancel targets one run at a time; e.g. ${JSON.stringify(EXTERNAL_RUNS_EXAMPLES.cancel)}.`,
          );
        }
        const targetRunId = (rawRunIds && rawRunIds.length === 1 ? rawRunIds[0] : undefined)
          ?? (typeof params.runId === "string" && params.runId.trim() !== "" ? params.runId.trim() : undefined);
        assertRunId(targetRunId, "cancel");
        const cancelled = (status: "requested" | "terminal") => ({
          ...result(status === "requested" ? `Cancellation requested for ${targetRunId}.` : `${targetRunId} is already terminal.`, { runId: targetRunId, status }),
          data: { runId: targetRunId, status },
        });
        const entry = options.registry.get(targetRunId);
        if (entry) {
          assertOwned(entry, sessionId, project);
          const reason = params.reason?.trim() ? params.reason.trim() : "cancelled by external_runs";
          const status = options.registry.cancel(targetRunId, reason);
          // "unknown" means the entry left the registry between get and cancel.
          if (status === "unknown") throw unavailable();
          return cancelled(status);
        }
        const isWorkflowId = WORKFLOW_ID.test(targetRunId);
        const historicalWorkflow = isWorkflowId ? await loadOwnedJournal(getSessionWorkflowDir(ctx), targetRunId, project) : undefined;
        if (historicalWorkflow) {
          if (historicalWorkflow.status !== "running") return cancelled("terminal");
          throw notLive("Run is no longer live in this session; cancellation cannot be confirmed");
        }
        // An unresolved wf_... ID is unknown, not an unowned agent record.
        if (isWorkflowId) throw unavailable();
        const durable = await getRunRecord(runsDirectory, targetRunId);
        assertOwnedRecord(durable, sessionId, project);
        if (terminalRecord(durable)) return cancelled("terminal");
        throw notLive("Run is no longer live in this session; cancellation cannot be confirmed");
      }

      if (params.action === "wait") {
        if (
          params.limitBytes !== undefined &&
          (typeof params.limitBytes !== "number" || !Number.isSafeInteger(params.limitBytes) || params.limitBytes < 4 || params.limitBytes > 65536)
        ) {
          throw invalid(
            `Invalid limitBytes for wait (must be an integer from 4 to 65536); e.g. ${JSON.stringify(EXTERNAL_RUNS_EXAMPLES.wait)}.`,
          );
        }
        if (params.mode !== undefined && !WAIT_MODES.includes(params.mode as any)) {
          throw invalid(
            `Invalid mode ${JSON.stringify(params.mode)} for wait; choose ${WAIT_MODES.join(" or ")}, e.g. ${JSON.stringify(EXTERNAL_RUNS_EXAMPLES.wait)}.`,
          );
        }
        const rawRunIds = params.runIds;
        if (rawRunIds?.length && params.runId?.trim()) {
          throw invalid(
            `wait accepts either runId or runIds, not both; e.g. ${JSON.stringify(EXTERNAL_RUNS_EXAMPLES.wait)}.`,
          );
        }
        const rawWaitRunIds = (rawRunIds && rawRunIds.length > 0)
          ? rawRunIds
          : (params.runId?.trim() ? [params.runId.trim()] : []);
        const runIds = [...new Set(rawWaitRunIds)];
        if (runIds.length === 0 || runIds.length > MAX_WAIT_TARGETS) {
          throw invalid(
            `wait requires 1-${MAX_WAIT_TARGETS} run IDs; e.g. ${JSON.stringify(EXTERNAL_RUNS_EXAMPLES.wait)}.`,
          );
        }
        for (const runId of runIds) assertRunId(runId, "wait");
      const known: WaitTarget[] = await Promise.all(runIds.map(async (runId): Promise<WaitTarget> => {
        const entry = options.registry.get(runId);
        if (entry) {
          assertOwned(entry, sessionId, project);
          return { runId, kind: entry.kind, terminal: entry.outcome, entry };
        }
        const isWorkflowId = WORKFLOW_ID.test(runId);
        const historicalWorkflow = isWorkflowId ? await loadOwnedJournal(getSessionWorkflowDir(ctx), runId, project) : undefined;
        if (historicalWorkflow) {
          if (historicalWorkflow.status === "running") throw notLive(`Run ${runId} is unavailable for live waiting`);
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
            durable: journalWorkflowRun(historicalWorkflow),
          };
        }
        // An unresolved wf_... ID is unknown, not an unowned agent record.
        if (isWorkflowId) throw unavailable();
        const durable = await getRunRecord(runsDirectory, runId);
        assertOwnedRecord(durable, sessionId, project);
        const terminal = terminalRecord(durable);
        if (!terminal) throw notLive(`Run ${runId} is unavailable for live waiting`);
        return { runId, kind: "agent" as const, terminal, durable: durableAgentRun(durable) };
      }));

      const mode = params.mode ?? "all";
      const outcomes = known.flatMap((target) => target.terminal ? [target.terminal] : []);
      let pending = known.filter((target) => !target.terminal);
      const shouldReturn = () =>
        (mode === "any" && outcomes.length > 0)
        || pending.length === 0
        || outcomes.some((outcome) => outcome.status !== "done" && known.some((target) => target.kind === "workflow" && target.runId === outcome.runId));

      // Bounded live observation while waiting: a fixed-cadence heartbeat,
      // not a subscription per registry event, so a single long-running
      // target still produces intermediate updates instead of silence.
      // Cleared on every exit path (normal return, thrown abort) so it never
      // outlives this call, and it only ever reads the registry — it cannot
      // mutate run state, restart, or cancel anything being watched.
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      const emitWaitProgress = (live: boolean) => {
        if (!onUpdate) return;
        const targets = known.map((target) => waitTargetSnapshot(target, options.registry));
        const text = `Waiting for ${pending.length} of ${known.length} task(s); ${outcomes.length} complete.`;
        onUpdate(result(text, { action: "wait", mode, live, targets, outcomes, pending: pending.map((target) => target.runId) }));
      };
      try {
        if (onUpdate) {
          emitWaitProgress(true);
          heartbeat = setInterval(() => emitWaitProgress(true), SPINNER_INTERVAL_MS);
          heartbeat.unref?.();
        }
        while (!shouldReturn()) {
          const waited = await options.registry.wait(pending.map((target) => target.runId), "any", signal);
          for (const outcome of waited.terminal) if (!outcomes.some((item) => item.runId === outcome.runId)) outcomes.push(outcome);
          pending = pending.filter((target) => !outcomes.some((outcome) => outcome.runId === target.runId));
          emitWaitProgress(true);
        }
      } finally {
        if (heartbeat) clearInterval(heartbeat);
      }
      // `outcomes` accumulated in SETTLEMENT order (whichever target's
      // `registry.wait` resolved first), not the caller's requested order —
      // reorder back to `known`'s order (the deduplicated `runId`/`runIds`
      // request order) before spending the shared budget, so collection is
      // deterministic from the caller's perspective rather than a race.
      const outcomeByRunId = new Map(outcomes.map((outcome) => [outcome.runId, outcome] as const));
      const settled = known.flatMap((target) => {
        const outcome = outcomeByRunId.get(target.runId);
        if (outcome) options.registry.markCollected(target.runId);
        return outcome ? [{ target, outcome }] : [];
      });
      const projected = await collectOutcomes(settled.map(({ outcome }) => outcome), runsDirectory, params.limitBytes);
      const finalPending = pending.map((target) => target.runId);
      const warnings = new Set<string>();
      // A structured value is inline only when it is in memory, its legacy
      // text was delivered whole, and its encoded JSON fits both the inline
      // cap and what remains of the structured channel's own copy of
      // limitBytes, spent in the same request order. Otherwise it is
      // delivered by reference. No extra evidence read.
      let structuredRemaining = waitBudget(params.limitBytes);
      const completed = settled.map(({ target, outcome }, index) => {
        if (target.durable) return target.durable;
        const legacy = projected[index]!;
        const eligible = outcome.result !== undefined && legacy.result !== undefined && legacy.resultTruncated !== true;
        const inlineBudget = eligible ? Math.min(INLINE_RESULT_BYTES, structuredRemaining) : 0;
        const current = options.registry.get(target.runId) ?? { ...target.entry!, state: "terminal" as const, outcome };
        const built = current.kind === "workflow" ? liveWorkflowRun(current, { inlineBudget }) : liveAgentRun(current, { inlineBudget });
        if (built.run.output.delivery === "inline") structuredRemaining -= Buffer.byteLength(JSON.stringify(built.run.output.value), "utf8");
        if (built.redacted) warnings.add("output_redacted");
        return built.run;
      });
      return {
        ...result(JSON.stringify({ outcomes: projected, pending: finalPending }), {
          action: "wait",
          mode,
          live: false,
          targets: known.map((target) => waitTargetSnapshot(target, options.registry)),
          outcomes: projected,
          pending: finalPending,
        }),
        data: { mode, completed, pending: finalPending },
        warnings: [...warnings],
      };
      }

      throw invalid(
        params.action === undefined
          ? `Missing required action; choose list, inspect, wait, or cancel, e.g. ${JSON.stringify(EXTERNAL_RUNS_EXAMPLES.list)}.`
          : `Invalid action ${JSON.stringify(params.action)}; choose list, inspect, wait, or cancel, e.g. ${JSON.stringify(EXTERNAL_RUNS_EXAMPLES.list)}.`,
      );
      });
    },
    renderCall(args, theme) {
      return renderExternalRunsCall(args, theme);
    },
    renderResult(toolResult, { expanded }, theme) {
      return renderExternalRunsResult(toolResult, theme, expanded);
    },
  };
}
