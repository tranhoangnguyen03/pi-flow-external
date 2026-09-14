# Child Observation and Workflow Supervision Implementation Plan

> **REQUIRED SUB-SKILL:** Use the executing-plans skill to implement this plan task-by-task.

**Goal:** Give users and parent agents readable child output and session-owned, workflow-aware supervision without routine model interruptions.

**Architecture:** Keep the existing external backend adapters, concurrency limiter, run evidence, and JavaScript workflow worker. Introduce a session-owned execution registry shared by direct calls and workflow children, project readable output from durable evidence, and expose bounded inspection plus outcome-only waits. One metadata-versioned workflow contract replaces failure-to-null semantics with catchable child errors.

**Tech Stack:** TypeScript, Node.js abort signals/processes/workers/filesystem, existing Pi extension APIs and TypeBox, Vitest. No new dependency or persistent service.

---

## Authority and scope

Read completely before implementation:

- [Approved design](2026-09-14-child-observation-and-supervision-design.md).
- [Approved decisions](2026-09-14-supervision-decisions.md), authoritative where early design prose differs.
- `AGENTS.md`, `README.md`, `docs/field-testing.md`.
- Installed Pi `docs/extensions.md`, `docs/sdk.md`, `docs/tui.md` and relevant linked Markdown/examples before implementing lifecycle/tools/UI. Resolve under the installed `@earendil-works/pi-coding-agent` documentation root, not this repository. Read these documents completely and verify actual installed type signatures.

This plan is not implementation. Suggested API spellings below are implementation choices consistent with approved semantics, not existing capabilities. No steering, parent checkpoints, dependency-graph inference, winner races, daemon, or live restart recovery.

Use an isolated worktree for implementation. Preserve the current untracked design documents by committing the documentation deliberately before deriving the implementation worktree, or copying them without overwriting unrelated changes. Do not silently discard or auto-commit unrelated user work.

## Concrete interface direction

### Launch

Add `background?: boolean` to existing `Agent` and `workflow` tools; default false. Both modes execute the same core and failure contract. Background returns a stable run handle after validation/registration, before waiting for a concurrency slot. Blocking awaits the same execution promise and keeps cancellation-on-tool-interrupt behavior.

### Supervision

Add one model-facing tool, `external_runs`, with a discriminated action schema:

- `list`: default current session; explicit project scope; bounded page/opaque cursor.
- `inspect`: `runId`, `view: summary|output|diagnostics` (summary default), bounded limit/opaque cursor; workflow summary exposes child IDs and pagination.
- `wait`: nonempty bounded `runIds`, `mode: any|all` (one target needs no separate mode). No polling timeout.
- `cancel`: `runId`, optional bounded reason. Report requested vs settled outcome accurately.

Use `external_runs` only as a naming proposal until verifying collisions with registered tools. Do not expose filesystem paths or backend event offsets as caller-supplied selectors. Reject unknown IDs, wrong-view cursors, malformed limits, and unavailable active ownership with actionable errors. Historical records remain inspectable; only the owning live session can cancel work. Deduplicate wait targets.

Wait returns terminal targets, pending targets, concise reasons/answer previews, and retrieval references. `any` returns already-terminal matches immediately, without cancelling siblings. `all` waits for all selected outcomes; when an explicitly selected workflow ends in unhandled failure, return early with a blocking-failure reason and pending targets to honor the agreed escalation rule. Child failure alone does not bypass all-of: the owning composition may handle it. Test and document this distinction.

### Workflow API

Require `meta.apiVersion: 1` as the first explicit version (unversioned scripts are legacy). One exported version constant, no legacy switch. Validate at source preparation and raw runtime entry before any child launches. Current `agent()` returns value or throws `ChildRunError`, with JSON-safe fields `runId`, `outcome`, `message`, and output/diagnostic references. Reconstruct the error in the worker; scripts need not import host modules. Preserve workflow-wide abort/fatal errors as uncatchable lifecycle termination rather than ordinary optional child failures.

Record API version in workflow journal identity/start data and replay fingerprints. Missing/mismatched journal contract rejects replay, with no backend launch. Update all shipped scripts/examples/test scripts together.

## Key current-code constraints

- `src/pi-subagent.ts` awaits spawn inline, stores TUI-only active runs, and gates progress on `hasUI`/theme availability.
- `src/core/spawn.ts` creates evidence after queue acquisition; attaches evidence IDs only at termination; timeout rewriting omits partial text from model-facing content.
- `src/core/{claude,codex,agy}.ts` own subprocesses and extract backend events. Claude/Codex failure paths omit captured result text. Process launch, first backend activity, and terminal success must remain distinct.
- `src/workflow/runtime.ts` converts nonfatal child exceptions to failed `null` results; shared abort controls prevent individual cancellation. `finishReject` currently rejects before awaiting every child cleanup.
- `src/workflow/script-worker.ts` also catches ordinary failures in composition helpers. Worker error messages currently lose structured child information. Discarded promises must continue to be accounted for.
- `src/workflow/tool.ts` owns snapshots and journals inside execute; it must be separable from invocation lifetime without a duplicate workflow runtime.
- `src/core/run-record.ts` provides serialized best-effort NDJSON and atomic summaries. Extend it rather than adding a parallel evidence system.
- `src/external-command.ts` exposes aggregate counts, not readable individual runs.

## Testing discipline for every task

1. Extend the existing lowest useful authoritative test for the behavior, or add one narrowly scoped new suite if ownership is new.
2. Run the targeted command and observe the intended failure before implementing.
3. Implement the minimum change, then rerun that command until it passes.
4. Review `git diff --check` and the task diff; commit only task-owned files at a coherent checkpoint.

Use fake backend executables and controllable promises/signals, never provider calls in `npm test`. Do not duplicate cancellation/receipt contracts at unit, integration, and E2E layers. Do not add rendering-prose assertion suites. Existing overlapping tests should be extended/replaced, not left alongside redundant coverage.

## Task 1: Enforce one workflow API version before execution

**Modify:** `src/workflow/types.ts`, `src/workflow/script-validation.ts`, `src/workflow/source.ts`, `src/workflow/runtime.ts`, `src/workflow/journal.ts`, `src/workflow/replay-cache.ts`, `src/prompts.ts`, `src/external-help.ts`.
**Update fixtures/examples:** workflow scripts in `test/workflow.test.ts`, `test/workflow-worker.test.ts`, source/contract tests, `scripts/e2e/external.mjs` and other shipped workflow examples found by `rg 'export const meta' src test scripts README.md`.

Steps:
1. Extend version/source validation coverage: missing/unsupported API declaration rejects before `runAgent` is called, and error explains repair plus zero launches.
2. Run `npx vitest run test/workflow.test.ts test/workflow-worker.test.ts` (expected new assertions fail).
3. Add one version constant and parse/validate metadata at both public source resolution and standalone runtime boundary. Enforce current-version journal loading and fingerprint identity.
4. Add the current declaration to maintained examples and fixtures; replace legacy failure examples rather than documenting both contracts.
5. Rerun targeted tests; commit `feat: enforce explicit workflow API contract`.

Do not use a textual regex to detect whether scripts handle failures. Version declaration is the compatibility boundary.

## Task 2: Give queued runs stable evidence identities

**Modify:** `src/types.ts`, `src/core/run-record.ts`, `src/core/spawn.ts`, `src/core/retention.ts`, `src/pi-subagent.ts`, `src/workflow/types.ts`, `src/workflow/runtime.ts`, `src/workflow/tool.ts`.
**Tests:** extend `test/run-record.test.ts`, `test/spawn-observation.test.ts`, `test/resume-retention.test.ts` at their respective owned boundaries.

Steps:
1. Add regression: register a queued run, cancel before slot acquisition, retrieve its same ID and terminal evidence; backend was never spawned.
2. Run `npx vitest run test/run-record.test.ts test/spawn-observation.test.ts test/resume-retention.test.ts`.
3. Allocate ID and record before enqueue; pass record/identity into shared spawn instead of minting another ID there. Keep internal probes' record opt-out working.
4. Persist parent session/project/workflow association and queue/start timestamps in existing evidence. Mark process started from actual spawn, not slot acquisition. Preserve integrity/pruning behavior for active/incomplete records.
5. Keep legacy record inspection supported where fields are absent; historical evidence compatibility is not legacy workflow execution support.
6. Rerun tests; commit `feat: identify external runs before queueing`.

## Task 3: Preserve partial output and separate observation from rendering

**Modify:** `src/core/{claude,codex,agy}.ts`, `src/core/progress.ts`, `src/core/spawn.ts`, `src/types.ts`, `src/pi-subagent.ts`, `src/workflow/tool.ts`.
**Tests:** extend `test/{claude,codex,agy}-backend.test.ts`, `test/spawn-observation.test.ts`, `test/agent-contract.test.ts`.

Steps:
1. Extend each adapter's existing interrupted/error fixture to emit assistant text before failure and assert its recovery without successful result status. Cover backend-specific parsing at adapters, timeout rewrite only at spawn.
2. Run `npx vitest run test/claude-backend.test.ts test/codex-backend.test.ts test/agy-backend.test.ts test/spawn-observation.test.ts test/agent-contract.test.ts`.
3. Keep available assistant output/message identity independently from successful final text. Preserve it through catch, timeout, and workflow failure boundaries. Keep stderr/tool results out of assistant output.
4. Add lifecycle/freshness observations to existing event flow; host heartbeat must not advance last-child-activity timestamps.
5. Remove direct-call observation gating on TUI themes. Keep spinners/status rendering conditional on UI availability. Produce observations even without an update subscriber, since registry/evidence consume them.
6. Do not claim first activity for backend init alone; use actual assistant/tool activity. Do not require model-authored reports.
7. Rerun tests; commit `fix: retain interrupted child output and normalize observation`.

## Task 4: Readable evidence projection with bounded cursors

**Create:** `src/core/run-inspection.ts`, `test/run-inspection.test.ts`.
**Modify:** `src/core/run-record.ts` only where existing evidence lacks required normalized metadata.

Steps:
1. Write reader checks for assistant message boundaries, no duplicate delta/final text, final vs interrupted labels, bounded pages and cursor continuation, malformed/wrong-run/wrong-view cursors, truncated NDJSON tail, and legacy records lacking optional metadata.
2. Run `npx vitest run test/run-inspection.test.ts` (expected fail until reader exists).
3. Project output/diagnostics from existing events plus summary. Reuse adapter extraction functions where appropriate; do not create a second transcript store or reimplement parsers in UI.
4. Use Node streaming line reads for evidence, not whole-file reads per poll. Encode run/view/version/position in an opaque validated cursor. Bound returned bytes and handle a single oversized message with text offsets rather than silently losing content. Cursor positions are implementation details.
5. Only parse complete appended records; incomplete trailing bytes are not EOF proof for a live run. Treat damaged terminal records distinctly from backend failure. No arbitrary caller paths.
6. Implement session/project-scoped bounded listing and workflow-child discovery from stored associations. Unknown/incomplete ownership yields honest historical state, not guessed live activity.
7. Rerun suite; commit `feat: add bounded readable run inspection`.

## Task 5: Session-owned registry and subscription cleanup

**Create:** `src/core/run-registry.ts`, `test/run-registry.test.ts`.
**Modify:** `src/pi-subagent.ts`, `src/workflow/tool.ts`, `src/types.ts`; share registry through existing extension construction.

Steps:
1. Read installed Pi lifecycle docs/types completely and trace session start/switch/shutdown. In particular verify whether switching sessions emits shutdown; if not, wire explicit old-session cleanup. Do not assume a singleton extension state means one originating session forever.
2. Write controllable-promise tests: run survives launching call return; separate per-run abort; workflow ownership; interrupt wait unsubscribes without aborting run; blocking interruption aborts run; session shutdown aborts/drains owned work; compaction does not cancel.
3. Run `npx vitest run test/run-registry.test.ts`.
4. Registry entry owns run ID, session/workflow association, abort controller, current observation, terminal promise, and listeners. Evidence remains durable truth; registry is active lifecycle state, not another persistence format.
5. Centralize registration and settlement. Attach rejection handling immediately to background promises; exactly-once terminal settlement, cleanup subscriptions, clear timers, release slots. Bound completed in-memory state by evicting after listeners consume, relying on evidence for history.
6. On graceful shutdown cancel then await adapter process cleanup/evidence flush within explicit existing kill/grace limits. On startup report records without local live ownership as interrupted/uncertain, never manufacture confirmed cancellation.
7. Run registry tests; commit `feat: own delegated execution by parent session`.

## Task 6: Structured child errors and composition semantics

**Modify:** `src/workflow/{types,runtime,script-worker,tool,journal}.ts`.
**Tests:** `test/workflow.test.ts`, `test/workflow-worker.test.ts`.

Steps:
1. Replace failure-to-null coverage with current contract: success remains raw value; caught child failure permits sibling success; uncaught failure aborts siblings and preserves records; cancellation/timeouts distinguish outcomes; worker roundtrip preserves error fields.
2. Run `npx vitest run test/workflow.test.ts test/workflow-worker.test.ts`.
3. Serialize child errors explicitly across worker messages and reconstruct Error instances with stable fields. Do not serialize Error via JSON.stringify alone.
4. Remove implicit ordinary-error swallowing in parallel/pipeline; preserve explicit user catches. Preserve fatal/global cancellation immunity to user catches.
5. Journal unsuccessful child outcomes before propagating; finish workflow only after pending child cleanup/record writes settle. Bound teardown if a worker is unresponsive; don't falsely imply killed subprocesses when cleanup fails.
6. Audit discarded agent promises: an unobserved child rejection must not produce a successful workflow merely because background observations used Promise.allSettled. Preserve detection without making legitimately caught errors fatal.
7. Replay reads only compatible successful prefix; unsuccessful child calls invalidate remaining prefix exactly as approved. Attach references for replayed children rather than losing discoverability or manufacturing backend runs for cache hits.
8. Rerun suites; commit `feat: propagate catchable workflow child outcomes`.

## Task 7: Unify launch lifetime and scoped cancellation

**Modify:** `src/pi-subagent.ts`, `src/workflow/tool.ts`, `src/workflow/runtime.ts`, `src/workflow/source.ts`, `src/core/run-registry.ts`.
**Tests:** extend `test/agent-contract.test.ts`, `test/workflow.test.ts`, `test/run-registry.test.ts` only for new integration boundaries.

Steps:
1. Add contract test for explicit background launch returning before child completion; blocking returns same terminal result; preflight validation fails with zero children.
2. Run `npx vitest run test/agent-contract.test.ts test/workflow.test.ts test/run-registry.test.ts`.
3. Extract execution from tool-call awaiting without duplicating runtime. Freeze parent context and capture session/cwd/profile/settings at invocation before queueing. Do not retain an onUpdate callback past a settled tool call; UI observes registry separately.
4. Add background schema to both tools. Background execution uses session/run abort signals, not launch-call signal after handle return. Blocking links its tool signal for its entire invocation.
5. Compose per-child signal with session/workflow cancellation. Cancelling one child is a catchable child outcome; cancelling workflow/session remains fatal and stops all owned children. Prevent new launches once parent workflow is terminating.
6. Keep shared limiter/timeout behavior: queue time excluded from execution deadline; slot release on all terminal paths. Backend-native nested agents remain adapter-owned process behavior, not invented registry nodes.
7. Rerun tests; commit `feat: launch session-owned background delegations`.

## Task 8: Model-facing list, inspect, wait, cancel

**Create:** `src/external-runs.ts`, `test/external-runs.test.ts`.
**Modify:** `src/pi-subagent.ts`, `src/prompts.ts`, `src/external-help.ts`.

Steps:
1. Write tool-boundary checks: valid actions, invalid/path-like IDs/cursors rejected, listing scopes, wait one/any/all terminal and pending behavior, selected workflow failure escalation, wait abort does not cancel, unknown target fails immediately, repeated explicit wait on completed work returns immediately.
2. Run `npx vitest run test/external-runs.test.ts`.
3. Define discriminated TypeBox schema, register tool, call registry/reader rather than reproduce logic. Validate whole wait target set before subscribing. Subscribe/recheck atomically to avoid lost completion between initial read and listener registration.
4. Build bounded model-facing receipts with result/error/output references in content, not only details. Return short complete answers inline. Distinguish cancellation requested from already terminal or confirmed stopped; no automatic retries.
5. No periodic timeout or unsolicited pi.sendMessage wakes. Parent acts after explicit wait returns; events inside composition remain passive.
6. Advertise compact guidance and put detailed syntax in external_help. Existing role catalog stays compact.
7. Rerun suite; commit `feat: expose outcome-only run supervision`.

## Task 9: User run navigation and full output access

**Modify:** `src/external-command.ts`, `src/core/subagent-render.ts`, `src/workflow/tool.ts`, `src/pi-subagent.ts`.
**Tests:** extend `test/external-command.test.ts`; use existing `test/agent-rendering.test.ts` only for functional access boundaries, not cosmetic variations.

Steps:
1. Add command-level behavior test: list current-session runs, select active/terminal child, retrieve output pages, navigate all workflow children; explicit cancel targets selected run. No raw filesystem knowledge required.
2. Run `npx vitest run test/external-command.test.ts test/agent-rendering.test.ts`.
3. Use installed Pi documented UI primitives, backed by the same reader/registry. Keep existing /external runs aggregate information available but make listing/detail access primary or explicit subcommands.
4. Expanded terminal results show bounded answer content plus clear navigation for more; hidden child rows must be reachable. Show freshness independently of spinner. Keep raw evidence paths as advanced diagnostics.
5. Passive updates do not inject messages into parent conversation or issue pop-up notifications for routine events.
6. Rerun tests; commit `feat: make delegated outputs discoverable in the UI`.

## Task 10: Cross-boundary verification and release preparation

**Modify:** `README.md`, `CONTEXT.md`, `AGENTS.md`, `docs/field-testing.md`, `src/prompts.ts`, `src/external-help.ts`, `scripts/e2e/external.mjs` and relevant existing fixtures; release metadata only per `docs/releasing.md`.

Steps:
1. Review authoritative tests against acceptance bar; add only missing boundary coverage. Important integrated scenario: two workflow children, one cancelled and explicitly handled, sibling completes, parent waits without update floods, all output discoverable; unhandled variant owned by runtime test, not repeated end-to-end offline.
2. Document current API declaration, cheap recomposition vs side-effecting reruns, exact background/blocking interrupt behavior, shutdown/crash limits, selected-outcome waits, output cursors, and no live steering.
3. Update opt-in E2E harness for change-triggered checks of each backend's interruption/output behavior and workflow child handling. Real providers remain opt-in, never npm test.
4. Run `npm run check`, `npm pack --dry-run --json`, `npm audit --omit=dev --audit-level=high`, and `git diff --check`. Cite actual results; do not claim success from this plan.
5. Follow `docs/field-testing.md` for selected provider checks: `npm run e2e -- --backend <claude|codex|agy> --workflow`. Record evidence and failures; do not automatically retry failed external runs beyond existing disclosed agy infrastructure exception.
6. Request correctness review focused on lifecycle leaks, wrong-session access, cursor trust boundaries, failure swallowing, terminal evidence integrity, replay mismatch, and background callbacks after tool settlement.
7. Fix findings and rerun affected checks. Prepare release under documented version/label/changelog rules; do not merge/publish as part of planning.

## Review checkpoints and delivery boundaries

- After tasks 1–4: inspectable output and evidence foundation, no public claim of background supervision yet.
- After tasks 5–8: complete execution/supervision contract, check session lifecycle and worker teardown before UI polish.
- After tasks 9–10: user/model ergonomics and full verification.

Tasks are ordered for integration safety, not independent parallel editing. Tests and source changes in shared runtime files should have one owner at a time. Do not ship a partially wired background option whose session cleanup or failure propagation is not implemented.

## Known verification limitation of this planning pass

An external planning run timed out without producing a draft (run `run_1e894ff7412d4f69a6c13b3d276e6c92`); it was not retried. This plan was authored directly against the approved documents and inspected runtime/types/test layout. Actual installed Pi session lifecycle hooks must be verified in task 5 before coding their integration; this plan does not claim a session-switch event name or daemon-like crash recovery. No implementation/tests/provider checks have been run as part of this document.
