import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { agyActivityFromEvent } from "./agy.ts";
import { claudeActivityFromEvent, extractClaudeFinalText } from "./claude.ts";
import { codexActivityFromEvent, extractCodexFinalText } from "./codex.ts";
import { extractTextContent } from "./progress.ts";

const CURSOR_VERSION = 1;
const DEFAULT_PAGE_BYTES = 32 * 1024;
const MAX_PAGE_BYTES = 64 * 1024;
const MAX_CURSOR_CHARS = 4096;
const MAX_LIST_SCAN = 200;
const RUN_ID_PATTERN = /^run_[A-Za-z0-9_-]{1,128}$/;

export type RunInspectionView = "output" | "diagnostics" | "summary" | "final";
export type RunRecordIntegrity = "complete" | "incomplete" | "damaged";
export type RunOutputStatus = "preliminary" | "final" | "interrupted";

export interface RunInspectionItem { id?: string; text: string }

export interface RunInspectionPage {
  runId: string;
  view: RunInspectionView;
  items: RunInspectionItem[];
  outputStatus: RunOutputStatus;
  /** Whether a separate verified final answer (view: "final") is available for this run. */
  finalAvailable: boolean;
  integrity: RunRecordIntegrity;
  truncatedTail: boolean;
  nextCursor?: string;
}

/**
 * Raw timestamp inputs for {@link deriveRunTiming}. Accepts either an ISO
 * string (durable evidence) or an epoch-ms number (live `SubagentProgressNode`
 * fields) so both `run-inspection.ts` and `external-runs.ts` can share one
 * derivation without a normalization step at every call site.
 */
export interface RunTimingInputs {
  queuedAt?: string | number;
  executionStartedAt?: string | number;
  processStartedAt?: string | number;
  firstActivityAt?: string | number;
  lastActivityAt?: string | number;
  finishedAt?: string | number;
}

export interface RunTiming {
  queuedAt?: string;
  executionStartedAt?: string;
  processStartedAt?: string;
  firstActivityAt?: string;
  lastActivityAt?: string;
  finishedAt?: string;
  queueDelayMs?: number;
  elapsedMs?: number;
  activityAgeMs?: number;
  processDurationMs?: number;
}

export interface RunRecordListItem {
  runId: string;
  queuedAt?: string;
  status?: string;
  outcome?: "succeeded" | "failed" | "cancelled" | "timed_out";
  settledAt?: number;
  error?: string;
  description?: string;
  backend?: string;
  /** Resolved profile/subagentType name, when persisted in run-record metadata. Never reparsed from other fields. */
  profile?: string;
  /** Resolved harness (registered pi-* config, or equal to backend for agy/claude/codex), when persisted in run-record metadata. */
  harness?: string;
  project?: string;
  parentSessionId?: string;
  workflowRunId?: string;
  outputAvailable: boolean;
  finalAvailable: boolean;
  timing: RunTiming;
  integrity: RunRecordIntegrity;
}

interface CursorBase { v: typeof CURSOR_VERSION; kind: "inspect"; runId: string; view: RunInspectionView }
type InspectionCursor = CursorBase & (
  | { source: "events"; position: number; textOffset: number }
  | { source: "terminal"; itemIndex: number; textOffset: number; revision: string }
  | { source: "summary"; itemIndex: 0; textOffset: number; revision: string }
);
interface ListCursor { v: typeof CURSOR_VERSION; kind: "list"; scope: string; after: string }
interface SummaryDocument { runId?: string; queuedAt?: string; startedAt?: string; finishedAt?: string; metadata?: unknown; summary?: unknown }
interface SummaryState { document?: SummaryDocument; integrity: RunRecordIntegrity }
interface EvidenceEvent { runId?: string; sequence?: number; timestamp?: string; type?: string; data?: unknown }
interface CompleteLine { start: number; end: number; text: string }
interface ScanResult { missing: boolean; stopped: boolean; truncatedTail: boolean; malformed: boolean; endPosition: number }
interface RunObservation {
  metadata?: Record<string, unknown>;
  queuedAt?: string;
  executionStartedAt?: string;
  processStartedAt?: string;
  firstActivityAt?: string;
  lastActivityAt?: string;
  outputAvailable: boolean;
  integrity: RunRecordIntegrity;
  truncatedTail: boolean;
}

export async function inspectRun({
  runsDirectory,
  runId,
  view,
  limitBytes = DEFAULT_PAGE_BYTES,
  cursor,
}: {
  runsDirectory: string;
  runId: string;
  view: RunInspectionView;
  limitBytes?: number;
  cursor?: string;
}): Promise<RunInspectionPage> {
  assertRunId(runId);
  const limit = normalizeByteLimit(limitBytes);
  const decoded = cursor ? decodeCursor(cursor) : undefined;
  if (decoded && decoded.kind !== "inspect") throw new Error("Invalid inspection cursor");
  if (decoded?.runId !== undefined && decoded.runId !== runId) throw new Error("Cursor belongs to a different run");
  if (decoded?.view !== undefined && decoded.view !== view) throw new Error("Cursor belongs to a different view");

  const directory = join(runsDirectory, runId);
  const eventsPath = join(directory, "events.ndjson");
  const summary = await readSummary(join(directory, "summary.json"), runId);
  const terminal = asRecord(summary.document?.summary);
  const terminalStatus = asString(terminal?.status);
  const finalAvailable = isFinalAvailable(terminal);

  if (view === "summary") {
    if (decoded?.kind === "inspect" && decoded.source !== "summary") throw new Error("Cursor source does not match summary view");
    const observation = await readObservation(eventsPath, runId);
    const text = JSON.stringify(summaryProjection(runId, summary, observation));
    const revision = contentRevision(text);
    if (decoded?.kind === "inspect" && decoded.revision !== revision) throw staleCursorError();
    const offset = decoded?.kind === "inspect" ? decoded.textOffset : 0;
    assertTextOffset(text, offset, "summary");
    const portion = sliceUtf8(text, offset, limit);
    return {
      runId,
      view,
      items: portion.text ? [{ text: portion.text }] : [],
      outputStatus: outputStatus(terminalStatus),
      finalAvailable,
      integrity: mergedIntegrity(summary, observation),
      truncatedTail: observation.truncatedTail,
      ...(portion.nextOffset < text.length
        ? { nextCursor: encodeCursor({ v: CURSOR_VERSION, kind: "inspect", runId, view, source: "summary", itemIndex: 0, textOffset: portion.nextOffset, revision }) }
        : {}),
    };
  }

  if (decoded?.kind === "inspect" && decoded.source === "summary") throw new Error("Cursor source does not match inspection view");

  if (view === "final") {
    // Reuses the same canonical terminal result every other view already reads
    // (canonicalResult/isFinalAvailable) — no separate backend parser or
    // narration heuristic. Always a single small terminal-document item, so it
    // reuses the same "terminal" cursor source as view: "output".
    const observation = await readObservation(eventsPath, runId);
    const finalText = finalAvailable ? canonicalResult(terminal) : undefined;
    const items: RunInspectionItem[] = finalText ? [{ text: finalText }] : [];
    const revision = contentRevision(finalText ?? "");
    const finalCursor = decoded?.kind === "inspect"
      ? decoded
      : { v: CURSOR_VERSION, kind: "inspect", runId, view, source: "terminal", itemIndex: 0, textOffset: 0, revision } as const;
    if (finalCursor.source !== "terminal") throw new Error("Cursor source does not match final view");
    if (finalCursor.revision !== revision) throw staleCursorError();
    return terminalPage(
      runId,
      view,
      items,
      finalCursor,
      limit,
      mergedIntegrity(summary, observation),
      observation.truncatedTail,
      terminalStatus,
      finalAvailable,
    );
  }

  if (view === "output" && summary.document && (terminalStatus === "done" || assistantItems(terminal).length > 0)) {
    if (decoded?.kind === "inspect" && decoded.source === "events") throw staleCursorError();
    const observation = await readObservation(eventsPath, runId);
    const items = terminalOutputItems(terminal);
    const revision = contentRevision(JSON.stringify(items));
    const terminalCursor = decoded?.kind === "inspect"
      ? decoded
      : { v: CURSOR_VERSION, kind: "inspect", runId, view, source: "terminal", itemIndex: 0, textOffset: 0, revision } as const;
    if (terminalCursor.source !== "terminal") throw new Error("Cursor source does not match output view");
    if (terminalCursor.revision !== revision) throw staleCursorError();
    return terminalPage(
      runId,
      view,
      items,
      terminalCursor,
      limit,
      mergedIntegrity(summary, observation),
      observation.truncatedTail,
      terminalStatus,
      finalAvailable,
    );
  }
  if (decoded?.kind === "inspect" && decoded.source === "terminal") throw new Error("Cursor source does not match diagnostics view");

  const state = decoded?.kind === "inspect" && decoded.source === "events"
    ? decoded
    : eventCursor(runId, view, 0, 0);
  await validateEventCursor(eventsPath, runId, view, state);

  const items: RunInspectionItem[] = [];
  let usedBytes = 0;
  let nextCursor: InspectionCursor | undefined;
  let activeAgyId: string | undefined;
  const scan = await scanCompleteLines(eventsPath, state.position, (line) => {
    const event = parseEvent(line.text, runId);
    if (!event) return "malformed";
    const projected = view === "output" ? outputFromEvent(event) : diagnosticFromEvent(event);
    if (!projected) return "continue";
    const startingOffset = line.start === state.position ? state.textOffset : 0;
    const remaining = limit - usedBytes;
    if (remaining <= 0) {
      nextCursor = eventCursor(runId, view, line.start, startingOffset);
      return "stop";
    }
    const chunk = sliceUtf8(projected.text, startingOffset, remaining);
    if (!chunk.text && startingOffset < projected.text.length) {
      nextCursor = eventCursor(runId, view, line.start, startingOffset);
      return "stop";
    }
    if (chunk.text) {
      if (view === "output" && projected.kind === "agy" && activeAgyId === projected.id && items.length > 0) items[items.length - 1]!.text += chunk.text;
      else items.push({ ...(projected.id ? { id: projected.id } : {}), text: chunk.text });
      activeAgyId = projected.kind === "agy" ? projected.id : undefined;
      usedBytes += Buffer.byteLength(chunk.text);
    }
    if (chunk.nextOffset < projected.text.length) {
      nextCursor = eventCursor(runId, view, line.start, chunk.nextOffset);
      return "stop";
    }
    return "continue";
  });

  if (!nextCursor && !summary.document && !scan.missing) nextCursor = eventCursor(runId, view, scan.endPosition, 0);

  const integrity: RunRecordIntegrity = scan.malformed || scan.missing || (summary.document && scan.truncatedTail) ? "damaged" : summary.integrity;
  return {
    runId,
    view,
    items,
    outputStatus: outputStatus(terminalStatus),
    finalAvailable,
    integrity,
    truncatedTail: scan.truncatedTail,
    ...(nextCursor ? { nextCursor: encodeCursor(nextCursor) } : {}),
  };
}

export async function listRunRecords({
  runsDirectory,
  sessionId,
  project,
  workflowRunId,
  limit = 50,
  cursor,
}: {
  runsDirectory: string;
  sessionId?: string;
  project?: string;
  workflowRunId?: string;
  limit?: number;
  cursor?: string;
}): Promise<{ items: RunRecordListItem[]; nextCursor?: string }> {
  const scope = JSON.stringify({ sessionId, project, workflowRunId });
  if (scope.length > 1024) throw new Error("Run list scope is too long");
  const decoded = cursor ? decodeCursor(cursor) : undefined;
  if (decoded && decoded.kind !== "list") throw new Error("Invalid list cursor");
  if (decoded?.kind === "list" && decoded.scope !== scope) throw new Error("Cursor belongs to a different list scope");
  const after = decoded?.kind === "list" ? decoded.after : undefined;
  if (!Number.isFinite(limit)) throw new Error("Run list limit must be finite");
  const pageSize = Math.max(1, Math.min(100, Math.floor(limit)));
  let entries: string[];
  try {
    entries = (await readdir(runsDirectory)).filter((name) => RUN_ID_PATTERN.test(name)).sort().reverse();
  } catch (error) {
    if (isNotFound(error)) return { items: [] };
    throw error;
  }

  const candidates = after ? entries.filter((name) => name < after) : entries;
  const items: RunRecordListItem[] = [];
  let scanned = 0;
  let lastScanned: string | undefined;
  for (const candidate of candidates) {
    if (scanned >= MAX_LIST_SCAN || items.length >= pageSize) break;
    scanned++;
    lastScanned = candidate;
    const item = await readListItem(runsDirectory, candidate);
    if (!item) continue;
    if (sessionId !== undefined && item.parentSessionId !== sessionId) continue;
    if (project !== undefined && item.project !== project) continue;
    if (workflowRunId !== undefined && item.workflowRunId !== workflowRunId) continue;
    items.push(item);
  }
  const hasMore = lastScanned !== undefined && candidates.some((name) => name < lastScanned!);
  return {
    items,
    ...(hasMore ? { nextCursor: encodeCursor({ v: CURSOR_VERSION, kind: "list", scope, after: lastScanned! }) } : {}),
  };
}

export async function getRunRecord(runsDirectory: string, runId: string): Promise<RunRecordListItem | undefined> {
  assertRunId(runId);
  return readListItem(runsDirectory, runId);
}

async function readListItem(runsDirectory: string, runId: string): Promise<RunRecordListItem | undefined> {
  const directory = join(runsDirectory, runId);
  const summary = await readSummary(join(directory, "summary.json"), runId);
  const observation = summary.document ? undefined : await readObservation(join(directory, "events.ndjson"), runId);
  const metadata = asRecord(summary.document?.metadata) ?? observation?.metadata;
  if (!metadata && summary.integrity === "damaged") return undefined;
  const terminal = asRecord(summary.document?.summary);
  const executionStartedAt = timeValue(terminal?.executionStartedAt) ?? observation?.executionStartedAt;
  const processStartedAtValue = timeValue(terminal?.processStartedAt) ?? observation?.processStartedAt;
  const status = asString(terminal?.status) ?? classifyQueuedOrRunning(executionStartedAt, processStartedAtValue, observation?.outputAvailable);
  const outcome = terminal
    ? status === "done" ? "succeeded" : terminal.timedOut === true ? "timed_out" : status === "aborted" ? "cancelled" : "failed"
    : undefined;
  const settledAt = documentTime(summary.document?.finishedAt);
  const queuedAt = asString(summary.document?.queuedAt) ?? observation?.queuedAt;
  return {
    runId,
    ...(queuedAt ? { queuedAt } : {}),
    status,
    ...(outcome ? { outcome } : {}),
    ...(settledAt !== undefined ? { settledAt } : {}),
    ...(boundedString(terminal?.error) ? { error: boundedString(terminal?.error) } : {}),
    ...(boundedString(metadata?.description) ? { description: boundedString(metadata?.description) } : {}),
    ...(asString(metadata?.backend) ? { backend: asString(metadata?.backend) } : {}),
    ...(metadataProfileName(metadata) ? { profile: metadataProfileName(metadata) } : {}),
    ...(metadataHarness(metadata) ? { harness: metadataHarness(metadata) } : {}),
    ...(asString(metadata?.project) ? { project: asString(metadata?.project) } : {}),
    ...(asString(metadata?.parentSessionId) ? { parentSessionId: asString(metadata?.parentSessionId) } : {}),
    ...(asString(metadata?.workflowRunId) ? { workflowRunId: asString(metadata?.workflowRunId) } : {}),
    outputAvailable: Boolean(canonicalResult(terminal) || assistantItems(terminal).length || observation?.outputAvailable),
    finalAvailable: isFinalAvailable(terminal),
    // Never live: a historical list row has no RunRegistry access either, so
    // this timing is always the durable-evidence-only projection (live=false).
    timing: deriveRunTiming({
      queuedAt,
      executionStartedAt,
      processStartedAt: processStartedAtValue,
      firstActivityAt: timeValue(terminal?.firstActivityAt) ?? observation?.firstActivityAt,
      lastActivityAt: timeValue(terminal?.lastActivityAt) ?? observation?.lastActivityAt,
      finishedAt: summary.document?.finishedAt,
    }, false),
    integrity: observation ? observation.integrity : summary.integrity,
  };
}

/**
 * Shared queued/running classification for a raw (pre-integrity-override)
 * status, used by both `readListItem` and `summaryProjection`.
 * `executionStartedAt` is backend-agnostic (present for pi too, unlike
 * `processStartedAt`, which only CLI backends with a child OS process ever
 * emit) and is the earliest reliable "execution actually began" signal, so it
 * must gate this classification alongside `processStartedAt`/output — or a pi
 * run that has started but produced no output yet would misreport as still
 * "queued". Does not affect the separate integrity/interrupted_or_uncertain
 * distinction, applied independently downstream (e.g. by `historicalAgent`).
 */
function classifyQueuedOrRunning(executionStartedAt: unknown, processStartedAt: unknown, outputAvailable: unknown): "queued" | "running" {
  return Boolean(executionStartedAt) || Boolean(processStartedAt) || Boolean(outputAvailable) ? "running" : "queued";
}

function documentTime(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : undefined;
}

async function readObservation(eventsPath: string, runId: string): Promise<RunObservation> {
  const observation: RunObservation = { outputAvailable: false, integrity: "incomplete", truncatedTail: false };
  const scan = await scanCompleteLines(eventsPath, 0, (line) => {
    const event = parseEvent(line.text, runId);
    if (!event) return "malformed";
    if (event.type === "run_started") {
      observation.metadata = asRecord(event.data);
      observation.queuedAt = asString(observation.metadata?.queuedAt) ?? event.timestamp;
    } else if (event.type === "execution_started") {
      observation.executionStartedAt ??= event.timestamp;
    } else if (event.type === "process_started") {
      observation.processStartedAt ??= event.timestamp;
    } else if (event.type === "backend_event") {
      const output = outputFromEvent(event);
      observation.outputAvailable ||= Boolean(output);
      if (output || activityFromEvent(event)) {
        observation.firstActivityAt ??= event.timestamp;
        observation.lastActivityAt = event.timestamp;
      }
    }
    return "continue";
  });
  observation.truncatedTail = scan.truncatedTail;
  observation.integrity = scan.missing || scan.malformed ? "damaged" : "incomplete";
  return observation;
}

function summaryProjection(runId: string, summary: SummaryState, observation: RunObservation): Record<string, unknown> {
  const document = summary.document;
  const metadata = asRecord(document?.metadata) ?? observation.metadata;
  const terminal = asRecord(document?.summary);
  const executionStartedAt = timeValue(terminal?.executionStartedAt) ?? observation.executionStartedAt;
  const processStartedAt = timeValue(terminal?.processStartedAt) ?? observation.processStartedAt;
  const firstActivityAt = timeValue(terminal?.firstActivityAt) ?? observation.firstActivityAt;
  const lastActivityAt = timeValue(terminal?.lastActivityAt) ?? observation.lastActivityAt;
  const status = asString(terminal?.status) ?? classifyQueuedOrRunning(executionStartedAt, processStartedAt, observation.outputAvailable);
  const queuedAt = asString(document?.queuedAt) ?? observation.queuedAt;
  return {
    runId,
    task: compactObject({
      description: boundedString(metadata?.description),
      backend: metadata?.backend,
      profile: metadataProfileName(metadata),
      harness: metadataHarness(metadata),
      project: boundedString(metadata?.project),
      parentSessionId: metadata?.parentSessionId,
      workflowRunId: metadata?.workflowRunId,
    }),
    state: compactObject({
      status,
      queuedAt,
      processStartedAt,
      firstActivityAt,
      lastActivityAt,
      finishedAt: document?.finishedAt,
      error: boundedString(terminal?.error),
      integrity: mergedIntegrity(summary, observation),
    }),
    // Never live here: this projection is durable-evidence-only (inspectRun has
    // no RunRegistry access), so now-relative fields (elapsedMs while running,
    // activityAgeMs) are never computed — only src/external-runs.ts may do that,
    // and only for a target it resolves through registry.get(runId).
    timing: deriveRunTiming({
      queuedAt,
      executionStartedAt,
      processStartedAt,
      firstActivityAt,
      lastActivityAt,
      finishedAt: document?.finishedAt,
    }, false),
    output: {
      available: Boolean(canonicalResult(terminal) || assistantItems(terminal).length || observation.outputAvailable),
      status: outputStatus(asString(terminal?.status)),
      finalAvailable: isFinalAvailable(terminal),
    },
  };
}

function outputFromEvent(event: EvidenceEvent): ({ kind: "claude" | "codex" | "agy" | "pi"; id?: string; text: string }) | undefined {
  if (event.type !== "backend_event") return undefined;
  const envelope = asRecord(event.data);
  const backendEvent = asRecord(envelope?.event);
  if (!backendEvent) return undefined;
  if (envelope?.backend === "claude" && backendEvent.type === "assistant") {
    const text = extractClaudeFinalText(backendEvent);
    const id = asString(asRecord(backendEvent.message)?.id);
    return text ? { kind: "claude", ...(id ? { id } : {}), text } : undefined;
  }
  if (envelope?.backend === "codex") {
    const text = extractCodexFinalText(backendEvent);
    const id = asString(asRecord(backendEvent.item)?.id);
    return text ? { kind: "codex", ...(id ? { id } : {}), text } : undefined;
  }
  if (envelope?.backend === "agy" && backendEvent.event === "step_update") {
    const update = asRecord(backendEvent.step_update);
    const text = (update?.step_type === "agent_response" || update?.step_type === "assistant") ? asString(update.text_delta) : undefined;
    const id = asString(update?.step_id);
    return text ? { kind: "agy", ...(id ? { id } : {}), text } : undefined;
  }
  if (envelope?.backend === "pi" && backendEvent.type === "message_end") {
    const message = asRecord(backendEvent.message);
    if (message?.role === "assistant") {
      const text = extractTextContent(message.content);
      const id = asString(message.id) ?? asString(message.responseId);
      return text ? { kind: "pi", ...(id ? { id } : {}), text } : undefined;
    }
  }
  return undefined;
}

function activityFromEvent(event: EvidenceEvent): string | undefined {
  const envelope = asRecord(event.data);
  const backendEvent = asRecord(envelope?.event);
  if (!backendEvent) return undefined;
  if (envelope?.backend === "claude") return claudeActivityFromEvent(backendEvent);
  if (envelope?.backend === "codex") return codexActivityFromEvent(backendEvent);
  if (envelope?.backend === "agy") return agyActivityFromEvent(backendEvent);
  return undefined;
}

function diagnosticFromEvent(event: EvidenceEvent): { kind: "codex"; id?: string; text: string } {
  return { kind: "codex", ...(event.sequence !== undefined ? { id: String(event.sequence) } : {}), text: JSON.stringify({ timestamp: event.timestamp, type: event.type, data: event.data }) };
}

async function readSummary(path: string, runId: string): Promise<SummaryState> {
  try {
    const document = asRecord(JSON.parse(await readFile(path, "utf8")));
    if (!document || document.runId !== runId || !asRecord(document.summary)) return { integrity: "damaged" };
    return { document: document as SummaryDocument, integrity: "complete" };
  } catch (error) {
    return { integrity: isNotFound(error) ? "incomplete" : "damaged" };
  }
}

async function scanCompleteLines(path: string, start: number, visit: (line: CompleteLine) => "continue" | "stop" | "malformed"): Promise<ScanResult> {
  let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let pendingStart = start;
  let malformed = false;
  try {
    for await (const chunk of createReadStream(path, { start })) {
      pending = pending.length ? Buffer.concat([pending, chunk as Buffer]) : chunk as Buffer;
      let newline: number;
      while ((newline = pending.indexOf(0x0a)) !== -1) {
        const end = pendingStart + newline + 1;
        const action = visit({ start: pendingStart, end, text: pending.subarray(0, newline).toString("utf8") });
        pending = pending.subarray(newline + 1);
        pendingStart = end;
        if (action === "malformed") malformed = true;
        if (action === "stop") return { missing: false, stopped: true, truncatedTail: false, malformed, endPosition: pendingStart };
      }
    }
    return { missing: false, stopped: false, truncatedTail: pending.length > 0, malformed, endPosition: pendingStart };
  } catch (error) {
    if (isNotFound(error)) return { missing: true, stopped: false, truncatedTail: false, malformed: false, endPosition: start };
    throw error;
  }
}

async function validateEventCursor(path: string, runId: string, view: RunInspectionView, cursor: Extract<InspectionCursor, { source: "events" }>): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "r");
    const size = (await handle.stat()).size;
    if (cursor.position > size) throw new Error("Cursor points past available evidence");
    if (cursor.position > 0) {
      const prior = Buffer.alloc(1);
      await handle.read(prior, 0, 1, cursor.position - 1);
      if (prior[0] !== 0x0a) throw new Error("Cursor is not at a record boundary");
    }
    if (cursor.textOffset > 0) {
      let projected: RunInspectionItem | undefined;
      await scanCompleteLines(path, cursor.position, (line) => {
        const event = parseEvent(line.text, runId);
        projected = event ? (view === "output" ? outputFromEvent(event) : diagnosticFromEvent(event)) : undefined;
        return "stop";
      });
      if (!projected) throw new Error("Cursor text offset has no matching record");
      assertTextOffset(projected.text, cursor.textOffset, "cursor");
    }
  } catch (error) {
    if (isNotFound(error) && cursor.position === 0 && cursor.textOffset === 0) return;
    throw error;
  } finally {
    await handle?.close();
  }
}

function terminalPage(runId: string, view: "output" | "final", items: RunInspectionItem[], cursor: Extract<InspectionCursor, { source: "terminal" }>, limit: number, integrity: RunRecordIntegrity, truncatedTail: boolean, terminalStatus: string | undefined, finalAvailable: boolean): RunInspectionPage {
  if (items.length || cursor.itemIndex !== 0 || cursor.textOffset !== 0) validateItemCursor(items, cursor.itemIndex, cursor.textOffset);
  const served = serveItems(items, cursor.itemIndex, cursor.textOffset, limit);
  return {
    runId,
    view,
    items: served.items,
    outputStatus: outputStatus(terminalStatus),
    finalAvailable,
    integrity,
    truncatedTail,
    ...(served.next ? { nextCursor: encodeCursor({ v: CURSOR_VERSION, kind: "inspect", runId, view, source: "terminal", ...served.next, revision: cursor.revision }) } : {}),
  };
}

function serveItems(items: RunInspectionItem[], itemIndex: number, textOffset: number, budget: number): { items: RunInspectionItem[]; next?: { itemIndex: number; textOffset: number } } {
  const served: RunInspectionItem[] = [];
  let remaining = budget;
  for (let index = itemIndex; index < items.length; index++) {
    const item = items[index]!;
    const offset = index === itemIndex ? textOffset : 0;
    if (remaining <= 0) return { items: served, next: { itemIndex: index, textOffset: offset } };
    const chunk = sliceUtf8(item.text, offset, remaining);
    if (chunk.text) served.push({ ...(item.id ? { id: item.id } : {}), text: chunk.text });
    remaining -= Buffer.byteLength(chunk.text);
    if (chunk.nextOffset < item.text.length) return { items: served, next: { itemIndex: index, textOffset: chunk.nextOffset } };
  }
  return { items: served };
}

function parseEvent(line: string, runId: string): EvidenceEvent | undefined {
  try {
    const event = asRecord(JSON.parse(line));
    return event && event.runId === runId ? event as EvidenceEvent : undefined;
  } catch {
    return undefined;
  }
}

function sliceUtf8(text: string, offset: number, budget: number): { text: string; nextOffset: number } {
  if (budget <= 0 || offset >= text.length) return { text: "", nextOffset: offset };
  let end = offset;
  let bytes = 0;
  for (const character of text.slice(offset)) {
    const size = Buffer.byteLength(character);
    if (bytes + size > budget) break;
    bytes += size;
    end += character.length;
  }
  return { text: text.slice(offset, end), nextOffset: end };
}

function assistantItems(summary: Record<string, unknown> | undefined): RunInspectionItem[] {
  const output = asRecord(summary?.assistantOutput);
  const messages = Array.isArray(output?.messages) ? output.messages : [];
  return messages.flatMap((message) => {
    const record = asRecord(message);
    const text = asString(record?.text);
    const id = asString(record?.id);
    return text ? [{ ...(id ? { id } : {}), text }] : [];
  });
}

function terminalOutputItems(summary: Record<string, unknown> | undefined): RunInspectionItem[] {
  const items = assistantItems(summary);
  const canonical = canonicalResult(summary);
  if (canonical && !items.some((item) => item.text === canonical)) items.push({ text: canonical });
  return items;
}

function contentRevision(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function staleCursorError(): Error {
  return new Error("Run changed while paging; restart inspection without a cursor");
}

function canonicalResult(summary: Record<string, unknown> | undefined): string | undefined {
  return summary?.status === "done" ? textValue(summary.structuredOutput ?? summary.result) : undefined;
}

/**
 * Whether a separate verified final answer (view: "final") is available.
 * Deliberately identical to `Boolean(canonicalResult(summary))`: the terminal
 * `status: "done"` gate lives inside `canonicalResult` itself, so there is
 * exactly one place that decides "this run has a verified successful
 * terminal boundary" — no second heuristic, no narration promotion.
 */
function isFinalAvailable(summary: Record<string, unknown> | undefined): boolean {
  return Boolean(canonicalResult(summary));
}

function msValue(value: string | number | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function nonNegativeDelta(end: number | undefined, start: number | undefined): number | undefined {
  if (end === undefined || start === undefined) return undefined;
  const delta = end - start;
  return delta >= 0 ? delta : undefined;
}

function isoValue(value: string | number | undefined): string | undefined {
  if (value === undefined) return undefined;
  return typeof value === "string" ? value : timeValue(value);
}

/**
 * One shared, pure timing projection used by durable summaries, list entries,
 * batch inspection, and (via `live: true`) live registry-backed summaries.
 *
 * `live` must be true ONLY for a target independently confirmed still running
 * by `RunRegistry` (i.e. resolved via `registry.get(runId)` in
 * `src/external-runs.ts`). Durable-evidence-only callers in this module
 * (`inspectRun`, `listRunRecords`, `getRunRecord`) always pass `false`: a
 * record with no `finishedAt` and no owning registry entry could be a
 * genuinely still-running child, or an orphaned/crashed one whose parent
 * session never got to write `finishedAt` — durable evidence alone cannot
 * tell the two apart, so a `now`-relative field is never fabricated for it.
 */
export function deriveRunTiming(inputs: RunTimingInputs, live: boolean, now: number = Date.now()): RunTiming {
  const queuedAtMs = msValue(inputs.queuedAt);
  const executionStartedAtMs = msValue(inputs.executionStartedAt);
  const processStartedAtMs = msValue(inputs.processStartedAt);
  const lastActivityAtMs = msValue(inputs.lastActivityAt);
  const finishedAtMs = msValue(inputs.finishedAt);

  const queueDelayMs = nonNegativeDelta(executionStartedAtMs, queuedAtMs);
  const elapsedMs = finishedAtMs !== undefined
    ? nonNegativeDelta(finishedAtMs, executionStartedAtMs)
    : live ? nonNegativeDelta(now, executionStartedAtMs) : undefined;
  const activityAgeMs = live && finishedAtMs === undefined ? nonNegativeDelta(now, lastActivityAtMs) : undefined;
  const processDurationMs = nonNegativeDelta(finishedAtMs, processStartedAtMs);

  return {
    ...(isoValue(inputs.queuedAt) ? { queuedAt: isoValue(inputs.queuedAt) } : {}),
    ...(isoValue(inputs.executionStartedAt) ? { executionStartedAt: isoValue(inputs.executionStartedAt) } : {}),
    ...(isoValue(inputs.processStartedAt) ? { processStartedAt: isoValue(inputs.processStartedAt) } : {}),
    ...(isoValue(inputs.firstActivityAt) ? { firstActivityAt: isoValue(inputs.firstActivityAt) } : {}),
    ...(isoValue(inputs.lastActivityAt) ? { lastActivityAt: isoValue(inputs.lastActivityAt) } : {}),
    ...(isoValue(inputs.finishedAt) ? { finishedAt: isoValue(inputs.finishedAt) } : {}),
    ...(queueDelayMs !== undefined ? { queueDelayMs } : {}),
    ...(elapsedMs !== undefined ? { elapsedMs } : {}),
    ...(activityAgeMs !== undefined ? { activityAgeMs } : {}),
    ...(processDurationMs !== undefined ? { processDurationMs } : {}),
  };
}

function textValue(value: unknown): string | undefined {
  if (typeof value === "string") return value || undefined;
  if (value === undefined || value === null) return undefined;
  return JSON.stringify(value);
}

function outputStatus(status: string | undefined): RunOutputStatus {
  return status === undefined ? "preliminary" : status === "done" ? "final" : "interrupted";
}

function mergedIntegrity(summary: SummaryState, observation: RunObservation): RunRecordIntegrity {
  return observation.integrity === "damaged" || (summary.document && observation.truncatedTail) ? "damaged" : summary.integrity;
}

function timeValue(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  return typeof value === "number" && Number.isFinite(value) ? new Date(value).toISOString() : undefined;
}

function boundedString(value: unknown): string | undefined {
  const text = asString(value);
  return text && text.length > 512 ? `${text.slice(0, 512)}…` : text;
}

function compactObject(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function normalizeByteLimit(value: number): number {
  if (!Number.isFinite(value)) throw new Error("limitBytes must be finite");
  return Math.max(4, Math.min(MAX_PAGE_BYTES, Math.floor(value)));
}

function assertRunId(runId: string): void {
  if (!RUN_ID_PATTERN.test(runId)) throw new Error("Invalid run ID");
}

function eventCursor(runId: string, view: RunInspectionView, position: number, textOffset: number): Extract<InspectionCursor, { source: "events" }> {
  return { v: CURSOR_VERSION, kind: "inspect", runId, view, source: "events", position, textOffset };
}

function encodeCursor(cursor: InspectionCursor | ListCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeCursor(value: string): InspectionCursor | ListCursor {
  if (!value || value.length > MAX_CURSOR_CHARS) throw new Error("Invalid cursor");
  try {
    const parsed = asRecord(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
    if (!parsed || parsed.v !== CURSOR_VERSION || (parsed.kind !== "inspect" && parsed.kind !== "list")) throw new Error();
    if (parsed.kind === "list") {
      if (!hasKeys(parsed, ["v", "kind", "scope", "after"]) || typeof parsed.scope !== "string" || !RUN_ID_PATTERN.test(asString(parsed.after) ?? "")) throw new Error();
      return parsed as unknown as ListCursor;
    }
    if (!RUN_ID_PATTERN.test(asString(parsed.runId) ?? "") || !isView(parsed.view) || (parsed.source !== "events" && parsed.source !== "terminal" && parsed.source !== "summary")) throw new Error();
    if (parsed.source === "events") {
      if (!hasKeys(parsed, ["v", "kind", "runId", "view", "source", "position", "textOffset"]) || !isNonNegativeInteger(parsed.position) || !isNonNegativeInteger(parsed.textOffset)) throw new Error();
    } else {
      if (!hasKeys(parsed, ["v", "kind", "runId", "view", "source", "itemIndex", "textOffset", "revision"]) || !isNonNegativeInteger(parsed.itemIndex) || !isNonNegativeInteger(parsed.textOffset) || typeof parsed.revision !== "string" || !/^[a-f0-9]{64}$/.test(parsed.revision)) throw new Error();
      if (parsed.source === "summary" && parsed.itemIndex !== 0) throw new Error();
    }
    return parsed as unknown as InspectionCursor;
  } catch {
    throw new Error("Invalid cursor");
  }
}

function validateItemCursor(items: RunInspectionItem[], itemIndex: number, textOffset: number): void {
  const item = items[itemIndex];
  if (!item) throw new Error("Cursor item is outside available terminal output");
  assertTextOffset(item.text, textOffset, "cursor");
}

function assertTextOffset(text: string, offset: number, label: string): void {
  const splitsSurrogate = offset > 0 && offset < text.length && /[\uD800-\uDBFF]/.test(text[offset - 1]!) && /[\uDC00-\uDFFF]/.test(text[offset]!);
  if (!isNonNegativeInteger(offset) || (offset >= text.length && offset !== 0) || splitsSurrogate) throw new Error(`${label === "cursor" ? "Cursor" : label} text offset is outside available content`);
}

function hasKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const expected = [...keys].sort();
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isView(value: unknown): value is RunInspectionView {
  return value === "output" || value === "diagnostics" || value === "summary" || value === "final";
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * Resolved profile/subagentType name from persisted run-record metadata.
 * `metadata.profile` has shipped in two shapes historically: a plain string
 * (the direct `Agent`/workflow-child metadata this package writes today) and
 * a full profile object (spawn.ts's own fallback record creation, used when
 * a caller does not pre-create its own run record). Both are read here, in
 * ONE place, so `readListItem` and `summaryProjection` cannot independently
 * drift on how they unpack it.
 */
function metadataProfileName(metadata: Record<string, unknown> | undefined): string | undefined {
  return typeof metadata?.profile === "string" ? metadata.profile : asString(asRecord(metadata?.profile)?.name);
}

/**
 * Resolved harness (registered pi-* config, or equal to backend for
 * agy/claude/codex) from persisted run-record metadata: an explicit
 * `metadata.harness` field when present (every current call site writes
 * one), falling back to the embedded profile object's own `harness` field
 * for the historical spawn.ts fallback shape. Never reparsed/guessed from
 * `profile`/`subagentType`'s name string.
 */
function metadataHarness(metadata: Record<string, unknown> | undefined): string | undefined {
  return asString(metadata?.harness) ?? asString(asRecord(metadata?.profile)?.harness);
}

function isNotFound(error: unknown): boolean {
  return asRecord(error)?.code === "ENOENT";
}
