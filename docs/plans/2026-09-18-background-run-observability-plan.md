# Background-run observability Implementation Plan

**Goal:** Improve background-run collection and observability using existing run evidence, without changing execution, cancellation, or hands-off semantics.

**Architecture:** Extend `external_runs` with safe batch summary inspection and a verified final-output projection; derive unambiguous timing from existing/frozen boundaries; improve the existing `/external runs` browser.

**Tech Stack:** TypeScript, Vitest, existing `src/external-runs.ts`, `src/core/run-inspection.ts`, backend adapters, `src/external-command.ts`, user docs.

**Post-implementation review correction (2026-09-20, independent review round 2):** the first implementation pass had six concrete defects, all now fixed and covered by regression tests; see the corresponding corrected passages in the design doc for full rationale. Summary: (1) batch inspection was letting a single oversized entry overflow the caller's own `limitBytes` instead of failing actionably — fixed to fail with an actionable error naming the run, never overflow, never silently drop a target. (2) batch entries mixed a flat `historicalAgent` shape with a nested live/workflow shape, and workflow entries carried an unbounded `children` array — fixed to one consistent normalized shape with `children` replaced by refs (workflow `source` was independently verified to be a small `"inline"|"saved"|"path"` enum, not raw script text, contrary to an earlier review claim). (3) the single-run `inspect` workflow branch had no `final` case and fell into the diagnostics `{status,error}` shape — fixed with an explicit branch, using a shared `workflowFinalState` helper and an explicit `result !== undefined` check so an intentional JSON `null` result reads as available. (4) a workflow child's `queuedAt` was invisible until its first real progress event (after limiter acquisition) because nothing seeded a registry observation at queue time — fixed by seeding one immediately in `workflow/tool.ts`'s `startAgentRun`. (5) durable status classification ignored `executionStartedAt`, so an already-running Pi run with no output yet could misreport as still queued — fixed to treat `executionStartedAt` as sufficient "running" evidence on its own. (6) live agent projections preferred `observation.status` over a settled `entry.outcome.status`, risking a stale status once terminal — fixed to prefer the registry's own settled outcome. A seventh, adjacent fix: an unresolvable `wf_...` ID was falling through to the agent-only durable reader across `inspect`/`cancel`/`wait`/batch and misreporting as an invalid-format ID; all four now reject it as unknown/unavailable directly.

**Post-implementation review correction (2026-09-20, independent review round 3):** a further pass found five more concrete defects in round 2's own fixes, all now fixed and covered by regression tests; see the matching corrected passages in the design doc. Summary: (1) the round-2 batch byte-budget fix still only summed each served entry's own JSON size (`usedBytes += Buffer.byteLength(JSON.stringify(entry))`), never accounting for the `{entries, nextCursor}` wrapper or the cursor string itself — so a real response could still exceed the caller's own `limitBytes` despite the check passing; fixed to size the actual full candidate response text at each step. (2) a workflow child's OWN `RunRegistry` entry (not the workflow's aggregate snapshot) never explicitly transitioned `queued` → `running` at the limiter-acquisition boundary — it only did so incidentally, once `spawnSubagent`'s own backend-specific progress emitter got around to firing; fixed by wiring an explicit `registry.update` into `workflow/tool.ts`'s `onAgentStart` handler, mirroring the direct `Agent` tool's already-correct `pi-subagent.ts` wiring. (3) `/external runs` list rows had no way to show a currently-queued row's queue duration at all (`queueDelayMs` only exists once execution starts) — fixed with a render-time "queue age" computed from `queuedAt`, gated on the row being registry-confirmed live so an orphaned durable row never gets a fabricated age. (4) the workflow `final` view's unavailable case returned raw `JSON.stringify({runId, finalAvailable:false})` as its response text instead of an explanation — fixed with a dedicated human-readable message, kept clearly distinct from a legitimate settled `null`/object result. (5) `docs/field-testing.md` had no concrete manual check for batch inspection, the `final` view, or `/external runs` `Refresh`; a `readListItem`/`summaryProjection` queued-vs-running classification duplicate was also folded into one shared helper (trivial, behavior-preserving reuse).

---

## Task dependencies

1. Shared timing helper and execution boundary
2. Verified final-output projection
3. Batch inspection
4. Command/UI browser and user guidance
5. Verification and release checks

Do not implement collection orchestration, automatic join, background polling, notifications, retries, or shell-command timing.

---

### Task 1: Freeze the execution-started evidence boundary

**Files:**
- Modify: `src/core/run-inspection.ts` (read the new event into `RunObservation`)
- Modify: `src/pi-subagent.ts` (direct `Agent` calls acquire the limiter here)
- Modify: `src/workflow/runtime.ts` (workflow `agent()` calls acquire the limiter here — **not** `src/workflow/tool.ts`, which only wires callbacks and never calls the limiter itself)
- Modify: `src/workflow/types.ts` (thread `executionStartedAt` through `WorkflowAgentCall`)
- Modify: `src/workflow/tool.ts` (pass `call.executionStartedAt` into `spawnSubagent`)
- Modify: `src/core/spawn.ts`, `src/core/progress.ts`, `src/core/claude.ts`, `src/core/codex.ts`, `src/core/agy.ts` (thread `executionStartedAt` through the existing `SubagentProgressNode` timing plumbing so it survives progress-node replacement and lands in the terminal summary)
- Modify: `src/types.ts` (`SubagentProgressNode.executionStartedAt`)
- Modify: `src/workflow/tool.ts` (also: seed an initial `status: "queued"`/`queuedAt` registry observation for a workflow child immediately in `startAgentRun`, mirroring the direct `Agent` tool's own top-of-`executeRun` `registry.update` — without it a workflow child has no observation at all, and so defaults to reporting `"running"` with no `queuedAt`, until its first real progress event fires deep inside `spawnSubagent`, after limiter acquisition; also: explicitly transition that same child's registry entry from `"queued"` to `"running"` with `executionStartedAt` inside `onAgentStart`, at the limiter-acquisition boundary — round-3 correction — rather than leaving that transition to happen incidentally whenever `spawnSubagent`'s own backend progress emitter first fires)
- Modify: `src/workflow/types.ts` (also: thread `runId`/`executionStartedAt` through the live, non-cached `onAgentStart` event so `workflow/tool.ts` can perform the update above)
- Modify: `src/workflow/runtime.ts` (also: pass `runId: runRecord?.runId, executionStartedAt` on the live `onAgentStart` call)
- Modify: `src/core/run-inspection.ts` (also: durable status classification — `readListItem` and `summaryProjection` — must treat `executionStartedAt` as sufficient "running" evidence on its own, alongside `processStartedAt`/observed output, not only as a timing input; `processStartedAt` never exists for Pi, so gating on it alone misreports an already-executing Pi run with no output yet as still queued)
- Modify: `src/external-runs.ts` (also: `liveAgentSummary`/`listedAgent` must prefer a settled `entry.outcome.status` over `observation.status` once the run has terminated, since the registry's own settled outcome is authoritative and an unvalidated ambient observation is not guaranteed to have been refreshed to match)
- Test: `test/run-inspection.test.ts` (event-derived `executionStartedAt` in the summary projection, and the `executionStartedAt`-alone running classification for both the summary projection and list entries; this repo has no separate `test/run-record.test.ts` case for this — `run-record.test.ts` covers the generic `event()`/`finish()` contract, not per-event-type projection, which is `run-inspection.ts`'s job)
- Test: `test/agent-contract.test.ts` (a real background codex run's live `timing.queuedAt`/`executionStartedAt` survive the backend's own progress-node replacement, observed through `external_runs inspect`)
- Test: `test/workflow.test.ts` (a workflow child queued behind an externally-saturated limiter is visible in the registry with `status: "queued"` and `queuedAt`, through `createWorkflowTool`'s real `startAgentRun`; round-3 addition: after releasing that slot while the backend's own response is held indefinitely, the child's OWN registry entry — not the workflow's aggregate snapshot — transitions to `status: "running"` with a numeric `executionStartedAt`, verified by spying on `registry.update` and asserting the first "running" observation is the small explicit shape from `onAgentStart`, not a full `SubagentProgressNode`)
- Test: `test/external-runs.test.ts` (settled `outcome.status` wins over a stale `observation.status`)

**Step 1: Write the failing test**

Add a test proving the execution-start boundary is recorded as evidence and surfaces in the summary projection's `timing` object:

```ts
it("derives executionStartedAt from the execution_started evidence event", async () => {
  const root = await temporaryRoot();
  const record = createRunRecord({ directory: root });
  await record.event("execution_started");
  await record.finish({ status: "done", result: "ok" });
  const page = await inspectRun({ runsDirectory: root, runId: record.runId, view: "summary" });
  const projection = JSON.parse(page.items.map((item) => item.text).join(""));
  expect(projection.timing.executionStartedAt).toEqual(expect.any(String));
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- test/run-inspection.test.ts`
Expected: FAIL because `execution_started` is not yet a recognized event type and `timing` does not yet exist.

**Step 3: Write minimal implementation**

- Append an `execution_started` event (no payload needed — the NDJSON envelope's own auto-generated `timestamp`, the same mechanism `process_started` already relies on, is the boundary) immediately after `limiter.acquire()` resolves, at each of the two real call sites (`pi-subagent.ts`'s `executeRun`, `workflow/runtime.ts`'s `executeAgent`).
- `run-inspection.ts`'s `readObservation` recognizes `execution_started` the same way it already recognizes `process_started`, populating `RunObservation.executionStartedAt`.
- Thread the same numeric timestamp through `SpawnSubagentParams.executionStartedAt` → `ProgressEmitterOptions.executionStartedAt` → `SubagentProgressNode.executionStartedAt`, mirroring exactly how `processStartedAt` already flows from a backend into the terminal summary via `details.progress?.processStartedAt`, so `record.finish()` persists it too.
- Preserve behavior for legacy records that lack the event: timing projection simply omits `executionStartedAt` and anything derived from it.

**Step 4: Run test to verify it passes**

Run: `npm test -- test/run-inspection.test.ts test/run-record.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/core/run-inspection.ts src/core/spawn.ts src/core/progress.ts src/core/claude.ts src/core/codex.ts src/core/agy.ts src/pi-subagent.ts src/workflow/runtime.ts src/workflow/tool.ts src/workflow/types.ts src/types.ts test/run-inspection.test.ts
git commit -m "feat: record explicit background execution-start boundary"
```

---

### Task 2: Derive explicit queued/live/terminal timing

**Files:**
- Modify: `src/core/run-inspection.ts`
- Modify: `src/external-runs.ts`
- Test: `test/run-inspection.test.ts`
- Test: `test/external-runs.test.ts`

**Step 1: Write the failing test**

Cover queued, live, and terminal records using existing fixtures:

```ts
it("derives queue delay, elapsed runtime, and activity age without inventing timestamps", async () => {
  const page = await inspectRun({ runsDirectory: root, runId: queued.runId, view: "summary" });
  const projection = JSON.parse(page.items.map((item) => item.text).join(""));
  expect(projection.state.status).toBe("queued");
  expect(projection.timing.queueDelayMs).toBeUndefined();
  expect(projection.timing.elapsedMs).toBeUndefined();
});

it("never computes a now-relative elapsed/activity age from durable evidence alone, even when status reads running", async () => {
  // A record with no finishedAt and no owning RunRegistry entry could be a live
  // run OR an orphaned/crashed one; run-inspection.ts has no registry access and
  // must not guess. Only src/external-runs.ts may compute now-relative fields,
  // and only for entries it resolves through registry.get(runId).
  const page = await inspectRun({ runsDirectory: root, runId: runningNoRegistry.runId, view: "summary" });
  const projection = JSON.parse(page.items.map((item) => item.text).join(""));
  expect(projection.state.status).toBe("running");
  expect(projection.timing.elapsedMs).toBeUndefined();
  expect(projection.timing.activityAgeMs).toBeUndefined();
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- test/run-inspection.test.ts`
Expected: FAIL because timing fields are missing.

**Step 3: Write minimal implementation**

Implement one shared, pure `deriveRunTiming(inputs, live, now?)` helper in `src/core/run-inspection.ts`, taking an explicit `live` boolean so the "durable, evidence-only" and "registry-confirmed live" code paths cannot silently diverge:

- `queuedAt`
- `executionStartedAt`
- `processStartedAt`
- `firstActivityAt`
- `lastActivityAt`
- `finishedAt`
- `queueDelayMs`
- `elapsedMs`
- `activityAgeMs`
- `processDurationMs`

Rules:
- Emit derived durations only when the necessary timestamps exist.
- `elapsedMs`/`activityAgeMs` for a run with no `finishedAt` are computed **only when `live` is true** — i.e. only in `src/external-runs.ts`, only for a target actually resolved via `RunRegistry.get(runId)`. `run-inspection.ts`'s own callers (`inspectRun`, `listRunRecords`, `getRunRecord`) always pass `live: false`, because durable evidence alone can never distinguish a genuinely still-running child from an orphaned/crashed record whose parent session never got to write `finishedAt`.
- Do not show `activityAgeMs` for terminal runs.
- Never expose process lifetime as shell-command duration.
- Clamp or omit negative/malformed values (omit, specifically — never floor to zero).
- Do not introduce a second evidence/UI-only representation; `external-runs.ts` imports and calls the same `deriveRunTiming` rather than reimplementing the math.

**Step 4: Run test to verify it passes**

Run: `npm test -- test/run-inspection.test.ts test/external-runs.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/core/run-inspection.ts src/external-runs.ts test/run-inspection.test.ts test/external-runs.test.ts
git commit -m "feat: expose explicit background-run timing from existing evidence"
```

---

### Task 3: Add the verified final-output projection

**Files:**
- Modify: `src/core/run-inspection.ts`
- Modify: `src/external-runs.ts`
- Test: `test/run-inspection.test.ts`

**Step 1: Write the failing test**

Verify a structured successful terminal answer is retrievable separately, while partial/interrupted runs are not mislabeled:

```ts
it("exposes verified terminal answers separately from combined output", async () => {
  const page = await inspectRun({ runsDirectory: root, runId: terminal.runId, view: "final", limitBytes: 1_000 });
  expect(page.outputStatus).toBe("final");
  expect(page.items.map((item) => item.text).join("")).toContain("canonical answer");
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- test/run-inspection.test.ts`
Expected: FAIL because `view: "final"` is unsupported.

**Step 3: Write minimal implementation**

Add `view: "final"` by **reusing the existing `canonicalResult(summary)` helper already in `run-inspection.ts` — do not add a second backend-specific parser or a narration-vs-final text heuristic.** `canonicalResult` already reads `summary.status === "done"` and `summary.structuredOutput ?? summary.result` from the terminal `summary.json` document, and that `result` field is already populated identically for all four backends by the single `record.finish({ ..., result: details.result })` call in `src/core/spawn.ts`, downstream of each backend's own already-tested strict terminal-success checks (`spawnClaudeSubagent`, `spawnCodexSubagent`, `spawnAgySubagent`, and the pi branch of `spawnSubagentRuntime`). So:

- Claude/Codex/Agy/Pi all go through the same `canonicalResult(terminal)` call — no per-backend branch is added in the `final` view itself.
- Empty bounded result plus `finalAvailable: false` when `terminal.status !== "done"` or the canonical result is empty.
- Reuse the existing single-item cursor machinery (`terminalPage`, generalized from `view: "output"`'s terminal branch) and preserve terminal success criteria exactly as already enforced.
- Existing `output` view and its per-backend streaming extraction (`extractClaudeFinalText`, `extractCodexFinalText`, the agy step_update branch) are unchanged; add `finalAvailable` metadata to summaries alongside the existing `output.available`/`output.status`.
- Only extend `test/claude-backend.test.ts`/`test/codex-backend.test.ts`/`test/agy-backend.test.ts` if this exposes a genuine final-boundary extraction regression in one adapter; otherwise this task adds no backend-adapter test changes, since `final` has no new backend-specific extraction logic to cover.
- `final` extends to workflows too (`src/external-runs.ts`'s single-run `inspect` workflow branch and the batch resolver in Task 4), via a shared `workflowFinalState(entry, journal)` helper checking an actually-settled `status === "done"` and an explicit `result !== undefined` — not `??`/truthiness — so a legitimate JSON `null` workflow result still reads as available. `final` must be its own branch of that handler's view selector, not left to fall through into the `{status, error}` diagnostics shape.
- **Round-3 correction:** when a workflow's `final` view is unavailable, it must return a bounded, cursor/limitBytes-validated EMPTY page (`text: ""`) with `finalAvailable: false` and a `status` field in `details` — never raw `JSON.stringify({runId, finalAvailable:false})`, and (round-4 correction below) never a synthesized human-readable sentence baked into the response text either. The available case (`finalAvailable: true`, including a legitimate `null`/object result) is unchanged and stays distinct in content and shape.
- **Round-4 correction (2026-09-20, independent review round 4):** round 3's own fix put the human-readable "no final answer" explanation into the TOOL's response text (`content[0].text`) for the workflow branch, which pollutes the `final` view's narration-free canonical-answer contract — and left the pre-existing agent-side fallback (`text || "No ${view} is available for ${runId}."`, shared with `output`/`diagnostics`) doing the same for agent runs. Both are reverted: `view: "final"` now returns a literal empty string when unavailable, for both agent and workflow runs, going through the same bounded/cursor-validated machinery as every other page (`output`/`diagnostics` keep their existing generic fallback text; only `final` is narration-free). The human-readable explanation moves entirely to the UI boundary: `src/external-command.ts`'s `showPages` now checks `page.details.finalAvailable !== true` for `view: "final"` and calls `ctx.ui.notify(...)` with a clear message instead of opening `ctx.ui.editor` with an uninformative (now literally empty) page — uniformly for both agent and workflow routes, since both share the same `finalAvailable` signal in `details`. The workflow branch's *available* case was also given an explicit `finalAvailable: true` in `details` (previously only embedded inside the JSON `content` text) so the UI boundary can distinguish available from unavailable without parsing content.

**Step 4: Run test to verify it passes**

Run: `npm test -- test/run-inspection.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/core/run-inspection.ts src/external-runs.ts test/run-inspection.test.ts
git commit -m "feat: expose verified final answers separately from combined output"
```

---

### Task 4: Add single-page batch summary inspection

**Files:**
- Modify: `src/external-runs.ts`
- Test: `test/external-runs.test.ts`

**Step 1: Write the failing test**

Prove explicit selected runs can be inspected without waiting:

```ts
it("inspects explicit selected runs in one bounded batch without waiting", async () => {
  const result = await execute({ action: "inspect", runIds: [first.runId, second.runId] });
  expect(result.details.entries.map((entry: any) => entry.runId)).toEqual([first.runId, second.runId]);
  expect(result.details.entries[0].outputRef).toMatchObject({ runId: first.runId, view: "output" });
  expect(result.details.nextCursor).toBeUndefined();
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- test/external-runs.test.ts`
Expected: FAIL because `runIds` is unsupported for `inspect`.

**Step 3: Write minimal implementation**

Add batch `inspect`:

- Accept either `runId` or `runIds`; never both.
- Deduplicate targets and preserve request order.
- Cap at 20 targets (a dedicated `MAX_BATCH_INSPECT_TARGETS`, distinct from — and lower than — `wait`'s existing 100-target cap; both share the same `runIds` schema field, so this cap is enforced at runtime for the `inspect` action specifically, not in the TypeBox schema).
- Default to summary and reject any non-summary batch view.
- Build a dedicated, consistent, normalized entry shape (`{runId, kind, live, task, state, timing, output, outputRef, diagnosticsRef}`) for every target regardless of live/durable/agent/workflow origin — reusing the underlying single-run resolution (`registry.get`, `loadWorkflowJournal`, `getRunRecord`) and, for the live-agent case, `liveAgentSummary` directly (it is already exactly this shape), but never raw-spreading `historicalAgent`'s flat `RunRecordListItem` shape or a workflow summary's unbounded `children` array into a batch entry.
- Validate every ID and session/project ownership for the **entire requested `runIds` set** before returning any page — not only the entries the current page would serve — so a bad target on a later page cannot slip through on an earlier one.
- Include run identity, state, timing, integrity (agents), `output.available`, and `output.finalAvailable`; `outputRef` and `diagnosticsRef`.
- **Byte budget: reuse the existing `limitBytes` parameter (default 32 KiB, existing 64 KiB `MAX_PAGE_BYTES` cap) — do not add a second, larger aggregate budget.** An earlier draft of this plan specified an additional 256 KiB aggregate page budget; that is corrected here and must not be implemented.
- Pagination is simple target-index pagination: the cursor is an opaque pointer to the next unserved index in the caller's own ordered `runIds` array, not a byte offset into or across entries. **Size the FULL candidate response text — `JSON.stringify({ entries: servedSoFar.concat(candidate), ...(moreRemain ? { nextCursor } : {}) })` — not just the sum of each entry's own JSON size.** A first implementation pass tracked only a running `usedBytes` sum of individual entry sizes, which silently ignored the `{entries, nextCursor}` wrapper and the cursor string itself (the cursor grows with the caller's own `runIds` array size); that under-counts the real response and can exceed the caller's stated `limitBytes` despite the check appearing to pass. Build and measure the actual candidate payload at each step instead — smallest simple approach, not a separate overhead-estimation formula. A page accumulates whole entries while that full candidate payload fits within `limitBytes` and never exceeds it in its real serialized form. **If a single entry plus its pagination envelope is larger than `limitBytes` on its own, fail the request with an actionable error naming the run and directing the caller to raise `limitBytes` or use single-run `inspect` — never serve an oversized page, never silently drop the target, and never return a zero-entry non-advancing page.** An earlier draft of this plan instead always served at least one entry per page even when it exceeded `limitBytes`; that is corrected here and must not be implemented — it violates the caller's own stated byte budget for no benefit a clear error doesn't provide better.
- Bind the batch cursor to the ordered target set and to session/project scope (an unknown-or-mismatched `runIds` array, or wrong scope, fails with an actionable error) — but **not** to any per-target live-record revision. Unlike the single-run summary cursor, a batch page's entries are always served whole, never mid-entry byte-sliced, so there is nothing for a target mutating between pages to corrupt, and no revision check is needed or added.
- Preserve single-run behavior compatibility.

**Step 4: Run test to verify it passes**

Run: `npm test -- test/external-runs.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/external-runs.ts test/external-runs.test.ts
git commit -m "feat: inspect selected background runs in one bounded request"
```

---

### Task 5: Improve the existing run browser and guidance

**Files:**
- Modify: `src/external-command.ts`
- Modify: `src/prompts.ts`
- Modify: `README.md`
- Modify: `docs/field-testing.md`
- Test: `test/external-command.test.ts`

**Step 1: Write the failing test**

Cover only behavior, not cosmetics:

```ts
it("refreshes the manual run list and exposes timing/final-output routes", async () => {
  await command?.handler("runs", interactiveCtx);
  expect(externalRuns.execute).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ action: "list" }), undefined, undefined, interactiveCtx);
});
```

Extend this minimal test to verify a `Refresh` selection re-reads the current page and summary output includes timing/final availability when changed command behavior is finalized.

**Step 2: Run test to verify it fails**

Run: `npm test -- test/external-command.test.ts`
Expected: FAIL until manual refresh/labels are implemented.

**Step 3: Write minimal implementation**

Update `/external runs`:

- Show short description, status, queue/elapsed duration, live activity age, and output/final availability in list rows.
- **Round-3 correction:** a row still genuinely queued (no `executionStartedAt` yet, so `queueDelayMs` does not exist) must show a live "queue age" (`now - queuedAt`, computed at render time — no new timer or evidence field) instead of no duration at all — but only when the row is registry-confirmed live (`item.live === true`); an orphaned/durable-looking `"queued"` row (`live: false`) must never get a fabricated, ever-growing age.
- Add a manual `Refresh` choice that re-reads from the current page start and resets stale cursors.
- Keep Summary/Output/Diagnostics/child/cancel navigation.
- Do not add live timers, widgets, dashboards, or completion notifications.
- Update prompts/README/field-testing docs with:
  - Batch summary inspection.
  - Verified final view and when output remains combined.
  - Manual refresh behavior.
  - A corrected usage example: two (or more) separate `background: true` launches, an optional parent delay, unrelated parent work in between, a single `inspect` (batch) call to check on both, then leaving them running and collecting output in a later turn — explicitly stating that a parent's own sleep/wait duration or process lifetime is not the same measurement as, and does not bound, how long the delegated command itself actually takes.

**Step 4: Run test to verify it passes**

Run: `npm test -- test/external-command.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/external-command.ts src/prompts.ts README.md docs/field-testing.md test/external-command.test.ts
git commit -m "feat: improve background-run discoverability in existing browser"
```

---

### Task 6: Final verification and review handoff

**Files:**
- No implementation changes unless verification exposes a regression.

**Step 1: Run deterministic checks**

Run: `npm run check`
Expected: PASS.

**Step 2: Run packaging and dependency checks**

Run: `npm pack --dry-run --json`
Expected: PASS.

Run: `npm audit --omit=dev --audit-level=high`
Expected: PASS; document any newly reported issue before release.

**Step 3: Stop before provider testing**

Do not run token-consuming E2E unless a changed backend adapter requires it. If needed, use only:
- `npm run e2e -- --backend <affected-backend>`
- `npm run e2e -- --backend pi --harness <already-registered-harness>`

**Step 4: Report**

This plan was approved by the user after an Agy/Claude design review round (2026-09-20) that produced the corrections folded into this document and into the design doc; implementation proceeded directly in the same session per the user's explicit instruction, single-session and without nested agents. Report changed files, exact verification command output, and any unresolved limitations at the end of the implementation turn instead of pausing here for an execution-approach choice.
