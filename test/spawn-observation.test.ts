import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createRunRecord } from "../src/core/run-record.ts";
import { describe, expect, it, vi } from "vitest";
import { agyActivityFromEvent } from "../src/core/agy.ts";
import { claudeActivityFromEvent } from "../src/core/claude.ts";
import { codexActivityFromEvent } from "../src/core/codex.ts";
import { getBackendAgentLabel } from "../src/core/display.ts";
import { grokActivityFromEvent } from "../src/core/grok.ts";
import { museActivityFromEvent } from "../src/core/muse.ts";
import { createProgressEmitter } from "../src/core/progress.ts";
import { hasNestedAgentActivity, spawnSubagent } from "../src/core/spawn.ts";

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

    expect(hasNestedAgentActivity({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "spawn_subagent" }] },
    }, "grok")).toBe(true);
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
    expect(hasNestedAgentActivity({
      type: "assistant",
      message: { content: [{ type: "text", text: "no tool use here" }] },
    }, "grok")).toBe(false);

    expect(hasNestedAgentActivity({
      payload_type: "task.lifecycle.proposed",
      payload: { event: { kind: "proposed", task_kind: "reminder.agent.skill-reminder" } },
    }, "muse")).toBe(false);
    // Never true for muse, even for a task_kind that looks like real
    // delegation: no confirmed real delegation event has ever been observed,
    // so speculative task_kind matching must not extend the nested timeout.
    expect(hasNestedAgentActivity({
      payload_type: "task.lifecycle.proposed",
      payload: { event: { kind: "proposed", task_kind: "agent.delegate" } },
    }, "muse")).toBe(false);
  });

  it("tracks child freshness without treating init or heartbeat as activity", async () => {
    expect(claudeActivityFromEvent({ type: "system", subtype: "init" })).toBeUndefined();
    expect(codexActivityFromEvent({ type: "thread.started" })).toBeUndefined();
    expect(agyActivityFromEvent({ event: "init" })).toBeUndefined();
    expect(grokActivityFromEvent({ type: "system", subtype: "init", session_id: "grok-sess" })).toBeUndefined();
    expect(museActivityFromEvent({ payload_type: "run.model.configured", payload: { provider_id: "meta" } })).toBeUndefined();

    vi.useFakeTimers();
    try {
      const emitter = createProgressEmitter({
        toolCallId: "freshness",
        description: "Freshness",
        subagentType: "codex-worker",
        backend: "codex",
        enabled: true,
        onProgress: () => undefined,
      });
      emitter.addActivity("read file");
      const observedAt = emitter.progress?.lastActivityAt;
      emitter.startHeartbeat();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(emitter.progress?.firstActivityAt).toBe(observedAt);
      expect(emitter.progress?.lastActivityAt).toBe(observedAt);
      emitter.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("labels grok and muse distinctly from the other external CLIs", () => {
    expect(getBackendAgentLabel("grok")).toBe("Grok CLI");
    expect(getBackendAgentLabel("muse")).toBe("Muse Code");
    expect(getBackendAgentLabel("claude")).toBe("Claude Code");
    expect(getBackendAgentLabel("codex")).toBe("Codex CLI");
    expect(getBackendAgentLabel("agy")).toBe("Antigravity");
  });
});

describe("spawn validation evidence", () => {
  it("finishes an unlaunched receipt when effort normalization rejects a value", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-flow-effort-"));
    try {
      for (const backend of ["agy", "grok", "muse", "claude", "codex"] as const) {
        const runRecord = createRunRecord({ directory, metadata: { backend } });
        const result = await spawnSubagent({
          toolCallId: "invalid-effort", description: "Invalid effort", prompt: "Do the task.",
          profile: { name: `${backend}-worker`, description: "x", backend, configVersion: 5 }, thinkingLevel: "typo",
          ctx: { cwd: directory } as ExtensionContext, signal: undefined, timeoutMs: 5000,
          progressEnabled: false, onProgress: undefined, onUsage: () => {}, permission: "danger", runRecord,
        });
        expect(result.details).toMatchObject({ status: "error", error: expect.stringMatching(/unsupported.*effort/i), runId: runRecord.runId });
        const summary = JSON.parse(await readFile(runRecord.summaryPath, "utf8"));
        expect(summary.summary).toMatchObject({ status: "error", backendStarted: false });
        expect(await readFile(runRecord.eventsPath, "utf8")).not.toContain("process_started");
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
