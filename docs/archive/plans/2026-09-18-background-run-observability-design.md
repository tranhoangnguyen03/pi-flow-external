# Background-run observability and collection ergonomics

**Status:** Approved; implemented  
**Issue:** [#49 Improve background-run observability and collection ergonomics](https://github.com/tranhoangnguyen03/pi-flow-external/issues/49)  
**Date:** 2026-09-18 (corrected 2026-09-20 after Agy/Claude design review; corrected again 2026-09-20 after a second implementation review — see the batch byte-budget, execution-boundary, queue-age, and final-unavailable corrections below)

## Goal

Make independently launched background `Agent` runs easier to inspect without changing their session-owned lifecycle, hands-off execution, concurrency, cancellation, or wait semantics.

The smallest useful change is to improve the existing `external_runs` reader and `/external runs` browser. Do not add a workflow abstraction, polling daemon, automatic join, completion notification, or second evidence store.

## Current findings

### Collection

- `Agent({ background: true })` allocates a durable `run_*` record, registers it in `RunRegistry`, starts execution without the caller signal, and returns immediately.
- `RunRegistry` already permits independent direct runs to overlap and provides non-blocking `inspect`, explicit `wait`, and cancellation.
- `external_runs` currently accepts one `runId` for `inspect`; `wait` already accepts `runIds`.
- `/external runs` already uses the same registry and durable readers as the tool, so it is the correct place for discoverability improvements.

### Timing

- `run_started` / `queuedAt` is recorded before the concurrency limiter is acquired.
- `SubagentProgressNode.startedAt` is assigned after the limiter grants a slot. It is execution start, not process start, but the current public projections expose it under a generic `startedAt` name.
- The shared `ConcurrencyLimiter` (`src/core/concurrency.ts`) is acquired in exactly two call sites, and the execution-start boundary must be recorded at each: directly in `src/pi-subagent.ts`'s `executeRun` (`Agent` tool, direct calls), and in `src/workflow/runtime.ts`'s `executeAgent` (workflow `agent()` calls). `src/workflow/tool.ts` does not call the limiter itself — it only wires `runAgent`/`startAgentRun` callbacks that `runWorkflow` (in `runtime.ts`) invokes; the original draft of this doc incorrectly named `workflow/tool.ts` as a limiter call site. `src/core/spawn.ts`'s shared `spawnSubagent` also never acquires the limiter — callers always acquire it before calling in (see its own doc comment) — so `spawnSubagent` only *receives* the already-captured execution-start timestamp as a parameter, it does not capture one itself.
- CLI backends emit `process_started` when their child process emits `spawn`; Pi children do not have a child OS process, so this timestamp is legitimately absent for Pi.
- `firstActivityAt` and `lastActivityAt` come from backend events. They do not prove command start, inference completion, or shell-command duration.
- `summary.json.finishedAt` is the terminal receipt time. Existing `durationMs` is useful internally but is not a sufficiently clear public timing contract.

### Output

- The existing output reader preserves backend-derived assistant text, canonical terminal result, partial output, and diagnostic events with bounded cursors.
- Existing backend boundaries are sufficient to expose a separate verified final answer:
  - Claude: successful `result` event (`result` or `structured_output`).
  - Codex: successful `turn.completed` and the final completed `agent_message` selected by the adapter.
  - Agy: successful `result` event (`response` or `structured_output`).
  - Pi: the final assistant turn after the observed non-retrying `agent_end` boundary; the adapter's canonical `result` is the safe receipt value.
- Assistant/tool narration must remain available as combined output. Do not identify narration as the final answer with text heuristics.

### UI

- `/external runs` is a manually opened selector. It does not poll or notify, which is correct for the issue's hands-off requirement.
- It already re-lists after returning from a run detail view, and output/diagnostic routes are available from the selected run.
- Its list labels currently show only kind, ID, and status. Timing, activity age, description, and output availability are missing.
- A manual refresh action is enough; a persistent widget or timer would add a second presentation path and routine churn without evidence that the existing browser is insufficient.

## Design

### 1. Batch selected-run inspection

Extend `external_runs` with an optional `runIds` parameter for `action: "inspect"`.

- `inspect` accepts either the existing `runId` or a deduplicated `runIds` array, never both.
- Keep the existing single-run response byte-for-byte compatible where practical.
- Cap batch inspection at 20 targets. This is intentionally below the existing wait cap of 100 because inspection returns projections and may include live evidence reads.
- Batch inspection is summary-only (`view` defaults to `summary` and must remain `summary` when `runIds` is used). Every entry shares one consistent, normalized shape — `{runId, kind, live, task, state, timing, output, outputRef, diagnosticsRef}` — regardless of whether the underlying target is a live agent, a durable/historical agent, a live workflow, or a historical workflow. This is a deliberate, separately-built projection in `resolveRunSummaryEntry` (`src/external-runs.ts`), not a raw spread of whichever single-run summary builder happens to apply: `historicalAgent`'s own flat `RunRecordListItem` fields (used by the unrelated `list` action, where compatibility with existing rows matters) are unwrapped into the same `task`/`state`/`output` grouping the live/workflow builders already use, so a caller iterating batch entries never has to branch on which kind or liveness produced one. Fields:
  - `task`: `description`/`backend`/`project`/`parentSessionId`/`workflowRunId` for an agent; `name`/`source` for a workflow (`source` is the enum `"inline"|"saved"|"path"`, never the script body — see the corrected finding below).
  - `state`: `status`, `outcome`, `error`, relevant timestamps, and (agents only) `integrity`.
  - `timing`: the shared timing projection (§2). Workflow entries carry an empty `timing: {}` — no workflow-level timing is tracked (see §2's closing paragraph) — present only so every entry has the same key set.
  - `output`: `available` and `finalAvailable`.
  - `outputRef` and `diagnosticsRef` routes for per-run detail retrieval.
- A workflow batch entry deliberately omits `children` (unbounded — up to the full agent roster) in favor of `outputRef`/`diagnosticsRef` and the entry's own `runId`, which single-run `inspect(view: "summary")` on that same workflow ID already returns in full. Do not aggregate output, diagnostics, or a workflow's full child roster into one large batch transcript. The returned refs preserve the existing per-run bounded/cursor-paged routes and avoid ambiguous ordering across children.
- **Corrected finding:** an earlier review pass asserted a workflow's `source` field is the raw script body and would need to be stripped from batch entries for that reason. That claim does not hold: `WorkflowToolDetails.source` (`src/types.ts`) and `LoadedWorkflowJournal.source` (`src/workflow/journal.ts`) are always one of the three short enum values `"inline" | "saved" | "path"` (verified at every write site in `src/workflow/source.ts`), never the script text itself. `source` is small and bounded and stays in batch entries; only `children` is the actual unbounded field, and it is what gets replaced by refs.
- Batch results are a bounded JSON projection reusing the tool's existing `limitBytes` parameter (default 32 KiB, capped at the existing 64 KiB `MAX_PAGE_BYTES` maximum already enforced for every other inspect view) — **there is no separate, larger aggregate budget.** An earlier draft of this design proposed an additional 256 KiB aggregate page budget; that is rejected as an unnecessary second byte-limit axis for callers to reason about, and the implementation must not add it.
- Pagination is simple target-index pagination, not byte-offset slicing within or across target boundaries: one opaque batch cursor holds the next unserved index into the caller's own ordered, deduplicated `runIds` array. A follow-up batch request repeats the identical `runIds` array, `view: "summary"`, and the returned `cursor`; the cursor is rejected with an actionable error if the requested `runIds` no longer match what it was issued for (target-set/session/project scope mismatch), but it is **not** bound to any per-target content revision — unlike the single-run summary cursor, a batch page is not invalidated by a target's live record changing between pages, because batch entries are always served whole (never mid-entry byte-sliced), so there is nothing for an in-flight mutation to corrupt.
- **Corrected finding (second implementation review, 2026-09-20):** the byte budget check must bound the FULL returned response text — the `{entries, nextCursor}` wrapper object and the `nextCursor` string itself — not merely the sum of each served entry's own JSON size. A first implementation pass tracked only `usedBytes += Buffer.byteLength(JSON.stringify(entry))` per entry and compared that running sum against `limitBytes`; because the actual tool result text is `JSON.stringify({ entries: served, nextCursor })`, that check silently ignored the `entries` array wrapper, the field names, and — often the largest single contributor — the base64url-encoded `nextCursor` string (which grows with the size of the caller's own `runIds` array), so a real response could exceed the caller's stated `limitBytes` despite the check appearing to pass. The corrected implementation sizes the actual candidate payload text at each step — `JSON.stringify({ entries: servedSoFar.concat(candidate), ...(moreRemain ? { nextCursor: candidateCursor } : {}) })` — and only accepts the candidate entry into the page if that whole candidate text fits within `limitBytes`; this is "smallest simple candidate-payload sizing," not a separate overhead-estimation formula that could itself drift from the real serialization. A page never contains zero entries without throwing (no non-advancing empty page) and never exceeds `limitBytes` in its actual serialized form.
- A batch page never exceeds the caller's own `limitBytes` and never silently drops a requested target. Each entry is already the compact, normalized shape above (no unbounded fields), so it comfortably fits typical budgets; a page accumulates entries while the full candidate payload (current entries plus the prospective next entry, plus the `nextCursor` that would result) fits within `limitBytes`, stopping (with a `nextCursor`) once the next entry would not fit. If a single entry plus its pagination envelope exceeds `limitBytes` on its own — a caller-chosen budget too small for even one compact entry — the implementation must not serve an oversized page (no overflow) and must not skip the target silently (no omission): it fails the whole request with an actionable error naming the specific run and telling the caller to either raise `limitBytes` or inspect that run individually with the existing single-run `inspect`. An earlier draft of this design instead always served at least one entry per page even when it exceeded `limitBytes`, on the theory that this mirrored the single-run byte-slicer's "always make forward progress" guarantee; that comparison does not hold for batch entries, which are served whole rather than sliced, so silently exceeding the caller's stated budget serves no purpose a clear error doesn't serve better — that behavior is rejected and the implementation must not restore it.
- Validate ownership and all target IDs *in the full requested set* before returning any batch page (not only the entries the current page would serve), so an unknown or cross-session/project target anywhere in the set fails the request rather than producing a misleading partial result on an early page and only failing once the cursor reaches it.
- Batch inspection remains non-blocking and never changes run state.

This gives the parent a single cheap request to see whether One/Two/Three are queued, running, or terminal, while preserving existing detail routes for the answer or diagnostics it chooses to inspect.

### 2. Explicit timing projection

Add a shared timing projection used by live summaries, durable summaries, list entries, and batch inspection. Keep raw evidence authoritative; derived values are only emitted when their input timestamps exist.

Expose timestamps with unambiguous names:

```json
{
  "timing": {
    "queuedAt": "...",
    "executionStartedAt": "...",
    "processStartedAt": "...",
    "firstActivityAt": "...",
    "lastActivityAt": "...",
    "finishedAt": "...",
    "queueDelayMs": 18000,
    "elapsedMs": 62000,
    "activityAgeMs": 2400,
    "processDurationMs": 59000
  }
}
```

Rules:

- `queueDelayMs` is `executionStartedAt - queuedAt`; absent until execution starts.
- `elapsedMs` is `finishedAt - executionStartedAt` for terminal runs (this half is evidence-only and always safe to compute). For a run with no `finishedAt` yet, `now - executionStartedAt` is computed **only when the run is independently confirmed live by `RunRegistry`** — never merely because a durable record's status field reads `"running"`. A durable record with no `finishedAt` and no owning registry entry (parent session restarted, extension process crashed, evidence was orphaned) is not proof the child is still executing; treating `now - executionStartedAt` as truth there would render an ever-growing, fabricated elapsed time for a run that may have died minutes or days ago. Concretely: `src/core/run-inspection.ts` (`inspectRun`, `listRunRecords`, `getRunRecord`) reads only durable evidence and never has registry access, so its timing projection never computes a `now`-relative field — it is restricted to `queueDelayMs`, terminal `elapsedMs`, and `processDurationMs`. `src/external-runs.ts` has `RunRegistry` access and computes `now`-relative `elapsedMs`/`activityAgeMs` only for entries it resolves through `registry.get(runId)` (i.e. `entry.state === "running"`), never for a record it had to fall back to durable evidence for.
- `activityAgeMs` is `now - lastActivityAt`, computed only under the same live-registry condition as the running-run half of `elapsedMs` above (never for a terminal run, and never for a durable record without a live registry entry).
- `processDurationMs` is `finishedAt - processStartedAt` only when both exist. It means observed backend-process lifetime, never shell-command runtime. It is absent for Pi and for records lacking process evidence.
- Never derive command duration from `firstActivityAt`, `lastActivityAt`, or a generic `durationMs`.
- Never use the UI heartbeat as activity.
- Clamp or omit negative values caused by malformed/out-of-order timestamps rather than inventing durations (omit, in the implementation: a negative delta is dropped rather than floored to zero, so a caller never mistakes a clock-skew artifact for a real zero-length duration).

A single shared, pure helper (`deriveRunTiming` in `src/core/run-inspection.ts`) implements these rules once, taking an explicit `live` flag so its "durable evidence only" and "registry-confirmed live" behaviors cannot silently diverge between callers; `src/external-runs.ts` imports it rather than reimplementing timing math.

Record the execution boundary explicitly by appending an `execution_started` evidence event immediately after the concurrency limiter grants the run a slot, at each of the two call sites named above (`pi-subagent.ts`, `workflow/runtime.ts`) — reusing the event's own auto-timestamped envelope (the same mechanism `process_started` already relies on for its timestamp) rather than a second clock reading. The same numeric timestamp is also threaded through `spawnSubagent`'s existing `SubagentProgressNode`-based timing plumbing (the same path `processStartedAt`/`firstActivityAt`/`lastActivityAt` already use) so it is persisted in the terminal summary when a run finishes, and so a still-live run's registry-observed progress snapshot carries it for the `now`-relative live path. Existing records without the event remain readable; their timing projection simply omits queue delay and uses only trustworthy legacy timestamps.

For workflow children, the same direct-child run record is authoritative. Workflow snapshots may mirror the timing fields for live rendering, but no workflow-only timing format is introduced.

**Corrected finding (second implementation review, 2026-09-20):** writing the durable `execution_started` evidence event (above) is necessary but not sufficient — the workflow child's own *live* `RunRegistry` observation (the one `external_runs inspect`/`list` actually reads for a still-running child, as opposed to the durable evidence file) must also flip from `status: "queued"` to `status: "running"` with `executionStartedAt` at that exact boundary, on the direct `runAgent`/`onAgentStart` call path — not merely whenever `spawnSubagent`'s own backend-specific progress emitter happens to fire its first update. The direct `Agent` tool (`pi-subagent.ts`'s `executeRun`) already did this correctly (its `state.registry.update(runRecord.runId, run.progress)` call sits directly after `limiter.acquire()` resolves, before `spawnSubagent` is even called); a first implementation pass left the equivalent workflow-child path — `workflow/tool.ts`'s `onAgentStart` handler — updating only the *workflow's own* aggregate snapshot/registry entry, never the child's own registered `run_...` entry, so a workflow child's own entry stayed reporting `"queued"` until the backend's real progress plumbing eventually reached it (fine for pi's near-immediate in-process emitter, but a real, growing user-visible gap for the CLI backends' external process spawn latency). The fix wires an explicit `options.registry.update(event.runId, { status: "running", queuedAt, executionStartedAt, description, backend })` directly into `onAgentStart` — reusing the existing boundary and event plumbing, adding no new abstraction — gated on `!event.cached` so a replayed/cached child (never re-executed) is unaffected.

### 3. Separate verified final answer

Add a `final` inspection view alongside `summary`, `output`, and `diagnostics`.

- `view: "final"` returns only the canonical terminal answer when the run has a verified successful terminal boundary.
- It is available for Claude, Codex, Agy, and Pi only when the existing success criteria have been met and the terminal result is non-empty.
- For a queued/live/failed/cancelled/timed-out run with no verified final answer, return an empty bounded page with an explicit `outputStatus`/`finalAvailable: false`; do not promote the last partial assistant message.
- Existing `output` remains the combined readable stream: assistant messages plus canonical result where the current reader provides them. Its status remains preliminary/final/interrupted for compatibility, but its summary metadata must say whether a separate verified final answer is available.
- **Implementation reuses the existing canonical terminal result — it does not add a second backend parser or a narration-vs-final heuristic.** `src/core/run-inspection.ts` already has `canonicalResult(summary)`, which reads `summary.status === "done"` and `summary.structuredOutput ?? summary.result` from the terminal `summary.json` document. That document's `result` field is already populated uniformly for all four backends by `src/core/spawn.ts`'s single `record.finish({ ..., result: details.result, ... })` call, using each backend's own already-strict, already-tested success/non-empty checks (`spawnClaudeSubagent`, `spawnCodexSubagent`, `spawnAgySubagent`, and the pi branch in `spawn.ts` each independently gate `status: "done"` on a verified terminal event and non-empty trimmed text before this field is ever set). The `final` view therefore only needs to call the existing `canonicalResult()` helper and wrap it in the existing single-item cursor/paging machinery (`terminalPage`) — it introduces no new per-backend event inspection. Distinguishing narration from a final answer is a pre-existing, already-tested property of each backend adapter's terminal-event handling in `test/claude-backend.test.ts`, `test/codex-backend.test.ts`, and `test/agy-backend.test.ts`; this work extends those suites only if a genuine extraction regression is found, and otherwise adds no duplicate coverage.
- The final view uses the existing inspection cursor machinery, even though it normally fits in one page. If a structured result exceeds the page limit, it is cursor-paged exactly like other views.
- The full event transcript and summary receipt remain unchanged as evidence. This is a projection, not a new transcript.
- Combined `output` (the existing view) is unchanged: same events, same terminal-document fallback, same cursor behavior as before this change. Only its summary-metadata neighbor (`finalAvailable`) and the new sibling `final` view are new.
- `final` also applies to workflows, not only agent runs: a workflow's verified final result is `entry.outcome.result` (live) or the journal's `result` (historical), gated on an actually-settled `status === "done"` — never merely "not running" — using a shared `workflowFinalState` helper so `liveSummary`, `journalSummary`, the single-run `inspect` workflow branch, and the batch resolver cannot diverge on what "done" or "available" means. Because a workflow's result is `unknown`-typed JSON, an intentional `null` result is a legitimate final answer and must read as available; the implementation must use an explicit `result !== undefined` check (never a `??`/truthiness chain, which would treat `entry.outcome.result === null` as absent and incorrectly fall back to a sibling value) to tell "settled with `null`" apart from "no result recorded." The single-run `inspect` handler's workflow branch is a three-way `view` selector (`summary` / `output` / `final`) plus a diagnostics fallback; `final` must be its own branch, not left to fall through into the diagnostics-shaped `{status, error}` response the way an early implementation draft did.

This makes the distinction mechanical: structured terminal boundaries decide whether final output exists; no prose search or “last paragraph” heuristic is added.

**Corrected finding (second implementation review, 2026-09-20):** an unavailable `final` view must be distinguishable from a legitimate settled `null`/object result. The workflow branch's `view === "final"` case, when `finalAvailable` is `false`, was returning `JSON.stringify({ runId, finalAvailable: false })` as literal response text — not blank, but raw and unexplained, and diverging from the agent path's own shape.

**Corrected finding (fourth implementation review, 2026-09-20):** the round-2 fix above (and a subsequent round-3 pass) put the human-readable explanation directly into the TOOL's `content[0].text` for the workflow branch — e.g. `"No verified final answer is available yet for ${runId} (the workflow is still running)."` — which pollutes `final`'s narration-free canonical-answer contract with prose the tool has to compose and a caller has to parse back out. The pre-existing agent-run fallback (`text || "No ${view} is available for ${runId}."`, shared with `output`/`diagnostics`) has the identical problem for agent runs. Both are corrected: `view: "final"` now returns a literal empty string when unavailable, for both agent and workflow runs, going through the exact same bounded/cursor-validated machinery as the available case (`output`/`diagnostics` keep their existing generic fallback text — only `final`, the canonical-answer surface, is narration-free). `details.finalAvailable` (`true`/`false`) is the only signal a caller needs, and the workflow branch's *available* case now also sets it explicitly in `details` (previously it only existed inside the JSON `content` text) so callers never have to parse content to tell available from unavailable.

Turning `finalAvailable: false` into a human-readable explanation is now the UI layer's job, not the tool's: `src/external-command.ts`'s `showPages` checks `page.details.finalAvailable !== true` for `view: "final"` and calls `ctx.ui.notify(...)` with a clear message instead of opening `ctx.ui.editor` on an now-genuinely-empty page — uniformly for both agent and workflow routes, since both share the same `finalAvailable` signal. This also fixes the actual reported symptom: `showPages` unconditionally opened an editor regardless of whether there was anything informative to show, which is what a user actually experiences as "blank" even when the tool technically returned a one-line sentence — the fix is to make the UI layer *decide* when there's nothing to show, not to keep stuffing more text into the tool response for it to blindly display. Available results (`finalAvailable: true`, including a legitimate `null`/object result) are unaffected: they still return the real JSON result via the tool and open in the editor via the UI, so "available with a null result" and "unavailable" remain distinct in both content and control flow, never conflated.

### 4. Existing UI discoverability

Improve `/external runs` without creating a dashboard:

- List rows show the short description, status, elapsed/queued duration, activity age when live, and an output-available/final-available marker.
- Add a manual `Refresh` choice to the root run selector. Refresh re-reads the current page from the beginning and resets stale list cursors; it never waits, polls, or changes execution.
- Keep the current `Summary`, `Output`, `Diagnostics`, child navigation, and cancel routes.
- Add timing and final-output availability to summary editor output so a user can inspect one run without interpreting raw timestamps.
- Keep normal terminal output bounded. Hidden runs and all detail pages remain reachable through the existing selectors and cursors.
- Do not add notifications when a background child completes.

**Corrected finding (second implementation review, 2026-09-20):** "elapsed/queued duration" above was under-specified for a row that is genuinely still queued (no `executionStartedAt` yet): `queueDelayMs` (§2) is only ever populated once execution *starts*, so a still-queued row previously showed no duration at all. The fix computes a "queue age" (`now - queuedAt`) directly in `src/external-command.ts`'s row formatter at render time — no new timer, no new evidence field, no polling — and only for a row the registry itself confirms is currently live (`item.live === true`, the same flag `listedAgent`/`historicalAgent` already set), gated on the row's status being `"queued"`. A durable/historical row that merely *looks* queued (a `historicalAgent` entry with no owning `RunRegistry` entry — e.g. an orphaned or crashed record) always carries `live: false` and must never get a fabricated, ever-growing age; only a row independently confirmed live by the registry may show one. This age display becomes far less commonly needed as soon as the item 2/§2 correction above lands, since a genuinely executing workflow child no longer lingers in `"queued"` — but a row can still be legitimately queued behind the shared concurrency limiter, and that case must still read correctly.

The direct Agent row remains a launch receipt. `/external runs` is the explicit passive browser for later progress discovery.

## Data flow

```text
Agent(background: true)
  -> create run record (run_started / queuedAt)
  -> register session-owned run
  -> acquire shared limiter
  -> record execution_started / executionStartedAt
  -> backend emits process_started and structured activity
  -> registry progress + durable events update
  -> terminal result writes finishedAt and final-result fields

external_runs inspect(runIds)
  -> validate all IDs and ownership
  -> read live registry or durable records
  -> derive timing/output metadata
  -> return bounded summary page + batch cursor + per-run detail refs

external_runs inspect(runId, view: final|output|diagnostics)
  -> existing single-run reader + cursor

/external runs
  -> same list/inspect APIs
  -> display passive rows
  -> user selects Refresh or a run/detail route
```

## Compatibility and error handling

- Existing single-target `inspect`, `wait`, `cancel`, list cursors, and output/diagnostic cursors remain supported.
- `runId`/`runIds` conflicts, empty target sets, more than 20 batch targets, invalid IDs, mismatched cursors, stale cursors, cross-scope records, and a batch entry too large for `limitBytes` all fail with actionable errors.
- Batch ownership is all-or-nothing: no partial response for an invalid target.
- An unresolvable `wf_...` ID (no live registry entry, no journal) must fail as "unknown or unavailable," not fall through to the agent-only durable reader (`getRunRecord`/`RUN_ID_PATTERN` only ever match `run_...` IDs, so a fallthrough there would misreport the ID as invalid-format rather than unknown). This applies uniformly to single-run `inspect`, `cancel`, `wait`, and the batch resolver — all four have the identical live-entry / historical-journal / durable-fallback shape and must apply the same guard before reaching the durable fallback.
- Incomplete or damaged records remain distinguishable from backend failures. A damaged record may expose timing/output metadata only when the evidence supports it.
- A durable record's raw `status` classification (queued vs. running, before any `interrupted_or_uncertain` integrity override is applied) must treat `executionStartedAt` as sufficient evidence of "running" on its own, on equal footing with `processStartedAt`/observed output — not only as an input to the timing projection. `processStartedAt` never exists for Pi (no child OS process), so gating classification on it (or on output having arrived yet) alone would misreport an already-executing Pi run with no output yet as still "queued." This does not weaken the separate `integrity`/`interrupted_or_uncertain` distinction, which is applied independently downstream (e.g. by `historicalAgent`) and is unaffected by this fix.
- Once a run has settled, its registry-confirmed `outcome.status` is authoritative and must be preferred over `observation.status` (an ambient, unvalidated `unknown`-typed passthrough whose last write is not guaranteed to be refreshed to match the terminal outcome) wherever both could otherwise be consulted for a live/list/summary projection.
- A workflow child queued behind the shared concurrency limiter must be visible with `status: "queued"` and its `queuedAt`, mirroring the direct `Agent` tool's own immediate post-registration observation — not merely defaulting to `"running"` with no timing because no observation has been recorded for it yet. The workflow tool seeds this observation itself immediately after registering the child's run, before the child's `run` function can advance past its own first await (concurrency-limiter acquisition).
- Timing is best-effort and never changes success criteria.
- Final output availability never changes terminal success criteria. A run still needs a recognized backend success event, zero process exit where applicable, and non-empty result.
- No retries, waits, joins, cancellation changes, or workflow semantics are introduced.

## Alternatives considered

1. **New live dashboard/widget with a refresh timer.** Rejected. Pi supports widgets, but the existing browser is already the explicit discovery route and a timer would create another UI-owned state source and routine churn.
2. **Batch full output/diagnostics aggregation.** Rejected. It makes byte bounds, ordering, and cursor semantics harder and is not needed to answer “which selected children are still running?” Summary batch plus per-run refs provides the collection ergonomics without a second transcript format.
3. **Infer final output from the last assistant-looking text.** Rejected. It would mislabel progress narration, partial output, or a failed turn. Use only structured terminal boundaries and existing canonical result fields.
4. **Measure shell-command duration.** Deferred. The extension observes backend process and structured events, not the child’s individual shell commands. Adding backend-specific command-start/command-end parsing would be a separate evidence contract and is not proven by the issue’s experiment.

## Verification

One authoritative deterministic test per public behavior:

- `test/external-runs.test.ts`: batch target validation, consistent normalized entry shape across live/durable agent and live/historical workflow targets (workflow entries never carry `children`), all-or-nothing ownership, bounded batch cursor continuation and its session/project scope binding, an actionable error (not an oversized page or a silently dropped target) when a single compact entry plus its pagination envelope cannot fit `limitBytes` — and, per the corrected §1 finding above, an assertion on the actual returned response TEXT byte length (the real `{entries, nextCursor}` envelope under multi-byte UTF-8 descriptions), not merely the entries array — detail refs, workflow `final` view including a legitimate JSON `null` result, and (per the fourth-review §3 correction above) the not-done/failed case returning a bounded EMPTY `content[0].text` with `finalAvailable: false` in `details` — no narration baked into the tool response, no raw JSON, never falling into the diagnostics shape — an unresolvable `wf_...` ID failing as unknown/unavailable across `inspect`/`cancel`/`wait`/batch, and settled `outcome.status` winning over a stale `observation.status`.
- `test/run-inspection.test.ts`: timing derivation from queued/execution/process/activity/finish boundaries; queued/live/terminal cases; missing and malformed timestamp handling; final view and cursor behavior across each supported structured backend shape; `executionStartedAt` alone (no `processStartedAt`, no output yet) classifying a record as running rather than queued, for both the summary projection and list entries.
- `test/agent-contract.test.ts`: a real background codex run's live `timing.queuedAt`/`executionStartedAt` stay visible through `external_runs inspect` after the backend's own progress node has replaced the tool's initial "queued" node (the actual regression the "preserve queuedAt across progress-node replacement" fix targets — a synthetic/mocked progress node would not exercise the real replacement path).
- `test/workflow.test.ts`: a workflow child sitting queued behind an externally-saturated concurrency limiter is visible in the registry with `status: "queued"` and a numeric `queuedAt` before its slot is granted, through `createWorkflowTool`'s real `startAgentRun` wiring (not the lower-level `runWorkflow` alone, which does not exercise the registry-seeding fix). Per the corrected §2 finding above, a second real-limiter test holds the backend's own response indefinitely after releasing an externally-saturated slot and asserts the child's OWN registry entry (not the workflow's aggregate snapshot) transitions to `status: "running"` with a numeric `executionStartedAt` — verified by spying on `registry.update` and asserting the first "running" observation is the small explicit `{status, executionStartedAt, queuedAt, description, backend}` shape (never a full `SubagentProgressNode` carrying `activity`/`id`, which would indicate the transition only happened via `spawnSubagent`'s own backend progress, not the `onAgentStart` boundary this fix wires).
- Backend adapter tests (`test/claude-backend.test.ts`, `test/codex-backend.test.ts`, `test/agy-backend.test.ts`, and existing Pi runtime coverage): only extend if a final-boundary extraction regression is exposed. Prefer one adapter test for each genuinely backend-specific distinction; do not duplicate the projection tests.
- `test/external-command.test.ts`: manual refresh and timing/final-availability labels only if command behavior is changed; the run-detail `Final` route dispatches to `inspect(view: "final")` distinctly from `Output`/`Diagnostics`; a registry-confirmed-live queued row shows a current queue age while an otherwise-identical `live: false` (orphaned/durable-looking) queued row does not, per the corrected §4 finding above; do not test colors or exact cosmetic spacing. Per the fourth-review §3 correction above, a real command-route regression (a real `RunRegistry`/`createExternalRunsTool`, not a stubbed `externalRuns.execute`) selects `Final` for a genuinely unavailable agent run and a genuinely unavailable workflow run and asserts `ctx.ui.notify` fires with an informative message and `ctx.ui.editor` is never opened, while a workflow with a legitimate settled `null` result still opens via `ctx.ui.editor` with the real JSON and never triggers the notice.
- `README.md`, `src/prompts.ts`, and `docs/field-testing.md`: document batch summary inspection, explicit final view, and manual refresh. The background-run usage example must show the actually-recommended shape — two (or more) separate `background: true` launches, an *optional* parent delay before doing anything else, unrelated parent work in between, a single batch `inspect` call to check on both, then leaving them running and collecting output in a later turn — and must state plainly that a parent's own `sleep`/wait or its process lifetime is not the same measurement as, and does not bound or guarantee, how long the delegated command itself takes to run. A 30-second-sounding child task can legitimately take substantially longer end-to-end once queueing and backend overhead are included, and a parent that returns or is torn down does not stop an already-registered background run.

Real-provider checks remain opt-in and change-triggered. The issue’s original sleep experiment is not a deterministic test of process overlap or command duration.
