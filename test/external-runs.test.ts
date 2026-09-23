import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as runInspection from "../src/core/run-inspection.ts";
import { createRunRecord } from "../src/core/run-record.ts";
import { RunRegistry } from "../src/core/run-registry.ts";
import { createExternalRunsTool } from "../src/external-runs.ts";
import { createWorkflowJournalWriter, createWorkflowRunIdentity, getSessionWorkflowDir } from "../src/workflow/journal.ts";

describe("external_runs", () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  function setup(completedLimit = 100) {
    const runsDirectory = mkdtempSync(join(tmpdir(), "external-runs-"));
    directories.push(runsDirectory);
    const registry = new RunRegistry(completedLimit);
    const tool = createExternalRunsTool({ registry, runsDirectory: () => runsDirectory }) as any;
    const ctx = { cwd: "/project", sessionManager: { isPersisted: () => true, getSessionDir: () => runsDirectory, getSessionId: () => "session-a" } } as any;
    const execute = (params: Record<string, unknown>, signal?: AbortSignal) => tool.execute("external-runs", params, signal, undefined, ctx);
    return { execute, registry, runsDirectory, tool, ctx };
  }

  async function completedRecord(runsDirectory: string, overrides: Record<string, unknown> = {}) {
    const record = createRunRecord({
      directory: runsDirectory,
      metadata: { parentSessionId: "session-a", project: "/project", description: "Done task", ...overrides },
    });
    await record.event("backend_event", { backend: "codex", event: { type: "item.completed", item: { type: "agent_message", text: "answer" } } });
    await record.finish({ status: "done", result: "answer" });
    return record;
  }

  it("lists only the current session/project and inspects bounded durable output", async () => {
    const { execute, runsDirectory, tool } = setup();
    const owned = await completedRecord(runsDirectory);
    await completedRecord(runsDirectory, { parentSessionId: "session-b" });

    expect((tool.parameters as any).properties.action.enum).toEqual(["list", "inspect", "wait", "cancel"]);
    const listed = await execute({ action: "list", limit: 10 });
    expect(listed.details.runs.map((run: any) => run.runId)).toEqual([owned.runId]);
    expect(listed.details.runs[0]).toMatchObject({ outcome: "succeeded", settledAt: expect.any(Number) });

    const inspected = await execute({ action: "inspect", runId: owned.runId, view: "output", limitBytes: 4 });
    expect(inspected.content[0].text).toContain("answ");
    expect(inspected.details).toMatchObject({ runId: owned.runId, view: "output", nextCursor: expect.any(String) });
    await expect(execute({ action: "inspect", runId: "../summary.json", view: "summary" })).rejects.toThrow(/run id/i);

    const finalView = await execute({ action: "inspect", runId: owned.runId, view: "final" });
    expect(finalView.details).toMatchObject({ finalAvailable: true, items: [{ text: "answer" }] });
  });

  it("inspects explicit selected runs in one bounded batch without waiting, validating all IDs up front", async () => {
    const { execute, registry, runsDirectory } = setup();
    const first = await completedRecord(runsDirectory, { description: "First" });
    const second = await completedRecord(runsDirectory, { description: "Second" });
    let finishThird!: (value: string) => void;
    registry.start({
      runId: "run_live_third",
      kind: "agent",
      sessionId: "session-a",
      project: "/project",
      run: () => new Promise((resolve) => { finishThird = resolve; }),
    });

    const batch = await execute({ action: "inspect", runIds: [first.runId, second.runId, "run_live_third"] });
    expect(batch.details.entries.map((entry: any) => entry.runId)).toEqual([first.runId, second.runId, "run_live_third"]);
    // Consistent nested shape across live/durable agent entries alike:
    // task/state/timing/output, never historicalAgent's raw flat fields.
    expect(batch.details.entries[0]).toMatchObject({
      runId: first.runId,
      kind: "agent",
      live: false,
      task: { description: "First" },
      state: { status: "done" },
      timing: { finishedAt: expect.any(String) },
      output: { available: true, finalAvailable: true },
      outputRef: { runId: first.runId, view: "output" },
      diagnosticsRef: { runId: first.runId, view: "diagnostics" },
    });
    expect(batch.details.entries[2]).toMatchObject({ runId: "run_live_third", kind: "agent", live: true });
    expect(batch.details.nextCursor).toBeUndefined();

    // A genuinely non-empty runId AND runIds together is a real conflict.
    await expect(execute({ action: "inspect", runId: first.runId, runIds: [first.runId] })).rejects.toThrow(/either runId or runIds/i);
    // Single-entry runIds inspect supports output/diagnostics/final views without forcing the caller to switch to runId.
    const singleOutput = await execute({ action: "inspect", runIds: [first.runId], view: "output" });
    expect(singleOutput.content[0].text).toBe("answer");
    expect(singleOutput.details).toMatchObject({ runId: first.runId, view: "output" });
    // Multi-entry batch inspect stays summary-only.
    await expect(execute({ action: "inspect", runIds: [first.runId, second.runId], view: "output" })).rejects.toThrow(/summary/i);
    // Ownership is validated for every target before any page returns.
    await expect(execute({ action: "inspect", runIds: [first.runId, "run_unowned"] })).rejects.toThrow(/unknown|unavailable/i);
    await expect(execute({ action: "inspect", runIds: [] })).rejects.toThrow(/1-20/);
    await expect(execute({ action: "inspect", runIds: Array.from({ length: 21 }, (_, index) => `run_${index}`) })).rejects.toThrow(/1-20/);

    finishThird("done");
  });

  it("treats a blank runId or empty runIds as omitted rather than a conflict, matching the #62 forced-placeholder reproduction", async () => {
    const { execute, runsDirectory } = setup();
    const owned = await completedRecord(runsDirectory);

    // A downstream schema-conversion layer may present runId/runIds as both
    // required (#62); a model forced to fill in the one it means to omit
    // sends a blank string or empty array for it ("an empty runId did not
    // help" from the #62 reproduction). Neither should conflict with a
    // genuinely populated selector.
    const blankRunId = await execute({ action: "inspect", runId: "", runIds: [owned.runId] });
    expect(blankRunId.details.entries.map((entry: any) => entry.runId)).toEqual([owned.runId]);

    // A whitespace-only placeholder is just as much "not a real run ID" as
    // an empty string, so it is normalized the same way.
    const whitespaceRunId = await execute({ action: "inspect", runId: "   ", runIds: [owned.runId] });
    expect(whitespaceRunId.details.entries.map((entry: any) => entry.runId)).toEqual([owned.runId]);

    const emptyRunIds = await execute({ action: "inspect", runId: owned.runId, runIds: [], view: "output" });
    expect(emptyRunIds.details).toMatchObject({ runId: owned.runId, view: "output" });

    // Never guess a cancellation target when both selectors are supplied.
    await expect(execute({ action: "cancel", runId: owned.runId, runIds: [owned.runId] })).rejects.toThrow(/either runId or runIds/);

    // cancel accepts the unified runIds list selector (singleton) and rejects multi-target cancel.
    await expect(execute({ action: "cancel", runIds: [owned.runId] })).resolves.toMatchObject({ details: { status: "terminal" } });
    await expect(execute({ action: "cancel", runIds: [owned.runId, "run_extra"] })).rejects.toThrow(/one run at a time/i);

    // Both blank at once still surfaces the batch-empty error, since no
    // target was actually provided either way.
    await expect(execute({ action: "inspect", runId: "", runIds: [] })).rejects.toThrow(/1-20/);
  });

  it("paginates a small batch limitBytes one target at a time without dropping any target, bounding the FULL returned text (entries wrapper and nextCursor, not just entry sizes) including under multi-byte UTF-8, and fails actionably rather than overflowing or returning a non-advancing empty page when even one entry cannot fit", async () => {
    const { execute, runsDirectory } = setup();
    // Multi-byte descriptions make Buffer.byteLength meaningfully diverge
    // from string .length, so a byte-based bound that was accidentally
    // checking character length (or only the entries array, not the full
    // wrapper+cursor envelope) would be caught here. The identical
    // description on every record keeps each compact entry's own byte size
    // equal, so a limitBytes derived from the first entry's boundary also
    // holds for the second and third pages below.
    const utf8Description = "Rêviéw 🧭 análysis summáry";
    const first = await completedRecord(runsDirectory, { description: utf8Description });
    const second = await completedRecord(runsDirectory, { description: utf8Description });
    const third = await completedRecord(runsDirectory, { description: utf8Description });
    const runIds = [first.runId, second.runId, third.runId];

    // Find the exact minimal limitBytes at which the full 3-target request
    // can serve its first page (one entry plus the {entries, nextCursor}
    // envelope) rather than throwing — i.e. the real boundary a caller would
    // hit, derived from the tool's actual behavior rather than a guessed
    // constant that could drift from the real envelope/cursor overhead.
    let lo = 4;
    let hi = 16384;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      try {
        const probe = await execute({ action: "inspect", runIds, limitBytes: mid });
        if (probe.details.entries.length >= 1) hi = mid; else lo = mid + 1;
      } catch {
        lo = mid + 1;
      }
    }
    const limitBytes = lo;

    // Below the boundary: no entry fits even with the envelope. Must fail
    // actionably (naming the run and how to proceed) rather than silently
    // omitting the target or returning a zero-entry, non-advancing page.
    await expect(execute({ action: "inspect", runIds, limitBytes: limitBytes - 1 }))
      .rejects.toThrow(new RegExp(`${first.runId}.*limitBytes.*envelope.*increase limitBytes or inspect`, "i"));

    // At and above the boundary: normal one-entry-per-page pagination, and
    // the ACTUAL serialized response text — not merely the entries array —
    // never exceeds the caller's own byte budget.
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await execute({ action: "inspect", runIds, limitBytes, cursor });
      expect(page.details.entries.length).toBe(1);
      const expectedText = JSON.stringify({ entries: page.details.entries, ...(page.details.nextCursor ? { nextCursor: page.details.nextCursor } : {}) });
      expect(page.content[0].text).toBe(expectedText);
      expect(Buffer.byteLength(page.content[0].text)).toBeLessThanOrEqual(limitBytes);
      seen.push(page.details.entries[0].runId);
      cursor = page.details.nextCursor;
      pages++;
    } while (cursor);
    expect(seen).toEqual(runIds);
    expect(pages).toBe(3);

    // A cursor for a different target set is rejected rather than silently reused.
    const firstPage = await execute({ action: "inspect", runIds, limitBytes });
    await expect(execute({ action: "inspect", runIds: [first.runId, second.runId], limitBytes, cursor: firstPage.details.nextCursor }))
      .rejects.toThrow(/does not match the requested run ids/i);
  });

  it("waits for one/any/all outcomes, returns workflow failure early, and repeats terminal waits immediately", async () => {
    const { execute, registry } = setup();
    let finishOne!: (value: string) => void;
    let finishTwo!: (value: string) => void;
    let failWorkflow!: (error: Error) => void;
    const one = registry.start({ runId: "run_one", kind: "agent", sessionId: "session-a", project: "/project", run: () => new Promise((resolve) => { finishOne = resolve; }) });
    registry.start({ runId: "run_two", kind: "agent", sessionId: "session-a", project: "/project", run: () => new Promise((resolve) => { finishTwo = resolve; }) });
    registry.start({ runId: "wf_failed", kind: "workflow", sessionId: "session-a", project: "/project", run: () => new Promise((_resolve, reject) => { failWorkflow = reject; }) });

    const anyWait = execute({ action: "wait", runIds: ["run_one", "run_two"], mode: "any" });
    finishOne("one");
    await expect(anyWait).resolves.toMatchObject({ details: { outcomes: [{ runId: "run_one", status: "done", outcome: "succeeded" }], pending: ["run_two"] } });
    await expect(execute({ action: "wait", runIds: ["run_one"] })).resolves.toMatchObject({ details: { outcomes: [{ runId: "run_one" }], pending: [] } });

    const allWait = execute({ action: "wait", runIds: ["wf_failed", "run_two"], mode: "all" });
    failWorkflow(new Error("workflow failed"));
    await expect(allWait).resolves.toMatchObject({ details: { outcomes: [{ runId: "wf_failed", status: "error" }], pending: ["run_two"] } });
    finishTwo("two");
    await Promise.allSettled([one.result]);
  });

  it("spends one shared result budget across every settled outcome in a wait response — complete text when it fits, truncated with continuation refs when it does not", async () => {
    const { execute, registry } = setup();
    const first = registry.start({ runId: "run_first", kind: "agent", sessionId: "session-a", project: "/project", run: async () => "A".repeat(50) });
    const second = registry.start({ runId: "run_second", kind: "agent", sessionId: "session-a", project: "/project", run: async () => "B".repeat(100) });
    await Promise.all([first.result, second.result]);

    const waited = await execute({ action: "wait", runIds: ["run_first", "run_second"], limitBytes: 80 });
    const outcomes = (waited as any).details.outcomes;
    expect(outcomes[0]).toMatchObject({ runId: "run_first", result: "A".repeat(50), resultTruncated: false });
    expect(outcomes[1]).toMatchObject({
      runId: "run_second",
      result: "B".repeat(30),
      resultTruncated: true,
      outputRef: { runId: "run_second", view: "output" },
      diagnosticsRef: { runId: "run_second", view: "diagnostics" },
    });
  });

  it("never reads a target's evidence from disk once the shared wait budget is already exhausted", async () => {
    const { execute, runsDirectory } = setup();
    // Both records are durable-only (no live registry entry), so `wait`
    // resolves them through getRunRecord/terminalRecord, whose synthesized
    // outcome deliberately carries no in-memory `.result` — collecting their
    // text always requires an inspectRun (disk) read, the exact path that
    // must be skipped once the shared budget runs out.
    const first = await completedRecord(runsDirectory, { description: "First" });
    const second = await completedRecord(runsDirectory, { description: "Second" });
    const inspectRunSpy = vi.spyOn(runInspection, "inspectRun");

    // limitBytes is sized to fully consume "answer" (6 bytes) plus envelope
    // room, leaving nothing for a second read.
    const waited = await execute({ action: "wait", runIds: [first.runId, second.runId], limitBytes: 6 });
    const outcomes = (waited as any).details.outcomes;
    expect(outcomes[0]).toMatchObject({ runId: first.runId, result: "answer", resultTruncated: false });
    expect(outcomes[1]).toMatchObject({ runId: second.runId, resultTruncated: true });
    expect(outcomes[1].result).toBeUndefined();
    // Exactly one disk read: the first target, which still had budget. The
    // second target's evidence was never touched once the budget hit zero.
    expect(inspectRunSpy).toHaveBeenCalledTimes(1);
    expect(inspectRunSpy).toHaveBeenCalledWith(expect.objectContaining({ runId: first.runId }));
    inspectRunSpy.mockRestore();
  });

  it("spends the wait budget in requested order, not settlement order — the same targets and final states spend the budget identically regardless of which one raced to settle first", async () => {
    const { execute, registry } = setup();
    let finishA!: (value: string) => void;
    let finishB!: (value: string) => void;
    registry.start({ runId: "run_ordered_a", kind: "agent", sessionId: "session-a", project: "/project", run: () => new Promise<string>((resolve) => { finishA = resolve; }) });
    registry.start({ runId: "run_ordered_b", kind: "agent", sessionId: "session-a", project: "/project", run: () => new Promise<string>((resolve) => { finishB = resolve; }) });

    const waited = execute({ action: "wait", runIds: ["run_ordered_a", "run_ordered_b"], limitBytes: 60 });
    // "b" (requested second) settles first, and with a longer result than
    // "a" — a settlement-order spend would give "b" first claim on the
    // budget instead of "a".
    finishB("B".repeat(50));
    await new Promise((resolve) => setTimeout(resolve, 20));
    finishA("A".repeat(50));
    const outcomes = (await waited as any).details.outcomes;
    // Requested order preserved regardless of settlement race: run_ordered_a
    // is spent first and gets the full budget it fits in.
    expect(outcomes[0]).toMatchObject({ runId: "run_ordered_a", result: "A".repeat(50), resultTruncated: false });
    expect(outcomes[1]).toMatchObject({ runId: "run_ordered_b", result: "B".repeat(10), resultTruncated: true });
  });

  it("emits bounded live progress via onUpdate while waiting, identifying watched targets, and stops updating once the wait settles without cancelling the watched work", async () => {
    const { registry, tool, ctx } = setup();
    let finish!: (value: string) => void;
    const running = registry.start({ runId: "run_slow", kind: "agent", sessionId: "session-a", project: "/project", run: () => new Promise<string>((resolve) => { finish = resolve; }) });
    registry.update("run_slow", { status: "running", description: "Slow task", lastActivityAt: Date.now(), activity: ["step one"] });

    const updates: Array<{ details: Record<string, unknown> }> = [];
    const waitPromise = tool.execute("call-wait", { action: "wait", runIds: ["run_slow"] }, undefined, (partial: { details: Record<string, unknown> }) => updates.push(partial), ctx);

    // First update is emitted immediately once targets resolve, before any heartbeat tick.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(updates.length).toBeGreaterThanOrEqual(1);
    expect(updates[0]!.details).toMatchObject({ action: "wait", mode: "all", live: true, pending: ["run_slow"] });
    expect((updates[0]!.details.targets as Array<Record<string, unknown>>)[0]).toMatchObject({ runId: "run_slow", status: "running", description: "Slow task" });

    // Bounded heartbeat: more than one update arrives while genuinely waiting,
    // without the watcher ever cancelling or restarting the watched run.
    await new Promise((resolve) => setTimeout(resolve, 250));
    const countBeforeSettlement = updates.length;
    expect(countBeforeSettlement).toBeGreaterThan(1);
    expect(registry.get("run_slow")?.state).toBe("running");

    finish("done");
    await waitPromise;
    const countAtSettlement = updates.length;

    // No further updates after settlement — the heartbeat is torn down, not
    // merely slowed.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(updates.length).toBe(countAtSettlement);
    await running.result;
  });

  it("interrupts a wait without cancelling work and validates every target before subscribing", async () => {
    const { execute, registry } = setup();
    let finish!: (value: string) => void;
    const running = registry.start({ runId: "run_live", kind: "agent", sessionId: "session-a", project: "/project", run: () => new Promise((resolve) => { finish = resolve; }) });
    const controller = new AbortController();
    const waiting = execute({ action: "wait", runIds: ["run_live"], mode: "all" }, controller.signal);
    controller.abort();
    await expect(waiting).rejects.toThrow(/wait aborted/i);
    expect(registry.get("run_live")?.state).toBe("running");
    await expect(execute({ action: "wait", runIds: ["run_live", "run_unknown"], mode: "all" })).rejects.toThrow(/unknown|unavailable/i);
    expect(registry.get("run_live")?.state).toBe("running");
    finish("done");
    await running.result;
  });

  it("merges live direct runs before evidence exists and marks ownerless incomplete history uncertain", async () => {
    const { execute, registry, runsDirectory } = setup();
    const live = registry.start({
      runId: "run_live_only",
      kind: "agent",
      sessionId: "session-a",
      project: "/project",
      run: (signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("stopped")), { once: true })),
    });
    registry.update("run_live_only", { description: "Queued live", status: "running", queuedAt: 123, processStartedAt: 234, lastActivityAt: 345, activity: [], activityCount: 1, assistantOutput: { status: "preliminary", messages: [{ text: "latest partial" }] } });
    const incomplete = createRunRecord({ directory: runsDirectory, metadata: { parentSessionId: "session-a", project: "/project", description: "Lost owner" } });
    await incomplete.event("queued");
    const workflowChild = registry.start({
      runId: "run_workflow_child",
      kind: "agent",
      sessionId: "session-a",
      project: "/project",
      workflowRunId: "wf_target",
      run: (signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("stopped")), { once: true })),
    });

    const listed = await execute({ action: "list" });
    expect(listed.details.runs).toEqual(expect.arrayContaining([
      expect.objectContaining({ runId: "run_live_only", status: "running", live: true }),
      expect.objectContaining({ runId: incomplete.runId, status: "interrupted_or_uncertain", live: false }),
    ]));
    expect(listed.details.runs.find((run: any) => run.runId === incomplete.runId)).not.toHaveProperty("settledAt");
    const inspected = await execute({ action: "inspect", runId: "run_live_only", view: "summary" });
    expect(inspected.content[0].text).toContain("Queued live");
    expect(JSON.parse(inspected.content[0].text).state).toMatchObject({ processStartedAt: 234, lastActivityAt: 345, activityCount: 1 });
    const output = await execute({ action: "inspect", runId: "run_live_only", view: "output" });
    expect(output.content[0].text).toContain("latest partial");
    expect((await execute({ action: "list", workflowRunId: "wf_target" })).details.runs.map((run: any) => run.runId)).toEqual(["run_workflow_child"]);

    registry.cancel("run_live_only");
    registry.cancel("run_workflow_child");
    await expect(live.result).rejects.toThrow("stopped");
    await expect(workflowChild.result).rejects.toThrow("stopped");
  });

  it("rejects stale live projection cursors after registry eviction", async () => {
    const { execute, registry, runsDirectory } = setup(1);
    const record = createRunRecord({ directory: runsDirectory, metadata: { parentSessionId: "session-a", project: "/project", description: "Durable description" } });
    let finish!: (value: string) => void;
    const live = registry.start({ runId: record.runId, kind: "agent", sessionId: "session-a", project: "/project", run: () => new Promise((resolve) => { finish = resolve; }) });
    registry.update(record.runId, { status: "running", description: "Live description differs", activity: [], activityCount: 0 });
    const first = await execute({ action: "inspect", runId: record.runId, view: "summary", limitBytes: 32 });
    expect(first.details.nextCursor).toEqual(expect.any(String));

    finish("done");
    await live.result;
    await record.finish({ status: "done", result: "done" });
    await registry.start({ runId: "run_evictor", kind: "agent", sessionId: "session-a", project: "/project", run: async () => "done" }).result;
    expect(registry.get(record.runId)).toBeUndefined();

    await expect(execute({ action: "inspect", runId: record.runId, view: "summary", limitBytes: 32, cursor: first.details.nextCursor }))
      .rejects.toThrow(/run changed.*restart inspection/i);
  });

  it("cancels only current-session live targets and reports already-terminal work accurately", async () => {
    const { execute, registry, runsDirectory } = setup();
    const terminal = await completedRecord(runsDirectory);
    const live = registry.start({
      runId: "run_cancel",
      kind: "agent",
      sessionId: "session-a",
      project: "/project",
      run: (signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("stopped")), { once: true })),
    });
    registry.start({ runId: "run_other", kind: "agent", sessionId: "session-b", project: "/project", run: () => new Promise(() => {}) });

    await expect(execute({ action: "cancel", runId: "run_cancel", reason: "stop now" })).resolves.toMatchObject({ details: { status: "requested" } });
    await expect(live.result).rejects.toThrow("stopped");
    await expect(execute({ action: "wait", runIds: ["run_cancel"] })).resolves.toMatchObject({ details: { outcomes: [{ outcome: "cancelled", error: "stop now" }] } });
    await expect(execute({ action: "cancel", runId: terminal.runId })).resolves.toMatchObject({ details: { status: "terminal" } });
    await expect(execute({ action: "cancel", runId: "run_other" })).rejects.toThrow(/unknown|unavailable/i);
  });

  it("keeps completed workflow IDs inspectable and waitable from their session journal", async () => {
    const { execute, runsDirectory } = setup();
    const identity = createWorkflowRunIdentity("script", null);
    const dir = getSessionWorkflowDir({ sessionManager: { getSessionDir: () => runsDirectory, getSessionId: () => "session-a" } })!;
    const journal = await createWorkflowJournalWriter({ dir, identity, name: "historical", source: "inline", project: "/project" });
    await journal.appendAgentResult({ index: 1, fingerprint: "x", result: "child", label: "child", subagentType: "codex-worker", prompt: "secret prompt", cached: false, failed: false, runId: "run_child" });
    for (let index = 2; index <= 60; index++) {
      await journal.appendAgentResult({ index, fingerprint: `x${index}`, result: `child ${index}`, label: `child ${index}`, subagentType: "codex-worker", prompt: "secret prompt", cached: true, failed: false, runId: `run_child_${index}` });
    }
    await journal.complete({ answer: 42 });

    const secondIdentity = createWorkflowRunIdentity("second script", null);
    const second = await createWorkflowJournalWriter({ dir, identity: secondIdentity, name: "second", source: "inline", project: "/project" });
    await second.complete("second");

    const listed = await execute({ action: "list", limit: 1 });
    expect(listed.details.workflows).toHaveLength(1);
    expect(listed.details.nextWorkflowCursor).toEqual(expect.any(String));
    const nextListed = await execute({ action: "list", limit: 1, workflowCursor: listed.details.nextWorkflowCursor });
    expect(new Set([...listed.details.workflows, ...nextListed.details.workflows].map((workflow: any) => workflow.runId))).toEqual(new Set([identity.runId, secondIdentity.runId]));
    const inspected = await execute({ action: "inspect", runId: identity.runId, view: "summary" });
    expect(inspected.content[0].text).not.toContain("secret prompt");
    expect(inspected.content[0].text).not.toContain('"answer":42');
    let childPages = "";
    let childCursor: string | undefined;
    do {
      const page = await execute({ action: "inspect", runId: identity.runId, view: "summary", limitBytes: 256, ...(childCursor ? { cursor: childCursor } : {}) });
      childPages += page.content[0].text;
      childCursor = page.details.nextCursor;
    } while (childCursor);
    expect(childPages).toContain("run_child_60");
    const output = await execute({ action: "inspect", runId: identity.runId, view: "output" });
    expect(output.content[0].text).toContain('"answer":42');
    const partial = await execute({ action: "inspect", runId: identity.runId, view: "output", limitBytes: 4 });
    await expect(execute({ action: "inspect", runId: identity.runId, view: "summary", cursor: partial.details.nextCursor })).rejects.toThrow(/cursor/i);
    await expect(execute({ action: "wait", runIds: [identity.runId] })).resolves.toMatchObject({ details: { outcomes: [{ runId: identity.runId, status: "done", outcome: "succeeded" }] } });

    const failedIdentity = createWorkflowRunIdentity("failed script", null);
    const failed = await createWorkflowJournalWriter({ dir, identity: failedIdentity, name: "failed", source: "inline", project: "/project" });
    await failed.fail("deadline exceeded", "timed_out");
    await expect(execute({ action: "wait", runIds: [failedIdentity.runId] })).resolves.toMatchObject({ details: { outcomes: [{ outcome: "timed_out", error: "deadline exceeded" }] } });

    const incompleteIdentity = createWorkflowRunIdentity("incomplete script", null);
    const incomplete = await createWorkflowJournalWriter({ dir, identity: incompleteIdentity, name: "incomplete", source: "inline", project: "/project" });
    await incomplete.appendAgentQueued({ index: 1, label: "orphan", subagentType: "codex-worker", prompt: "private", runRecord: { runId: "run_orphan" } as any });
    await incomplete.appendAgentQueued({ index: 2, label: "cleaned", subagentType: "codex-worker", prompt: "private", runRecord: { runId: "run_cleaned" } as any });
    await incomplete.appendAgentResult({
      index: 2,
      fingerprint: "cleanup",
      result: undefined,
      label: "cleaned",
      subagentType: "codex-worker",
      prompt: "private",
      cached: false,
      failed: true,
      runId: "run_cleaned",
      error: {
        runId: "run_cleaned",
        outcome: "cancelled",
        message: "fatal sibling cleanup",
        outputRef: { runId: "run_cleaned", view: "output" },
        diagnosticsRef: { runId: "run_cleaned", view: "diagnostics" },
      },
    });
    const interrupted = await execute({ action: "inspect", runId: incompleteIdentity.runId, view: "summary" });
    expect(JSON.parse(interrupted.content[0].text)).toMatchObject({
      state: { status: "interrupted_or_uncertain" },
      output: { status: "interrupted" },
      children: [
        { runId: "run_orphan", status: "interrupted_or_uncertain" },
        { runId: "run_cleaned", status: "aborted" },
      ],
    });
    await expect(execute({ action: "cancel", runId: incompleteIdentity.runId })).rejects.toThrow(/no longer live/i);
  });

  it("projects a workflow's verified final result via view: final, including a legitimate JSON null result, without falling into the diagnostics shape", async () => {
    const { execute, runsDirectory } = setup();
    const dir = getSessionWorkflowDir({ sessionManager: { getSessionDir: () => runsDirectory, getSessionId: () => "session-a" } })!;

    const nullResultIdentity = createWorkflowRunIdentity("null result script", null);
    const nullResultJournal = await createWorkflowJournalWriter({ dir, identity: nullResultIdentity, name: "null-result", source: "inline", project: "/project" });
    await nullResultJournal.complete(null);
    const nullFinal = await execute({ action: "inspect", runId: nullResultIdentity.runId, view: "final" });
    expect(JSON.parse(nullFinal.content[0].text)).toEqual({ runId: nullResultIdentity.runId, result: null, finalAvailable: true });

    const objectResultIdentity = createWorkflowRunIdentity("object result script", null);
    const objectResultJournal = await createWorkflowJournalWriter({ dir, identity: objectResultIdentity, name: "object-result", source: "inline", project: "/project" });
    await objectResultJournal.complete({ answer: 42 });
    const objectFinal = await execute({ action: "inspect", runId: objectResultIdentity.runId, view: "final" });
    expect(JSON.parse(objectFinal.content[0].text)).toEqual({ runId: objectResultIdentity.runId, result: { answer: 42 }, finalAvailable: true });

    // A failed workflow must not promote its status/error through the final
    // view (that shape belongs to the diagnostics branch, not final): an
    // unavailable final answer is a bounded EMPTY page with
    // finalAvailable:false — the tool's projection stays narration-free
    // (a human-readable explanation is the UI layer's job, not this tool's,
    // and is covered separately in test/external-command.test.ts) — never
    // raw JSON or the diagnostics {status,error} shape a caller could
    // mistake for a legitimate result.
    const failedIdentity = createWorkflowRunIdentity("failed final script", null);
    const failedJournal = await createWorkflowJournalWriter({ dir, identity: failedIdentity, name: "failed-final", source: "inline", project: "/project" });
    await failedJournal.fail("deadline exceeded", "timed_out");
    const failedFinal = await execute({ action: "inspect", runId: failedIdentity.runId, view: "final" });
    expect(failedFinal.content[0].text).toBe("");
    expect(failedFinal.details).toMatchObject({ runId: failedIdentity.runId, finalAvailable: false, status: "error" });
  });

  it("returns a consistent nested task/state/timing/output shape for live and durable agent AND workflow batch entries alike, omitting a workflow's unbounded children", async () => {
    const { execute, registry, runsDirectory } = setup();
    const dir = getSessionWorkflowDir({ sessionManager: { getSessionDir: () => runsDirectory, getSessionId: () => "session-a" } })!;

    const doneAgent = await completedRecord(runsDirectory, { description: "Durable agent" });
    let finishLiveAgent!: (value: string) => void;
    registry.start({
      runId: "run_live_batch",
      kind: "agent",
      sessionId: "session-a",
      project: "/project",
      run: () => new Promise((resolve) => { finishLiveAgent = resolve; }),
    });

    const historicalIdentity = createWorkflowRunIdentity("historical batch script", null);
    const historicalJournal = await createWorkflowJournalWriter({ dir, identity: historicalIdentity, name: "historical-batch", source: "inline", project: "/project" });
    for (let index = 1; index <= 5; index++) {
      await historicalJournal.appendAgentQueued({ index, label: `child ${index}`, subagentType: "codex-worker", prompt: "private", runRecord: { runId: `run_hidden_${index}` } as any });
    }
    await historicalJournal.complete("historical done");

    let finishLiveWorkflow!: (value: unknown) => void;
    registry.start({
      runId: "wf_live_batch",
      kind: "workflow",
      sessionId: "session-a",
      project: "/project",
      run: () => new Promise((resolve) => { finishLiveWorkflow = resolve; }),
      outcome: (value) => ({ status: "done", outcome: "succeeded", result: value }),
    });
    registry.update("wf_live_batch", {
      name: "live workflow",
      source: "inline",
      agentCount: 3,
      agents: Array.from({ length: 3 }, (_, index) => ({ externalRunId: `run_hidden_live_${index}`, label: `live ${index}`, status: "done" })),
    });

    const runIds = [doneAgent.runId, "run_live_batch", historicalIdentity.runId, "wf_live_batch"];
    const batch = await execute({ action: "inspect", runIds });
    expect(batch.details.entries).toHaveLength(4);
    // Same top-level key set across live agent, durable agent, live workflow,
    // and durable workflow entries alike — never historicalAgent's raw flat
    // RunRecordListItem shape, never a workflow's unbounded children array.
    const keysets = batch.details.entries.map((entry: any) => Object.keys(entry).sort().join(","));
    expect(new Set(keysets).size).toBe(1);
    for (const entry of batch.details.entries) expect(entry).not.toHaveProperty("children");
    expect(batch.details.entries.find((entry: any) => entry.runId === historicalIdentity.runId)).toMatchObject({
      kind: "workflow", live: false, state: { status: "done" }, output: { finalAvailable: true },
    });
    expect(batch.details.entries.find((entry: any) => entry.runId === "wf_live_batch")).toMatchObject({
      kind: "workflow", live: true, task: { name: "live workflow", source: "inline" },
    });

    finishLiveAgent("done");
    finishLiveWorkflow("done");
  });

  it("rejects an unresolvable wf_... ID as unknown/unavailable rather than falling through to the agent-only durable reader", async () => {
    const { execute } = setup();
    const unknownWorkflowId = "wf_doesnotexist00000000000000000000";
    await expect(execute({ action: "inspect", runId: unknownWorkflowId, view: "summary" })).rejects.toThrow(/unknown or unavailable/i);
    await expect(execute({ action: "cancel", runId: unknownWorkflowId })).rejects.toThrow(/unknown or unavailable/i);
    await expect(execute({ action: "wait", runIds: [unknownWorkflowId] })).rejects.toThrow(/unknown or unavailable/i);
    await expect(execute({ action: "inspect", runIds: [unknownWorkflowId] })).rejects.toThrow(/unknown or unavailable/i);
  });

  it("prioritizes the registry's settled outcome status over a stale observation.status", async () => {
    const { execute, registry } = setup();
    let resolveRun!: (value: string) => void;
    const handle = registry.start({
      runId: "run_stale_obs",
      kind: "agent",
      sessionId: "session-a",
      project: "/project",
      run: () => new Promise((resolve) => { resolveRun = resolve; }),
      outcome: () => ({ status: "done", outcome: "succeeded", result: "answer" }),
    });
    // Simulate an observation left behind mid-run (e.g. a caller whose final
    // progress update races behind settle()) that is never refreshed to
    // "done" before the run settles.
    registry.update("run_stale_obs", { status: "running", description: "Working" });
    resolveRun("answer");
    await handle.result;

    const listed = await execute({ action: "list" });
    expect(listed.details.runs.find((run: any) => run.runId === "run_stale_obs")).toMatchObject({ status: "done", outcome: "succeeded" });
    const inspected = await execute({ action: "inspect", runId: "run_stale_obs", view: "summary" });
    expect(JSON.parse(inspected.content[0].text).state.status).toBe("done");
  });

  it("rejects a batch cursor replayed under a different session/project scope", async () => {
    const { execute, runsDirectory } = setup();
    const first = await completedRecord(runsDirectory, { description: "First" });
    const second = await completedRecord(runsDirectory, { description: "Second" });
    const page = await execute({ action: "inspect", runIds: [first.runId, second.runId], limitBytes: 900 });
    expect(page.details.nextCursor).toEqual(expect.any(String));

    const otherTool = createExternalRunsTool({ registry: new RunRegistry(), runsDirectory: () => runsDirectory }) as any;
    const otherCtx = { cwd: "/project", sessionManager: { isPersisted: () => true, getSessionDir: () => runsDirectory, getSessionId: () => "session-other" } };
    await expect(otherTool.execute(
      "x",
      { action: "inspect", runIds: [first.runId, second.runId], limitBytes: 900, cursor: page.details.nextCursor },
      undefined,
      undefined,
      otherCtx,
    )).rejects.toThrow(/unknown or unavailable/i);
  });
});
