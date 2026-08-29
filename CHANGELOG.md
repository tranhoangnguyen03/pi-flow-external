# Changelog

All notable changes to pi-flow external are documented here.

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
