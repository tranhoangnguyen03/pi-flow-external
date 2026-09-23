import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionContext, type Theme, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { getRunRecord, inspectRun, listRunRecords, type RunInspectionView, type RunRecordListItem } from "./core/run-inspection.ts";
import { RunRegistry, type RegisteredRunEntry, type RegisteredRunOutcome } from "./core/run-registry.ts";
import { projectDurableAgent, projectLiveAgent, projectWorkflowRun } from "./core/run-projection.ts";
import { formatRunRow, formatWaitTargetRow } from "./core/run-render.ts";
import { renderOutputText } from "./core/subagent-render.ts";
import { SPINNER_INTERVAL_MS } from "./core/spinner.ts";
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
    description: "Single target run ID (run_... agent, wf_... workflow). Required for cancel, for wait/inspect of a single run, and for inspect view output/diagnostics/final on one run. Cannot be combined with a non-empty runIds on inspect.",
  })),
  runIds: Type.Optional(Type.Array(Type.String(), {
    minItems: 1,
    maxItems: MAX_TARGETS,
    description: "The list target selector: wait targets any|all of up to 100, deduplicated, already-terminal targets return immediately. inspect batches summary-only entries for 1-20 targets, deduplicated, order preserved, including a single-entry list — for output/diagnostics/final view on one run, use runId instead. Cannot be combined with a non-empty runId on inspect.",
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
    description: "Max bytes per inspect page, including the summary view; follow nextCursor for the remainder. For wait, this is the total result budget shared across every settled outcome in the response (default 32768): a result that fits is returned complete, one that does not is truncated with resultTruncated:true and outputRef/diagnosticsRef for the rest.",
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
    return { ...projection, ...refs };
  }
  // A wf_... ID that failed to resolve (no live entry, no journal) is
  // definitely unknown — RUN_ID_PATTERN in run-inspection.ts only ever
  // matches run_... IDs, so letting this fall through to getRunRecord below
  // would misreport it as an invalid-format ID rather than "unknown".
  if (isWorkflowId) throw new Error("Run is unknown or unavailable in this session");

  if (entry) return { ...projectLiveAgent(entry), ...refs };
  const durable = await getRunRecord(runsDirectory, runId);
  assertOwnedRecord(durable, sessionId, project);
  return { ...projectDurableAgent(durable), ...refs };
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

const DEFAULT_WAIT_RESULT_BUDGET = 32_768;

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
    // only the slicing/spend below is budget-gated.
    full = typeof outcome.result === "string" ? outcome.result : JSON.stringify(outcome.result);
  } else if (outcome.kind === "agent" && remainingBudget > 0) {
    // A disk read is real I/O: never perform one once the shared budget is
    // already exhausted, since its result could not be used anyway.
    const page = await inspectRun({ runsDirectory, runId: outcome.runId, view: "output", limitBytes: Math.min(65536, remainingBudget) });
    full = page.items.map((item) => item.text).join("") || undefined;
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

/** Spends one shared byte budget across every settled outcome, in the caller's requested order (see `collectOutcome`). */
async function collectOutcomes(outcomes: RegisteredRunOutcome[], runsDirectory: string, limitBytes: number | undefined): Promise<Record<string, unknown>[]> {
  let remaining = Math.max(4, Math.min(65536, limitBytes ?? DEFAULT_WAIT_RESULT_BUDGET));
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
 * (see docs/plans/2026-09-21-unified-run-experience-design.md), so a host
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
    detail = `cancel ${String(args.runId ?? "")}`;
  } else if (action === "inspect") {
    const target = Array.isArray(args.runIds) ? `${args.runIds.length} run(s) (batch)` : String(args.runId ?? "");
    detail = `inspect ${target} · ${typeof args.view === "string" ? args.view : "summary"}`;
  } else {
    detail = `list${typeof args.workflowRunId === "string" ? ` · workflow ${args.workflowRunId}` : ""}`;
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
    throw new Error("inspect accepts either runId or runIds, not both");
  }
  if (runId === params.runId && runIds === params.runIds) return params;
  return { ...params, runId, runIds };
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
    async execute(_toolCallId, params: ExternalRunsParams, signal, onUpdate, ctx) {
      if (params.action === "inspect") params = normalizeInspectSelectors(params);
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
        // normalizeInspectSelectors already guarantees runId is unset here.
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
          const source = entry ? projectLiveAgent(entry) : historicalAgent(durable!);
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
      const orderedOutcomes = known.flatMap((target) => {
        const outcome = outcomeByRunId.get(target.runId);
        return outcome ? [outcome] : [];
      });
      const projected = await collectOutcomes(orderedOutcomes, runsDirectory, params.limitBytes);
      const finalPending = pending.map((target) => target.runId);
      return result(JSON.stringify({ outcomes: projected, pending: finalPending }), {
        action: "wait",
        mode,
        live: false,
        targets: known.map((target) => waitTargetSnapshot(target, options.registry)),
        outcomes: projected,
        pending: finalPending,
      });
    },
    renderCall(args, theme) {
      return renderExternalRunsCall(args, theme);
    },
    renderResult(toolResult, { expanded }, theme) {
      return renderExternalRunsResult(toolResult, theme, expanded);
    },
  });
}
