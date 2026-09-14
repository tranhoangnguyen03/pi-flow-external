import { describe, expect, it, vi } from "vitest";
import { RunRegistry } from "../src/core/run-registry.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("RunRegistry", () => {
  it("owns run lifetime, scoped cancellation, workflow association, and terminal settlement", async () => {
    const registry = new RunRegistry();
    const first = deferred<string>();
    const second = deferred<string>();
    const firstAbort = vi.fn();
    const secondAbort = vi.fn();

    const a = registry.start({
      runId: "run_a",
      kind: "agent",
      sessionId: "session-a",
      project: "/repo",
      workflowRunId: "wf_a",
      run: (signal) => {
        signal.addEventListener("abort", firstAbort, { once: true });
        return first.promise;
      },
    });
    const b = registry.start({
      runId: "run_b",
      kind: "agent",
      sessionId: "session-a",
      project: "/repo",
      run: (signal) => {
        signal.addEventListener("abort", secondAbort, { once: true });
        return second.promise;
      },
    });

    expect(registry.get("run_a")).toMatchObject({ state: "running", workflowRunId: "wf_a" });
    expect(registry.cancel("run_a", "stop one")).toBe("requested");
    expect(firstAbort).toHaveBeenCalledOnce();
    expect(secondAbort).not.toHaveBeenCalled();

    first.reject(new Error("stopped"));
    second.resolve("done");
    await expect(a.result).rejects.toThrow("stopped");
    await expect(b.result).resolves.toBe("done");
    expect(await a.terminal).toMatchObject({ runId: "run_a", status: "aborted", outcome: "cancelled", error: "stop one" });
    expect(await b.terminal).toMatchObject({ runId: "run_b", status: "done", outcome: "succeeded", result: "done" });
    expect(registry.cancel("run_b")).toBe("terminal");
  });

  it("unsubscribes an interrupted wait without cancelling work", async () => {
    const registry = new RunRegistry();
    const work = deferred<string>();
    const aborted = vi.fn();
    const run = registry.start({
      runId: "run_wait",
      kind: "agent",
      sessionId: "session-a",
      project: "/repo",
      run: (signal) => {
        signal.addEventListener("abort", aborted, { once: true });
        return work.promise;
      },
    });
    const waiting = new AbortController();
    const wait = registry.wait(["run_wait"], "all", waiting.signal);

    waiting.abort();
    await expect(wait).rejects.toThrow(/abort/i);
    expect(aborted).not.toHaveBeenCalled();

    work.resolve("finished later");
    await expect(run.result).resolves.toBe("finished later");
    expect((await registry.wait(["run_wait"], "any")).terminal).toHaveLength(1);
  });

  it("links blocking interruption but leaves background work independent", async () => {
    const registry = new RunRegistry();
    const blockingSignal = new AbortController();
    const blocking = registry.start({
      runId: "run_blocking",
      kind: "agent",
      sessionId: "session-a",
      project: "/repo",
      signal: blockingSignal.signal,
      run: (signal) => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("blocking aborted")), { once: true });
      }),
    });
    const background = deferred<string>();
    const backgroundRun = registry.start({
      runId: "run_background",
      kind: "agent",
      sessionId: "session-a",
      project: "/repo",
      run: () => background.promise,
    });

    blockingSignal.abort();
    await expect(blocking.result).rejects.toThrow(/blocking aborted/);
    expect(registry.get("run_background")?.state).toBe("running");
    background.resolve("survived");
    await expect(backgroundRun.result).resolves.toBe("survived");
  });

  it("cancels and drains only work owned by the shutting-down session", async () => {
    const registry = new RunRegistry();
    const settled: string[] = [];
    const start = (runId: string, sessionId: string) => registry.start({
      runId,
      kind: runId.startsWith("wf_") ? "workflow" as const : "agent" as const,
      sessionId,
      project: "/repo",
      run: (signal) => new Promise<string>((resolve) => {
        signal.addEventListener("abort", () => {
          settled.push(runId);
          resolve("drained");
        }, { once: true });
      }),
    });
    start("run_one", "session-a");
    start("wf_one", "session-a");
    const other = start("run_other", "session-b");

    await registry.shutdownSession("session-a", "session shutdown");

    expect(settled.sort()).toEqual(["run_one", "wf_one"]);
    expect(registry.get("run_other")?.state).toBe("running");
    registry.cancel("run_other");
    await other.result;
  });

  it("rejects a launch whose async preflight crossed session shutdown", async () => {
    const registry = new RunRegistry();
    const preflight = deferred<void>();
    const sessionVersion = registry.sessionVersion("session-a");
    const launch = (async () => {
      await preflight.promise;
      return registry.start({
        runId: "run_late",
        kind: "agent",
        sessionId: "session-a",
        sessionVersion,
        project: "/repo",
        run: async () => "too late",
      });
    })();

    await registry.shutdownSession("session-a");
    preflight.resolve();
    await expect(launch).rejects.toThrow(/session.*closed/i);
    expect(registry.get("run_late")).toBeUndefined();
  });

  it("bounds shutdown when child cleanup cannot confirm settlement", async () => {
    const registry = new RunRegistry(100, 10);
    registry.start({
      runId: "run_stuck",
      kind: "agent",
      sessionId: "session-a",
      project: "/repo",
      run: () => new Promise(() => {}),
    });

    await expect(registry.shutdownSession("session-a")).resolves.toEqual({ settled: [], pending: ["run_stuck"] });
    expect(registry.get("run_stuck")).toBeUndefined();
  });

  it("retains a classified timeout outcome separately from display status", async () => {
    const registry = new RunRegistry();
    const run = registry.start({
      runId: "run_timeout",
      kind: "agent",
      sessionId: "session-a",
      project: "/repo",
      run: async () => "timed out result",
      outcome: () => ({ status: "aborted", outcome: "timed_out", error: "deadline exceeded" }),
    });

    await run.result;
    const terminal = await run.terminal;
    expect(terminal).toMatchObject({ status: "aborted", outcome: "timed_out", error: "deadline exceeded" });
    expect(terminal).not.toHaveProperty("result");
  });
});
