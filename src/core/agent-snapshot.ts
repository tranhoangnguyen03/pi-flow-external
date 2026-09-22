import type { SubagentProgressNode, SubagentToolDetails, WorkflowAgentSnapshot } from "../types.ts";

/**
 * Single source of truth for copying a running child's live progress onto its
 * workflow snapshot row. Previously inlined per-field in `workflow/tool.ts`'s
 * `onProgress` handler; kept here so the running and terminal copies
 * (`applySubagentResultToWorkflowAgent` below) cannot silently drift apart on
 * which fields they carry.
 */
export function applySubagentProgressToWorkflowAgent(agent: WorkflowAgentSnapshot, progress: SubagentProgressNode): void {
  agent.startedAt = progress.startedAt;
  agent.endedAt = progress.endedAt;
  agent.activity = [...progress.activity];
  agent.activityCount = progress.activityCount;
  agent.result = progress.result;
  agent.error = progress.error;
  agent.assistantOutput = progress.assistantOutput;
  agent.processStartedAt = progress.processStartedAt;
  agent.firstActivityAt = progress.firstActivityAt;
  agent.lastActivityAt = progress.lastActivityAt;
  agent.timedOut = progress.timedOut;
  agent.usage = progress.usage;
  agent.status = progress.status;
  agent.sessionId = progress.sessionId;
  agent.resumedFrom = progress.resumedFrom;
  agent.context = progress.context;
  if (progress.thinkingClamped) agent.thinkingClamped = progress.thinkingClamped;
}

/**
 * Single source of truth for copying a finished child's full result details
 * onto its workflow snapshot row. Fixes a real disclosure/evidence gap: the
 * previous inline copy in `workflow/tool.ts` never carried `retries`,
 * `retryOf`, `permissionRequested`, or `thinkingClamped` onto
 * `WorkflowAgentSnapshot`, so a workflow child that retried an agy
 * infrastructure failure (or had its thinking level clamped, or its
 * requested permission tier elevated) silently lost that disclosure the
 * moment it became part of a workflow — a direct `Agent` call never lost it.
 */
export function applySubagentResultToWorkflowAgent(agent: WorkflowAgentSnapshot, resultDetails: SubagentToolDetails): void {
  const progress = resultDetails.progress;
  agent.status = resultDetails.status;
  agent.result = resultDetails.result;
  agent.error = resultDetails.error;
  agent.assistantOutput = resultDetails.assistantOutput;
  agent.processStartedAt = progress?.processStartedAt;
  agent.firstActivityAt = progress?.firstActivityAt;
  agent.lastActivityAt = progress?.lastActivityAt;
  agent.timedOut = resultDetails.timedOut;
  agent.usage = resultDetails.usage;
  agent.externalRunId = resultDetails.runId;
  agent.recordPath = resultDetails.recordPath;
  agent.backendEventCount = resultDetails.backendEventCount;
  agent.nestedActivitySeen = resultDetails.nestedActivitySeen;
  agent.nestedTimeoutExtended = resultDetails.nestedTimeoutExtended;
  agent.effectiveTimeoutMs = resultDetails.effectiveTimeoutMs;
  agent.recordingError = resultDetails.recordingError;
  agent.permission = resultDetails.permission;
  agent.permissionEnforced = resultDetails.permissionEnforced;
  agent.permissionDenials = resultDetails.permissionDenials;
  agent.maxBudgetUsd = resultDetails.maxBudgetUsd;
  agent.sessionId = resultDetails.sessionId;
  agent.resumedFrom = resultDetails.resumedFrom;
  agent.context = resultDetails.context;
  if (resultDetails.permissionRequested !== undefined) agent.permissionRequested = resultDetails.permissionRequested;
  if (resultDetails.retries !== undefined) agent.retries = resultDetails.retries;
  if (resultDetails.retryOf !== undefined) agent.retryOf = resultDetails.retryOf;
  if (resultDetails.capabilities !== undefined) agent.capabilities = resultDetails.capabilities;
  const thinkingClamped = resultDetails.thinkingClamped ?? progress?.thinkingClamped;
  if (thinkingClamped) agent.thinkingClamped = thinkingClamped;
  if (progress) {
    agent.startedAt = progress.startedAt;
    agent.endedAt = progress.endedAt;
    agent.activity = [...progress.activity];
    agent.activityCount = progress.activityCount;
  }
}
