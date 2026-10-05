# Workflows

Workflows provide trusted JavaScript orchestration across external AI harnesses and in-process Pi models, enabling parallel fan-out, multi-stage pipelines, and structured failure handling.

---

## Minimal Workflow Structure

Every workflow script must begin with a versioned metadata export:

```js
export const meta = {
  apiVersion: 1,
  name: "code-review",
  description: "Parallel architecture and QA review",
};

// Orchestrate subagents:
const [arch, qa] = await parallel([
  () => agent("Review architecture read-only", {
    role: "reviewer",
    harness: "claude",
    permission: "readonly",
  }),
  () => agent("Review test coverage read-only", {
    role: "qa",
    harness: "codex",
    permission: "readonly",
  }),
]);

return { arch, qa };
```

---

## Global Functions & Environment

The workflow sandbox exposes these helpers:

- **`agent(prompt, options)`:** Delegates one subagent task.
  - `options.role`: Role name (`explorer`, `reviewer`, `implementer`, etc.).
  - `options.harness`: Optional harness override (`claude`, `codex`, `agy`, `grok`, `muse`, `opencode`, or named `pi-*`).
  - `options.permission`: Sandbox tier (`readonly`, `edit`, or `danger`).
  - `options.context`: Context sharing (`{ mode: "recent", turns: 5 }` or `{ mode: "full" }`).
  - `options.description`: User-facing task label in UI.
  - `options.schema`: Optional JSON / TypeBox schema for structured return values (supported on Pi subagents and native CLI schemas).
  - `options.maxBudgetUsd`: Optional USD spending cap (enforced natively on Claude Code; recorded elsewhere).
- **`parallel([thunk1, thunk2, ...])`:** Runs an array of functions concurrently under the shared session concurrency limiter (`maxConcurrentSubagents`, default 12).
- **`pipeline(items, ...stages)`:** Feeds items sequentially through transformation stages.
- **`phase(title)`:** Marks milestone boundaries in live progress presentation.
- **`log(message)`:** Appends diagnostic notes to the workflow journal.
- **`args`:** Input JSON arguments passed via `workflow({ args: { ... } })`.
- **`cwd`:** Current working directory of the Pi session.

---

## Error Handling & Resilience

Successful `agent()` calls return their canonical output directly.

If a child fails, times out, or is cancelled, `agent()` throws a catchable **`ChildRunError`**:

```js
export const meta = { apiVersion: 1, name: "resilient-audit", description: "Audit with fallback" };

let securityReport = null;
try {
  securityReport = await agent("Deep security audit", {
    role: "reviewer",
    harness: "claude",
    permission: "readonly",
  });
} catch (err) {
  log(`Primary audit failed: ${err.message} (${err.outcome})`);
  // Graceful fallback or recovery:
  securityReport = "Security audit unavailable.";
}

return { securityReport };
```

### Handled Child Failures
- If a child error is caught, the workflow continues, and active sibling runs are not interrupted.
- The final workflow receipt stays `ok: true`, with `run.children.failed` counted and a `handled_child_failures` warning attached.
- If a child error is **uncaught**, the workflow terminates immediately and cancels all pending siblings.

---

## Snapshot Consistency & Explicit Replay

### Frozen Catalog Snapshot
When a workflow begins, it freezes an immutable snapshot of all settings, role instructions, and override files. Editing files on disk during a workflow run will not desync or corrupt currently running children.

### Replay via `resumeFromRunId`
When executing a saved workflow file from disk, you can pass `resumeFromRunId` to replay:

```ts
await workflow({
  scriptPath: "/path/to/workflow.js",
  resumeFromRunId: "wf_previous_run_id",
});
```

- **Prefix Cache Reuse:** The runtime calculates cryptographic fingerprints of each child step (prompt, role, harness, options, and transferred context). It reuses cached results for the longest unchanged prefix of successful calls. Note: Replay requires explicit resolved configurations; unresolved native CLI defaults cannot establish replay equivalence.
- **Suffix Invalidation:** The first modified, failed, timed-out, or cancelled step invalidates all subsequent steps, re-running them cleanly.

---

## Related Documentation

- **[Public Contract v1](public-contract.md):** Formal envelope and error structure for programmatic workflows.
- **[Supervision & Runtime](supervision-and-runtime.md):** Monitoring background children and reading operational evidence.
- **[Harness Reference](harness-reference.md):** Per-harness capabilities and budget enforcement constraints.
