# Documentation consolidation verification — 2026-10-01

Scope: approved documentation plan in isolated issue-73 worktree. No commit, push, version bump, live-user migration or publishing.

## Ownership and integration

- Claude continued its user-journey audit as run_ee07b2588ce848c8a643ef877e0a8d52, editing README and Unreleased changelog only.
- Antigravity continued its technical audit as run_b5558f5129284d1bb2aa039389e9f5f7, editing field-testing and releasing only.
- Parent rewrote the current architecture map, refreshed AGENTS/CONTEXT, added an investigation-scope note, aligned in-app help and reviewed/integrated both contributions.
- Parent corrections include terminal-only busy cancellation/default confirmations, Pi creation vs testing, registry filtering vs sorting, migrated binding exclusions, real Pi E2E usage charges, actual menu labels, and release classification left to the approved release PR.
- Architecture snapshot added to package files because shipped contributor notes refer to it. No documentation framework or exhaustive model inventory added. Historical plans/released changelog sections retained.

## Fresh checks

- `npm run check -- --maxWorkers=1 --minWorkers=1`: TypeScript plus 569/569 tests across 51 files passed. `/tmp/docs-73-check.log`.
- Command contract regression: explicit `config text` never opens TUI or invokes CLI checks; completion surface includes it. Existing command suite: 15/15 passed, `/tmp/docs-73-targeted.log`.
- `npm pack --dry-run --json`: passed; 73 files, including current architecture/operational guides and new configuration sources, excluding tests and development E2E scripts. `/tmp/docs-73-pack.json`.
- `npm audit --omit=dev --audit-level=high`: zero vulnerabilities. `/tmp/docs-73-audit.log`.
- `git diff --check`: passed.
- All 33 registered command entries match README command table in both directions, expanding enable/disable rows.
- 14 local Markdown links/anchors across changed current guides resolve. Obsolete-route scan reviewed: remaining matches are migration mappings or explicit rejection checks, not current instructions.
- Released changelog suffix matches HEAD byte-for-byte; no historical plan file rewritten in this pass.

## Disposable real terminal walkthrough

Installed Pi v0.99.2, tmux, empty disposable agent/workspace, explicit worktree extension, no discovered extensions/skills/templates or supplied credentials:

1. `/external` opened the agent-first overlay. Opening alone created no extension settings; Pi itself created its own root files.
2. Claude Code → Model → `/opus` filtered the named alias; selecting saved `opus` locally.
3. Role customizations → reviewer → Reasoning → High saved the sparse role patch.
4. Same as Claude Code restored inheritance; direct JSON assertion confirmed harness model remained `opus` and reviewer effort was removed (`harnesses.claude` was `{ "model": "opus" }`).
5. Resize to 48×16 retained the selected row and navigation; Esc returned through menus and closed.
6. `/external config text` printed configuration details in TUI without reopening the modal.
7. Scratch session and directory removed.

No backend model-list subprocess, provider prompt, CLI authentication change or real configuration conversion was performed during this UI walkthrough. Claude/Antigravity implementation delegations are distinct authorized model work; the statement above is about product acceptance testing.

## Evidence limits

- RPC behavior was checked against implementation and offline native-dialog fixtures, not a live RPC client. Its busy cancellation limitation is documented.
- No real backend/provider acceptance or paid Pi readiness test was run in this documentation pass.
- Existing live-backend evidence remains historical. Model names, listed credentials and setup checks are not access guarantees.
- Publication and version/label decisions remain separate authorization.
