# Workflows

The `external_workflow` tool provides trusted JavaScript orchestration across external AI harnesses and in-process Pi models, enabling parallel fan-out, multi-stage pipelines, and structured failure handling. The former `workflow` tool name is not an alias; see the [rename migration guide](migration-workflow-to-external-workflow.md).

**Need help choosing a plan, not just syntax?** Read the installed [pi-flow-orchestration skill](../skills/pi-flow-orchestration/SKILL.md) and [Orchestration Playbook](orchestration-playbook.md). They teach pattern selection and provide tested scripts without adding runtime helpers.

---

## Minimal Workflow Structure

Every workflow script must begin with a versioned metadata export:

```js
export const meta = {
  apiVersion: 1,
  name: "code-review",
  description: "Parallel architecture and QA review",
  phases: [
    { title: "Review", detail: "Claude checks architecture while Codex checks tests; both use readonly access." },
    { title: "Collect", detail: "Return both reports for the parent to compare." },
  ],
};

phase("Review");
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

phase("Collect");
return { arch, qa };
```

---

## Explain the Plan Before Launch

Before calling `external_workflow`, the parent agent must tell the user, in plain language:

- The purpose and which agent/harness handles each assignment.
- What runs in parallel and what waits for earlier results.
- What may change and what deliverable the user will receive.

For example: “Claude will review the architecture while Codex checks test coverage, both with readonly access. Then I’ll compare their reports and return one prioritized list.” Follow the user's existing approval policy; a briefing is not an extra approval gate. Explain material changes to the plan.

Put the same roadmap in `meta.phases`, an optional ordered array of `{ title, detail? }`, and call `phase(title)` when each stage actually begins. Short phase details explain the work on the live card; future stages appear as planned. Existing saved scripts without phases remain valid.

**A plan is intent, not proof of execution.** The briefing is an agent instruction, not a runtime-verified chat message. Runtime validation checks phase metadata, not whether the script follows its prose. Child states and activity are the source of truth for observed execution. Do not invent completion estimates or call a quiet agent healthy merely because a spinner moves.

Choose foreground by default when you need the result next, including parallel workflows. Use background when you have independent local work to do first, or when the user asks to leave the workflow running across turns; it does not make children more parallel. While a foreground call runs, the live card carries progress; the parent cannot reliably send chat updates from inside that call. A background receipt is not a live monitor, though UI sessions show active background runs in the status bar and wake the session with a follow-up message when an uncollected background run settles across turns. Keep the owning session open and collect results after independent work finishes, or report the run ID and switch tasks/end the turn when the user wants to check back later. See [execution and collection](supervision-and-runtime.md#foreground-background--lifecycle) for the complete lifecycle and interruption rules.

The recorded purpose and phase details remain accessible in explicit launch inspection, during execution and after completion:

```ts
await tools.external_runs({ action: "inspect", runIds: [runId], view: "launch" });
```

Launch evidence also includes the script and arguments and may contain sensitive information. Follow `nextCursor` and concatenate pages when the response is paged.

---

## Global Functions & Environment

The workflow sandbox exposes these helpers:

- **`agent(prompt, options)`:** Delegates one subagent task.
  - `options.role`: Role name (`explorer`, `reviewer`, `implementer`, etc.).
  - `options.harness`: Optional harness override (`claude`, `codex`, `agy`, `muse`, or named `pi-*`).
  - `options.permission`: Permission tier (`readonly`, `edit`, or `danger`).
  - `options.context`: Context sharing (`{ mode: "recent", turns: 5 }` or `{ mode: "full" }`).
  - `options.description`: User-facing task label in UI.
  - `options.schema`: Optional JSON / TypeBox schema for structured return values (supported on Pi subagents and native CLI schemas).
  - `options.maxBudgetUsd`: Optional USD spending cap (enforced natively on Claude Code; recorded elsewhere).
- **`parallel([thunk1, thunk2, ...])`:** Runs an array of functions concurrently under the shared session concurrency limiter (`maxConcurrentSubagents`, default 12).
- **`pipeline(items, ...stages)`:** Feeds items sequentially through transformation stages.
- **`phase(title)`:** Marks milestone boundaries in live progress presentation.
- **`log(message)`:** Appends diagnostic notes to the workflow journal.
- **`args`:** Input JSON arguments passed via `external_workflow({ args: { ... } })`.
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
await tools.external_workflow({
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
