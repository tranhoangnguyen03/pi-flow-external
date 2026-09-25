import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { hashStableValue } from "./replay-cache.ts";
import { WORKFLOW_API_VERSION, type ChildRunOutcome, type WorkflowAgentQueuedEvent, type WorkflowAgentResultEvent, type WorkflowCachedAgentResult } from "./types.ts";

const JOURNAL_VERSION = 1;
const RUN_ID_PREFIX = "wf_";
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

interface WorkflowSessionManagerLike {
  isPersisted?: () => boolean;
  getSessionFile?: () => string | undefined;
  getSessionDir?: () => string | undefined;
  getSessionId?: () => string | undefined;
}

export interface WorkflowSessionContextLike {
  sessionManager?: WorkflowSessionManagerLike;
}

export interface WorkflowRunIdentity {
  runId: string;
  apiVersion: typeof WORKFLOW_API_VERSION;
  scriptHash: string;
  argsHash: string;
}

export interface LoadedWorkflowJournal {
  launch?: unknown;
  runId: string;
  path: string;
  agentResults: WorkflowCachedAgentResult[];
  name?: string;
  source?: string;
  project?: string;
  status: "running" | "done" | "error";
  outcome?: "succeeded" | ChildRunOutcome;
  result?: unknown;
  error?: string;
  children: Array<{ index: number; runId?: string; label?: string; status: "queued" | "done" | "error" | "aborted"; outcome?: ChildRunOutcome; error?: unknown }>;
}

export interface WorkflowJournalWriter {
  runId: string;
  path: string;
  appendAgentQueued(event: WorkflowAgentQueuedEvent): Promise<void>;
  appendAgentResult(event: WorkflowAgentResultEvent): Promise<void>;
  complete(result: unknown): Promise<void>;
  fail(error: string, outcome?: ChildRunOutcome): Promise<void>;
}

export function getSessionWorkflowDir(ctx: WorkflowSessionContextLike): string | undefined {
  const manager = ctx.sessionManager;
  if (!manager || manager.isPersisted?.() === false) {
    return undefined;
  }
  const sessionFile = manager.getSessionFile?.();
  if (sessionFile) {
    return join(dirname(sessionFile), `${basename(sessionFile, extname(sessionFile))}.workflows`);
  }
  const sessionDir = manager.getSessionDir?.();
  const sessionId = manager.getSessionId?.();
  if (!sessionDir || !sessionId) {
    return undefined;
  }
  return join(sessionDir, `${safeFilePart(sessionId)}.workflows`);
}

export function createWorkflowRunIdentity(script: string, args: unknown): WorkflowRunIdentity {
  const scriptHash = hashStableValue(script);
  const argsHash = hashStableValue(args ?? null);
  return {
    scriptHash,
    argsHash,
    apiVersion: WORKFLOW_API_VERSION,
    runId: `${RUN_ID_PREFIX}${hashStableValue({ apiVersion: WORKFLOW_API_VERSION, scriptHash, argsHash }).slice(0, 8)}_${randomUUID().replace(/-/g, "")}`,
  };
}

export async function persistWorkflowScript(params: {
  dir: string;
  metaName: string;
  scriptHash: string;
  script: string;
}): Promise<string> {
  await mkdir(params.dir, { recursive: true });
  const path = join(params.dir, `${safeFilePart(params.metaName)}-${params.scriptHash.slice(0, 12)}.js`);
  await writeFile(path, params.script, "utf8");
  return path;
}

export async function loadWorkflowJournal(dir: string, runId: string): Promise<LoadedWorkflowJournal | undefined> {
  if (!SAFE_ID.test(runId)) {
    throw new Error(`Invalid workflow run id: ${runId}`);
  }
  const path = workflowJournalPath(dir, runId);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isNotFound(error)) {
      return undefined;
    }
    throw error;
  }

  const agentResults: WorkflowCachedAgentResult[] = [];
  const children: LoadedWorkflowJournal["children"] = [];
  let launch: unknown;
  let seenRunStart = false;
  let name: string | undefined;
  let source: string | undefined;
  let project: string | undefined;
  let status: LoadedWorkflowJournal["status"] = "running";
  let outcome: LoadedWorkflowJournal["outcome"];
  let result: unknown;
  let terminalError: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      break;
    }
    if (entry.type === "run_start") {
      if (entry.version !== JOURNAL_VERSION || entry.apiVersion !== WORKFLOW_API_VERSION) {
        throw new Error(
          `Workflow journal ${path} uses an incompatible API contract; recompose with meta.apiVersion: ${WORKFLOW_API_VERSION}. No children were launched`,
        );
      }
      seenRunStart = entry.runId === runId;
      launch = entry.launch;
      name = typeof entry.name === "string" ? entry.name : undefined;
      source = typeof entry.source === "string" ? entry.source : undefined;
      project = typeof entry.project === "string" ? entry.project : undefined;
      continue;
    }
    if (entry.type === "run_complete") {
      status = "done";
      outcome = "succeeded";
      result = entry.result;
      continue;
    }
    if (entry.type === "run_error") {
      status = "error";
      outcome = entry.outcome === "cancelled" || entry.outcome === "timed_out" ? entry.outcome : "failed";
      terminalError = typeof entry.error === "string" ? entry.error : "workflow failed";
      continue;
    }
    if (entry.type === "agent_queued") {
      if (typeof entry.index !== "number") continue;
      children[entry.index - 1] = {
        index: entry.index,
        ...(typeof entry.runId === "string" ? { runId: entry.runId } : {}),
        ...(typeof entry.label === "string" ? { label: entry.label } : {}),
        status: "queued",
      };
      continue;
    }
    if (entry.type !== "agent_result") {
      continue;
    }
    const index = entry.index;
    const fingerprint = entry.fingerprint;
    if (typeof index !== "number" || typeof fingerprint !== "string") {
      continue;
    }
    agentResults[index - 1] = {
      index,
      fingerprint,
      result: entry.result,
      failed: entry.failed === true,
      ...(typeof entry.runId === "string" ? { runId: entry.runId } : {}),
    };
    const childOutcome = entry.error && typeof entry.error === "object" && (entry.error as Record<string, unknown>).outcome;
    children[index - 1] = {
      index,
      ...(typeof entry.runId === "string" ? { runId: entry.runId } : {}),
      ...(typeof entry.label === "string" ? { label: entry.label } : {}),
      status: entry.failed === true
        ? childOutcome === "cancelled" || childOutcome === "timed_out" ? "aborted" : "error"
        : "done",
      ...(childOutcome === "failed" || childOutcome === "cancelled" || childOutcome === "timed_out" ? { outcome: childOutcome } : {}),
      ...(entry.error !== undefined ? { error: entry.error } : {}),
    };
  }

  if (!seenRunStart) {
    throw new Error(`Workflow journal ${path} does not match run id ${runId}`);
  }
  return { launch, runId, path, agentResults, name, source, project, status, outcome, result, error: terminalError, children: children.filter(Boolean) };
}

export interface WorkflowJournalPage {
  items: LoadedWorkflowJournal[];
  nextCursor?: string;
}

function workflowListCursor(name: string): string {
  return Buffer.from(JSON.stringify({ v: 1, kind: "workflow-list", name })).toString("base64url");
}

function workflowListStart(names: string[], cursor?: string): number {
  if (!cursor) return 0;
  if (cursor.length > 4_096) throw new Error("Invalid workflow list cursor");
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<string, unknown>;
    if (Object.keys(parsed).sort().join(",") !== "kind,name,v" || parsed.v !== 1 || parsed.kind !== "workflow-list" || typeof parsed.name !== "string") throw new Error();
    const index = names.indexOf(parsed.name);
    if (index < 0) throw new Error();
    return index + 1;
  } catch {
    throw new Error("Invalid workflow list cursor");
  }
}

export async function listWorkflowJournals(dir: string, project: string, limit = 100, cursor?: string): Promise<WorkflowJournalPage> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((name) => /^run-wf_[A-Za-z0-9_-]{1,128}\.jsonl$/.test(name)).sort().reverse();
  } catch (error) {
    if (isNotFound(error)) return { items: [] };
    throw error;
  }
  const start = workflowListStart(names, cursor);
  const pageLimit = Math.max(1, Math.min(100, limit));
  const journals: LoadedWorkflowJournal[] = [];
  let index = start;
  for (; index < names.length && index < start + 200; index++) {
    const name = names[index]!;
    const journal = await loadWorkflowJournal(dir, name.slice(4, -6));
    if (journal?.project === project) journals.push(journal);
    if (journals.length >= pageLimit) {
      index++;
      break;
    }
  }
  return {
    items: journals,
    ...(index < names.length ? { nextCursor: workflowListCursor(names[index - 1]!) } : {}),
  };
}

export async function createWorkflowJournalWriter(params: {
  launch?: unknown;
  dir: string;
  identity: WorkflowRunIdentity;
  name: string;
  source: string;
  project?: string;
  scriptPath?: string;
  resumeFromRunId?: string;
}): Promise<WorkflowJournalWriter> {
  await mkdir(params.dir, { recursive: true, mode: 0o700 });
  const path = workflowJournalPath(params.dir, params.identity.runId);
  await writeFile(
    path,
    `${JSON.stringify({
      type: "run_start",
      launch: params.launch,
      version: JOURNAL_VERSION,
      apiVersion: params.identity.apiVersion,
      runId: params.identity.runId,
      name: params.name,
      source: params.source,
      project: params.project,
      scriptPath: params.scriptPath,
      resumeFromRunId: params.resumeFromRunId,
      scriptHash: params.identity.scriptHash,
      argsHash: params.identity.argsHash,
    })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );

  let appendQueue = Promise.resolve();
  const enqueueAppend = (value: unknown) => {
    const next = appendQueue.then(() => appendJsonLine(path, value));
    appendQueue = next.catch(() => {});
    return next;
  };

  return {
    runId: params.identity.runId,
    path,
    appendAgentQueued: async (event) => {
      await enqueueAppend({
        type: "agent_queued",
        index: event.index,
        label: event.label,
        phase: event.phase,
        subagentType: event.subagentType,
        runId: event.runRecord?.runId,
      });
    },
    appendAgentResult: async (event) => {
      await enqueueAppend({
        type: "agent_result",
        index: event.index,
        fingerprint: event.fingerprint,
        label: event.label,
        phase: event.phase,
        subagentType: event.subagentType,
        prompt: event.prompt,
        ...(event.context ? { context: event.context } : {}),
        schema: event.schema,
        cached: event.cached,
        failed: event.failed === true,
        runId: event.runId,
        error: event.error,
        result: event.result,
      });
    },
    complete: async (result) => {
      await enqueueAppend({ type: "run_complete", result });
    },
    fail: async (error, outcome = "failed") => {
      await enqueueAppend({ type: "run_error", error, outcome });
    },
  };
}

function workflowJournalPath(dir: string, runId: string): string {
  return join(dir, `run-${runId}.jsonl`);
}

async function appendJsonLine(path: string, value: unknown): Promise<void> {
  await appendFile(path, `${JSON.stringify(value)}\n`, "utf8");
}

function safeFilePart(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "workflow";
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";
}
