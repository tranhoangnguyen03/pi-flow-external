# Guided modal verification

Implementation: config-hub.ts (flows), config-modal.ts (one focused native overlay), external-command.ts (entry routes). Commands remain secondary; RPC uses ordinary dialogs; headless text preserved.

Fresh verification:
- npm run check -- --maxWorkers=1 --minWorkers=1: TypeScript, 566/566 offline tests, 50 files. /tmp/hub-verified.log
- npm pack --dry-run --json: passed. /tmp/hub-pack.json
- npm audit --omit=dev --audit-level=high: zero vulnerabilities. /tmp/hub-audit.log
- git diff --check: passed.
- Disposable real Pi TUI in tmux: opened /external, selected Codex, changed reasoning to High, saved feedback, resized 100x32 to 48x16, Esc returned preserving selection and closed. No credentials or model requests. Scratch session/directory removed.

Independent Claude review run_0fa9b8b4243348bfa29f688dbb44d826 identified repeated-confirm selection, paid-test cancellation, malformed instruction reset, parent effort labeling, irrelevant availability fixes, recovery action mismatch, editor/keybinding/context issues. Addressed: confirmations always Cancel; request abort forwarded to readonly readiness controller; raw malformed previews; policy-aware labels; scoped fix choices/report; only convertible formats offer conversion; configured cancel/external-editor keys; prototype-based context overrides; viewport-aware confirmation layout and line counts.

Known limits:
- CLI model IDs are manual and verified only by actual CLI execution. Pi models use provider-grouped native lists, no model search field yet.
- No real provider tests were performed; paid test cancellation was checked with offline signal tests.
- No configuration engine changes beyond shared reasoning-choice export and readiness cancellation wiring; live configuration untouched. No commit, push or release.
- External editor uses VISUAL/EDITOR on this Unix-oriented host; failure preserves the draft. Terminal keyboard hints name defaults; configured cancel/external-editor bindings are honored.

User acceptance: reopen disposable Pi session with worktree index.ts, /external, select Codex, set model/reasoning, Roles -> Reviewer -> Codex customization, change and return via Same as Codex. Confirm the interaction is understandable without command reference. Do not migrate real settings for this first UX check.
