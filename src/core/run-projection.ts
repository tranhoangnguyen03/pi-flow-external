import type { RunRecordListItem, RunTiming } from "./run-inspection.ts";
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
  project?: string;
  parentSessionId?: string;
  workflowRunId?: string;
}

export interface RunStateProjection {
  status: string;
  outcome?: string;
  queuedAt?: string;
  settledAt?: number;
  error?: string;
  integrity?: string;
}

export interface RunOutputProjection {
  available: boolean;
  finalAvailable: boolean;
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
