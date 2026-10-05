# Agent Tasking Transparency Implementation Plan

> **REQUIRED SUB-SKILL:** Use the executing-plans skill to implement this plan task-by-task.

**Goal:** Make direct agent and workflow progress clearly show current activity, completed outcomes, remaining work, failures, and timeouts.

**Architecture:** Keep backend execution unchanged. Extend the existing progress snapshots with one timeout flag, then improve the shared subagent renderer and workflow aggregate renderer. Reuse existing preview truncation and rendering components.

**Tech Stack:** TypeScript, pi-tui components, Vitest.

---

### Task 1: Activity retention and compact summaries

**Files:**
- Modify: `test/agent-rendering.test.ts`
- Modify: `src/core/progress.ts`
- Modify: `src/core/subagent-render.ts`

**Step 1: Write failing tests**

Add tests that:
- create a progress emitter, append five events, and expect the retained activity to equal the latest four;
- render a running compact node with five active agents and expect `-- <latest activity>`;
- render a completed node and expect `-> <first non-empty result line>`;
- verify long compact previews do not expose text beyond the existing preview bound.

**Step 2: Verify RED**

Run: `npx vitest run test/agent-rendering.test.ts`

Expected: failures showing only two events are retained and compact rows omit activity/results.

**Step 3: Implement minimally**

- Change `MAX_ACTIVITY_LINES` from `2` to `4`.
- In `renderCompactSubagentNode`, append the latest formatted activity for running nodes and the first non-empty formatted result line for done nodes.
- Reuse `formatActivityLineForDisplay`; do not add another truncation mechanism.

**Step 4: Verify GREEN**

Run: `npx vitest run test/agent-rendering.test.ts`

Expected: all tests pass.

**Step 5: Commit**

```bash
git add test/agent-rendering.test.ts src/core/progress.ts src/core/subagent-render.ts
git commit -m "feat: surface compact agent activity and results"
```

### Task 2: Distinguish timeouts from cancellation

**Files:**
- Modify: `test/timeout.test.ts`
- Modify: `test/agent-rendering.test.ts`
- Modify: `src/types.ts`
- Modify: `src/core/timeout.ts`
- Modify: `src/core/subagent-render.ts`
- Modify: `src/workflow/tool.ts`

**Step 1: Write failing tests**

Extend timeout tests to expect `timedOut: true` on both tool details and progress. Add rendering assertions that a timed-out aborted node uses `T`/timer treatment and `timed out:` wording, while ordinary abortion keeps the existing cancellation marker and `aborted:` wording.

**Step 2: Verify RED**

Run: `npx vitest run test/timeout.test.ts test/agent-rendering.test.ts`

Expected: failures because no timeout flag or distinct rendering exists.

**Step 3: Implement minimally**

- Add optional `timedOut?: boolean` to `WorkflowAgentSnapshot`, `SubagentProgressNode`, `SubagentToolDetails`, and the renderable node shape.
- Set the flag in `markSubagentTimedOut` on details and progress.
- Copy it from partial/final subagent details into workflow agent snapshots.
- Render a timer marker for timed-out nodes and use `timed out:` instead of `aborted:`.

**Step 4: Verify GREEN**

Run: `npx vitest run test/timeout.test.ts test/agent-rendering.test.ts test/workflow.test.ts`

Expected: all tests pass.

**Step 5: Commit**

```bash
git add test/timeout.test.ts test/agent-rendering.test.ts src/types.ts src/core/timeout.ts src/core/subagent-render.ts src/workflow/tool.ts
git commit -m "feat: distinguish agent timeouts from cancellation"
```

### Task 3: Explicit workflow progress counts

**Files:**
- Modify: `test/workflow.test.ts`
- Modify: `src/workflow/tool.ts`

**Step 1: Write failing tests**

Update/add workflow rendering tests that expect:
- workflow headers to show `done`, `active`, `queued`, and `failed` counts against total;
- phase headers to show the same breakdown;
- hidden-row footers to include hidden failure counts when non-zero.

**Step 2: Verify RED**

Run: `npx vitest run test/workflow.test.ts`

Expected: failures against the old `done/total` and generic hidden-row strings.

**Step 3: Implement minimally**

Add one local count formatter in `src/workflow/tool.ts` and use it for workflow and phase headers. Compute hidden failures from agents excluded by `selectAgentsForRender` and append `(<n> failed)` only when non-zero.

**Step 4: Verify GREEN**

Run: `npx vitest run test/workflow.test.ts`

Expected: all tests pass.

**Step 5: Commit**

```bash
git add test/workflow.test.ts src/workflow/tool.ts
git commit -m "feat: clarify workflow progress counts"
```

### Task 4: Full verification and review

**Files:**
- Review all changed files.

**Step 1: Run full verification**

Run: `npm run check`

Expected: TypeScript exits successfully and all enabled Vitest tests pass.

**Step 2: Inspect the diff**

Run: `git diff --check HEAD~3..HEAD && git status --short && git log -5 --oneline`

Expected: no whitespace errors and only intended commits/files.

**Step 3: Request independent code review**

Provide the approved design, base SHA, head SHA, and worktree path to a read-only reviewer. Fix any critical or important findings with tests first, then rerun `npm run check`.
