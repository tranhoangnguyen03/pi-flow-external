import { describe, expect, it } from "vitest";
import { applySubagentProgressToWorkflowAgent, applySubagentResultToWorkflowAgent } from "../src/core/agent-snapshot.ts";
import type { ResolvedCapabilities, SubagentProgressNode, SubagentToolDetails, WorkflowAgentSnapshot } from "../src/types.ts";

function baseAgent(): WorkflowAgentSnapshot {
  return { index: 1, label: "child", status: "queued", activity: [], activityCount: 0 };
}

function baseProgress(overrides: Partial<SubagentProgressNode> = {}): SubagentProgressNode {
  return {
    id: "call-1",
    description: "child",
    subagentType: "agy-worker",
    status: "running",
    startedAt: 100,
    activity: ["did a thing"],
    activityCount: 1,
    ...overrides,
  };
}

describe("workflow agent snapshot copy", () => {
  it("carries retry disclosure, requested-tier elevation, and thinking clamp from a finished child onto its workflow snapshot", () => {
    // Regression for a real data-loss bug: the previous inline copy in
    // workflow/tool.ts never forwarded retries/retryOf/permissionRequested/
    // thinkingClamped, so a workflow child that hit an agy retry or a
    // permission/thinking adjustment silently lost that disclosure the
    // moment it ran inside a workflow instead of as a direct Agent call.
    const agent = baseAgent();
    const resultDetails: SubagentToolDetails = {
      description: "child",
      subagentType: "agy-worker",
      backend: "agy",
      status: "done",
      result: "done",
      progress: baseProgress({ status: "done", endedAt: 200 }),
      retries: 1,
      retryOf: "agy transient failure",
      permission: "danger",
      permissionRequested: "edit",
      thinkingClamped: { requested: "high", effective: "medium" },
      sessionId: "session-123",
    };

    applySubagentResultToWorkflowAgent(agent, resultDetails);

    expect(agent.status).toBe("done");
    expect(agent.retries).toBe(1);
    expect(agent.retryOf).toBe("agy transient failure");
    expect(agent.permissionRequested).toBe("edit");
    expect(agent.thinkingClamped).toEqual({ requested: "high", effective: "medium" });
    expect(agent.sessionId).toBe("session-123");
  });

  it("carries a resolved capabilitySet selection from a finished child onto its workflow snapshot", () => {
    // Regression for issue #43 slice 2: this helper is the declared "single
    // source of truth" for copying a finished child's result onto its
    // snapshot row, but the workflow/tool.ts <> capabilities.ts merge
    // originally left `capabilities` off the copy list here, which would
    // have silently dropped the disclosed skill/prompt-template selection
    // for any caller that relies on this helper alone (not the separate
    // pre-launch disclosure step in workflow/tool.ts).
    const agent = baseAgent();
    const capabilities: ResolvedCapabilities = { set: "docs", skills: ["writer"], promptTemplates: [], contentHash: "a".repeat(64) };
    const resultDetails: SubagentToolDetails = {
      description: "child",
      subagentType: "pi-deepseek-docs",
      backend: "pi",
      status: "done",
      result: "done",
      progress: baseProgress({ status: "done", endedAt: 200 }),
      capabilities,
    };

    applySubagentResultToWorkflowAgent(agent, resultDetails);

    expect(agent.capabilities).toEqual(capabilities);
  });

  it("keeps the running-progress copy and the finished-result copy from drifting apart on which fields they carry", () => {
    const agent = baseAgent();
    const progress = baseProgress({ thinkingClamped: { requested: "high", effective: "low" } });

    applySubagentProgressToWorkflowAgent(agent, progress);

    expect(agent.status).toBe("running");
    expect(agent.activity).toEqual(["did a thing"]);
    expect(agent.thinkingClamped).toEqual({ requested: "high", effective: "low" });
  });
});
