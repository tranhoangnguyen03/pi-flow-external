import { deriveRunTiming, type RunRecordListItem, type RunTiming } from "./run-inspection.ts";
import type { RegisteredRunEntry } from "./run-registry.ts";
import type { SubagentRunStatus } from "../types.ts";

/**
 * Normalize a legacy internal lifecycle word to the vocabulary every other
 * surface already uses (`SubagentRunStatus`). Workflow's own runtime state
 * keeps the literal "completed" internally (existing journal readers and
 * `WorkflowToolDetails.status` depend on it), so this mapping happens only at
 * projection boundaries: the model/human-facing fields built from that state,
 * never the state machine itself.
 */
export function normalizeRunStatus(status: string): SubagentRunStatus {
  return status === "completed" ? "done" : (status as SubagentRunStatus);
}

export interface RunTaskProjection {
  description?: string;
  backend?: string;
  profile?: string;
  /** Resolved harness (registered pi-* config, or equal to backend for agy/claude/codex). Persisted explicitly — never reparsed from profile/subagentType. */
  harness?: string;
  project?: string;
  parentSessionId?: string;
  workflowRunId?: string;
}

/**
 * `status` is the one guaranteed field; live and durable evidence otherwise
 * carry genuinely different raw diagnostics (live: startedAt/activityCount/
 * in-memory timestamps; durable: settledAt/integrity from the written
 * summary), so this stays open rather than forcing an identical field set
 * onto sources with different actual data.
 */
export interface RunStateProjection {
  status: string;
  [key: string]: unknown;
}

export interface RunOutputProjection {
  available: boolean;
  /** "preliminary" | "final" | "interrupted" — omitted where a caller has no comparable notion (e.g. a bare agent list row). */
  status?: string;
  finalAvailable: boolean;
  [key: string]: unknown;
}

export interface AgentRunProjection {
  runId: string;
  kind: "agent";
  live: boolean;
  task: RunTaskProjection;
  state: RunStateProjection;
  timing: RunTiming;
  output: RunOutputProjection;
}

export function compact<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Partial<T>;
}

/**
 * The single durable-agent projection: identity/state/timing/output nested
 * under `task`/`state`/`output`, reused by `external-runs.ts`'s single-run
 * `inspect` durable branch, batch `inspect`, and (with legacy flat fields
 * spread alongside for compatibility — see CHANGELOG) `list`'s `runs` rows.
 * Building this once here, instead of independently in each call site,
 * removes the shape drift a durable agent row previously had relative to a
 * live one (see docs/plans/2026-09-21-unified-run-experience-design.md).
 */
export function projectDurableAgent(durable: RunRecordListItem): AgentRunProjection {
  return {
    runId: durable.runId,
    kind: "agent",
    live: false,
    task: compact({
      description: durable.description,
      backend: durable.backend,
      profile: durable.profile,
      harness: durable.harness,
      project: durable.project,
      parentSessionId: durable.parentSessionId,
      workflowRunId: durable.workflowRunId,
    }),
    state: {
      status: durable.integrity === "complete" ? durable.status ?? "queued" : "interrupted_or_uncertain",
      ...compact({
        outcome: durable.outcome,
        queuedAt: durable.queuedAt,
        settledAt: durable.settledAt,
        error: durable.error,
        integrity: durable.integrity,
      }),
    },
    timing: durable.timing,
    output: { available: durable.outputAvailable, finalAvailable: durable.finalAvailable },
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function boundedString(value: unknown, max = 512): string | undefined {
  return typeof value === "string" && value ? (value.length > max ? `${value.slice(0, max - 1)}…` : value) : undefined;
}

/**
 * `entry` must be a live RunRegistry entry (resolved via `registry.get`), so
 * — unlike anything read through durable evidence — it is independently
 * confirmed by the registry, not merely a record whose status field happens
 * to read "running". This is the ONLY condition under which
 * `deriveRunTiming`'s `live: true` (now-relative elapsedMs/activityAgeMs)
 * may be used.
 *
 * The single live-agent projection: identity/state/timing/output nested the
 * same way `projectDurableAgent` nests a durable one, reused by
 * `external-runs.ts`'s single-run `inspect`, `list`, and batch `inspect` for
 * a live target — removing three independent hand-rolled builders
 * (`liveAgentSummary`, `listedAgent`, and batch inspect's own inline object)
 * that previously could drift on which fields they read from `observation`.
 */
export function projectLiveAgent(entry: RegisteredRunEntry): AgentRunProjection {
  const observation = record(entry.observation);
  const assistantOutput = record(observation?.assistantOutput);
  const finalAvailable = entry.outcome?.status === "done" && entry.outcome?.result !== undefined;
  return {
    runId: entry.runId,
    kind: "agent",
    live: entry.state === "running",
    task: compact({
      description: boundedString(observation?.description),
      backend: typeof observation?.backend === "string" ? observation.backend : undefined,
      // The resolved profile/subagentType name is already the same value a
      // durable record persists as `profile` — read directly, never
      // reparsed or guessed from anything else.
      profile: typeof observation?.subagentType === "string" && observation.subagentType !== "unknown" ? observation.subagentType : undefined,
      harness: typeof observation?.harness === "string" ? observation.harness : undefined,
      workflowRunId: entry.workflowRunId,
    }),
    state: {
      // A settled entry.outcome is the registry's own authoritative
      // conclusion, set exactly once by RunRegistry.settle(); prefer it over
      // observation.status (an ambient, unvalidated passthrough that could
      // in principle lag or diverge) whenever it exists, falling back to
      // observation.status only pre-settlement.
      status: entry.outcome?.status ?? (typeof observation?.status === "string" ? observation.status : "running"),
      outcome: entry.outcome?.outcome,
      settledAt: entry.outcome?.settledAt,
      queuedAt: observation?.queuedAt,
      startedAt: observation?.startedAt,
      processStartedAt: observation?.processStartedAt,
      firstActivityAt: observation?.firstActivityAt,
      lastActivityAt: observation?.lastActivityAt,
      activityCount: observation?.activityCount,
      endedAt: observation?.endedAt,
      error: boundedString(entry.outcome?.error ?? (typeof observation?.error === "string" ? observation.error : undefined)),
    },
    timing: deriveRunTiming({
      queuedAt: numberValue(observation?.queuedAt),
      executionStartedAt: numberValue(observation?.executionStartedAt),
      processStartedAt: numberValue(observation?.processStartedAt),
      firstActivityAt: numberValue(observation?.firstActivityAt),
      lastActivityAt: numberValue(observation?.lastActivityAt),
      finishedAt: entry.outcome?.settledAt,
    }, entry.state === "running"),
    output: {
      available: entry.outcome?.result !== undefined || Array.isArray(assistantOutput?.messages),
      status: entry.state === "running" ? "preliminary" : entry.outcome?.outcome === "succeeded" ? "final" : "interrupted",
      finalAvailable,
    },
  };
}

export interface WorkflowRunProjection {
  runId: string;
  kind: "workflow";
  live: boolean;
  task: { name?: string; source?: string };
  state: RunStateProjection;
  timing: Record<string, never>;
  output: RunOutputProjection;
}

/**
 * The single workflow run-level projection (root identity/state/output, NOT
 * the child roster — see `WorkflowAgentSnapshot`/`WorkflowToolDetails` for
 * that), reused by `liveSummary`, `journalSummary`, and the workflow branch
 * of batch `resolveRunSummaryEntry`. Fixes a real drift: `resolveRunSummaryEntry`
 * previously omitted `output.status` entirely while the other two computed
 * it, and `liveSummary` never stated a top-level `live` flag at all. Callers
 * remain free to add their own extras (`children`, `workflowRunId`, batch
 * `outputRef`/`diagnosticsRef`) on top — this only owns the part that must
 * not diverge.
 */
export function projectWorkflowRun(input: {
  runId: string;
  live: boolean;
  name?: string;
  source?: string;
  /** Raw lifecycle word: "running" | "done" | "error" | "aborted" | "interrupted_or_uncertain". */
  status: string;
  outcome?: string;
  error?: string;
  agentCount?: number;
  resultAvailable: boolean;
  finalAvailable: boolean;
}): WorkflowRunProjection {
  return {
    runId: input.runId,
    kind: "workflow",
    live: input.live,
    task: compact({ name: input.name, source: input.source }),
    state: {
      status: input.status,
      ...compact({ outcome: input.outcome, error: input.error, agentCount: input.agentCount }),
    },
    // No per-workflow queue/elapsed timing is derived anywhere today (unlike
    // agents, which always have deriveRunTiming); kept as an explicit empty
    // object rather than an absent key so every AgentRunProjection/
    // WorkflowRunProjection consumer can rely on `.timing` always existing.
    timing: {},
    output: {
      available: input.resultAvailable,
      status: input.live ? "preliminary" : input.status === "done" ? "final" : "interrupted",
      finalAvailable: input.finalAvailable,
    },
  };
}
