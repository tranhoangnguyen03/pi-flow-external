# Paste-ready brief for the receiving agent

You are implementing a scoped improvement to `tranhoangnguyen03/pi-flow-external`. Read this handoff's `00_START_HERE.md`, `01_ISSUE.md`, `02_DESIGN.md`, `03_IMPLEMENTATION_PLAN.md`, and the current repository `AGENTS.md`. Consult `04_TESTS_AND_ACCEPTANCE.md` as you work. This package supplies the context; do not require the user to reconstruct the prior chat.

The approved direction is: clean machine-facing public contracts, coordinated machine/status/evidence views, and concise discoverable schemas and harness capabilities. The proposed details and fixtures are an implementation-ready design, not an already-shipped API. They may be adjusted for demonstrated compatibility, with a written rationale, without reopening the goals.

**Do not replace Flow's runtime, migrate to QuickJS, or embed Pi codemode as Flow's new executor.** Preserve the current worker/VM, lifecycle, cancellation, forgotten-await guard, typed child errors, session ownership, replay rules, and adapter-specific permission/retry behaviour. Do not build a second registry or database.

Start by recording HEAD and working-tree state, reading the current instructions, and running the repository baseline. The inspected Flow commit is `ae04c8883470dcc16995f75ea2a39b5b32e729db`; Pi reference is `8ce69e9d2b171d173fe4b6b2b6256f1f4411e69d` / 0.99.2. Do not reset newer code. Flow's old 0.79.4 development pins require a target-host compatibility check; use an isolated environment and never upgrade global user Pi or modify their settings just to run tests.

Your first deliverable is a thin real-Pi/fake-child vertical slice of the registered `Agent` tool through native codemode: typed success, typed data-bearing failure, background receipt, and pre-launch failure, while preserving the direct card. Then apply the shared boundary to `workflow` and all `external_runs` actions. `external_help` must expose actual contracts and capability facts on demand without provider probes or a giant always-on prompt.

A valid public receipt is not accepted work. A successful inspection can reveal a failed worker. A successful wait can contain failed outcomes. `null`, `false`, `0`, and `""` are real values. A cancellation request is not completed termination. Host validation/permission failures can happen before Flow runs and need separate handling. Keep evidence references, ownership, byte budgets, ordering, cursors, and truthful unknowns intact. Never parse human prose to infer success.

The context-handoff document is primarily analysis. Implement its compatibility tests and a documented explicit-handoff pattern using existing `prompt` and `context:none|recent|full`/resume paths. Do not implement a new context mode, transcript-reference selector, shared blackboard, or automatic context expansion. Issue #29's no-go remains in force. The active publish/consume experiment is a separate follow-up, not a delivery blocker.

Work directly by default and carry the authorized local change through verification. Do not use codemode to bypass approvals for coordinated agents or expensive model calls. Keep short progress updates at completed slices or material findings. Ask only for a genuinely missing authorization or material scope decision, not every routine step. No issue creation, push, PR, merge, publish, deployment, or paid-provider experiment without the applicable authorization.

Report the actual changed files, tests/commands and outcomes, host compatibility, preserved behaviours, and anything unverified. The handoff's fixture checks are not repository tests. Do not claim runtime or provider validation you did not execute.
