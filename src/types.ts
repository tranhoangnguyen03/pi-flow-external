import type { ParentContextReceipt } from "./core/parent-context.ts";
import type { ChildRunOutcome, WorkflowMetaPhase } from "./workflow/types.ts";

export type SubagentType = string;
export const EXTERNAL_HARNESSES = ["agy", "claude", "codex", "grok", "muse"] as const;
export type ExternalHarness = (typeof EXTERNAL_HARNESSES)[number];
export type SubagentBackend = "pi" | ExternalHarness;
export type ThinkingLevel = string;

/**
 * Permission tier chosen by the orchestrator. `danger` is the default and
 * matches the historical unsandboxed behavior. Tiers map onto native
 * harness mechanisms where they exist; unsupported combinations are labeled
 * advisory rather than blocked (trust + disclose).
 */
export type PermissionTier = "readonly" | "edit" | "danger";

export interface SubagentProfile {
  name: string;
  description: string;
  backend: SubagentBackend;
  /**
   * Which configuration to use. For claude/codex/agy/grok/muse this always equals
   * `backend`. For a pi-backed profile, `backend` is always the literal "pi"
   * while `harness` names the specific registered `pi-*` configuration
   * (see src/harnesses.ts) that pins its model and thinking level.
   */
  harness?: string;
  model?: string;
  thinking?: ThinkingLevel;
  tools?: string[];
  systemPrompt?: string;
  /** Default tier for calls using this profile; the call parameter wins. */
  permission?: PermissionTier;
  /** Default USD budget cap for calls using this profile; the call parameter wins. */
  maxBudgetUsd?: number;
  /** Ownership tag. "user" marks profiles authored by the user. */
  owner?: string;
}

export interface SubagentExtensionOptions {
  /**
   * Maximum number of subagents allowed to run concurrently across the whole
   * agent run (a global in-flight cap, not a per-level fan-out width). A slot is
   * taken when a subagent launches and released when it completes, fails, or is
   * aborted. The cap is shared by the `Agent` tool and the `workflow` tool.
   */
  maxConcurrentSubagents?: number;
  /**
   * Maximum wall-clock runtime for each launched subagent, in milliseconds.
   * Defaults to a generous global guardrail. Set to 0 to disable. The limit is
   * shared by direct `Agent` calls and workflow `agent()` calls, and can also
   * be overridden with `--subagent-timeout-ms`.
   */
  subagentTimeoutMs?: number;
  /**
   * Register the dynamic `workflow` tool alongside `Agent`. Defaults to true:
   * one product, two entry points. Set to false for a subagents-only surface.
   */
  workflow?: boolean;
}

export type FlowExtensionOptions = SubagentExtensionOptions;

export type SubagentRunStatus = "queued" | "running" | "done" | "error" | "aborted";

/** A pi child's requested thinking level was clamped to what its resolved model actually supports. */
export interface ThinkingClamp {
  requested: string;
  effective: string;
}

export interface SubagentAssistantOutput {
  status: "preliminary" | "final" | "interrupted";
  messages: Array<{ id?: string; text: string }>;
}

export interface WorkflowAgentSnapshot {
  context?: ParentContextReceipt;
  index: number;
  label: string;
  phase?: string;
  subagentType?: string;
  backend?: SubagentBackend;
  /** Resolved harness name (registered pi-* config, or equal to backend for agy/claude/codex). Persisted explicitly — never reparsed from subagentType/label. */
  harness?: string;
  status: SubagentRunStatus;
  startedAt?: number;
  queuedAt?: number;
  processStartedAt?: number;
  firstActivityAt?: number;
  lastActivityAt?: number;
  endedAt?: number;
  activity?: string[];
  activityCount?: number;
  result?: string;
  error?: string;
  assistantOutput?: SubagentAssistantOutput;
  timedOut?: boolean;
  usage?: SubagentUsage;
  /** Local field-observation run ID for this external child. */
  externalRunId?: string;
  recordPath?: string;
  backendEventCount?: number;
  nestedActivitySeen?: boolean;
  nestedTimeoutExtended?: boolean;
  effectiveTimeoutMs?: number;
  recordingError?: string;
  /** Resolved permission tier for this run. */
  permission?: PermissionTier;
  /** Tier explicitly requested by the caller when it differs from the resolved tier. */
  permissionRequested?: PermissionTier;
  /** False when the tier is advisory on this backend (instruction, not enforcement). */
  permissionEnforced?: boolean;
  /** Permission denials reported by the backend (claude plan/acceptEdits runs). */
  permissionDenials?: number;
  /** Resolved USD budget cap, when any. */
  maxBudgetUsd?: number;
  /** Backend conversation/session id for later resume. */
  sessionId?: string;
  /** Prior run id this run continued, when resuming. */
  resumedFrom?: string;
  /** Set when a pi child's requested thinking level was clamped by model capability. */
  thinkingClamped?: ThinkingClamp;
  /** Attempts retried for this run (agy infra failures retry once). */
  retries?: number;
  /** Error message of the retried-away first attempt, for transparency. */
  retryOf?: string;
}

export interface WorkflowToolDetails {
  name: string;
  status: "running" | "completed" | "error" | "aborted";
  /**
   * `status` normalized to the same vocabulary `Agent`'s `SubagentToolDetails.status`
   * already uses ("done" rather than the legacy internal "completed"), so a
   * coordinating model reading either tool's details sees one lifecycle
   * vocabulary. Additive: `status` itself is unchanged for existing readers
   * (journal/replay/rendering internals) that depend on the literal "completed".
   */
  lifecycleStatus?: SubagentRunStatus;
  outcome?: "succeeded" | ChildRunOutcome;
  agentCount: number;
  phases: string[];
  plannedPhases?: WorkflowMetaPhase[];
  currentPhase?: string;
  agents: WorkflowAgentSnapshot[];
  logs: string[];
  source?: "inline" | "saved" | "path";
  sourcePath?: string;
  scriptPath?: string;
  runId?: string;
  journalPath?: string;
  resumeFromRunId?: string;
  cachedAgentCount?: number;
  result?: unknown;
  error?: string;
  /** Monotonic spinner frame, advanced by the runtime heartbeat while agents run. */
  frame?: number;
}

export interface SubagentUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Dollar cost to include in aggregate status. Unknown external costs are represented as 0. */
  cost: number;
  /** False when an external backend did not expose cost and no local price table entry matched. */
  costKnown?: boolean;
  /** True when cost was estimated locally from token usage instead of reported by the backend. */
  costEstimated?: boolean;
  latestCacheHitRate?: number;
}

export interface SubagentProgressNode {
  context?: ParentContextReceipt;
  id: string;
  description: string;
  subagentType: SubagentType | "unknown";
  backend?: SubagentBackend;
  /** Resolved harness name (registered pi-* config, or equal to backend for agy/claude/codex). Persisted explicitly — never reparsed from subagentType/label. */
  harness?: string;
  status: SubagentRunStatus;
  startedAt: number;
  queuedAt?: number;
  endedAt?: number;
  activity: string[];
  activityCount: number;
  result?: string;
  error?: string;
  assistantOutput?: SubagentAssistantOutput;
  /** Execution-start boundary: immediately after the shared concurrency limiter granted this run a slot. */
  executionStartedAt?: number;
  processStartedAt?: number;
  firstActivityAt?: number;
  lastActivityAt?: number;
  timedOut?: boolean;
  usage?: SubagentUsage;
  /** Local field-observation run ID for this external invocation. */
  runId?: string;
  /** Directory containing the local event transcript and summary. */
  recordPath?: string;
  /** Number of structured backend events captured in the local transcript. */
  backendEventCount?: number;
  /** True when the backend stream exposed nested-agent activity. */
  nestedActivitySeen?: boolean;
  /** True when observed nested work received the one-time deadline extension. */
  nestedTimeoutExtended?: boolean;
  effectiveTimeoutMs?: number;
  /** Set when the agent result is valid but its local observation record is incomplete. */
  recordingError?: string;
  /** Resolved permission tier for this run. */
  permission?: PermissionTier;
  /** Tier explicitly requested by the caller when it differs from the resolved tier. */
  permissionRequested?: PermissionTier;
  /** False when the tier is advisory on this backend (instruction, not enforcement). */
  permissionEnforced?: boolean;
  /** Permission denials reported by the backend (claude plan/acceptEdits runs). */
  permissionDenials?: number;
  /** Resolved USD budget cap, when any. */
  maxBudgetUsd?: number;
  /** Backend conversation/session id for later resume. */
  sessionId?: string;
  /** Prior run id this run continued, when resuming. */
  resumedFrom?: string;
  /** Set when a pi child's requested thinking level was clamped by model capability. */
  thinkingClamped?: ThinkingClamp;
}

export interface SubagentToolDetails {
  context?: ParentContextReceipt;
  description: string;
  subagentType: SubagentType | "unknown";
  backend?: SubagentBackend;
  /** Resolved harness name (registered pi-* config, or equal to backend for agy/claude/codex). Persisted explicitly — never reparsed from subagentType/label. */
  harness?: string;
  status: SubagentRunStatus;
  result?: string;
  error?: string;
  assistantOutput?: SubagentAssistantOutput;
  timedOut?: boolean;
  usage?: SubagentUsage;
  progress?: SubagentProgressNode;
  /** Local field-observation run ID for this external invocation. */
  runId?: string;
  /** Directory containing the local event transcript and summary. */
  recordPath?: string;
  /** Number of structured backend events captured in the local transcript. */
  backendEventCount?: number;
  /** True when the backend stream exposed nested-agent activity. */
  nestedActivitySeen?: boolean;
  /** True when observed nested work received the one-time deadline extension. */
  nestedTimeoutExtended?: boolean;
  effectiveTimeoutMs?: number;
  /** Set when the agent result is valid but its local observation record is incomplete. */
  recordingError?: string;
  /** Number of currently running subagents, used to choose rich vs compact live rendering. */
  activeCount?: number;
  /** Attempts retried for this run (agy infra failures retry once). */
  retries?: number;
  /** Error message of the retried-away first attempt, for transparency. */
  retryOf?: string;
  frame?: number;
  /** Resolved permission tier for this run. */
  permission?: PermissionTier;
  /** Tier explicitly requested by the caller when it differs from the resolved tier. */
  permissionRequested?: PermissionTier;
  /** False when the tier is advisory on this backend (instruction, not enforcement). */
  permissionEnforced?: boolean;
  /** Permission denials reported by the backend (claude plan/acceptEdits runs). */
  permissionDenials?: number;
  /** Resolved USD budget cap, when any. */
  maxBudgetUsd?: number;
  /** Backend conversation/session id for later resume. */
  sessionId?: string;
  /** Prior run id this run continued, when resuming. */
  resumedFrom?: string;
  /** Set when a pi child's requested thinking level was clamped by model capability. */
  thinkingClamped?: ThinkingClamp;
}
