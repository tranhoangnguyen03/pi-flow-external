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

## Foreground, Background & Lifecycle

**Foreground is the default:** omit `background` or set it to `false`. The original `external_delegate` or `external_workflow` call waits for settlement and returns the result or failure. Its live card carries progress while the parent waits.

**Background returns a handle:** set `background: true` when the parent has independent local work to do first, or when the user asks to run in the background, switch tasks, or check back in a later turn. The receipt confirms registration, not completion; a fast run may already be settled. The launch receipt is not a live monitor. Use `/external runs` to browse, or `external_runs` to inspect, wait, or cancel.

Use foreground when the result is needed next—even for a long workflow or parallel children. Never launch background then immediately wait; do your independent work first, or if leaving the run active across turns, report the run ID and proceed or end your turn without waiting. Both modes support `parallel()` under the same concurrency limiter; neither changes permission boundaries or budget enforcement. Prompt instructions express intent, not an enforced restriction.

### Background Example: Launch → Independent Work → Collect

Before launch, tell the user: “Claude will audit the API with readonly permission. While it runs, I’ll read the release checklist, then compare the findings.” For a workflow, also explain assignments and ordering as described in [Workflows](workflows.md#explain-the-plan-before-launch).

This codemode example assumes both paths exist; replace them with your project's absolute paths. It uses `external_delegate`, but collection is the same for `external_workflow` and its `wf_...` ID.

```js
const launched = await tools.external_delegate({
  description: "Audit API routes",
  role: "reviewer", harness: "claude", permission: "readonly",
  prompt: "Audit /absolute/project/api for security defects. Do not edit files.",
  background: true,
});
if (!launched.ok) throw new Error(launched.error.message);
let run = launched.data.run; // Retain this handle and its runId.

// Useful independent work, not an immediate wait:
const checklist = await tools.read({ path: "/absolute/project/RELEASE.md" });

if (!run.state.outcome) {
  const waited = await tools.external_runs({
    action: "wait", runIds: [run.runId], mode: "all",
  });
  if (!waited.ok) throw new Error(waited.error.message);
  const settled = waited.data.completed.find(item => item.runId === run.runId);
  if (!settled) return { pending: waited.data.pending, checklist };
  run = settled;
}

if (run.state.outcome === "succeeded" && run.output.delivery === "inline") {
  return { run, result: run.output.value, checklist }; // null/false/0 are valid.
}

const view = run.state.outcome === "succeeded" ? "final" : "diagnostics";
let cursor;
let text = "";
let encoding;
do {
  const inspected = await tools.external_runs({
    action: "inspect", runIds: [run.runId], view, ...(cursor ? { cursor } : {}),
  });
  if (!inspected.ok) throw new Error(inspected.error.message);
  if (view === "final" && !inspected.data.finalAvailable) {
    throw new Error("No verified final answer is available");
  }
  text += inspected.data.page.text;
  encoding = inspected.data.page.encoding;
  cursor = inspected.data.page.nextCursor;
} while (cursor);
return { run, view, encoding, text, checklist };
```

- **Check the run, not just `ok`.** `wait.ok` means supervision worked, even if a child failed. Read each `completed[i].state.outcome` and all `pending` IDs. Even in `mode: "all"`, a selected workflow that fails, is cancelled, or times out ends the wait early; pending work continues. Keep collecting it unless the user defers, or cancel it explicitly.
- **Avoid redundant calls.** If settlement is already known, inspect directly rather than wait again. Successful inline output needs no second fetch. A successful workflow can still have `children.failed` when the script handled child errors; check the returned reports.
- **Read every page.** Otherwise use `final` for verified success or `diagnostics`/`output` for failure. `final` is empty without verified success. Follow `page.nextCursor`, concatenate text, and only then parse if `encoding` is `json`. Workflow final JSON wraps the value in `{ runId, result, finalAvailable }`; agent finals are text.
- **Keep ownership.** The parent retains IDs and collects/checks results after its independent work finishes, unless the user asks to leave work running or check back later—in which case it reports the IDs and switches tasks or ends the turn without waiting. A script's local variables do not survive a separate codemode call; pass the retained handle or ID explicitly. If independent work or collection fails, report any still-running IDs rather than abandoning them silently. Never retry a child automatically.

### Interruption, Cancellation & Session Ownership

- **Foreground interruption:** interrupting the original blocking call cancels that work.
- **Wait interruption:** interrupting `external_runs wait` only stops waiting; it does not cancel the selected runs. Use `external_runs cancel` to stop background work. Cancellation requests are not proof of completed cleanup; check settlement.
- **Workflow cancellation:** cancelling the root stops its active children. Cancelling one child throws a catchable child error; a script that handles it may continue.
- **Status bar & completion wake-up:** ending a turn does not stop background work; it continues in the owning session. UI sessions display active background root runs in the status bar (`pi-flow-runs`), show a completion notification, and queue a debounced follow-up wake message (`pi-flow-background-settled`) when an uncollected background root run settles across turns. Runs already collected in the turn or cancelled by the caller do not send a wake message.
- **Not a persistent service:** keep the owning Pi session open. Orderly shutdown requests cancellation and waits for bounded cleanup. Crashes or force-kills leave unfinished evidence `interrupted_or_uncertain`; restarting Pi never adopts live orphan work.

---

## The `external_runs` Tool

Use `external_runs` to supervise, inspect, and manage runs programmatically. Only `action` is top-level required in the JSON Schema; omit parameters that do not apply to the chosen action:

| Action | Required | Optional | Inapplicable (omit) |
| --- | --- | --- | --- |
| `list` | `action` | `workflowRunId`, `cursor`, `workflowCursor`, `limit` | `runIds`, `view`, `limitBytes`, `mode`, `reason` |
| `list` (with `workflowRunId`) | `action`, `workflowRunId` | `cursor`, `limit` | `workflowCursor`, `runIds`, `view`, `limitBytes`, `mode`, `reason` |
| `inspect` (single run: 1 ID) | `action`, `runIds` (`[id]`) | `view` (`summary` \| `output` \| `diagnostics` \| `final` \| `launch`), `cursor`, `limitBytes` | `workflowRunId`, `workflowCursor`, `limit`, `mode`, `reason` |
| `inspect` (batch: 2-20 IDs) | `action`, `runIds` (`2-20` IDs) | `view` (`"summary"` only), `cursor`, `limitBytes` | `workflowRunId`, `workflowCursor`, `limit`, `mode`, `reason` |
| `wait` | `action`, `runIds` (`1-100` IDs) | `mode` (`"any"` \| `"all"`), `limitBytes` | `workflowRunId`, `view`, `cursor`, `workflowCursor`, `limit`, `reason` |
| `cancel` | `action`, `runIds` (`[id]`, `1` ID) | `reason` | `workflowRunId`, `view`, `cursor`, `workflowCursor`, `limit`, `limitBytes`, `mode` |

### 1. `list`
Page session-owned agent runs and workflow roots:
```ts
await external_runs({
  action: "list",
  limit: 10,
});
```
- **`cursor` vs. `workflowCursor`:** `list` returns two independent paged streams: `runs` (paged with `cursor` from `nextCursor`) and `workflows` (paged with `workflowCursor` from `nextWorkflowCursor`).
- **`workflowRunId` filtering:** Passing `workflowRunId: "wf_..."` filters `runs` to that workflow's child agent runs and returns `workflows: []`, so only `cursor` applies (`workflowCursor` is inapplicable).
- Each entry returns timing projections (`queueDelayMs`, `elapsedMs`, `activityAgeMs`, `processDurationMs`).

### 2. `inspect`
Inspect a specific run's state and streams:
```ts
// Single-run inspection (1 ID) supports any view:
await external_runs({
  action: "inspect",
  runIds: [runId],
  view: "final", // "summary" | "output" | "diagnostics" | "final" | "launch"
  limitBytes: 32768,
});
```
- `summary`: High-level status, timing, and references.
- `output`: Streamed assistant messages and terminal text.
- `diagnostics`: Captured tool events, warnings, and errors.
- `final`: **Verified canonical result only**. Returns empty with `finalAvailable: false` until the child reaches verified terminal success.
- `launch`: Detailed initial launch prompt, configuration, and shared context snapshot.

**Batch Inspection (`2-20` IDs, `summary` view only):** Pass 2 to 20 IDs in `runIds` to check multiple background runs in a single bounded call (non-`summary` views require a single target):
```ts
await external_runs({
  action: "inspect",
  runIds: [runId1, runId2],
});
```

### 3. `wait`
Block until one or more targets (`1-100` IDs in `runIds`) reach terminal state:
```ts
const waitResult = await external_runs({
  action: "wait",
  runIds: [runId1, runId2],
  mode: "all", // An unsuccessful workflow ends the wait early; check data.pending.
  limitBytes: 32768,
});
```
- **Wait Modes:** `any` returns after a selected target settles; `all` waits for all, except an unsuccessful workflow returns early. Check `completed` outcomes and `pending` IDs; `ok: true` does not mean every run succeeded.
- **Live Progress Heartbeat:** While waiting, the tool emits bounded progress updates (watched targets, completed/pending counts, recent activity) through Pi's update channel.
- **Shared Budget:** The `limitBytes` cap is spent across settled results in requested order. If a result exceeds remaining space, it returns `resultTruncated: true` with references to inspect the rest.

### 4. `cancel`
Cancel a single active run (`1` ID via `runIds: [runId]` or `runId`):
```ts
await external_runs({
  action: "cancel",
  runIds: [runId],
  reason: "User cancelled task",
});
```

---

## Operational Evidence & Run Storage

Normal runs write private, best-effort evidence to disk; unavailable storage does not discard a settled in-memory result:

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
