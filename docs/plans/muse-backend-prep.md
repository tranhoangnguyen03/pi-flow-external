# Muse CLI integration preparation

## Scope

Add the installed `muse` executable as an external backend in a separate change from permission-floor patch PR #55. Start with a dedicated adapter patterned after existing CLI adapters, not a generic runner refactor or MSP server client. Apply the permission-floor patch before implementation verification.

## Verified locally (2026-09-21)

- Binary: `~/.local/bin/muse`, Muse Code 1.3.0 (1.3.0-R3401.1).
- `muse exec --json` emits schema-versioned JSONL envelopes with `payload_type`, `payload`, session stream UUID, run UUID, and sequence.
- Real default Meta provider/model `muse-spark-1.3-contributor` read an unpredictable nonce file and returned its exact contents. Exit 0 plus `run.terminal.completed`, payload `terminal: completed`, `text` is final answer.
- Real `--output-schema FILE` produced a JSON object whose nonce exactly matched the file. The same completed terminal envelope contains serialized JSON in `payload.text`.
- Billing-error sample: exit 1, `run.terminal.failed`, payload `terminal: failed`, empty text, structured reason containing HTTP 402. Billing subsequently fixed by user; fresh real direct and structured checks passed.
- Echo provider also yields a completed terminal event; useful offline CLI protocol smoke, not evidence of real model/tool execution.
- No usage/cost event was observed in the successful direct sample. Report unknown rather than zero-known or fabricate cost.
- Offline `muse schema generate-json-schema --out DIR` exports the binary's exact stable MSP schema.

Private raw evidence: `/tmp/pi-flow-muse-probe.Ect6Fw/` (`paid-events.jsonl`, `structured-events.jsonl`, earlier failure `events.jsonl`, schema bundle). Do not package transcripts or credentials.

## Adapter contract

- Invoke `exec --json --prompt-file PATH --workspace CWD`, explicit model/reasoning when configured; temp prompt and schema files cleaned in finally.
- Success requires process exit 0, root run's `run.terminal.completed` with `terminal: completed`, and nonempty canonical `text`. Do not promote `run.output.delta`, task output, or nested completion to final.
- Match root command/run IDs from session linkage; tolerate irrelevant envelope types, fail clearly on malformed/unsupported terminal contracts.
- Structured mode passes `--output-schema`; parse/validate terminal JSON using existing result contract, preserving root JSON strings correctly.
- Reuse process-group cancellation, output bounds, duration, durable receipts, and native session IDs.
- No adapter automatic retry. Observed provider task metadata advertises attempt 1/10: determine native retry policy and disclose it rather than claim all provider retries are disabled.
- No budget-enforcement claim without a supported native control.

## Permissions and friction

Use shared profile-floor resolver from PR #55. Execution roles default danger. Muse `--yolo` disables approvals/sandbox and trusts workspace; disclosure must reflect that additional trust behavior. Evaluate explicit disable flags to avoid enabling unrelated configuration unnecessarily.

Readonly candidate: `--disable-approval --disable-write --disable-shell` (used in both successful probes). These disable non-shell writes and shell separately; do not claim comprehensive OS isolation based on flags alone. Edit candidate: sandbox enabled plus headless approval bypass; verify real shell/write behavior. Do not alter global Muse credentials or workspace trust persistently.

## Remaining probes before implementation claims

1. Headless resume: help documents interactive `resume` and `exec --session-id`; determine whether the latter reloads context or merely selects an ID. If unsupported, explicitly reject resume initially.
2. Cancellation after observed activity and child-process cleanup.
3. Writable workspace operation; out-of-workspace enforcement if claiming a boundary.
4. Token/cost availability, native retry configuration, max-step terminal semantics.
5. Nested-agent events: distinguish actual delegation from internal reminder tasks before adding timeout extensions.

## Implementation checklist

1. Add one authoritative adapter test suite with fixtures matching captured envelopes: normal/structured final, failure, truncation, cancellation, non-root terminal isolation, unknown usage.
2. Wire backend/harness unions, profile parsing, dispatch, permissions, inspection, help/settings, profile creator and E2E backend switch.
3. Seed six Muse roles via migration that preserves deleted/customized earlier profiles; never reseed the entire roster.
4. Document supported model/reasoning, limits and real permission boundaries.
5. Run full offline check, pack/audit, real deterministic direct/workflow/active-interrupt E2E with exact nonce validation. Release as a separate additive-backend PR.

## Implementation results (2026-09-21)

- Base integration: `origin/main` already contained the merged permission-floor fix (`0000eaa`) plus the unrelated unified-run-experience work on top; `feat/muse-cli` fast-forwarded onto it directly rather than cherry-picking.
- Resume: **confirmed real**, not assumed. Two independent `muse exec --session-id <same-uuid>` processes against the same workspace: the first was told a secret word and replied `OK`; the second, given no context beyond the same `--session-id`, correctly recalled the exact word. The session stream id (`stream.id` in the envelope) was identical across both processes. `--session-id` genuinely reloads prior context; it is not merely a label as the interactive-only `muse resume` command's existence might suggest.
- Native provider retry: **confirmed and disclosed, not performed by the adapter**. The same resume probe's first call hit transient 503/504 errors from the `meta` provider and was retried internally by muse itself up to attempt 5/10 (observed `retry_delay_ms` of 1000ms then repeated 60000ms) before eventually succeeding — all inside the `muse` process, visible only as `task.lifecycle.status` narration (e.g. "retrying meta model stream in 60000ms (attempt 3/10)"). The adapter performs no retry of its own.
- Terminal contract: task-lifecycle events live in a disjoint `task.lifecycle.*` payload_type namespace and can never be confused with a root run terminal by shape alone — but a parent-inspection review correctly flagged that `payload_type` alone does not prove an envelope belongs to the *root* run specifically, since a hypothetical nested delegated run could in principle emit its own `run.*`-shaped events with a different `run_stream.id`. Fixed: root-run identity is now captured once from `runtime.command.accepted` (`command_id`) plus `session.run.linked`/`run.lifecycle.started` (tying that `command_id` to a `run_stream.id`), and every `run.terminal.*`/`run.output.delta` envelope is checked against it before it can affect the result; `sessionId` is captured once from that same bootstrap rather than overwritten by every envelope. Covered by three authoritative negative tests (nested-success-ignored, nested-failure-ignored, mismatched-terminal-only fails closed) with realistic fixtures in `test/muse-backend.test.ts`.
- Usage/cost: never observed on any run (success, structured, or billing-failure). Reported as `costKnown: false`, never a fabricated zero or estimate.
- Nested-agent delegation: **still unconfirmed, and now deliberately never reported**. Every probe run (including the resume probe) saw only internal `reminder.agent.*` skill-reminder tasks and logged "muse: Agent delegation: auto unavailable: workspace is untrusted." An earlier draft speculatively matched a `task_kind` starting with `agent.` but not `reminder.` as nested delegation; a parent-inspection review correctly rejected this as unsafe (it could let ordinary internal task activity spuriously grant the one-time nested-timeout extension) and it was removed — `museHasNestedAgentActivity` now always returns `false`. Flagged in code comments, `AGENTS.md`, `CONTEXT.md`, `CHANGELOG.md`, and the architecture snapshot as an open item — worth revisiting only once a real, confirmed delegation event has actually been observed.
- Structured output: simpler than Grok's contract — `--output-schema <FILE>` (a temp file path, not inline JSON) produces a terminal `payload.text` that is already the pre-serialized JSON document; no separate structured-document parsing step is needed.
- No native system-prompt flag was found in `muse exec --help`; `systemPrompt` is folded into the prompt file content, matching Antigravity's existing pattern.
