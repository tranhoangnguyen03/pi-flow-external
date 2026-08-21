import { describe, expect, it } from "vitest";
import { hasNestedAgentActivity } from "../src/core/spawn.ts";

describe("external nested-agent observation", () => {
  it("recognizes known Claude, Codex, and Antigravity event shapes", () => {
    expect(hasNestedAgentActivity({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Agent" }] },
    }, "claude")).toBe(true);

    expect(hasNestedAgentActivity({
      type: "item.completed",
      item: { type: "collab_tool_call", tool: "spawn_agent" },
    }, "codex")).toBe(true);

    expect(hasNestedAgentActivity({
      event: "step_update",
      step_update: { step_type: "tool", tool_name: "spawn_agent" },
    }, "agy")).toBe(true);

    expect(hasNestedAgentActivity({
      event: "step_update",
      step_update: {
        step_type: "subagent",
        tool_name: "invoke_subagent",
        subagent_info: { subagents: [{ type_name: "research" }] },
      },
    }, "agy")).toBe(true);
  });

  it("ignores generic values and terminal structured output", () => {
    expect(hasNestedAgentActivity({ type: "agent" }, "claude")).toBe(false);
    expect(hasNestedAgentActivity({
      type: "item.completed",
      item: { type: "command_execution", name: "wait" },
    }, "codex")).toBe(false);
    expect(hasNestedAgentActivity({
      event: "result",
      result: { status: "SUCCESS", structured_output: { type: "agent" } },
    }, "agy")).toBe(false);
  });
});
