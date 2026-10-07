# Menu UX rework after user acceptance feedback

Read-only Claude audit: run_7aae4f40c84b4cf1ac0b7c953986ac75 reviewed 17 menu areas. Parent implemented directly. No Codex delegation.

Changes:
- Removed ambiguous Keep current value. Explicit current summary/markers; opening pickers preserves current values unless another option is selected.
- CLI names from Codex local model catalog (CODEX_HOME supported), Claude aliases, explicit picker-time agy/grok/opencode models commands (OpenCode standalone). Muse/unlisted model IDs retain manual fallback. Pi registry names, configured accounts first, all-provider option. CLI listings may use network but never send a prompt; no eligibility claim. Cancellation/timeout for listing.
- / search across model names/menu rows, resize-safe current selection. Status/notes separated from headings.
- Readable access words, current-valued Advanced rows, timeout presets/custom minutes, spending cap choices; whole-number validation for counts.
- Role list customization counts; agent-role list names custom fields; direct scope-specific on/off, only applicable fixes.
- Pi review exposes model/reasoning/skills values and permits changing them before creation. Name validation before later steps. Role description editing with keep-existing on blank.
- Current model/skills/instructions markings, contextual save feedback; no retry prose on ordinary input errors; recovery when settings change while open.
- Guided Antigravity/Grok reasoning offers only levels actually forwarded without adapter remapping. Existing stored values/parser policies remain compatible.

Evidence:
- TypeScript + 569/569 tests (51 files), /tmp/menu-verified.log.
- Package dry-run /tmp/menu-pack.json; audit zero vulnerabilities /tmp/menu-audit.log; whitespace passed.
- Disposable real terminal: Codex picker displayed GPT-6-Astra/Sol/Luna names with IDs; GPT-6-Sol marked Current; /sol filtered named choices. No model prompt. Scratch session removed.

Remaining limits:
- Backend model listing formats are bounded known parsers; missing/malformed catalog falls back to current/configured IDs and manual entry. No price-table or Pi-to-CLI model guessing.
- Model-specific reasoning capabilities are not fully discovered for all CLIs; existing adapter validator remains authoritative. This change does not claim max/ultra support the adapters do not implement.
- Existing command-driven detailed views/deletion previews retain technical text under Advanced. UI rows still use unique full strings mapped to known IDs; no general menu framework added.
- No live settings changed, provider prompt sent, commit/push/release. Listing agy/grok/opencode during investigation may contact their model metadata services.
