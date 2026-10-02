import { Type, type Static, type TProperties } from "typebox";
import { projectDurableAgent, projectLiveAgent } from "../core/run-projection.ts";
import type { RunRecordListItem } from "../core/run-inspection.ts";
import type { RegisteredRunEntry } from "../core/run-registry.ts";
import type { WorkflowToolDetails } from "../types.ts";
import type { LoadedWorkflowJournal, UnreadableWorkflowJournal } from "../workflow/journal.ts";
import { deliverValue, strings } from "./envelope.ts";

export type EvidenceIntegrity = "complete" | "incomplete" | "damaged" | "unknown";

const inspectRef = Type.Object({ tool: Type.Literal("external_runs"), action: Type.Literal("inspect"), runIds: Type.Array(Type.String()), view: strings("summary", "final", "diagnostics") });
const timing = Type.Object({
  queuedAt: Type.Optional(Type.String()), executionStartedAt: Type.Optional(Type.String()),
  processStartedAt: Type.Optional(Type.String()), firstActivityAt: Type.Optional(Type.String()),
  lastActivityAt: Type.Optional(Type.String()), finishedAt: Type.Optional(Type.String()),
  queueDelayMs: Type.Optional(Type.Number()), elapsedMs: Type.Optional(Type.Number()),
  activityAgeMs: Type.Optional(Type.Number()), processDurationMs: Type.Optional(Type.Number()),
});
const outcome = strings("succeeded", "failed", "cancelled", "timed_out");
const optionalStrings = (...names: string[]): TProperties => Object.fromEntries(names.map((name) => [name, Type.Optional(Type.String())]));

/** One PublicRun builder; each tool declares only the kinds, statuses and fields it can return. */
function publicRunSchema(kind: ReturnType<typeof Type.Literal> | ReturnType<typeof strings>, statuses: ReturnType<typeof strings>, task: TProperties, children: boolean) {
  return Type.Object({
    runId: Type.String(), kind, live: Type.Boolean(),
    task: Type.Object(task),
    state: Type.Object({ status: statuses, outcome: Type.Optional(outcome) }),
    timing,
    output: Type.Object({ available: Type.Boolean(), finalAvailable: Type.Boolean(), delivery: strings("inline", "reference", "none"), value: Type.Optional(Type.Unknown()) }),
    evidence: Type.Object({ integrity: strings("complete", "incomplete", "damaged", "unknown") }),
    ...(children ? { children: Type.Optional(Type.Object({ count: Type.Optional(Type.Integer()), failed: Type.Optional(Type.Integer()) })) } : {}),
    refs: Type.Optional(Type.Object({ summary: inspectRef, final: inspectRef, diagnostics: inspectRef })),
  });
}

export const agentRunSchema = publicRunSchema(Type.Literal("agent"), strings("queued", "running", "done", "error", "aborted"), optionalStrings("description", "profile", "backend", "harness"), false);
export const workflowRunSchema = publicRunSchema(Type.Literal("workflow"), strings("running", "done", "error", "aborted"), optionalStrings("name", "source"), true);
export const supervisedRunSchema = publicRunSchema(
  strings("agent", "workflow"),
  strings("queued", "running", "done", "error", "aborted", "interrupted_or_uncertain"),
  optionalStrings("description", "profile", "backend", "harness", "workflowRunId", "name", "source"),
  true,
);
type InspectRef = Static<typeof inspectRef>;
export interface PublicRun {
  runId: string;
  kind: "agent" | "workflow";
  live: boolean;
  task: Record<string, string>;
  state: { status: "queued" | "running" | "done" | "error" | "aborted" | "interrupted_or_uncertain"; outcome?: Static<typeof outcome> };
  timing: Static<typeof timing>;
  output: { available: boolean; finalAvailable: boolean; delivery: "inline" | "reference" | "none"; value?: unknown };
  evidence: { integrity: EvidenceIntegrity };
  children?: { count?: number; failed?: number };
  refs?: { summary: InspectRef; final: InspectRef; diagnostics: InspectRef };
}

export function runRefs(runId: string): NonNullable<PublicRun["refs"]> {
  const ref = (view: "summary" | "final" | "diagnostics") => ({ tool: "external_runs" as const, action: "inspect" as const, runIds: [runId], view });
  return { summary: ref("summary"), final: ref("final"), diagnostics: ref("diagnostics") };
}

export interface RunDelivery {
  /** Evidence integrity; defaults to incomplete while live, unknown once settled without an evidence read. */
  integrity?: EvidenceIntegrity;
  /** 0 never inlines (list and batch rows). */
  inlineBudget?: number;
  inspectable?: boolean;
}

interface Built { run: PublicRun; redacted: boolean }

function defaultIntegrity(entry: RegisteredRunEntry): EvidenceIntegrity {
  return entry.state === "running" ? "incomplete" : "unknown";
}

function pick(task: Record<string, unknown>, keys: string[]): Record<string, string> {
  return Object.fromEntries(keys.flatMap((key) => typeof task[key] === "string" ? [[key, task[key] as string]] : []));
}

/** Only registry-confirmed entries are live; liveness is never inferred from disk. */
export function liveAgentRun(entry: RegisteredRunEntry, { integrity, inlineBudget = 0, inspectable = true }: RunDelivery = {}): Built {
  const projected = projectLiveAgent(entry);
  const finalAvailable = projected.output.finalAvailable;
  const delivered = deliverValue(entry.outcome?.result, { finalAvailable, inlineBudget, inspectable });
  return {
    run: {
      runId: entry.runId, kind: "agent", live: projected.live,
      task: pick(projected.task as Record<string, unknown>, ["description", "profile", "backend", "harness", "workflowRunId"]),
      state: { status: projected.state.status as PublicRun["state"]["status"], ...(entry.outcome ? { outcome: entry.outcome.outcome } : {}) },
      timing: projected.timing,
      output: { available: projected.output.available, finalAvailable, ...delivered.output },
      evidence: { integrity: integrity ?? defaultIntegrity(entry) },
      ...(inspectable ? { refs: runRefs(entry.runId) } : {}),
    },
    redacted: delivered.redacted,
  };
}

export function durableAgentRun(item: RunRecordListItem): PublicRun {
  const projected = projectDurableAgent(item);
  return {
    runId: item.runId, kind: "agent", live: false,
    task: pick(projected.task as Record<string, unknown>, ["description", "profile", "backend", "harness", "workflowRunId"]),
    state: { status: projected.state.status as PublicRun["state"]["status"], ...(item.outcome ? { outcome: item.outcome } : {}) },
    timing: item.timing,
    output: { available: item.outputAvailable, finalAvailable: item.finalAvailable, delivery: item.finalAvailable ? "reference" : "none" },
    evidence: { integrity: item.integrity },
    refs: runRefs(item.runId),
  };
}

export function liveWorkflowRun(entry: RegisteredRunEntry, { integrity, inlineBudget = 0, inspectable = true }: RunDelivery = {}): Built {
  const observation = entry.observation as WorkflowToolDetails | undefined;
  const status = entry.state === "running" ? "running" : entry.outcome?.status ?? "error";
  const finalAvailable = entry.outcome?.status === "done" && entry.outcome.result !== undefined;
  const delivered = deliverValue(entry.outcome?.result, { finalAvailable, inlineBudget, inspectable });
  const count = observation?.agentCount ?? observation?.agents?.length;
  return {
    run: {
      runId: entry.runId, kind: "workflow", live: entry.state === "running",
      task: pick({ name: observation?.name, source: observation?.source }, ["name", "source"]),
      state: { status, ...(entry.outcome ? { outcome: entry.outcome.outcome } : {}) },
      timing: {},
      output: { available: entry.outcome?.result !== undefined, finalAvailable, ...delivered.output },
      evidence: { integrity: integrity ?? defaultIntegrity(entry) },
      children: { ...(count !== undefined ? { count } : {}), ...(observation?.childFailures !== undefined ? { failed: observation.childFailures } : {}) },
      ...(inspectable ? { refs: runRefs(entry.runId) } : {}),
    },
    redacted: delivered.redacted,
  };
}

export function journalWorkflowRun(journal: LoadedWorkflowJournal): PublicRun {
  const finalAvailable = journal.status === "done" && journal.result !== undefined;
  return {
    runId: journal.runId, kind: "workflow", live: false,
    task: pick({ name: journal.name, source: journal.source }, ["name", "source"]),
    state: { status: journal.status === "running" ? "interrupted_or_uncertain" : journal.status, ...(journal.outcome ? { outcome: journal.outcome } : {}) },
    timing: {},
    output: { available: journal.result !== undefined, finalAvailable, delivery: finalAvailable ? "reference" : "none" },
    evidence: { integrity: journal.integrity },
    children: { count: journal.children.length, ...(journal.childFailures !== undefined ? { failed: journal.childFailures } : {}) },
    refs: runRefs(journal.runId),
  };
}

/** No refs: inspecting an unreadable journal reports its read error rather than a page. */
export function unreadableWorkflowRun(journal: UnreadableWorkflowJournal): PublicRun {
  return {
    runId: journal.runId, kind: "workflow", live: false, task: {},
    state: { status: "interrupted_or_uncertain" },
    timing: {},
    output: { available: false, finalAvailable: false, delivery: "none" },
    evidence: { integrity: journal.integrity },
  };
}
