# Delegation Transparency Implementation Plan

> **REQUIRED SUB-SKILL:** Use the executing-plans skill to implement this plan task-by-task.

**Goal:** Make the TUI disclose external-agent access, explain profile selection, and link completed rows to durable evidence.

**Architecture:** Keep backend execution and record formats unchanged. Extend the existing tool renderers and shared subagent renderer, using the current progress/details snapshots and tool-output expansion state.

**Tech Stack:** TypeScript, Pi extension `renderCall`/`renderResult`, `@earendil-works/pi-tui`, Vitest.

---

### Task 1: Specify direct delegation rendering

**Files:**
- Create: `test/agent-rendering.test.ts`
- Modify: `src/pi-subagent.ts`
- Modify: `src/core/subagent-render.ts`

**Step 1: Write the failing test**

Add focused assertions that:
- a pending direct call renders `Delegating`, backend/profile, task, profile purpose, workspace, and `unsandboxed external CLI`;
- a completed expanded result renders `Evidence`, record path, and backend event count;
- compact terminal output calls the run identifier `evidence`, not `run`.

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/agent-rendering.test.ts`
Expected: FAIL because the current renderers omit access, purpose, workspace, and expanded evidence.

**Step 3: Write minimal implementation**

Update the direct `renderCall` copy and pass `expanded` into the shared renderer. Add bounded expanded receipt lines to `renderSubagentNode`; reuse `recordPath`, `runId`, and `backendEventCount` already present in details.

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/agent-rendering.test.ts`
Expected: PASS.

### Task 2: Specify workflow-level transparency

**Files:**
- Modify: `test/agent-rendering.test.ts`
- Modify: `src/workflow/tool.ts`

**Step 1: Write the failing test**

Assert that workflow preflight/live rendering states unsandboxed external access once, preserves done/active/queued/failed counts, and shows workflow journal evidence in expanded terminal output.

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/agent-rendering.test.ts`
Expected: FAIL because workflow rendering has no access or expanded evidence receipt.

**Step 3: Write minimal implementation**

Add the access cue to workflow call/live headers, pass `expanded` into the workflow snapshot renderer, and append the existing workflow run/journal reference only when terminal and expanded.

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/agent-rendering.test.ts`
Expected: PASS.

### Task 3: Verify contracts

**Files:**
- Modify only if required by test failures.

**Step 1: Run focused contracts**

Run: `npx vitest run test/agent-rendering.test.ts test/agent-contract.test.ts test/workflow.test.ts`
Expected: PASS.

**Step 2: Run full verification**

Run: `npm run check`
Expected: TypeScript succeeds and all tests pass.

**Step 3: Inspect the diff**

Run: `git diff --check && git status --short && git diff --stat`
Expected: no whitespace errors; only the rendering test, renderers, and design/plan docs changed.
