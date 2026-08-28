# Changelog

All notable changes to pi-flow external are documented here.

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
