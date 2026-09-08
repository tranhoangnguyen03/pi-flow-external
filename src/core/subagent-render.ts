import type { Theme } from "@earendil-works/pi-coding-agent";
import { Container, Text, TruncatedText } from "@earendil-works/pi-tui";
import { getBackendAgentLabel } from "./display.ts";
import { formatParentContext, type ParentContextReceipt } from "./parent-context.ts";
import { SPINNER_FRAMES } from "./spinner.ts";
import type { PermissionTier, SubagentBackend, SubagentRunStatus, SubagentUsage } from "../types.ts";
export { SPINNER_FRAMES, SPINNER_INTERVAL_MS } from "./spinner.ts";

const ACTIVITY_DISPLAY_PREVIEW_CHARS = 120;
export const RICH_SUBAGENT_ACTIVE_LIMIT = 4;

export interface RenderableSubagentNode {
  context?: ParentContextReceipt;
  description?: string;
  label?: string;
  subagentType?: string;
  backend?: SubagentBackend;
  status: SubagentRunStatus;
  startedAt?: number;
  endedAt?: number;
  activity?: string[];
  activityCount?: number;
  result?: string;
  error?: string;
  timedOut?: boolean;
  usage?: SubagentUsage;
  runId?: string;
  recordPath?: string;
  backendEventCount?: number;
  nestedActivitySeen?: boolean;
  nestedTimeoutExtended?: boolean;
  effectiveTimeoutMs?: number;
  recordingError?: string;
  externalRunId?: string;
  permission?: PermissionTier;
  permissionEnforced?: boolean;
  permissionDenials?: number;
  maxBudgetUsd?: number;
  sessionId?: string;
  resumedFrom?: string;
}

export function isActiveSubagentStatus(status: SubagentRunStatus): boolean {
  return status === "queued" || status === "running";
}

export function isCompletedSubagentStatus(status: SubagentRunStatus): boolean {
  return status === "done";
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  if (hours > 0) {
    return `${hours}h${minutes}m${seconds}s`;
  }
  if (minutes > 0) {
    return `${minutes}m${seconds}s`;
  }
  return `${seconds}s`;
}

export function formatTokens(count: number): string {
  if (count < 1000) {
    return count.toString();
  }
  if (count < 10000) {
    return `${(count / 1000).toFixed(1)}k`;
  }
  if (count < 1000000) {
    return `${Math.round(count / 1000)}k`;
  }
  if (count < 10000000) {
    return `${(count / 1000000).toFixed(1)}M`;
  }
  return `${Math.round(count / 1000000)}M`;
}

export function formatUsage(usage: SubagentUsage): string {
  const parts = [`↑${formatTokens(usage.input)}`, `↓${formatTokens(usage.output)}`];
  if (usage.cacheRead) {
    parts.push(`R${formatTokens(usage.cacheRead)}`);
  }
  if (usage.cacheWrite) {
    parts.push(`W${formatTokens(usage.cacheWrite)}`);
  }
  if ((usage.cacheRead > 0 || usage.cacheWrite > 0) && usage.latestCacheHitRate !== undefined) {
    parts.push(`CH${usage.latestCacheHitRate.toFixed(1)}%`);
  }
  return parts.join(" ");
}

export function subagentMarker(status: SubagentRunStatus, theme: Theme, frame: number, timedOut = false): string {
  if (status === "running") return theme.fg("accent", SPINNER_FRAMES[frame % SPINNER_FRAMES.length]);
  if (status === "queued") return theme.fg("muted", "◌");
  if (isCompletedSubagentStatus(status)) return theme.fg("success", "✓");
  if (timedOut) return theme.fg("warning", "⏱");
  if (status === "aborted") return theme.fg("warning", "⊘");
  return theme.fg("error", "✗");
}

function formatActivityLineForDisplay(line: string): string {
  if (line.length <= ACTIVITY_DISPLAY_PREVIEW_CHARS) {
    return line;
  }
  const hiddenChars = line.length - ACTIVITY_DISPLAY_PREVIEW_CHARS;
  return `${line.slice(0, ACTIVITY_DISPLAY_PREVIEW_CHARS).trimEnd()} ... (+${hiddenChars} chars)`;
}

function nodeType(node: RenderableSubagentNode): string {
  return node.subagentType || "agent";
}

function nodeLabel(node: RenderableSubagentNode): string {
  return (node.label ?? node.description ?? "").trim();
}

function compactTitle(node: RenderableSubagentNode): string {
  const label = nodeLabel(node);
  return `${getBackendAgentLabel(node.backend)}(${nodeType(node)}${label ? `, ${label}` : ""})`;
}

function richTitle(node: RenderableSubagentNode): string {
  const label = nodeLabel(node);
  return `${getBackendAgentLabel(node.backend)}(${nodeType(node)}${label ? `: ${label}` : ""})`;
}

function formatRuntimeAndUsage(node: RenderableSubagentNode, now: number, showAccess = true): string {
  const parts: string[] = [];
  if (showAccess && isActiveSubagentStatus(node.status)) {
    parts.push("external host access");
  }
  if (node.context) parts.push(`context ${node.context.mode} (${node.context.sharedTurns} turns)`);
  if (node.permission && node.permission !== "danger") {
    parts.push(node.permissionEnforced === false ? `${node.permission} (advisory)` : node.permission);
  }
  if (node.permissionDenials && node.permissionDenials > 0) {
    parts.push(`${node.permissionDenials} permission denials`);
  }
  if (node.maxBudgetUsd !== undefined && node.backend && node.backend !== "claude") {
    parts.push("budget unenforceable");
  }
  const startedAt = node.startedAt;
  if (typeof startedAt === "number") {
    const duration = formatDuration((node.endedAt ?? now) - startedAt);
    if (node.status === "queued") {
      parts.push(`queued ${duration}`);
    } else {
      parts.push(duration);
    }
  } else if (node.status === "queued") {
    parts.push("queued");
  }
  if (node.usage) {
    const usage = formatUsage(node.usage);
    if (usage) {
      parts.push(usage);
    }
  }
  const runId = node.runId ?? node.externalRunId;
  if (node.recordingError) {
    parts.push("evidence incomplete");
  } else if (!isActiveSubagentStatus(node.status) && runId) {
    parts.push(`evidence ${runId.slice(-8)}`);
  }
  if (node.nestedActivitySeen) {
    parts.push("nested activity seen");
  }
  if (node.nestedTimeoutExtended) {
    parts.push("timeout extended");
  }
  return parts.join(" ");
}

export function shouldRenderRichSubagent(node: RenderableSubagentNode, runningCount: number): boolean {
  return node.status === "running" && runningCount <= RICH_SUBAGENT_ACTIVE_LIMIT;
}

export function renderCompactSubagentNode(
  node: RenderableSubagentNode,
  theme: Theme,
  frame: number,
  indent = "",
  now = Date.now(),
  showAccess = true,
): Text {
  const status = node.status;
  const bodyColor = status === "error" || status === "aborted" ? "error" : "muted";
  const runtime = formatRuntimeAndUsage(node, now, showAccess);
  const detail = node.error && (status === "error" || status === "aborted")
    ? `${node.timedOut ? "timed out" : status}: ${node.error}`
    : "";
  const meta = [runtime, detail].filter(Boolean).join(" ");
  const summary = status === "running"
    ? node.activity?.at(-1)
    : status === "done"
      ? node.result?.split("\n").find((line) => line.trim())?.trim()
      : undefined;
  const preview = summary
    ? ` ${theme.fg("muted", `${status === "running" ? "--" : "->"} ${formatActivityLineForDisplay(summary)}`)}`
    : "";
  return new Text(
    `${indent}${subagentMarker(status, theme, frame, node.timedOut)} ${theme.fg(bodyColor, compactTitle(node))}${meta ? ` ${theme.fg("dim", meta)}` : ""}${preview}`,
    0,
    0,
  );
}

export function renderRichSubagentNode(
  node: RenderableSubagentNode,
  theme: Theme,
  frame: number,
  indent = "",
  now = Date.now(),
  showAccess = true,
): Container {
  const container = new Container();
  const status = node.status;
  const meta = formatRuntimeAndUsage({ ...node, status }, now, showAccess);
  container.addChild(
    new Text(
      `${indent}${subagentMarker(status, theme, frame, node.timedOut)} ${theme.bold(richTitle(node))}${meta ? ` ${theme.fg("dim", meta)}` : ""}`,
      0,
      0,
    ),
  );

  const activity = node.activity ?? [];
  const activityCount = node.activityCount ?? activity.length;
  const skipped = activityCount - activity.length;
  if (skipped > 0) {
    container.addChild(new Text(`${indent}  ${theme.fg("muted", `... +${skipped} earlier events`)}`, 0, 0));
  }
  for (const line of activity) {
    container.addChild(new TruncatedText(`${indent}  ${theme.fg("muted", formatActivityLineForDisplay(line))}`, 0, 0));
  }

  if (node.error) {
    container.addChild(new Text(`${indent}  ${theme.fg("error", node.error)}`, 0, 0));
  }

  return container;
}

export function renderSubagentNode(
  node: RenderableSubagentNode,
  theme: Theme,
  frame: number,
  runningCount: number,
  indent = "",
  now = Date.now(),
  expanded = false,
  showAccess = true,
): Text | Container {
  const rendered = shouldRenderRichSubagent(node, runningCount)
    ? renderRichSubagentNode(node, theme, frame, indent, now, showAccess)
    : renderCompactSubagentNode(node, theme, frame, indent, now, showAccess);
  if (!expanded || isActiveSubagentStatus(node.status)) {
    return rendered;
  }

  const container = new Container();
  container.addChild(rendered);
  if (node.context) container.addChild(new Text(`${indent}  ${theme.fg("dim", formatParentContext(node.context))}`, 0, 0));
  if (node.recordPath) {
    const events = node.backendEventCount === undefined ? "" : ` · ${node.backendEventCount} backend events`;
    container.addChild(new Text(`${indent}  ${theme.fg("dim", `Evidence ${node.recordPath}${events}`)}`, 0, 0));
  }
  if (node.recordingError) {
    container.addChild(new Text(`${indent}  ${theme.fg("warning", `Evidence incomplete: ${node.recordingError}`)}`, 0, 0));
  }
  return container;
}
