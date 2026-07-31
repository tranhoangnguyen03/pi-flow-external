# Profile Creator Deployment Hardening Implementation Plan

> **REQUIRED SUB-SKILL:** Use the executing-plans skill to implement this plan task-by-task.

**Goal:** Make the approved external-profile creator safe and verifiable enough to merge and publish.

**Architecture:** Keep the existing interview, confirmation, staging, smoke-test, and atomic hard-link flow. Harden only its trust boundary: generated names must match their backend, and the unrestricted external smoke process must run from a fresh temporary working directory that is removed afterward. Reuse the existing backend launchers and Node standard library; add no abstraction or dependency.

**Tech Stack:** TypeScript, Node.js `fs/promises` and `os`, Vitest, npm package tooling.

---

### Task 1: Lock down creator behavior

**Files:**
- Modify: `test/profile-creator.test.ts`
- Modify: `src/profile-creator.ts`

1. Add a test that rejects a generated profile whose name prefix does not match its backend.
2. Add a test assertion recording the smoke subprocess working directory and requiring a fresh temporary directory rather than the project directory.
3. Run `npx vitest run test/profile-creator.test.ts`; verify both assertions fail for the expected missing behavior.
4. Add the minimum backend-prefix check to `compileProfile()`.
5. Create and remove a temporary smoke directory around `spawnSubagent()`, overriding only the external process working directory.
6. Re-run the focused test and verify it passes.

### Task 2: Cover failure and concurrency boundaries

**Files:**
- Modify: `test/profile-creator.test.ts`

1. Add focused checks for confirmation rejection and unavailable UI, proving neither path invokes a backend or writes a profile.
2. Add a concurrent same-name installation check proving exactly one install wins, the winner remains valid, and no staged files remain.
3. Add Codex and AGY fake-CLI smoke coverage proving proposed profile instructions are not passed to those backends.
4. Run `npx vitest run test/profile-creator.test.ts`.

### Task 3: Restore the repository release gate

**Files:**
- Modify: `test/workflow.test.ts:851`

1. Reproduce `TS1355` with `npm run check`.
2. Move the existing literal const assertions onto each conditional branch; do not alter runtime behavior.
3. Run `npx tsc --noEmit` and the workflow test.

### Task 4: Align release documentation and version

**Files:**
- Modify: `README.md`
- Modify: `package.json`
- Modify: `package-lock.json`

1. Replace the unsupported “harmless” claim with the exact boundary: profile instructions are omitted, the CLI runs in an empty temporary working directory, and its no-approval mode still requires a trusted environment.
2. Bump the already-published prerelease from `1.0.10-external.2` to `1.0.10-external.3` without creating a tag or commit.

### Task 5: Verify and review

1. Run `git diff --check`.
2. Run `npm run check`.
3. Run `npm pack --dry-run --json` and confirm the new source file is included with the bumped version.
4. Inspect the final diff and git status.
5. Request a fresh read-only review; fix only concrete blockers.

Do not commit, tag, publish, or create a real user profile without a separate explicit request.