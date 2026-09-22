# Grok CLI External Agent Implementation Plan

> **REQUIRED SUB-SKILL:** Use the executing-plans skill to implement this plan task-by-task.

**Goal:** Add `grok` as a fully supported external harness using the installed official Grok Build CLI.

**Architecture:** Add one backend adapter following the existing Claude-compatible message stream rather than creating a generic runner. Register it at existing backend switch points, preserve fail-closed native sandbox behavior, and migrate default seeding without restoring deleted profiles. Use Grok's single JSON result only when native structured output is requested.

**Tech Stack:** TypeScript, Node child processes, Vitest, Grok Build CLI 1.0.40.

---

## Verified protocol decisions

- Normal runs use `--output-format streaming-messages-json`, whose `assistant` and terminal `result` events match the established Claude message/result envelope and expose clean final-message boundaries.
- Structured runs use `--json-schema <inline JSON>`, which emits one pretty-printed JSON result containing `structuredOutput`; the adapter must parse the complete stdout document at process close.
- Prompt input uses `--prompt-file` because Grok does not consume a raw prompt from stdin.
- Terminal success requires `type=result`, `subtype=success`, `is_error=false`, `stop_reason=end_turn`, exit 0, and non-empty canonical result.
- `--reasoning-effort` accepts only `low|medium|high|xhigh` in 1.0.40; map `off|minimal` to `low`.
- Permissions are native and fail closed: readonly=`--sandbox read-only`, edit=`--sandbox workspace`, danger=`--sandbox off`; all pair with `--permission-mode bypassPermissions`. The local macOS readonly startup failure is surfaced rather than silently weakening isolation.
- Grok reports native `total_cost_usd`; no budget enforcement and no retries.

### Task 1: Backend protocol and lifecycle

**Files:**
- Create: `src/core/grok.ts`
- Create: `test/grok-backend.test.ts`

1. Write failing tests for exact argv, thinking normalization, streaming terminal success, native usage/cost/session capture, structured JSON output, terminal rejection, abort, and oversized output.
2. Run `npx vitest run test/grok-backend.test.ts` and confirm failures are caused by the missing adapter.
3. Implement the smallest adapter reusing existing progress, bounded-buffer, permission, process-tree, and result helpers.
4. Run the focused test until green.

### Task 2: Registration, permissions, observation, and resume routing

**Files:**
- Modify: `src/types.ts`
- Modify: `src/profiles.ts`
- Modify: `src/core/permissions.ts`
- Modify: `src/core/spawn.ts`
- Modify: `src/core/display.ts`
- Modify: `src/core/run-inspection.ts`
- Modify relevant existing tests under `test/`

1. Extend existing tests first for profile acceptance, all permission tiers, execution-lane behavior, dispatch, nested `spawn_subagent` observation, durable assistant output/activity, and labels.
2. Run the focused tests and verify red.
3. Add explicit Grok branches and registration; do not refactor the other adapters.
4. Run focused tests green.

### Task 3: Defaults migration and public surfaces

**Files:**
- Modify: `src/defaults.ts`
- Modify: `src/pi-subagent.ts`
- Modify: `src/prompts.ts`
- Modify: `src/external-help.ts`
- Modify: `src/profile-creator.ts`
- Modify: `scripts/e2e/external.mjs`
- Modify: `scripts/field-report.mjs`
- Modify relevant existing tests under `test/`

1. Add failing coverage showing fresh installs receive 24 canonical profiles while a v1 upgrade adds only six `grok-*` profiles and does not restore a deleted old profile.
2. Extend exact-list/help/E2E parser tests for Grok and verify red.
3. Implement the version-aware seed migration and user-facing registrations.
4. Run focused tests green.

### Task 4: Documentation and verification

**Files:**
- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `CONTEXT.md`
- Modify: `docs/ARCHITECTURE_SNAPSHOT.md`
- Modify: `docs/field-testing.md`
- Modify: `package.json`
- Modify: `CHANGELOG.md` only if repository release policy requires a shipped-file version entry in this branch

1. Document installation/authentication, permission boundaries, structured output, resume, lack of budget enforcement, and opt-in E2E syntax.
2. Run `npm run check`.
3. Run `npm pack --dry-run --json` and `npm audit --omit=dev --audit-level=high`; record rather than auto-fix dependency findings.
4. Run opt-in real `npm run e2e -- --backend grok` only after offline tests pass.
5. Request final correctness and over-engineering reviews; fix confirmed issues and rerun checks.
