# Final review corrections — 2026-10-01

Worktree: `feat/issue-73-config-lifecycle`, isolated `.worktrees/issue-73`. User authorized the corrective pass after Claude and Antigravity requested changes. Grok is excluded from further work; its claimed source review lacked tool evidence and is not a sign-off.

## Review disposition

- Claude `run_a0b72a7cf0424effade6c3d0a5cf5330`: runtime/catalog/migration review.
- Antigravity `run_62d4ab8f0e824fe196d5708b389db34d`: lifecycle/trust review.
- Parent independently reproduced exact exclusion bleed, linked instruction roots, legacy CLI metadata migration failure, and editor version-change bypass in disposable directories before fixing.
- One bounded read-only advisor consultation confirmed that CLI adapters never enforced legacy tools metadata and recommended conservative effort validation, files-first reset, and converter-only version activation. Parent made all edits and verified outcomes.

## Corrected

1. Catalog and lifecycle remaining-gate checks exclude stored exact selectors from inferred structured-binding exclusions. Exact records retain their own disable gates.
2. Catalog rejects linked/non-directory configuration, roles and overrides roots before reading instructions, including linked ancestors. Existing scoped-directory/file protections remain.
3. Migration preserves Pi tools; drops only historically unenforced CLI tools with source-specific preview notes. Unsupported effort remains blocked, naming the source and supported values/repair path. No effort is silently reinterpreted.
4. Shared settings writer refuses editor upgrades/downgrades, including invalid same-version settings being repaired. Only verified v4→v5 conversion passes explicit activation authorization. Malformed-file and same-version repair remain supported.
5. Conversion confirmation includes retained-exclusion diagnostics and notes when compatibility Pi exact records pin current effective defaults.
6. Pi text inspection reads the actual parent/off/explicit policy instead of mislabeling the legacy registration projection.
7. Role reset removes instruction files before deleting scalars. Unlink failure skips scalar deletion; a later atomic write failure reports removed instructions and unchanged settings. Fresh preview can finish; gates never change.
8. Current README, AGENTS, architecture and Unreleased changelog explain these guarantees and parent-effort compatibility limits.

## Regression evidence

Extended existing authoritative suites rather than duplicate E2E coverage:
- First targeted run: 10 expected assertion failures / 59 passes, `/tmp/correction-73-red.log`.
- Initial corrected targeted run: 69/69, `/tmp/correction-73-green.log`.
- Additional reset write-failure disclosure regression failed first (`/tmp/correction-73-reset-red.log`), then passed (`/tmp/correction-73-reset-green.log`).
- Full `npm run check -- --maxWorkers=1 --minWorkers=1`: TypeScript and **575/575 tests in 51 files**, `/tmp/correction-73-check.log`.
- `npm pack --dry-run --json`: **73 files**, expected runtime/docs included, tests/development E2E excluded, `/tmp/correction-73-pack.json`.
- `npm audit --omit=dev --audit-level=high`: **0 vulnerabilities**, `/tmp/correction-73-audit.log`.
- `git diff --check`: clean.
- Independent disposable Node assertion replay: structured/exact gates separated, linked roots blocked, editor bypass refused with unchanged source, successful converter backup/instructions preserved. No provider request.
- 14 local current-doc links/anchors valid; released changelog matches HEAD unchanged.

## Remaining gates and deliberate limits

- Package version remains `2.10.0-external.0`; release version/classification, lockfile synchronization and dated release section require separate approval before a release PR is finalized. No commit/push/PR/publication performed.
- No new real-provider acceptance or live RPC client test. Previous terminal walkthrough remains valid historical evidence; RPC native-dialog fixtures are offline only.
- Unsupported legacy effort intentionally requires explicit repair, not automatic mapping. Parent policy requires a backend-supported root effort.
- Concurrent independent settings writers remain last-writer-wins; reset across files/JSON is explicitly partial, not transactional.
- RPC cannot cancel busy listings/tests; model listing/credential observations do not prove account access. Pi children still lack persisted resume/enforced budget.
- External editor remains POSIX `/bin/sh`; substituting arbitrary `$SHELL` is not safe with its POSIX command syntax. Empty CODEX_HOME/catalog fallback polish was not part of this safety correction.
- Reviewers have not issued a new post-fix sign-off. Parent verified every implemented correction directly and through regressions; do not label this unanimous multi-review approval.
