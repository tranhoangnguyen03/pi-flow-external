# User and Agent Documentation Sync Implementation Plan

> **REQUIRED SUB-SKILL:** Use the executing-plans skill to implement this plan task-by-task.

**Goal:** Align every active user-facing and agent-facing guide with the field-tested external-agent contract, then release the documentation and prompt guidance as `1.0.10-external.5`.

**Architecture:** Keep `README.md` as the concise entry point, put repeatable operational detail in dedicated field-testing and release guides, and keep runtime agent guidance in `src/prompts.ts`. Preserve historical plans and the `CLAUDE.md` pointer instead of duplicating or rewriting them.

**Tech Stack:** Markdown, TypeScript string prompts, Vitest, npm package/release tooling.

---

### Task 1: Synchronize runtime agent guidance

**Files:**
- Modify: `test/agent-contract.test.ts`
- Modify: `src/prompts.ts`
- Modify: `AGENTS.md`
- Modify: `CONTEXT.md`

1. Add focused prompt-contract assertions that require explicit backend-qualified profiles, forbid silent retries, and require explicit workspace paths for backend-native nesting.
2. Run `npx vitest run test/agent-contract.test.ts`; verify the new assertions fail.
3. Add the minimum matching coordinator and workflow guidance to `src/prompts.ts`.
4. Correct `AGENTS.md` so `subagent_type` is required and add the terminal-receipt, evidence, privacy, nested-timeout, and workspace invariants.
5. Add concise receipt/evidence vocabulary to `CONTEXT.md`.
6. Re-run the focused test and verify it passes.

### Task 2: Refresh the user entry point

**Files:**
- Modify: `README.md`

1. Distinguish root Pi authentication from external CLI authentication and add `pi auth check --model <provider/model> --json`.
2. State that every direct and workflow child requires a backend-qualified profile.
3. Explain successful receipts, complete backend failures, and incomplete evidence.
4. Document Agy stdin transport, the one-time nested timeout extension, explicit-path guidance for backend-native nesting, record privacy, and troubleshooting.
5. Link to the field-testing and release guides.

### Task 3: Add operational guides

**Files:**
- Create: `docs/field-testing.md`
- Create: `docs/releasing.md`

1. Write a bounded field-test checklist covering direct Claude/Codex, Agy stdin privacy, workflow fan-out, nested timeout extension, expected backend failure, damaged evidence, and cleanup.
2. Write a release checklist covering unique version selection, verification, package inspection, npm web authentication, explicit prerelease dist-tag, publish-time 2FA, and registry verification.
3. Keep secrets and local evidence warnings explicit.

### Task 4: Align embedded E2E help

**Files:**
- Modify: `scripts/e2e/claude-subagent.mjs`
- Modify: `scripts/e2e/codex-subagent.mjs`
- Modify: `scripts/e2e/workflow-features.mjs`

1. Update comments and help examples to distinguish the root Pi model from the delegated CLI model.
2. Show `openai-codex/gpt-5.4-mini` as an OAuth-capable root-model override without changing script runtime defaults.

### Task 5: Prepare and verify release

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`

1. Bump the unpublished documentation release to `1.0.10-external.5` with `npm version 1.0.10-external.5 --no-git-tag-version`.
2. Run `git diff --check`.
3. Run `npm run check`; expect all active tests to pass.
4. Run `npm pack --dry-run --json`; confirm both new guides and the updated runtime prompt are included.
5. Run `npm audit --omit=dev --audit-level=high`; expect zero runtime vulnerabilities.
6. Review the complete diff and request a read-only production review.
7. Commit, push a branch, open a PR to `main`, merge after checks, then publish with `npm publish --access public --tag latest` and verify npm version/dist-tags.
