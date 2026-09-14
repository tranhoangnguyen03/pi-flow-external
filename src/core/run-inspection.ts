import { createReadStream } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { extractClaudeFinalText } from "./claude.ts";
import { extractCodexFinalText } from "./codex.ts";

const CURSOR_VERSION = 1;
const DEFAULT_PAGE_BYTES = 32 * 1024;
const MAX_PAGE_BYTES = 64 * 1024;
const RUN_ID_PATTERN = /^run_[A-Za-z0-9_-]+$/;

export type RunInspectionView = "output" | "diagnostics" | "summary";
export type RunRecordIntegrity = "complete" | "incomplete" | "damaged";
export type RunOutputStatus = "preliminary" | "final" | "interrupted";

export interface RunInspectionItem {
  id?: string;
  text: string;
}

export interface RunInspectionPage {
  runId: string;
  view: RunInspectionView;
  items: RunInspectionItem[];
  outputStatus: RunOutputStatus;
  integrity: RunRecordIntegrity;
  truncatedTail: boolean;
  nextCursor?: string;
}

export interface RunRecordListItem {
  runId: string;
  queuedAt?: string;
  status?: string;
  description?: string;
  backend?: string;
  project?: string;
  parentSessionId?: string;
  workflowRunId?: string;
  outputAvailable: boolean;
  integrity: RunRecordIntegrity;
}

interface InspectionCursor {
  v: typeof CURSOR_VERSION;
  kind: "inspect";
  runId: string;
  view: RunInspectionView;
  position: number;
  textOffset: number;
  sawOutput: boolean;
}

interface ListCursor {
  v: typeof CURSOR_VERSION;
  kind: "list";
  scope: string;
  position: number;
}

interface SummaryDocument {
  runId?: string;
  queuedAt?: string;
  metadata?: unknown;
  summary?: unknown;
}

interface SummaryState {
  document?: SummaryDocument;
  integrity: RunRecordIntegrity;
}

interface EvidenceEvent {
  runId?: string;
  sequence?: number;
  timestamp?: string;
  type?: string;
  data?: unknown;
}

interface CompleteLine {
  start: number;
  end: number;
  text: string;
}

interface ScanResult {
  missing: boolean;
  stopped: boolean;
  truncatedTail: boolean;
  malformed: boolean;
  endPosition: number;
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

  const state: InspectionCursor = decoded?.kind === "inspect"
    ? decoded
    : { v: CURSOR_VERSION, kind: "inspect", runId, view, position: 0, textOffset: 0, sawOutput: false };
  const directory = join(runsDirectory, runId);
  const summary = await readSummary(join(directory, "summary.json"), runId);
  const summaryRecord = asRecord(summary.document?.summary);
  const outputStatus: RunOutputStatus = !summary.document
    ? "preliminary"
    : summaryRecord?.status === "done" ? "final" : "interrupted";

  if (view === "summary") {
    const text = summary.document ? JSON.stringify(summary.document) : "Run has no terminal summary yet.";
    return {
      runId,
      view,
      items: [{ text }],
      outputStatus,
      integrity: summary.integrity,
      truncatedTail: false,
    };
  }

  const items: RunInspectionItem[] = [];
  let usedBytes = 0;
  let nextCursor: InspectionCursor | undefined;
  let sawOutput = state.sawOutput;
  let activeAgyId: string | undefined;
  const scan = await scanCompleteLines(join(directory, "events.ndjson"), state.position, (line) => {
    const event = parseEvent(line.text, runId);
    if (!event) return "malformed";
    const projected = view === "output" ? outputFromEvent(event) : diagnosticFromEvent(event);
    if (!projected) return "continue";

    const startingOffset = line.start === state.position ? state.textOffset : 0;
    const remaining = limit - usedBytes;
    if (remaining <= 0) {
      nextCursor = { ...state, position: line.start, textOffset: startingOffset, sawOutput };
      return "stop";
    }
    const chunk = sliceUtf8(projected.text, startingOffset, remaining);
    if (!chunk.text && startingOffset < projected.text.length) {
      nextCursor = { ...state, position: line.start, textOffset: startingOffset, sawOutput };
      return "stop";
    }
    if (chunk.text) {
      if (view === "output" && projected.kind === "agy" && activeAgyId === projected.id && items.length > 0) {
        items[items.length - 1]!.text += chunk.text;
      } else {
        items.push({ ...(projected.id ? { id: projected.id } : {}), text: chunk.text });
      }
      activeAgyId = projected.kind === "agy" ? projected.id : undefined;
      usedBytes += Buffer.byteLength(chunk.text);
      if (view === "output") sawOutput = true;
    }
    if (chunk.nextOffset < projected.text.length) {
      nextCursor = { ...state, position: line.start, textOffset: chunk.nextOffset, sawOutput };
      return "stop";
    }
    state.textOffset = 0;
    state.position = line.end;
    state.sawOutput = sawOutput;
    return "continue";
  });

  let truncatedTail = scan.truncatedTail;
  let malformed = scan.malformed || scan.missing;
  if (!nextCursor && !scan.stopped && view === "output" && !sawOutput) {
    const fallback = summaryResult(summaryRecord);
    if (fallback) {
      const fallbackOffset = state.position === scan.endPosition ? state.textOffset : 0;
      const chunk = sliceUtf8(fallback, fallbackOffset, limit - usedBytes);
      if (chunk.text) items.push({ text: chunk.text });
      sawOutput = true;
      if (chunk.nextOffset < fallback.length) {
        nextCursor = { ...state, position: scan.endPosition, textOffset: chunk.nextOffset, sawOutput: false };
      }
    }
  }
  if (!nextCursor && !summary.document && !scan.missing) {
    nextCursor = { ...state, position: scan.endPosition, textOffset: 0, sawOutput };
  }

  const integrity: RunRecordIntegrity = malformed || (summary.document && truncatedTail)
    ? "damaged"
    : summary.integrity;
  return {
    runId,
    view,
    items,
    outputStatus,
    integrity,
    truncatedTail,
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
  const decoded = cursor ? decodeCursor(cursor) : undefined;
  if (decoded && decoded.kind !== "list") throw new Error("Invalid list cursor");
  if (decoded?.kind === "list" && decoded.scope !== scope) throw new Error("Cursor belongs to a different list scope");
  const position = decoded?.kind === "list" ? decoded.position : 0;
  const pageSize = Math.max(1, Math.min(100, Math.floor(limit)));
  let entries: string[];
  try {
    entries = await readdir(runsDirectory);
  } catch (error) {
    if (isNotFound(error)) return { items: [] };
    throw error;
  }

  const records = (await Promise.all(entries.filter((name) => RUN_ID_PATTERN.test(name)).map((runId) => readListItem(runsDirectory, runId))))
    .filter((item): item is RunRecordListItem => Boolean(item))
    .filter((item) => sessionId === undefined || item.parentSessionId === sessionId)
    .filter((item) => project === undefined || item.project === project)
    .filter((item) => workflowRunId === undefined || item.workflowRunId === workflowRunId)
    .sort((a, b) => (b.queuedAt ?? "").localeCompare(a.queuedAt ?? "") || b.runId.localeCompare(a.runId));
  const items = records.slice(position, position + pageSize);
  const nextPosition = position + items.length;
  return {
    items,
    ...(nextPosition < records.length
      ? { nextCursor: encodeCursor({ v: CURSOR_VERSION, kind: "list", scope, position: nextPosition }) }
      : {}),
  };
}

async function readListItem(runsDirectory: string, runId: string): Promise<RunRecordListItem | undefined> {
  const directory = join(runsDirectory, runId);
  const summary = await readSummary(join(directory, "summary.json"), runId);
  const document = summary.document;
  let metadata = asRecord(document?.metadata);
  if (!document) {
    let started: EvidenceEvent | undefined;
    await scanCompleteLines(join(directory, "events.ndjson"), 0, (line) => {
      const event = parseEvent(line.text, runId);
      if (event?.type === "run_started") {
        started = event;
        return "stop";
      }
      return event ? "continue" : "malformed";
    });
    metadata = asRecord(started?.data);
    if (!metadata && summary.integrity === "damaged") return undefined;
  }
  const terminal = asRecord(document?.summary);
  return {
    runId,
    ...(typeof document?.queuedAt === "string"
      ? { queuedAt: document.queuedAt }
      : typeof metadata?.queuedAt === "string" ? { queuedAt: metadata.queuedAt } : {}),
    ...(typeof terminal?.status === "string" ? { status: terminal.status } : {}),
    ...(typeof metadata?.description === "string" ? { description: metadata.description } : {}),
    ...(typeof metadata?.backend === "string" ? { backend: metadata.backend } : {}),
    ...(typeof metadata?.project === "string" ? { project: metadata.project } : {}),
    ...(typeof metadata?.parentSessionId === "string" ? { parentSessionId: metadata.parentSessionId } : {}),
    ...(typeof metadata?.workflowRunId === "string" ? { workflowRunId: metadata.workflowRunId } : {}),
    outputAvailable: Boolean(summaryResult(terminal) || asRecord(terminal?.assistantOutput)),
    integrity: summary.integrity,
  };
}

function outputFromEvent(event: EvidenceEvent): ({ kind: "claude" | "codex" | "agy"; id?: string; text: string }) | undefined {
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
    const text = (update?.step_type === "agent_response" || update?.step_type === "assistant")
      ? asString(update.text_delta)
      : undefined;
    const id = asString(update?.step_id);
    return text ? { kind: "agy", ...(id ? { id } : {}), text } : undefined;
  }
  return undefined;
}

function diagnosticFromEvent(event: EvidenceEvent): { kind: "codex"; id?: string; text: string } {
  return {
    kind: "codex",
    ...(event.sequence !== undefined ? { id: String(event.sequence) } : {}),
    text: JSON.stringify({ timestamp: event.timestamp, type: event.type, data: event.data }),
  };
}

async function readSummary(path: string, runId: string): Promise<SummaryState> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    const document = asRecord(parsed);
    if (!document || document.runId !== runId || !asRecord(document.summary)) return { integrity: "damaged" };
    return { document: document as SummaryDocument, integrity: "complete" };
  } catch (error) {
    return { integrity: isNotFound(error) ? "incomplete" : "damaged" };
  }
}

async function scanCompleteLines(
  path: string,
  start: number,
  visit: (line: CompleteLine) => "continue" | "stop" | "malformed",
): Promise<ScanResult> {
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

function summaryResult(summary: Record<string, unknown> | undefined): string | undefined {
  if (typeof summary?.result === "string" && summary.result) return summary.result;
  const output = asRecord(summary?.assistantOutput);
  const messages = Array.isArray(output?.messages) ? output.messages : [];
  const texts = messages.map((message) => asString(asRecord(message)?.text)).filter((text): text is string => Boolean(text));
  return texts.length ? texts.join("\n") : undefined;
}

function normalizeByteLimit(value: number): number {
  if (!Number.isFinite(value)) throw new Error("limitBytes must be finite");
  return Math.max(1, Math.min(MAX_PAGE_BYTES, Math.floor(value)));
}

function assertRunId(runId: string): void {
  if (!RUN_ID_PATTERN.test(runId)) throw new Error("Invalid run ID");
}

function encodeCursor(cursor: InspectionCursor | ListCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeCursor(value: string): InspectionCursor | ListCursor {
  try {
    const parsed = asRecord(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
    if (!parsed || parsed.v !== CURSOR_VERSION || (parsed.kind !== "inspect" && parsed.kind !== "list")) throw new Error();
    if (parsed.kind === "inspect") {
      if (!RUN_ID_PATTERN.test(asString(parsed.runId) ?? "") || !isView(parsed.view) || !isNonNegativeInteger(parsed.position) || !isNonNegativeInteger(parsed.textOffset) || typeof parsed.sawOutput !== "boolean") throw new Error();
      return parsed as unknown as InspectionCursor;
    }
    if (typeof parsed.scope !== "string" || !isNonNegativeInteger(parsed.position)) throw new Error();
    return parsed as unknown as ListCursor;
  } catch {
    throw new Error("Invalid cursor");
  }
}

function isView(value: unknown): value is RunInspectionView {
  return value === "output" || value === "diagnostics" || value === "summary";
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

function isNotFound(error: unknown): boolean {
  return asRecord(error)?.code === "ENOENT";
}
