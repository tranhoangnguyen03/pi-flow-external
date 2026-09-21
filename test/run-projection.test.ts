import { describe, expect, it } from "vitest";
import { normalizeRunStatus, projectDurableAgent } from "../src/core/run-projection.ts";
import type { RunRecordListItem } from "../src/core/run-inspection.ts";

describe("run-projection", () => {
  it("normalizes the legacy workflow 'completed' lifecycle word to the Agent vocabulary, leaving other words untouched", () => {
    expect(normalizeRunStatus("completed")).toBe("done");
    expect(normalizeRunStatus("running")).toBe("running");
    expect(normalizeRunStatus("error")).toBe("error");
    expect(normalizeRunStatus("aborted")).toBe("aborted");
  });

  it("builds the same nested task/state/timing/output shape for a durable agent as a live one, while preserving flat fields for existing list consumers", () => {
    const durable: RunRecordListItem = {
      runId: "run_abc",
      queuedAt: "2026-01-01T00:00:00.000Z",
      status: "done",
      outcome: "succeeded",
      settledAt: 12345,
      description: "Review the diff",
      backend: "codex",
      project: "/repo",
      parentSessionId: "session-a",
      outputAvailable: true,
      finalAvailable: true,
      timing: { queuedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:01:00.000Z" },
      integrity: "complete",
    };

    const projection = projectDurableAgent(durable);

    expect(projection).toMatchObject({
      runId: "run_abc",
      kind: "agent",
      live: false,
      task: { description: "Review the diff", backend: "codex", project: "/repo", parentSessionId: "session-a" },
      state: { status: "done", outcome: "succeeded", settledAt: 12345 },
      output: { available: true, finalAvailable: true },
    });
    expect(projection.timing).toBe(durable.timing);
  });

  it("marks an incomplete durable record's projected state as interrupted_or_uncertain rather than trusting its raw status", () => {
    const durable: RunRecordListItem = {
      runId: "run_orphan",
      status: "running",
      outputAvailable: false,
      finalAvailable: false,
      timing: {},
      integrity: "incomplete",
    };

    expect(projectDurableAgent(durable).state.status).toBe("interrupted_or_uncertain");
  });
});
