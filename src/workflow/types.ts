import type { ParentContextMessages, ParentContextReceipt } from "../core/parent-context.ts";
import type { ConcurrencyLimiter } from "../core/concurrency.ts";
import type { RunRecord } from "../core/run-record.ts";

export type ChildRunOutcome = "failed" | "cancelled" | "timed_out";

export interface ChildRunReference {
  runId: string;
  view: "output" | "diagnostics";
}

export interface SerializedChildRunError {
  runId: string;
  outcome: ChildRunOutcome;
  message: string;
  outputRef?: ChildRunReference;
  diagnosticsRef?: ChildRunReference;
}

export class ChildRunError extends Error {
  readonly runId: string;
  readonly outcome: ChildRunOutcome;
  readonly outputRef?: ChildRunReference;
  readonly diagnosticsRef?: ChildRunReference;

  constructor(error: SerializedChildRunError) {
    super(error.message);
    this.name = "ChildRunError";
    this.runId = error.runId;
    this.outcome = error.outcome;
    this.outputRef = error.outputRef;
    this.diagnosticsRef = error.diagnosticsRef;
  }
}

export function childRunErrorData(error: ChildRunError): SerializedChildRunError {
  return {
    runId: error.runId,
    outcome: error.outcome,
    message: error.message,
    ...(error.outputRef ? { outputRef: error.outputRef } : {}),
    ...(error.diagnosticsRef ? { diagnosticsRef: error.diagnosticsRef } : {}),
  };
}

export interface WorkflowMetaPhase {
  title: string;
  detail?: string;
  model?: string;
}

export interface WorkflowMeta {
  apiVersion: typeof WORKFLOW_API_VERSION;
  name: string;
  description: string;
  phases?: WorkflowMetaPhase[];
}

export const WORKFLOW_API_VERSION = 1 as const;

/** A single agent() invocation requested by a workflow script. */
export interface WorkflowAgentCall {
  /** Receipt for the frozen parent snapshot this child received, when sharing was requested. */
  context?: ParentContextReceipt;
  index?: number;
  prompt: string;
  label: string;
  phase?: string;
  subagentType: string;
  /** JSON Schema for structured output from the child subagent. */
  schema?: unknown;
  /** Permission tier for this child (call > profile > settings default). */
  permission?: import("../types.ts").PermissionTier;
  /** USD budget cap for this child, when any. */
  maxBudgetUsd?: number;
  /** Prior run id whose backend conversation this child continues. */
  resumeRunId?: string;
  /** Evidence allocated before the call waits for a global concurrency slot. */
  runRecord?: RunRecord;
}

export interface WorkflowCachedAgentResult {
  index: number;
  fingerprint: string;
  result: unknown;
  failed?: boolean;
  runId?: string;
}

export interface WorkflowAgentResultEvent extends WorkflowCachedAgentResult {
  context?: ParentContextReceipt;
  label: string;
  phase?: string;
  subagentType: string;
  prompt: string;
  schema?: unknown;
  cached: boolean;
  error?: SerializedChildRunError;
}

export interface WorkflowAgentQueuedEvent {
  index: number;
  label: string;
  phase?: string;
  subagentType: string;
  prompt: string;
  context?: ParentContextReceipt;
  runRecord?: RunRecord;
}

/**
 * Runs one subagent and resolves with its final text. The workflow tool
 * supplies the real implementation (profile resolution + spawnSubagent); tests
 * inject a fake. Unsuccessful children throw ChildRunError unless the workflow
 * itself is aborting.
 */
export type WorkflowAgentRunner = (
  call: WorkflowAgentCall,
  signal: AbortSignal | undefined,
) => Promise<unknown>;

export interface WorkflowLimits {
  /** Hard cap on agent() calls per workflow run, including cached calls. */
  maxAgentCalls: number;
  /** Retained workflow log lines. Further logs are summarized/truncated. */
  maxLogs: number;
  /** Maximum retained characters per workflow log line. */
  maxLogLength: number;
  /** Heartbeat sent by the isolated script worker. */
  workerHeartbeatIntervalMs: number;
  /** Kill the isolated script worker only after this much heartbeat silence. */
  workerStallTimeoutMs: number;
  /** Kill a responsive script that makes no workflow progress and has no active agent calls. */
  workerIdleTimeoutMs: number;
  /** Initial synchronous vm execution timeout before the script's first await. */
  syncExecutionTimeoutMs: number;
  /** Old-generation V8 heap cap for the workflow script worker. */
  workerMaxOldGenerationSizeMb: number;
  /** Young-generation V8 heap cap for the workflow script worker. */
  workerMaxYoungGenerationSizeMb: number;
  /** Worker stack cap. */
  workerStackSizeMb: number;
  /** Cooperative abort grace period before terminating an unresponsive worker. */
  abortGraceMs: number;
}

export interface RunWorkflowOptions {
  parentMessages?: ParentContextMessages;
  parentToolCallId?: string;
  args?: unknown;
  cwd: string;
  signal?: AbortSignal;
  /** Shared global concurrency cap; agent() queues on this. */
  limiter: ConcurrencyLimiter;
  runAgent: WorkflowAgentRunner;
  defaultSubagentType?: string | null;
  /** Resolve role/harness or legacy exact-profile selection before queueing and fingerprinting. */
  resolveSubagentType?: (selection: { role?: string; harness?: string; subagentType?: string }) => string;
  limits?: Partial<WorkflowLimits>;
  onLog?: (message: string) => void;
  onPhase?: (title: string) => void;
  resumeAgentResults?: WorkflowCachedAgentResult[];
  onAgentQueued?: (event: WorkflowAgentQueuedEvent) => void;
  onAgentStart?: (event: { index: number; label: string; phase?: string; subagentType: string; prompt: string; cached?: boolean; runId?: string }) => void;
  onAgentEnd?: (event: { index: number; label: string; phase?: string; result: unknown; cached?: boolean; failed?: boolean; error?: SerializedChildRunError }) => void;
  onAgentResult?: (event: WorkflowAgentResultEvent) => void | Promise<void>;
}

export interface WorkflowRunResult<T = unknown> {
  meta: WorkflowMeta;
  result: T;
  logs: string[];
  phases: string[];
  agentCount: number;
}
