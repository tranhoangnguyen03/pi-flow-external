# Supervision & Runtime

This guide documents execution lifecycle, delegation transparency, background run management, and operational evidence storage in `pi-flow-external`.

---

## Delegation Transparency & UI

When an external subagent runs, Pi renders an execution card in the terminal:

```text
Delegating Claude Code → claude/explorer · unsandboxed external CLI
Task Map repository architecture
Why Repository exploration through Claude Code.
Context recent · up to 5 user turns
Workspace /path/to/project
⠋ Claude Code(claude/explorer, Map repository architecture) external host access · 12s
```

### Key Indicators
- **Authority Label:** Discloses actual execution authority: `unsandboxed external CLI` for danger tiers, or `Pi SDK child · host access · curated tools` for Pi models.
- **Context Line:** Appears only when conversation history is transferred to the child, ensuring external data transfer is always visible.
- **Expanded Details (Ctrl+O):** Pressing the tool expansion hotkey reveals canonical terminal output, full run ID, local evidence paths, and backend event counts:
  ```text
  ✓ Claude Code(claude/explorer, Map repository architecture) 42s evidence 8f21a004 -> Architecture mapped.
    Final output
    Architecture mapped.
    Run run_... · /external runs for full paged output and diagnostics
    Evidence ~/.pi/agent/pi-flow-external/runs/run_... · 15 backend events
  ```

---

## Background Runs & Lifecycle

By default, calls to `Agent` and `workflow` are blocking: the caller waits until the child process completes.

Setting `background: true` queues and starts the work asynchronously while returning an immediate receipt containing a stable handle:

```ts
const receipt = await tools.Agent({
  description: "Audit security-sensitive endpoints",
  role: "reviewer",
  harness: "claude",
  permission: "readonly",
  prompt: "Audit security-sensitive endpoints.",
  background: true,
});

if (!receipt.ok) {
  throw new Error(`Failed to launch: ${receipt.error.message}`);
}

const runId = receipt.data.run.runId; // e.g. "run_..."
```

### Ownership Invariants
- **Session-Owned:** Background children belong to the active Pi session, not a persistent OS daemon.
- **Orderly Shutdown:** Closing Pi gracefully signals cancellation and waits for bounded cleanup.
- **Unconfirmed Exits:** Host crashes or force-kills leave unfinished evidence marked `interrupted_or_uncertain`. A restarted session never re-attaches to live orphan processes.

---

## The `external_runs` Tool

Use `external_runs` to supervise, inspect, and manage runs programmatically:

### 1. `list`
Page session-owned runs and workflow roots:
```ts
await external_runs({
  action: "list",
  limit: 10,
  cursor: undefined, // pass nextCursor for pagination
});
```
Each entry returns timing projections (`queueDelayMs`, `elapsedMs`, `activityAgeMs`, `processDurationMs`).

### 2. `inspect`
Inspect a specific run's state and streams:
```ts
// Single-run inspection supports any view:
await external_runs({
  action: "inspect",
  runIds: [runId],
  view: "summary", // "summary" | "output" | "diagnostics" | "final" | "launch"
  limitBytes: 32768,
});
```
- `summary`: High-level status, timing, and references.
- `output`: Streamed assistant messages and terminal text.
- `diagnostics`: Captured tool events, warnings, and errors.
- `final`: **Verified canonical result only**. Returns empty with `finalAvailable: false` until the child reaches verified terminal success.
- `launch`: Detailed initial launch prompt, configuration, and shared context snapshot.

**Batch Inspection (Summary-only):** Pass up to 20 IDs to check multiple background children in a single cheap call:
```ts
await external_runs({
  action: "inspect",
  runIds: [runId1, runId2],
  view: "summary", // Batch inspect is summary-only
});
```

### 3. `wait`
Block until one or more targets reach terminal state:
```ts
const waitResult = await external_runs({
  action: "wait",
  runIds: [runId1, runId2],
  mode: "all", // "all" waits for every run; "any" returns after the first settles
  limitBytes: 32768,
});
```
- **Live Progress Heartbeat:** While waiting, the tool emits bounded progress updates (watched targets, completed/pending counts, recent activity) through Pi's update channel.
- **Shared Budget:** The `limitBytes` cap is spent across settled results in requested order. If a result exceeds remaining space, it returns `resultTruncated: true` with references to inspect the rest.

### 4. `cancel`
Cancel an active run:
```ts
await external_runs({
  action: "cancel",
  runIds: [runId],
  reason: "User cancelled task",
});
```

---

## Operational Evidence & Run Storage

Every normal run writes durable, private evidence to disk:

```text
~/.pi/agent/pi-flow-external/runs/<run-id>/
  events.ndjson     # Structured stream of parsed backend events
  summary.json      # Final status, duration, token usage, cost, and result
```

- **Environment Override:** Set `PI_FLOW_EXTERNAL_RUNS_DIR` to change the storage root.
- **Data Privacy:** Prompts, diffs, and tool outputs are stored locally. Redaction is applied on a best-effort basis; records remain sensitive to the local user.
- **Automatic Retention:** When starting a session or running `/external runs --prune`, the oldest completed records exceeding `maxRunRecords` (default: 200) are automatically purged. Incomplete, damaged, or currently active records are never deleted.
- **Offline Health Check:** Inspect local evidence integrity from the repository:
  ```bash
  npm run field-report
  ```

---

## Related Documentation

- **[Public Contract v1](public-contract.md):** Structured response envelopes (`{ ok, data, error }`) for `external_runs`.
- **[Workflows](workflows.md):** Managing parallel children and handling failures programmatically.
- **[Configuration Reference](configuration-reference.md):** Settings and CLI commands for runs and retention.
