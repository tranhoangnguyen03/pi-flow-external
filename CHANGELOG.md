# Changelog

All notable changes to pi-flow external are documented here.

## [1.9.0-external.0] - 2026-09-08

Lets the parent decide how much of its own conversation an external child starts with, closing [#30](https://github.com/tranhoangnguyen03/pi-flow-external/issues/30).

### Added

- Opt-in parent-context sharing for `Agent` and workflow `agent()`: `context: { mode: "recent", turns: N }` shares the last N available user turns (including the current one), `{ mode: "full" }` shares available current-branch conversation after compaction, and the default remains no shared history. A user turn starts at a user message and carries its assistant messages and tool exchanges; a linked tool call is retained when its result crosses the selected boundary.
- Context receipts on every surface: the delegation card names the requested mode before launch, compact and expanded rows report mode plus shared/requested turns, messages, bytes, and compaction state, and `summary.json` plus the workflow journal record the same block.
- `docs/field-testing.md` change-triggered context transfer check.

### Changed

- Coordinator guidance and `external_help` workflow help document the context modes, exclusions, and the `resume` exclusion.

### Notes

- Snapshots are frozen before queueing, exclude parent system instructions, thinking blocks, tool-result metadata, and pending tool calls, and fail explicitly on images/unsupported content or snapshots over 1 MiB instead of truncating. Sharing cannot be combined with `resume`. Workflow children select from one snapshot frozen at invocation, and replay fingerprints include the transferred context.
- This is text transfer into a new external conversation, not a native session clone, system-prompt inheritance, or guaranteed prompt-cache reuse.

## [1.8.0-external.1] - 2026-09-08

### Fixed

- agy `--print-timeout` is now derived from the configured `subagentTimeoutMs` instead of a hardcoded 15-minute ceiling that let agy's internal wait timeout preempt the extension's outer subagent deadline. A disabled deadline (`0`) maps to a ~1-year ceiling because agy has no no-timeout flag, and `timeout waiting for response` is pinned as non-retryable.

## [1.8.0-external.0] - 2026-09-08

### Added

- Role-first external delegation with optional harness overrides, a compact configured-role catalog, on-demand `external_help` for roles/permissions/workflows, and settings v3 with the global `defaultHarness` (initially `agy`). Legacy `subagent_type` remains available for exact-profile selection.

## [1.7.0-external.1] - 2026-09-07

### Fixed

- `/external profile clean-up` inverted ownership: it archived native Pi profiles (`backend: pi` or no backend), which belong to Pi's native subagent system, not this extension. It now archives only retired pi-flow default profiles (the former `debugger` role) after confirmation, and never lists or moves native Pi profiles.
- Profile ownership tag: profiles created through `/external profile create` are stamped `owner: user` in frontmatter, and clean-up refuses to archive any `owner: user` profile even when named directly (enforced at the archive mutation point). Hand-written profiles opt in with the same tag.

## [1.7.0-external.0] - 2026-09-07

### Added

- Shipped default profile roster: on first session start the extension seeds five code-oriented roles (explorer, planner, implementer, reviewer, qa) plus the generalist worker for each backend (18 profiles). Seeding is one-time (marker file), never overwrites existing profiles, and leaves `model`/`thinking` unpinned so defaults track the CLI's model and the current Pi thinking level. The `debugger` role is no longer shipped; create it with `/external profile create` if needed.
- `/external profile clean-up`: archives only profiles this extension itself shipped and later retired (currently the former `debugger` role) to `~/.pi/agent/subagents/archive/` after confirmation. Files are moved, never deleted; existing archive files are never overwritten. Native Pi profiles (`backend: pi` or no backend) and `owner: user` profiles are never touched. Non-interactive sessions get a read-only listing.
- Profile ownership tag: profiles created through `/external profile create` are stamped `owner: user` in frontmatter, and clean-up refuses to archive any `owner: user` profile even when named directly. Hand-written profiles can opt in with the same tag.

## [1.6.0-external.0] - 2026-09-07

### Changed

- Antigravity (`agy`) runs unsandboxed in every mode: its default headless sandbox (`proceed-in-sandbox`) hard-denies read-only tools like `read_url_content`, so `buildPermissionArgs` now always passes `--dangerously-skip-permissions` and `resolveEffectivePermissionTier` elevates every agy tier to `danger`. `readonly`/`edit` on agy are advisory profile-body instructions, not a harness boundary.
- Agent-facing surfaces stop promising a boundary agy cannot keep: the delegation roster and the `permission` parameter description now state the backend-honest rules, and the coordinator guidelines note that agy tiers are advisory only.

## [1.5.0-external.0] - 2026-09-06

Keeps Claude execution lanes from starting as guaranteed no-ops under an `edit` override, closing [#19](https://github.com/tranhoangnguyen03/pi-flow-external/issues/19).

### Added

- Claude execution profiles (`implementer`, `debugger`, `qa`, `worker`, or any profile declaring `permission: danger`) maintain a `danger` floor: an explicit `permission: "edit"` override is elevated to `danger` because headless Claude auto-denies all Bash commands at `acceptEdits`.
- Elevated runs are disclosed to the caller, not just the operator: the parent-facing result banner reads `[run run_xxx · permission elevated edit→danger]`, tool details and `summary.json` carry `permissionRequested`, and the pre-launch delegation line shows `(edit→danger floor)`.

### Changed

- Permission tiers now resolve once in the shared spawn primitive (`Agent` and `workflow` pass the requested tier plus the settings default), removing per-caller resolution drift.
- Agent guidelines and the `permission` parameter description now warn about the real remaining hazard: `edit` on non-execution Claude lanes still auto-denies shell commands headlessly.

## [1.4.0-external.0] - 2026-09-06

Routes the receipt's truth into the agent-facing surfaces a delegating parent actually reads, closing the disclosure gaps from [#16](https://github.com/tranhoangnguyen03/pi-flow-external/issues/16).

### Added

- Delegation and workflow rosters now show each profile's backend and default permission tier (e.g. `claude-implementer (claude · danger)`).
- Agent tool result text ends with the run id, plus the permission-denial count when any occurred (`[run run_xxx · N permission denials — commands may have been blocked]`), so a blocked lane is visible without parsing child prose or reading `summary.json`.

### Changed

- The `permission` parameter advice no longer steers callers toward `edit` for implementation tasks; it now states that omitting uses the profile's calibrated default (recommended) and that explicit tiers mean different things per backend (claude headless denies all shell at `edit`).

## [1.3.0-external.0] - 2026-09-06

Adds a bounded retry for the Antigravity backend and documents the standardized external profile role matrix.

### Added

- Single automatic retry for agy infrastructure failures (authentication, eligibility, network timeouts), disclosed in receipt details as `retries` and `retryOf`. Agent-level failures, aborts, and timeouts are never retried.

### Changed

- AGENTS.md records the agy retry exception to the no-auto-retry policy; CONTEXT.md documents the profile role-matrix design stance (guardrails define lanes, not methods) and the known one-file-per-backend format inelegance.

## [1.2.0-external.0] - 2026-08-29

Implements the orchestrator-decided tiers design ([#11](https://github.com/tranhoangnguyen03/pi-flow-external/issues/11)), live-verified against Claude Code 2.1.239, codex-cli 0.150.1, and agy 1.1.22.

### Added

- Orchestrator-decided permission tiers: `permission` (`readonly`/`edit`/`danger`, default `danger`) on `Agent` calls and workflow `agent()` children, enforced via native harness mechanisms (Claude permission modes, Codex single-axis `--sandbox`, agy bypass-flag omission). Unsupported tiers are labeled `advisory, not enforced` instead of blocking the launch; Claude permission denials are surfaced in receipts.
- Per-call and per-profile USD budgets (`max_budget_usd`, settings `defaultMaxBudgetUsd`): passed natively to Claude (`--max-budget-usd`) and recorded elsewhere with an honest `budget unenforceable` label when the backend reports no cost.
- Session resume: `resume` on `Agent`/`agent()` continues a prior run's backend conversation (Claude `--resume`, Codex `exec resume`, agy `--conversation`); session ids are recorded in `summary.json`. Claude sessions now persist in Claude Code's own local storage (live-verified: `--resume` fails after `--no-session-persistence`, so that flag is gone).
- Run-record retention: settings `maxRunRecords` (default 200, `0` keeps everything) prunes oldest completed records at session start and via `/external runs --prune`; incomplete or active records are never pruned.
- Settings v2 with migrate-on-read from v1 files.

### Changed

- Codex `danger` runs now use `--sandbox danger-full-access` (single axis) instead of `--dangerously-bypass-approvals-and-sandbox`, so sandbox and bypass flags can never combine.
- Run summaries replace the `permissionControl` prototype field with the resolved `permission` tier, enforcement flag, budget, session id, and resume provenance.

## [1.1.0-external.3] - 2026-08-28

### Fixed

- Claude runs that spawn background agents no longer fail when a later task-notification result follows the parent turn result; the latest result is used and process exit remains the stream boundary.
- Agy children now run with `--print-timeout 15m`, so Agy's own five-minute print-mode default can no longer end a run early. Runs longer than 15 minutes are cut by Agy itself; the extension timeout still governs below that.
- Agy failures now surface the backend's terminal error (for example "The stream was interrupted") instead of only `agy exited with code 1`.

## [1.1.0-external.2] - 2026-08-24

### Added

- Persistent direct-delegation cards showing the backend, selected profile, task, profile purpose, working directory, and unsandboxed execution boundary.
- Live external-host-access cues for direct agents and workflows.
- Expanded evidence receipts with local record paths and structured backend-event counts.
- Expanded workflow receipts with workflow evidence IDs and journal paths.

### Changed

- Completed external-run identifiers are labeled as `evidence` instead of `run`.
- Recording failures are labeled `evidence incomplete` independently of backend status.
- Backend labels use the recognizable product names Claude Code, Codex CLI, and Antigravity.
- Workflow progress retains explicit done, active, queued, and failed counts while access disclosure is shown once at the workflow level.

### Security

- The new access labels are disclosure only; this release does not add sandboxing or change external CLI permission modes.
- Read-only remains an instruction to an external agent, not an enforced permission boundary.
- Backend execution, timeout behavior, evidence formats, and automatic-retry policy are unchanged.
