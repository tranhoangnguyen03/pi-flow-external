# External Command, Settings, and Essential Tests Implementation Plan

> **REQUIRED SUB-SKILL:** Use the executing-plans skill to implement this plan task-by-task.

**Goal:** Replace the fragmented profile command with one `/external` namespace, add a minimal extension-owned settings file, expose only execution tools to the ordinary driver, and cut duplicate/non-product tests.

**Architecture:** Keep profile Markdown as the harness source of truth. Add one settings loader for extension-owned concurrency and timeout defaults, one command dispatcher backed by shared profile/workflow/report readers, and preserve `Agent`/`workflow` contracts. Consolidate tests around public contracts and trust/process/data-integrity boundaries; real providers remain opt-in.

**Tech Stack:** TypeScript, Earendil Pi extension API, TypeBox, Vitest, Node.js standard library.

---

### Task 1: Establish the essential suite

**Files:**
- Delete: `test/pi-backend-behavior.test.ts`
- Delete: `test/proactive-routing.test.ts`
- Modify: `test/agent-contract.test.ts`
- Modify: `test/workflow.test.ts`
- Modify: `test/profile-creator.test.ts`
- Modify or consolidate the remaining `test/*.test.ts`

**Steps:**
1. Remove skipped Pi-backend and model-routing scenarios because the product explicitly excludes Pi-backed agents.
2. Replace prompt-fragment assertions with the three public policy invariants: external-only, explicit profile, no automatic retry.
3. Collapse workflow microcases into table-driven contract tests covering parsing, execution, concurrency, cancellation, source trust, structured output, persistence, and resume.
4. Collapse repeated backend lifecycle tests while retaining one success, terminal-failure, and abort/stream-boundary check per backend.
5. Run `npm test`; preserve passing coverage of public contracts and critical boundaries.
6. Commit `test: keep only essential external contracts`.

### Task 2: Add extension-owned settings using TDD

**Files:**
- Create: `src/settings.ts`
- Create: `test/settings.test.ts`
- Modify: `src/pi-subagent.ts`
- Modify: `src/core/spawn.ts`

**Steps:**
1. Write failing tests for missing-file creation, valid parsing, malformed fallback diagnostics, and precedence.
2. Run `npx vitest run test/settings.test.ts` and verify failures are caused by the absent module.
3. Implement `$PI_CODING_AGENT_DIR/pi-flow-external/settings.json` with `{ version: 1, maxConcurrentSubagents: 12, subagentTimeoutMs: 7200000 }`.
4. Create missing settings with mode `0600`; never overwrite an existing file.
5. Resolve `CLI flags > factory options > settings > built-ins`; retain `PI_FLOW_EXTERNAL_RUNS_DIR` for receipt-directory overrides.
6. Run the focused test, then `npm test`.
7. Commit `feat: add external harness settings`.

### Task 3: Implement `/external` using TDD

**Files:**
- Create: `src/external-command.ts`
- Create: `test/external-command.test.ts`
- Modify: `src/profile-creator.ts`
- Modify: `src/pi-subagent.ts`
- Modify: `scripts/field-report.mjs` or extract its shared report reader into `src/field-report.ts`

**Steps:**
1. Write one failing command-routing test covering completions and the supported routes.
2. Run `npx vitest run test/external-command.test.ts` and verify `/external` is absent.
3. Register one dispatcher with routes: empty status, `doctor`, `settings`, `profiles`, `profile create`, `workflows`, `runs`, and `help`.
4. Reuse one command table for completion and help text.
5. Keep `/pi-flow-profile create` as a deprecated one-release alias.
6. Ensure Doctor is non-destructive and consumes no model turn; label unverifiable auth as unverified.
7. Run focused and full tests.
8. Commit `feat: add external command namespace`.

### Task 4: Restrict the ordinary driver surface

**Files:**
- Modify: `src/profile-creator.ts`
- Modify: `src/prompts.ts`
- Modify: `test/agent-contract.test.ts`
- Modify: `test/profile-creator.test.ts`

**Steps:**
1. Write a failing contract test asserting the ordinary driver exposes only `Agent` and `workflow` from this extension.
2. Keep profile finalization available only inside the profile interview path, or replace it with command-owned finalization if Pi cannot scope a tool by child session.
3. Shorten injected guidance so tool schemas own syntax while the system prompt retains routing, self-contained prompt, and no-retry rules.
4. Run focused and full tests.
5. Commit `refactor: narrow external driver surface`.

### Task 5: Consolidate opt-in E2E and documentation

**Files:**
- Create: `scripts/e2e/external.mjs`
- Delete: redundant `scripts/e2e/*.mjs`
- Modify: `package.json`
- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `CONTEXT.md`
- Modify: `docs/field-testing.md`
- Modify: `docs/releasing.md`

**Steps:**
1. Replace provider-specific runners with one opt-in runner accepting `--backend claude|codex|agy` and `--workflow`.
2. Keep `npm test` deterministic and offline.
3. Add the essential-test mandate to `AGENTS.md`: one authoritative test per behavior; no prose/cosmetic/model-interpretation tests; regression tests replace overlaps.
4. Document `/external`, settings path/schema/precedence, profile source-of-truth, and deprecated alias.
5. Restrict npm `files` to ship `scripts/field-report.mjs`, not development E2E scripts.
6. Run command help and dry-pack checks.
7. Commit `docs: document external control surface`.

### Task 6: Verify and review

**Steps:**
1. Run `npm run check`.
2. Run `npm pack --dry-run --json` and inspect the file list.
3. Run `npm audit --omit=dev --audit-level=high` and record residual risks without auto-fixing dependencies.
4. Compare test file/case/LOC totals with the baseline: 21 files, 181 cases (41 skipped), 6,248 test LOC, 2,400 E2E LOC.
5. Request a read-only code review against the branch base.
6. Fix Critical and Important findings with focused red-green tests.
7. Re-run the complete verification gate and report evidence.
