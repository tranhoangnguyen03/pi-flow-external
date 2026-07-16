import { describe, expect, it } from "vitest";
import { createWorkflowScriptWorker, type ParentToWorkerMessage, type WorkerToParentMessage } from "../src/workflow/script-worker.ts";
import type { WorkflowLimits } from "../src/workflow/types.ts";

const TEST_LIMITS: WorkflowLimits = {
  maxAgentCalls: 10,
  maxLogs: 10,
  maxLogLength: 1_000,
  workerHeartbeatIntervalMs: 1_000,
  workerStallTimeoutMs: 1_000,
  workerIdleTimeoutMs: 1_000,
  syncExecutionTimeoutMs: 1_000,
  workerMaxOldGenerationSizeMb: 64,
  workerMaxYoungGenerationSizeMb: 16,
  workerStackSizeMb: 4,
  abortGraceMs: 100,
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("createWorkflowScriptWorker", () => {
  it("does not emit a worker error for discarded late agent reactions", async () => {
    const worker = createWorkflowScriptWorker({
      body: "agent('a').then(() => agent('b')); return 'early';",
      metaName: "late-reaction",
      args: undefined,
      cwd: "/tmp",
      limits: TEST_LIMITS,
    });
    const workflowErrors: string[] = [];
    const workerErrors: Error[] = [];
    let repliedToFirstAgent = false;

    try {
      const intendedError = new Promise<void>((resolve) => {
        worker.on("message", (message: WorkerToParentMessage) => {
          if (message.type === "agent" && !repliedToFirstAgent) {
            repliedToFirstAgent = true;
            const reply: ParentToWorkerMessage = { type: "agentResult", id: message.id, ok: true, result: "a done" };
            worker.postMessage(reply);
          }
          if (message.type === "error") {
            workflowErrors.push(message.error);
            resolve();
          }
        });
      });
      worker.on("error", (error) => workerErrors.push(error));

      await intendedError;
      await delay(50);

      expect(repliedToFirstAgent).toBe(true);
      expect(workflowErrors).toContain("every started agent() call must be awaited before the workflow returns");
      expect(workerErrors.map((error) => error.message)).not.toContain("agent() cannot be called after the workflow body has returned");
      expect(workerErrors).toEqual([]);
    } finally {
      await worker.terminate();
    }
  });
});
