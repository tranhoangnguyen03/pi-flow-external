# Child observation and workflow-aware supervision

Status: approved architectural design; not an implemented API or an implementation plan. See the [approved decision log](2026-09-14-supervision-decisions.md) for authoritative resolutions and rationale.
Date: 2026-09-14

This document preserves the agreed product design for pi-flow-external and explains it independently of Pi so other agent systems can reuse it. Execution ownership, scoped cancellation, replay, inspection, and API compatibility have been resolved in the companion decision log. Exact tool schemas and runtime wiring remain implementation-level design.

## Purpose

Move from delegation with a live status display to delegation whose work is discoverable, readable, and deliberately supervisable. Preserve child autonomy and the authority of explicitly composed workflows. More observation must not mean more interruptions.

## Vocabulary and ownership

- **Parent:** the actual model conversation that delegates and later reasons over results.
- **Child:** an external agent execution with a stable run identity.
- **Workflow:** an explicit composition that owns dependencies, branching, aggregation, failure policy, and completion.
- **Host:** the application executing tools and receiving backend events.
- **User interface:** a presentation of execution state; it is not the parent model.
- **Wake:** returning control and relevant information to the parent so it can make a decision.
- **Evidence:** durable execution records, distinct from display snapshots.

A callback into the host or terminal renderer does not inherently wake the parent model. A parent waiting on a tool needs that tool to return before it can reason again.

## Governing principles

1. Children work autonomously. No acknowledgement ritual or mandatory progress-report prose.
2. Workflows own coordination. Parent supervision must not silently rewrite a composition.
3. Record broadly, display passively, wake selectively.
4. Output survives failure without becoming a successful result.
5. One run identity and underlying evidence serve UI, model inspection, and workflow supervision.
6. Preserve simple blocking delegation as the default. Nonblocking supervision is explicit.

## Lifecycle and freshness

Startup visibility is sufficient at:

```
Queued -> Process started -> First activity observed
```

These are host observations, not reports demanded of a child. Backend session initialization need not become a separate user-facing milestone. Process launch alone does not prove that the agent has begun useful work.

Terminal outcomes are conceptually completed, failed, cancelled, and timed out. Existing internal status fields may express these distinctions without a schema migration.

Expose queue duration, execution duration, last backend activity, and last observed operation when available. A spinner/host heartbeat is not child activity. Show silence as activity age; do not infer that a silent child is stuck or automatically escalate it.

## Task, state, output, diagnostics

Every child offers four inspection views:

| View | Purpose |
| --- | --- |
| Task | Brief, role, backend, workspace, workflow membership |
| State | Lifecycle, timestamps, freshness, terminal reason |
| Output | Available assistant messages and artifact references; partial/final distinction |
| Diagnostics | Tool activity/results where available, errors, raw evidence |

Output requirements:

- Preserve available assistant text on failure, cancellation, and timeout.
- Distinguish preliminary/interrupted output from a verified successful final result.
- Preserve message boundaries where possible rather than blindly concatenating deltas.
- Keep verbose tool results separate from assistant output.
- Support bounded reading and cursors for older/additional/new content.
- Expose known artifact references; do not promise automatic discovery of every modified file.
- Partial output is inspectable but does not satisfy workflow dependencies.

Prefer readable projections over existing event evidence to a competing transcript store. Exact normalized representation, backend extraction rules, and cursor semantics remain open.

## Discoverability

Default run discovery to the current session/project. Show task label, backend, status, workflow membership, output availability, and stable run ID. Provide access to readable full output and diagnostics; raw backend events are an advanced view, not a prerequisite for reading an answer.

Terminal expansion must make full answers and hidden workflow children reachable, not merely reveal filesystem paths. Equivalent inspection is available to the parent through tools. Workflow failure must not hide completed child work.

## Supervision operations

The conceptual operations are start, inspect, wait, and cancel. Names and tool schemas are not finalized.

- **Start:** preserve blocking calls; explicitly requested nonblocking calls return a stable handle.
- **Inspect:** retrieve state/output/diagnostics without changing execution.
- **Wait:** return on requested outcomes or actionable blocking failure, without interrupting children.
- **Cancel:** request stopping a defined scope with observable acknowledgement/outcome.

Direct children and workflow children share run identity and inspection semantics. A workflow handle groups children without hiding them. The default wait on a composed workflow targets its outcome, not every child's completion. An explicitly selected child can be awaited without changing workflow dependencies.

No ordinary periodic wait timeout or model polling loop. A wait timeout would mean only that waiting stops while the child continues; this is unnecessary in the normal experience. Host tool-duration constraints are implementation details, not a reason to repeatedly wake the model with "still running." Child execution deadlines remain separate. User interruption remains possible. Delivered events must not repeatedly wake the parent.

## Notification contract

| Event | Default treatment |
| --- | --- |
| Queued, process started, first activity | Record and passive display |
| Tool activity, text fragments, usage | Record; bounded passive display |
| Partial output available | Inspectable, no wake |
| Phase transition | Passive display |
| Quiet child | Display activity age, no wake |
| Child completed inside workflow | Store output; advance dependencies |
| Failure handled by composition | Record; no parent interruption |
| Explicitly awaited result ready | Wake parent / resolve wait |
| Unhandled failure blocks workflow | Wake parent |
| Expected branch cancellation | Record, no unsolicited interruption |
| Requested cancellation completed | Acknowledge request, no duplicate notification |

An error inside an optional branch is not necessarily an actionable workflow failure. The composition determines escalation. Waking the parent does not automatically mean interrupting the human: notify the user only when their input is needed.

An explicit parent decision checkpoint would also wake the parent, but is a deferred feature, not part of this scope.

## Workflow-aware cancellation

- Support direct-child and whole-workflow cancellation.
- Targeted workflow-child cancellation must be an explicit outcome visible to the composition.
- Never silently satisfy a dependency with a cancelled child.
- Preserve available output and cancellation reason.
- Stopping execution does not roll back edits or other side effects.
- Never automatically cancel siblings merely because another result looks promising.
- Under one current workflow contract, unsuccessful children throw structured, catchable errors; successful children return their results. Helpers must not silently turn failures into null.
- Scripts own dependency handling; do not infer a dependency graph from arbitrary JavaScript. Handled child errors allow continuation. Unhandled errors terminate the workflow and cancel remaining active children, preserving output.
- No suspended blocked state waiting for parent repair; follow-up/replay is explicit.

Current runtime behavior must change: ordinary failures currently return null and children receive shared cancellation signals. Require a current API-version declaration in metadata and reject stale scripts before launching children, with actionable repair guidance. Do not maintain legacy failure semantics. Blocking and nonblocking workflows use the same current failure contract.

## Persistence, execution ownership, and replay

Inspection retrieves existing work; replay decides which prior results can be reused. These must not be conflated.

Requirements:

- Stable run IDs remain usable after termination.
- Workflow records retain child references, including failed/cancelled children.
- Earlier successful output remains readable after later failure.
- Returning from wait does not itself alter execution or replay.
- Execution belongs to the originating session. Nonblocking runs survive tool returns, parent turns, and compaction; interrupting wait stops waiting only. Blocking-call interruption cancels that call's work.
- Closing the originating session/gracefully shutting down cancels its work. After crashes, unfinished runs are interrupted/uncertain, not falsely active or confirmed cancelled. Restart restores evidence access, not live execution; cross-session live takeover is out of scope.
- Replay is an explicitly requested new attempt with longest unchanged successful-prefix reuse. Execute again from the first changed or unsuccessful call; historical cancellation commands do not carry forward. Branch choices may differ on the new attempt.
- Retain unsuccessful outcomes as evidence, not successful cache entries. Replay is not rollback; surface reuse boundaries when known without pretending dynamic future calls are known in advance.
- Reject replay across incompatible API contracts. No automatic retry or repaired-script rerun is introduced.

Do not introduce completion-order races or first-acceptable-answer policies in this initial scope. Promise.race alone does not cancel losers; timing-dependent branching requires additional scheduling and replay decisions.

## Deferred expansion: parent as an intermediary workflow node

The user's concept is an adult-in-the-loop node, analogous to human-in-the-loop evaluation. A deliberately composed, rare checkpoint asks the actual parent conversation to evaluate intermediate findings or make a decision before dependent stages begin.

This is not a replacement agent impersonating the parent, routine child approval, or live steering. It requires explicit yield/continuation, recorded decision inputs, replay semantics, and a policy for independent active branches. Track separately in issue #41.

## Other non-goals

- Unsolicited live instruction injection or objective changes.
- Dynamic rewriting of running workflow stages.
- Automatic winner selection and loser cancellation.
- Incremental partial output feeding downstream children.
- Workflow pause/resume checkpoints.
- Cosmetic dashboard/animation work or additional profile controls.

## Implementation sequence (direction, not a plan)

### A. Observation and output foundation

Preserve partial output; decouple observation from terminal availability; establish readable run inspection, discoverability, identity, and freshness.

### B. Workflow-aware supervision

Explicit nonblocking execution; inspect/wait/cancel; scoped cancellation, session cleanup, and replay treatment. Preserve blocking invocation ergonomics, not legacy failure-to-null semantics.

Architectural decisions for both stages are approved in the companion decision log. Plan against that contract: one current metadata-declared API version, structured child errors, session-owned lifetime, successful-prefix replay, stable IDs from queueing, summary-first cursor-based inspection, and outcome-only waits for one/any/all selected runs.

## Acceptance bar

- Failed-child findings are readable without backend-log parsing.
- User and parent can discover and inspect any workflow child.
- Waiting does not flood the parent with routine updates.
- Cancellation stops the intended scope and preserves evidence.
- Current-contract workflows retain script-owned coordination. Stale workflows fail before execution with actionable recomposition guidance, rather than silently changing semantics.
- Direct calls and workflow children are consistently observable outside the terminal.

## Repository context and related issues

Relevant implementation areas:

- `src/pi-subagent.ts`: direct Agent lifecycle; progress currently gated on TUI availability.
- `src/core/progress.ts`: bounded activity and update emission.
- `src/core/{claude,codex,agy}.ts`: backend event extraction and terminal outcomes.
- `src/core/spawn.ts`: shared execution, timeout rewriting, evidence attachment.
- `src/core/run-record.ts`: backend evidence and terminal summaries.
- `src/core/subagent-render.ts`: bounded terminal rendering.
- `src/workflow/{tool,runtime,script-worker,journal}.ts`: composition, updates, cancellation, replay records.

Workflow progress callbacks are not gated in the same way as direct Agent progress. Neither callback path alone gives the actual parent model a turn while a workflow tool is pending. Decoupling observation from presentation is a desired consistency improvement, not a claim that model supervision already exists.

- [#40: Preserve and expose partial child output on failure, cancellation, and timeout](https://github.com/tranhoangnguyen03/pi-flow-external/issues/40)
- [#41: Explore explicit parent-agent decision nodes in composed workflows](https://github.com/tranhoangnguyen03/pi-flow-external/issues/41)
- [#35: Experiment: mid-flight steering for running workflows](https://github.com/tranhoangnguyen03/pi-flow-external/issues/35) — related background, not authorization to bundle steering into this design.
