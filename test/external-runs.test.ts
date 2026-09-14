import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRunRecord } from "../src/core/run-record.ts";
import { RunRegistry } from "../src/core/run-registry.ts";
import { createExternalRunsTool } from "../src/external-runs.ts";
import { createWorkflowJournalWriter, createWorkflowRunIdentity, getSessionWorkflowDir } from "../src/workflow/journal.ts";

describe("external_runs", () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  function setup() {
    const runsDirectory = mkdtempSync(join(tmpdir(), "external-runs-"));
    directories.push(runsDirectory);
    const registry = new RunRegistry();
    const tool = createExternalRunsTool({ registry, runsDirectory: () => runsDirectory }) as any;
    const ctx = { cwd: "/project", sessionManager: { isPersisted: () => true, getSessionDir: () => runsDirectory, getSessionId: () => "session-a" } } as any;
    const execute = (params: Record<string, unknown>, signal?: AbortSignal) => tool.execute("external-runs", params, signal, undefined, ctx);
    return { execute, registry, runsDirectory, tool };
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

    const inspected = await execute({ action: "inspect", runId: owned.runId, view: "output", limitBytes: 4 });
    expect(inspected.content[0].text).toContain("answ");
    expect(inspected.details).toMatchObject({ runId: owned.runId, view: "output", nextCursor: expect.any(String) });
    await expect(execute({ action: "inspect", runId: "../summary.json", view: "summary" })).rejects.toThrow(/run id/i);
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
    await expect(anyWait).resolves.toMatchObject({ details: { outcomes: [{ runId: "run_one", status: "done" }], pending: ["run_two"] } });
    await expect(execute({ action: "wait", runIds: ["run_one"] })).resolves.toMatchObject({ details: { outcomes: [{ runId: "run_one" }], pending: [] } });

    const allWait = execute({ action: "wait", runIds: ["wf_failed", "run_two"], mode: "all" });
    failWorkflow(new Error("workflow failed"));
    await expect(allWait).resolves.toMatchObject({ details: { outcomes: [{ runId: "wf_failed", status: "error" }], pending: ["run_two"] } });
    finishTwo("two");
    await Promise.allSettled([one.result]);
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
    await expect(execute({ action: "cancel", runId: terminal.runId })).resolves.toMatchObject({ details: { status: "terminal" } });
    await expect(execute({ action: "cancel", runId: "run_other" })).rejects.toThrow(/unknown|unavailable/i);
  });

  it("keeps completed workflow IDs inspectable and waitable from their session journal", async () => {
    const { execute, runsDirectory } = setup();
    const identity = createWorkflowRunIdentity("script", null);
    const dir = getSessionWorkflowDir({ sessionManager: { getSessionDir: () => runsDirectory, getSessionId: () => "session-a" } })!;
    const journal = await createWorkflowJournalWriter({ dir, identity, name: "historical", source: "inline", project: "/project" });
    await journal.appendAgentResult({ index: 1, fingerprint: "x", result: "child", label: "child", subagentType: "codex-worker", prompt: "secret prompt", cached: false, failed: false, runId: "run_child" });
    await journal.complete({ answer: 42 });

    const listed = await execute({ action: "list" });
    expect(listed.details.workflows).toEqual(expect.arrayContaining([expect.objectContaining({ runId: identity.runId, state: expect.objectContaining({ status: "done" }) })]));
    const inspected = await execute({ action: "inspect", runId: identity.runId, view: "summary" });
    expect(inspected.content[0].text).not.toContain("secret prompt");
    expect(inspected.content[0].text).not.toContain('"answer":42');
    const output = await execute({ action: "inspect", runId: identity.runId, view: "output" });
    expect(output.content[0].text).toContain('"answer":42');
    const partial = await execute({ action: "inspect", runId: identity.runId, view: "output", limitBytes: 4 });
    await expect(execute({ action: "inspect", runId: identity.runId, view: "summary", cursor: partial.details.nextCursor })).rejects.toThrow(/cursor/i);
    await expect(execute({ action: "wait", runIds: [identity.runId] })).resolves.toMatchObject({ details: { outcomes: [{ runId: identity.runId, status: "done" }] } });
  });
});
