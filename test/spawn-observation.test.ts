import { describe, expect, it } from "vitest";
import { hasNestedAgentActivity } from "../src/core/spawn.ts";

describe("external nested-agent observation", () => {
  it("recognizes known Claude, Codex, and Antigravity event shapes", () => {
    expect(hasNestedAgentActivity({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Agent" }] },
    })).toBe(true);

    expect(hasNestedAgentActivity({
      type: "item.completed",
      item: { type: "collab_tool_call", tool: "spawn_agent" },
    })).toBe(true);

    expect(hasNestedAgentActivity({
      event: "step_update",
      step_update: { step_type: "tool", tool_name: "spawn_agent" },
    })).toBe(true);

    expect(hasNestedAgentActivity({
      type: "item.completed",
      item: { type: "command_execution", command: "npm test" },
    })).toBe(false);
  });
});
