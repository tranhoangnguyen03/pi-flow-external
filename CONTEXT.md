# pi-flow external context

This package is a fork of pi-flow whose `Agent` and `workflow` tools are reserved for external agent harness delegation.

## Domain language

- **External profile:** A markdown file under `~/.pi/agent/subagents/*.md` whose filename and frontmatter select `backend: claude`, `backend: codex`, or `backend: agy`.
- **Native Pi subagent:** A subagent exposed by Pi's native subagent system. This fork intentionally does not route it through `Agent`.
- **Agent call:** A direct external delegation with a required backend-qualified `subagent_type`.
- **Workflow call:** Trusted JavaScript orchestration that may fan out several explicit external `agent()` calls.
- **Delegation intent:** The backend, profile, task label, profile purpose, and workspace shown to the user before and during direct execution.
- **Access disclosure:** A visible statement that external CLI work is unsandboxed and has host access; it is not a sandbox or read-only guarantee.
- **Evidence ID:** The short terminal reference to a persisted external run.
- **Expanded receipt:** On-demand record or workflow-journal paths plus bounded evidence metadata.
- **Successful receipt:** A zero-exit run with a recognized backend terminal-success event and a non-empty result.
- **Complete failure evidence:** The backend failed, but its event log and summary were persisted consistently.
- **Incomplete record:** Local evidence is missing, malformed, or internally inconsistent; it must not be reported as trustworthy merely because the backend status says `done`.
- **Nested activity:** A recognized backend-native subagent event. Its first observation may extend the deadline once by one fresh base timeout, capped at twice the original deadline.

## Routing rule

- Native Pi work -> native subagent tool.
- Claude Code / Codex CLI / Antigravity work -> this extension's `Agent` or `workflow`.

The split is global and intentional to avoid tool ambiguity across projects. The ordinary driver sees only `Agent` and `workflow`; the profile finalizer is activated only by `/external profile create`. External children start in the requested working directory, but backend-native nested helpers may create or use a separate workspace; prompts that request further nesting should include explicit absolute paths and all required context.

## User control surface

User operations are namespaced under `/external`: status, Doctor, settings, profiles, profile creation, workflows, runs, and help. Extension-owned concurrency and timeout defaults live in `$PI_CODING_AGENT_DIR/pi-flow-external/settings.json`; profiles remain authoritative for downstream backend/model/thinking metadata.

## Evidence boundary

Normal external runs write best-effort local records under `~/.pi/agent/pi-flow-external/runs/` unless `PI_FLOW_EXTERNAL_RUNS_DIR` overrides it. The TUI shows short evidence IDs by default and exposes record/journal paths only through expanded output. Redaction is best-effort, records are not rotated automatically, and failed/aborted runs are not retried automatically.
