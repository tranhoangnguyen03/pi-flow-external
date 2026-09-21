import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RunRegistry } from "../src/core/run-registry.ts";
import { createExternalRunsTool } from "../src/external-runs.ts";

/**
 * The authoritative cross-surface contract check for issue #52: the SAME
 * underlying run must report the same identity, status, and output facts
 * regardless of which `external_runs` surface reads it (list, single
 * inspect, batch inspect, wait), and a workflow's own child snapshot must
 * agree with what `external_runs` independently reports for that same child
 * runId. This does not re-test any single surface's own behavior (already
 * covered by external-runs.test.ts/workflow.test.ts) — it tests that they
 * cannot silently drift from each other, which a standalone per-surface or
 * per-renderer test cannot catch.
 */
describe("cross-surface run contract", () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  function setup() {
    const runsDirectory = mkdtempSync(join(tmpdir(), "run-contract-"));
    directories.push(runsDirectory);
    const registry = new RunRegistry();
    const tool = createExternalRunsTool({ registry, runsDirectory: () => runsDirectory }) as any;
    const ctx = { cwd: "/project", sessionManager: { isPersisted: () => true, getSessionDir: () => runsDirectory, getSessionId: () => "session-a" } } as any;
    const execute = (params: Record<string, unknown>, signal?: AbortSignal) => tool.execute("run-contract", params, signal, undefined, ctx);
    return { execute, registry, runsDirectory };
  }

  it("keeps identity (description/profile/harness), status, and output facts consistent for the same agent across list, single inspect, and batch inspect while running, and through wait once settled", async () => {
    const { execute, registry } = setup();
    let finish!: (value: string) => void;
    const running = registry.start({
      runId: "run_contract_agent",
      kind: "agent",
      sessionId: "session-a",
      project: "/project",
      run: () => new Promise<string>((resolve) => { finish = resolve; }),
    });
    // Mirrors exactly what pi-subagent.ts's own progress node carries: the
    // resolved profile name in `subagentType` and the explicitly persisted
    // `harness` — never a value the projection would have to reparse/guess.
    registry.update("run_contract_agent", {
      description: "Audit auth module",
      backend: "claude",
      subagentType: "claude-reviewer",
      harness: "claude",
      status: "running",
      queuedAt: Date.now() - 1_000,
      startedAt: Date.now() - 500,
      activity: ["Reading auth.ts"],
      activityCount: 1,
    });

    const listed = (await execute({ action: "list" })).details.runs.find((run: any) => run.runId === "run_contract_agent");
    const singleSummaryText = (await execute({ action: "inspect", runId: "run_contract_agent", view: "summary" })).content[0].text;
    const singleSummary = JSON.parse(singleSummaryText);
    const batch = (await execute({ action: "inspect", runIds: ["run_contract_agent"] })).details.entries[0];

    for (const projection of [listed, singleSummary, batch]) {
      expect(projection.runId).toBe("run_contract_agent");
      expect(projection.kind).toBe("agent");
      expect(projection.live).toBe(true);
      expect(projection.task).toMatchObject({
        description: "Audit auth module",
        backend: "claude",
        profile: "claude-reviewer",
        harness: "claude",
      });
      expect(projection.state.status).toBe("running");
      expect(projection.output.available).toBe(false);
      expect(projection.output.finalAvailable).toBe(false);
    }

    // Settle the run and confirm wait's outcome agrees on the same identity
    // facts and now-final output availability.
    finish("Audit complete: no issues found.");
    const waited = await execute({ action: "wait", runIds: ["run_contract_agent"] });
    expect((waited as any).details.outcomes[0]).toMatchObject({
      runId: "run_contract_agent",
      status: "done",
      outcome: "succeeded",
      result: "Audit complete: no issues found.",
      resultTruncated: false,
    });
    await running.result;

    const settledSingleSummary = JSON.parse((await execute({ action: "inspect", runId: "run_contract_agent", view: "summary" })).content[0].text);
    const settledBatch = (await execute({ action: "inspect", runIds: ["run_contract_agent"] })).details.entries[0];
    for (const projection of [settledSingleSummary, settledBatch]) {
      expect(projection.state.status).toBe("done");
      expect(projection.output.finalAvailable).toBe(true);
      // Identity survives settlement unchanged.
      expect(projection.task).toMatchObject({ profile: "claude-reviewer", harness: "claude" });
    }
  });

  it("keeps a workflow's own root identity/status facts consistent between list and single/batch inspect, and its child runId independently inspectable with matching facts", async () => {
    const { execute, registry } = setup();
    let finishWorkflow!: (value: unknown) => void;
    const workflow = registry.start({
      runId: "wf_contract",
      kind: "workflow",
      sessionId: "session-a",
      project: "/project",
      run: () => new Promise((resolve) => { finishWorkflow = resolve; }),
      outcome: (value) => ({ status: "done", outcome: "succeeded", result: value }),
    });
    registry.update("wf_contract", {
      name: "Review workflow",
      source: "inline",
      status: "running",
      agentCount: 1,
      agents: [{ index: 1, externalRunId: "run_contract_child", label: "Review diff", status: "running" }],
    });
    let finishChild!: (value: string) => void;
    const child = registry.start({
      runId: "run_contract_child",
      kind: "agent",
      sessionId: "session-a",
      project: "/project",
      workflowRunId: "wf_contract",
      run: () => new Promise<string>((resolve) => { finishChild = resolve; }),
    });
    registry.update("run_contract_child", {
      description: "Review diff",
      backend: "codex",
      subagentType: "codex-reviewer",
      harness: "codex",
      status: "running",
      activity: [],
      activityCount: 0,
    });

    const listedWorkflow = (await execute({ action: "list" })).details.workflows.find((wf: any) => wf.runId === "wf_contract");
    const batchWorkflow = (await execute({ action: "inspect", runIds: ["wf_contract"] })).details.entries[0];
    for (const projection of [listedWorkflow, batchWorkflow]) {
      expect(projection.kind).toBe("workflow");
      expect(projection.live).toBe(true);
      expect(projection.state.status).toBe("running");
      expect(projection.output.available).toBe(false);
    }
    // Batch stays a cheap, bounded projection: no unbounded children array.
    expect(batchWorkflow).not.toHaveProperty("children");
    // list's own workflow summary DOES carry a bounded children preview.
    expect(listedWorkflow.children).toEqual([{ runId: "run_contract_child", label: "Review diff", status: "running" }]);

    // The child is independently inspectable via its own runId, and its
    // reported identity matches exactly what the workflow's own roster says.
    const childBatch = (await execute({ action: "inspect", runIds: ["run_contract_child"] })).details.entries[0];
    expect(childBatch).toMatchObject({
      runId: "run_contract_child",
      kind: "agent",
      task: { description: "Review diff", backend: "codex", profile: "codex-reviewer", harness: "codex" },
      state: { status: "running" },
    });

    finishChild("Review complete.");
    await child.result;
    finishWorkflow({ summary: "done" });
    await workflow.result;

    const settledListedWorkflow = (await execute({ action: "list" })).details.workflows.find((wf: any) => wf.runId === "wf_contract");
    const settledBatchWorkflow = (await execute({ action: "inspect", runIds: ["wf_contract"] })).details.entries[0];
    for (const projection of [settledListedWorkflow, settledBatchWorkflow]) {
      expect(projection.state.status).toBe("done");
      expect(projection.output.finalAvailable).toBe(true);
    }
  });
});
