/**
 * Human-facing row/line formatting shared between `/external runs` (a
 * command-palette browser over plain text) and the `external_runs` tool's
 * own `renderCall`/`renderResult` (a live TUI card) — one formatting source
 * for "what does one run/workflow row say", reused across both surfaces
 * instead of two independently drifting presentations.
 */

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** ~s/m/h duration label for a millisecond value, or undefined when absent/invalid. Human-readable only — never a second timing source. */
export function formatDurationMs(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  if (value < 1_000) return `${Math.round(value)}ms`;
  const seconds = value / 1_000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${minutes.toFixed(1)}m`;
  return `${(minutes / 60).toFixed(1)}h`;
}

/** One list-row label: kind, ID, short description, status, queue/elapsed duration, live activity age, and output/final availability — best-effort per field, since live, historical, and workflow shapes each carry a different subset. */
export function formatRunRow(kind: "Run" | "Workflow", item: Record<string, unknown>): string {
  const state = object(item.state);
  const status = String(state.status ?? item.status ?? "unknown");
  const task = object(item.task);
  const description = typeof item.description === "string" && item.description
    ? item.description
    : typeof task.description === "string" && task.description
      ? task.description
      : typeof task.name === "string" && task.name
        ? task.name
        : undefined;
  const timing = object(item.timing);
  // A still-queued row has no queueDelayMs yet (it only exists once execution
  // starts), so without this a genuinely queued row would show no duration at
  // all. Compute a live "how long has it been queued" age directly from the
  // existing queuedAt timestamp at render time — no new timer, no new
  // evidence field — and only for an entry the registry itself confirms is
  // still live (`item.live === true`): an orphaned durable row with a
  // stale "queued"-looking status but no live registry entry must never get
  // a fabricated, ever-growing age.
  const queuedAtMs = typeof timing.queuedAt === "string" ? Date.parse(timing.queuedAt) : NaN;
  const queueAgeMs = item.live === true && status === "queued" && Number.isFinite(queuedAtMs)
    ? Math.max(0, Date.now() - queuedAtMs)
    : undefined;
  const timingLabel = typeof timing.elapsedMs === "number"
    ? `elapsed ${formatDurationMs(timing.elapsedMs)}`
    : queueAgeMs !== undefined
      ? `queued ${formatDurationMs(queueAgeMs)}`
      : typeof timing.queueDelayMs === "number"
        ? `queued ${formatDurationMs(timing.queueDelayMs)}`
        : undefined;
  const activityAge = typeof timing.activityAgeMs === "number" ? `active ${formatDurationMs(timing.activityAgeMs)} ago` : undefined;
  const output = object(item.output);
  const outputAvailable = item.outputAvailable === true || output.available === true;
  const finalAvailable = item.finalAvailable === true || output.finalAvailable === true;
  const outputLabel = finalAvailable ? "final ready" : outputAvailable ? "output available" : undefined;
  return [`${kind} ${String(item.runId)}`, description, status, timingLabel, activityAge, outputLabel]
    .filter((part): part is string => Boolean(part))
    .join(" · ");
}

/** One wait-target row: marker-free status word, description/id, and freshness — the same shape whether the target is settled or still being watched. */
export function formatWaitTargetRow(target: Record<string, unknown>): string {
  const description = typeof target.description === "string" && target.description ? target.description : String(target.runId);
  const status = String(target.status ?? "unknown");
  const activity = Array.isArray(target.activity) ? target.activity.filter((line): line is string => typeof line === "string") : [];
  const lastActivityAt = typeof target.lastActivityAt === "number" ? target.lastActivityAt : undefined;
  const age = lastActivityAt !== undefined ? `activity ${formatDurationMs(Math.max(0, Date.now() - lastActivityAt))} ago` : undefined;
  const outcome = typeof target.outcome === "string" ? target.outcome : undefined;
  const parts = [description, status, outcome, age].filter((part): part is string => Boolean(part));
  const line = parts.join(" · ");
  return activity.length ? `${line}\n    ${activity[activity.length - 1]}` : line;
}
