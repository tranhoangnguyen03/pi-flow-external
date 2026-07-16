# Installation and External Profile Hardening Implementation Plan

> **REQUIRED SUB-SKILL:** Use the executing-plans skill to implement this plan task-by-task.

**Goal:** Make a fresh pi-flow-external installation understandable and fail safely unless every direct or workflow delegation selects a configured external profile.

**Architecture:** Keep external profiles user-defined under `~/.pi/agent/subagents`. Tighten the public `Agent` schema, disable the workflow runtime's legacy Pi-profile default only for this extension, and preserve the generic workflow runtime default for existing internal callers. Fix the workflow worker's late promise-reaction crash at the promise boundary where the rejected reaction is created.

**Tech Stack:** TypeScript, TypeBox, Node worker threads, Vitest, Pi package metadata, Markdown.

---

### Task 1: Require a direct Agent profile

**Files:**
- Modify: `test/agent-contract.test.ts`
- Modify: `src/pi-subagent.ts`

**Step 1: Write the failing contract test**

Change the existing schema assertion to require `subagent_type` and verify its string schema rejects an empty value through `minLength: 1`.

```ts
expect(schema?.required).toContain("subagent_type");
expect(schema?.properties.subagent_type).toMatchObject({ type: "string", minLength: 1 });
```

**Step 2: Run the focused test and verify RED**

Run: `npx vitest run test/agent-contract.test.ts`

Expected: FAIL because `subagent_type` is optional and has no `minLength`.

**Step 3: Implement the minimum contract change**

In `src/pi-subagent.ts`, make `subagent_type` a required `Type.String({ minLength: 1, ... })`. Remove the unavailable `claude-explorer` fallback. Trim the selected profile name and retain a renderer-only neutral fallback for partial arguments.

**Step 4: Verify GREEN**

Run: `npx vitest run test/agent-contract.test.ts test/external-only-agent.test.ts`

Expected: both files pass.

### Task 2: Require profiles in extension workflows

**Files:**
- Modify: `test/workflow.test.ts`
- Modify: `src/workflow/types.ts`
- Modify: `src/workflow/runtime.ts`
- Modify: `src/workflow/tool.ts`

**Step 1: Write the failing workflow test**

Add a test showing that a caller can disable the legacy runtime default and receives a clear error when `agent()` omits `subagent_type`.

```ts
await expect(runWorkflow(script, {
  cwd: "/tmp",
  limiter: new ConcurrencyLimiter(1),
  runAgent: echo,
  defaultSubagentType: null,
})).rejects.toThrow(/subagent_type is required/);
```

**Step 2: Run the focused test and verify RED**

Run: `npx vitest run test/workflow.test.ts`

Expected: typecheck/test failure because `null` is unsupported and the legacy `general-purpose` default is used.

**Step 3: Implement the minimum extension-specific requirement**

Allow `RunWorkflowOptions.defaultSubagentType` to be `string | null`. In `runWorkflow`, distinguish omitted (`undefined`, retain generic `general-purpose`) from explicit `null` (no default), then throw `agent subagent_type is required` before queueing a call when neither source supplies one. Pass `defaultSubagentType: null` from `createWorkflowTool`.

**Step 4: Verify GREEN**

Run: `npx vitest run test/workflow.test.ts`

Expected: all workflow runtime tests pass.

### Task 3: Stop late workflow reactions from crashing the worker

**Files:**
- Create: `test/workflow-worker.test.ts`
- Modify: `src/workflow/script-worker.ts`

**Step 1: Write the deterministic worker regression test**

Create a worker directly with a script that starts `agent('a').then(() => agent('b'))` and returns early. Reply to the first agent request, capture worker `error` events, and assert the worker reports the intended workflow error without emitting an uncaught worker error.

**Step 2: Run the focused test and verify RED**

Run: `npx vitest run test/workflow-worker.test.ts`

Expected: FAIL because the discarded promise reaction rejects with `agent() cannot be called after the workflow body has returned`, emitting a worker error.

**Step 3: Implement the root-cause fix**

At the custom thenable boundary in `src/workflow/script-worker.ts`, attach a no-op rejection observer to each native reaction promise returned by `then`, `catch`, or `finally`, while returning the original promise unchanged. This preserves rejection semantics for callers that await the chain but prevents discarded reactions from becoming uncaught worker exceptions.

**Step 4: Verify GREEN on supported Node lines**

Run:

```bash
npx vitest run test/workflow-worker.test.ts test/workflow.test.ts
npx -y node@22.22.1 node_modules/vitest/vitest.mjs run test/workflow-worker.test.ts test/workflow.test.ts
```

Expected: both commands pass with no unhandled errors.

### Task 4: Complete installation and usage documentation

**Files:**
- Modify: `README.md`

**Step 1: Replace the stale install section**

Document and verify the exact commands:

```bash
pi install npm:@tranhoangnguyen0310/pi-flow-external
pi list
pi install -l npm:@tranhoangnguyen0310/pi-flow-external
```

Explain project trust and `pi list --approve` for an untrusted project. Replace the vague local-development sentence with `pi install ./path` and `pi -e ./index.ts` examples.

**Step 2: Make prerequisites and profile setup explicit**

State that the npm package does not install or authenticate `claude`, `codex`, or `agy`; at least one must be available. State that no external profiles are bundled and project-only installation still reads global profiles from `~/.pi/agent/subagents`. Add a minimal Antigravity profile alongside the existing Claude and Codex examples.

**Step 3: Add end-user usage examples**

Add normal Pi prompts for natural routing, an exact profile, parallel delegation, and workflow orchestration. Keep the `Agent({...})` snippet only as an advanced tool-call shape and ensure every workflow `agent()` example supplies `subagent_type`.

**Step 4: Verify documentation strings**

Run:

```bash
grep -n "pi install npm:@tranhoangnguyen0310/pi-flow-external" README.md
grep -n "pi install -l npm:@tranhoangnguyen0310/pi-flow-external" README.md
grep -n "Ask Claude Code" README.md
grep -n "subagent_type" README.md
```

Expected: each required instruction is present.

### Task 5: Repair npm metadata

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`

**Step 1: Update package metadata**

Include Antigravity in the description, add `agy` and `antigravity` keywords, and point `pi.image` to the existing `assets/pi-flow.png`. Keep the current version unchanged until an actual npm publish is requested.

**Step 2: Keep lockfile metadata synchronized**

Run: `npm install --package-lock-only --ignore-scripts`

Expected: only top-level package metadata changes, with no dependency churn.

**Step 3: Verify package contents**

Run: `npm pack --dry-run --json`

Expected: exit 0 and `assets/pi-flow.png` appears in the tarball.

### Task 6: Full verification and review

**Files:**
- Review all modified files.

**Step 1: Run the full checks on Node 24**

Run: `npm run check`

Expected: typecheck succeeds; all enabled tests pass with no unhandled errors.

**Step 2: Run the full suite on Node 22**

Run: `npx -y node@22.22.1 node_modules/vitest/vitest.mjs run`

Expected: all enabled tests pass with no unhandled errors.

**Step 3: Verify installation in temporary global and project agent directories**

Use temporary directories to run both documented `pi install` forms, `pi list`, and `pi list --approve`; remove temporary directories afterward.

**Step 4: Inspect the final diff**

Run: `git diff --check && git status --short && git diff --stat`

Expected: no whitespace errors; only planned source, test, docs, and metadata files plus this plan are changed.

**Step 5: Request independent code review**

Ask a read-only reviewer to check the diff against this plan, fix any Critical or Important findings, and rerun Steps 1–4.
