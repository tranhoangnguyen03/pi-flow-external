# Workflow supervision decision log

Companion to [the design](2026-09-14-child-observation-and-supervision-design.md). Records approved architectural decisions separately from proposals under discussion.

## 1. Execution ownership — approved

Execution is owned by the originating parent session, not by an individual start, inspect, or wait call. The session owns lifetime; workflows retain ownership of coordination and their children.

- Explicit nonblocking runs survive tool returns and parent turns.
- Returning from inspect/wait does not stop execution.
- Finishing an assistant response or compacting parent context does not stop execution. Runs remain discoverable independently of model memory.
- Interrupting a wait stops waiting only. Explicit cancellation stops work.
- Blocking invocations retain interruption behavior: interrupting the call cancels its work. This lifetime behavior is separate from the uniform workflow failure contract in decision 5.
- Closing the originating session or gracefully shutting down the host cancels its active work and preserves available interrupted output.
- After a crash, unfinished records are interrupted/uncertain, never falsely reported as active or confirmed cancelled. Process termination cannot be guaranteed retrospectively.
- Restart restores evidence access, not live execution. Replay and backend conversation resume are explicit operations.
- Cross-session live takeover and a persistent background-job service are out of scope.

Approved by user in design discussion.

## 2. Cancellation, dependency handling, and escalation — approved

The composition owns handling of unsuccessful child outcomes. JavaScript workflows are not declared dependency graphs; the runtime must not infer dependencies or automatically cancel presumed dependants.

- Under the new supervision contract, completed, failed, cancelled, and timed-out children have distinguishable outcomes with references to available output. The JavaScript representation remains undecided.
- Scripts explicitly handle optional failures/cancellations and any fallback. Handled outcomes allow independent work to continue without unsolicited parent wake-up.
- An unhandled unsuccessful outcome terminates the workflow unsuccessfully and cancels remaining active children as lifecycle cleanup. Preserve their available output.
- Cancelling a child does not itself cancel siblings when the composition handles that outcome.
- No automatic retry, no implicit use of partial output as a dependency result, and no guessed dependency graph.
- A parent-requested cancellation receives acknowledgement, not duplicate unsolicited child-cancellation notification. Unhandled workflow failure wakes the parent.
- No suspended blocked workflow waiting for parent repair. Follow-up/replay is explicit; parent checkpoints remain deferred.
- Superseded compatibility proposal: preserving legacy failure-to-null execution was rejected in decision 5. Stale scripts must instead fail transparently before execution.

Approved by user in design discussion.

## 3. Replay — approved

Replay is an explicitly requested new execution attempt with successful-prefix reuse, not restoration of a suspended worker or exact reproduction of execution timing/decisions.

- Inspection executes nothing. Backend conversation resume is a separate operation.
- Retain longest unchanged successful-prefix reuse. Execute again from the first changed or unsuccessful call.
- Failed, cancelled, and timed-out outcomes remain historical evidence, not successful cache entries.
- Explicit replay authorizes another attempt at unsuccessful children; nothing retries automatically as a consequence of this design.
- Cancellation commands apply to their original invocation only, not future replays.
- Successful fallback work after the first unsuccessful call may execute again under the prefix rule. A previously failed child can succeed, changing the script's branch on replay.
- Replay is not rollback and does not guarantee side-effect-free reruns. Surface reusable-prefix/execution-boundary information when known, without introducing mandatory approval ceremony or pretending dynamic future calls are known in advance.
- Decision replay for races, parent checkpoints, and live steering remains deferred.

Approved by user in design discussion.

## 4. Inspection, identity, output, and wait — approved

- A stable run ID exists from queueing through terminal evidence retrieval. Use it for inspect, wait, cancel, and receipts; labels are descriptive, not unique identifiers.
- Workflows have their own IDs and expose child IDs. Summary inspection includes bounded navigable child listings.
- Inspect defaults to task/state/freshness/output availability, not transcript dumps.
- Output and diagnostics are separately retrievable in bounded portions with opaque continuation cursors and an explicit indication of more content.
- Output is labeled preliminary, final, or interrupted independently of run status. Preserve available interrupted output without claiming successful completion.
- Wait targets terminal outcomes for one, any, or all selected runs. Targets can be direct children, workflow children, or workflows. No public general event subscription.
- Waiting for a workflow does not wake for routine internal child events. Explicitly waiting for a child observes its outcome without changing composition semantics.
- Wait returns outcomes/reasons, bounded answer previews, output/diagnostic references, and which selected runs remain pending. Short answers need not require another retrieval call.
- The caller waits on the remaining set next; no event acknowledgement subsystem. Already-terminal targets return immediately when explicitly requested.
- Any-of wait does not select a winner or cancel remaining work. Routine activity never triggers unsolicited wake-ups.

Approved by user in design discussion.

## 5. One workflow API contract; transparent incompatibility — approved

Do not maintain legacy and new execution modes. Workflows are cheaply recomposed by the parent; actionable incompatibility is preferable to dual semantics.

- Every current-contract agent() returns its result on success and throws a structured, catchable child error for failure, cancellation, or timeout.
- Errors carry outcome, run ID, concise reason, and available output/diagnostic references across the worker boundary. Partial output never occupies the successful result slot.
- Composition helpers honor the same contract: no implicit conversion of failures to null. Explicit handling permits continuation; errors escaping the composition terminate it and cancel remaining children.
- Blocking/nonblocking affects parent control and lifetime behavior, not failure semantics.
- Require a minimal API-version declaration in existing workflow metadata. Support one current contract; the declaration detects stale scripts, not selects a legacy execution mode. Exact field/version is an implementation detail.
- Reject missing/unsupported declarations before launching any children. State that none were launched, explain current semantics, and give actionable recomposition instructions. Update tool guidance/examples accordingly.
- Saved and persisted scripts follow the same boundary. Reject replay evidence from incompatible execution contracts; no silent cross-contract cache reuse or automatic migration.
- Parent may recompose explicitly. Runtime never automatically reruns repaired scripts. Distinguish cheap script repair from potentially costly or side-effecting child re-execution.

Approved by user. Architectural decisions are complete enough for implementation planning; concrete schemas, cursor mechanics, and runtime wiring remain implementation-level design.
