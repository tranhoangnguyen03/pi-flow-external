# Delegation experience north star

**Status:** Design direction approved by the maintainer. This is the product contract for future implementation, not a claim that the current UI satisfies it.

**Tracking:** [Issue #67 — Delegation transparency: workflow visibility and shared prompt/config/context inspection](https://github.com/tranhoangnguyen03/pi-flow-external/issues/67).

## Objective

A user must be able to understand and supervise delegated work without asking the parent model to extract raw diagnostics:

> What is being launched? What exactly was sent? Under which configuration? What is happening now? Where can I inspect or stop it?

Agent represents one assignment. Workflow represents an execution plan containing assignments. Inspecting an assignment must have the same contract whether it was launched directly or as a workflow child.

## Delivery gate: minimum standard before visual polish

All five standards below take priority over cosmetic redesign, animations, result styling, and layout refinements:

1. **Every launch explains its purpose, execution mode, and workspace.** Ad-hoc workflows receive the same disclosure as saved workflows.
2. **Every assignment is inspectable while queued or running.** Users can inspect prompts, known configuration, and context without asking the parent model to retrieve raw events.
3. **Background receipts cannot be mistaken for live monitors.** A historical launch receipt explicitly routes users to current run state.
4. **Workflow children have the same inspection experience as direct Agents.** Every hidden child and truncated output remains reachable.
5. **Displayed configuration comes from authoritative launch evidence.** Show requested versus effective settings and known versus unknown values; never reconstruct historical execution from today's settings.

A smaller, plain interface that meets these standards is preferable to a polished interface that does not. Usability needed to find and operate inspection is part of this gate, not optional polish.

## Three surface responsibilities

These are responsibilities, not a requirement to build three new screens:

| Surface | User question | Contract |
| --- | --- | --- |
| Card | What is being delegated, and what is happening? | Compact intent, bounded progress, clear lifecycle and inspection route. |
| Inspector | Exactly what was sent, under which settings and context? | Explicit, authoritative detail available throughout the lifecycle. |
| Monitor | What is currently happening across these assignments? | Current state, freshness, child navigation, and correctly scoped controls. |

Reuse existing tool cards, `/external runs`, registry projections, and durable evidence. Do not introduce a parallel UI-only record format.

## Experience by path and lifecycle

### Launch intent: direct Agent

Retain concise task, execution identity, workspace, permission/access disclosure, and parent-context disclosure. Add execution mode and a consistent inspection route as soon as a stable run exists.

A role's description is its purpose, not necessarily the parent's reason for delegating. Label it honestly; do not invent a rationale.

Full prompts and configuration belong behind inspection, not in the default transcript. Disclosure does not introduce a mandatory approval dialog or change existing execution authorization.

### Launch intent: workflow

Show workflow name, purpose, source kind/path where applicable, workspace, foreground/background mode, and declared phases when available.

Ad-hoc, saved-name, and script-path invocations receive equivalent treatment. Metadata inside an ad-hoc script must not become invisible merely because it is not a top-level tool argument.

Before assignments exist, show `Preparing workflow` or `No assignments launched yet`, not an ambiguous empty progress display. Dynamic JavaScript may not have a knowable future child roster: show only declared or observed structure and label planned phases as planned. Never execute workflow code in a renderer to discover metadata.

### Queued assignments

Show that the assignment is waiting for execution capacity, queue age, known identity, and routes to inspection and cancellation.

Inspection is available before backend startup. Configuration not yet finalized is labeled pending. A workflow coordinator can be running while some children are queued; represent these states separately.

### Foreground Agent execution

Show concise status, duration, recent activity, last-activity age, and usage when known. Do not infer a stalled process solely from quiet activity.

Inspection works during execution and does not pause, restart, or mutate the assignment. Users can examine the task, effective configuration, transferred context, output so far, and diagnostics.

### Foreground workflow execution

Show coordinator state, current phase, child counts, and a bounded assignment list. Each visible child exposes task identity, execution identity, state, and recent activity.

Child inspection opens the same assignment experience as direct Agent inspection. Prioritize failures and active work without losing access to hidden children. A bounded list must have a discoverable route to the full roster.

Do not require users to expand every child's answer to examine one assignment. Preserve handled child failures even when the workflow ultimately succeeds.

### Background launch and monitoring

The originating card is a historical launch receipt, explicitly labeled as such. It identifies the run and explains how to follow it. It must not leave a frozen snapshot looking like a live `running · 0/0` monitor, or always claim the run is queued when execution may already have begun.

Opening the monitor retrieves current registry-backed state and indicates freshness. The minimum is refresh-on-open plus an explicit Refresh action. Automatic updates while the monitor is open are a possible enhancement, not a prerequisite for an always-on dashboard.

Humans must be able to observe execution independently of the parent calling `external_runs wait`. Parent wait operations should still provide bounded progress.

This design does not require unsolicited parent-agent wakeups, automatic completion notifications, or a persistent dashboard.

### Completion

For Agent, show a compact outcome, a verified answer preview, and an inspection route.

For workflow, show the overall outcome, child counts including handled failures, the workflow result, and child navigation. Workflow success does not imply that every child succeeded.

Expansion should focus on the selected result rather than automatically concatenating all child answers. Preserve structured workflow results and the full model-facing result contract; friendly presentation must not replace data the parent needs with an invented prose summary.

Background receipts remain historical. Current completion state belongs in the monitor and durable inspection.

### Failure, timeout, cancellation, and restart

Distinguish failed, timed out, cancelled, and interrupted/uncertain states. Identify the relevant child and whether the workflow handled its failure. Preserve interrupted output and diagnostics.

Cancellation clearly identifies scope: one assignment versus the whole workflow. Explain that stopping execution does not roll back side effects. Inspection itself is read-only; cancellation is an explicit action.

After restart or loss of ownership, durable records must not animate or claim to be confirmed live. Recording gaps are visible. Do not introduce automatic retries.

## Shared inspector contract

The organization below is conceptual; it does not mandate tabs, custom widgets, or specific shortcuts.

| Section | Required meaning |
| --- | --- |
| Overview | Assignment identity, workspace, lifecycle, timestamps/freshness, and parent workflow where applicable. |
| Prompt | Authored assignment, role/system instructions, transferred conversation, and appended execution/output instructions are distinguishable. |
| Configuration | Resolved harness/model/thinking, requested and effective permission with enforcement caveats, known tools/resources, timeout, budget and enforceability, and resume provenance. |
| Context | Parent-sharing mode and requested/shared scope, inspectable transferred content where retained, exclusions, and separate disclosure of resumed or backend-loaded context. |
| Output | Preliminary narration, interrupted output, and verified final answer remain distinct. |
| Diagnostics | Advanced raw events, recording integrity, evidence references, and paged access. |

Workflow root inspection additionally exposes source, arguments, declared/runtime phases, child roster, replay provenance, and workflow result. Dynamic child prompts become inspectable when materialized, not before.

### Context is not one thing

Distinguish:

1. **Shared parent conversation:** none, recent turns, or full available history.
2. **Resumed child history:** backend session history reused from an earlier run.
3. **Loaded resources:** project instructions, skills, tools, and other resources known to the extension.
4. **Backend-internal context:** information the extension may not be able to observe.

Do not imply that a parent-context receipt reveals the backend's entire effective prompt. Unknown or backend-controlled values stay explicitly unknown.

### Evidence and privacy

Capture authoritative launch-time values in the shared execution/evidence path. Effective values finalized later should be recorded as such, not silently substituted into an earlier snapshot.

Never reread current profile files and present them as historical truth. Older records with absent fields say `Not recorded`.

Sensitive prompt/context content requires explicit inspection, remains subject to redaction, and is not automatically copied into the default transcript. Preserve existing session/project ownership boundaries and canonical-result integrity.

## Delivery order

1. **Honest intent and receipts:** workflow launch disclosure, explicit background handoff, stable run references and visible inspection routes.
2. **Authoritative inspection:** shared launch evidence and prompt/configuration/context inspection for queued and active assignments.
3. **Integrated supervision:** workflow-child drill-down, full-roster access, and monitor refresh/freshness using the same projections.
4. **Gate verification:** demonstrate all five minimum standards across direct Agent, foreground workflow, and background execution.
5. **Then polish:** terminal-result deduplication, visual hierarchy, and optional live-monitor conveniences.

This is an outcome sequence, not a detailed implementation plan or authorization to launch coordinated agents.

## Verification expectations

Use deterministic execution to verify the lifecycle and data contracts at the lowest useful layer. Cover direct Agent, ad-hoc/saved/path workflows, queueing, background handoff, active inspection, hidden children, completion, handled/unhandled failure, cancellation, and incomplete historical records without duplicating the same behavior across test layers.

Perform bounded interactive checks of actual terminal behavior: discoverability, narrow widths, expansion, refresh, and fallback rendering. Passing snapshot/unit tests alone does not establish that the interactive experience works. Real-provider execution is not required to prove most of these contracts.

Access descriptions must match the actual backend boundary, including Pi SDK children rather than generic external-CLI language.

## Deliberately open implementation choices

- Exact keyboard/command route from a tool card to a run. Use supported native interactions; do not promise clickable controls in every terminal mode.
- Manual refresh versus automatic updates while a monitor is open.
- Presentation of long prompt/context components without leaking them into ordinary output.

These choices may change without weakening the minimum standard. Mid-flight steering, new child capabilities, parent decision nodes, and opt-in notifications are separate scope, not prerequisites.
