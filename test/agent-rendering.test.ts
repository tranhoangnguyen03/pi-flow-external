import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Component } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { createSubagentExtension } from "../src/pi-subagent.ts";
import type { SubagentToolDetails, WorkflowToolDetails } from "../src/types.ts";
import { setupPiSubagentTestHarness } from "./helpers/pi-subagent-harness.ts";

type RenderableTool = {
  renderCall?: (args: Record<string, unknown>, theme: never, context: Record<string, unknown>) => Component;
  renderResult?: (
    result: { content: Array<{ type: "text"; text: string }>; details: unknown },
    options: { expanded: boolean; isPartial: boolean },
    theme: never,
    context: Record<string, unknown>,
  ) => Component;
};

describe("delegation transparency rendering", () => {
  let cwd = "";
  let agentDir = "";
  const { makeMockTheme, renderToText } = setupPiSubagentTestHarness((state) => {
    cwd = state.cwd;
    agentDir = state.agentDir;
  });

  function captureTools(): RenderableTool[] {
    const tools: Array<RenderableTool & { name?: string }> = [];
    const flags = new Map<string, string | boolean>();
    createSubagentExtension()({
      registerTool: (tool: RenderableTool & { name?: string }) => tools.push(tool),
      registerCommand: () => {},
      registerFlag: (name: string, options: { default?: string | boolean }) => {
        if (options.default !== undefined) flags.set(name, options.default);
      },
      getFlag: (name: string) => flags.get(name),
      getThinkingLevel: () => "high",
      getAllTools: () => tools,
      on: () => {},
    } as never);
    return tools;
  }

  it("explains a direct delegation and links its expanded evidence receipt", () => {
    const profilesDir = join(agentDir, "subagents");
    mkdirSync(profilesDir, { recursive: true });
    const profilePath = join(profilesDir, "claude-explorer.md");
    writeFileSync(
      profilePath,
      "---\ndescription: Repository exploration through Claude Code.\nbackend: claude\n---\nExplore repositories read-only.\n",
    );
    const tool = captureTools().find((candidate) => (candidate as RenderableTool & { name?: string }).name === "Agent")!;
    const theme = makeMockTheme() as never;

    const callArgs = {
      description: "Map repository architecture",
      prompt: "Map the repository read-only.",
      subagent_type: "claude-explorer",
    };
    const callContext = { cwd, executionStarted: true, state: {} };
    const call = tool.renderCall?.(callArgs, theme, callContext);
    const callText = renderToText(call!);
    expect(callText).toContain("Delegating");
    expect(callText).toContain("Claude Code → claude-explorer");
    expect(callText).toContain("unsandboxed external CLI");
    expect(callText).toContain("Task Map repository architecture");
    expect(callText).toContain("Why Repository exploration through Claude Code.");
    expect(callText).toContain(`Workspace ${cwd}`);

    unlinkSync(profilePath);
    const cachedCall = tool.renderCall?.(callArgs, theme, callContext);
    expect(renderToText(cachedCall!)).toContain("Why Repository exploration through Claude Code.");

    const running: SubagentToolDetails = {
      description: "Map repository architecture",
      subagentType: "claude-explorer",
      backend: "claude",
      status: "running",
    };
    const live = tool.renderResult?.(
      { content: [{ type: "text", text: "running" }], details: running },
      { expanded: false, isPartial: true },
      theme,
      { cwd },
    );
    expect(renderToText(live!)).toContain("external host access");

    const details: SubagentToolDetails = {
      ...running,
      status: "done",
      result: "Architecture mapped.",
      runId: "claude_12345678",
      recordPath: "/tmp/pi-flow-runs/claude_12345678",
      backendEventCount: 17,
    };
    const receipt = tool.renderResult?.(
      { content: [{ type: "text", text: details.result! }], details },
      { expanded: true, isPartial: false },
      theme,
      { cwd },
    );
    const receiptText = renderToText(receipt!);
    expect(receiptText).toContain("evidence 12345678");
    expect(receiptText).toContain("Evidence /tmp/pi-flow-runs/claude_12345678");
    expect(receiptText).toContain("17 backend events");
    expect(receiptText).not.toContain("run 12345678");
  });

  it("states workflow access once and exposes terminal journal evidence on expansion", () => {
    const tool = captureTools().find((candidate) => (candidate as RenderableTool & { name?: string }).name === "workflow")!;
    const theme = makeMockTheme() as never;

    const call = tool.renderCall?.({ name: "architecture-review" }, theme, { cwd, executionStarted: true });
    expect(renderToText(call!)).toContain("unsandboxed external agents");

    const live: WorkflowToolDetails = {
      name: "architecture-review",
      status: "running",
      agentCount: 4,
      phases: [],
      agents: [
        { index: 1, label: "map", status: "done" },
        { index: 2, label: "review", status: "running" },
        { index: 3, label: "queued", status: "queued" },
        { index: 4, label: "failed", status: "error" },
      ],
      logs: [],
    };
    const liveComponent = tool.renderResult?.(
      { content: [{ type: "text", text: "running" }], details: live },
      { expanded: false, isPartial: true },
      theme,
      { cwd },
    );
    const liveText = renderToText(liveComponent!);
    expect(liveText).toContain("external host access");
    expect(liveText).toContain("1 done · 1 active · 1 queued · 1 failed / 4");

    const completed: WorkflowToolDetails = {
      ...live,
      status: "completed",
      agents: live.agents.map((agent) => ({ ...agent, status: agent.status === "error" ? "error" : "done" })),
      runId: "wf_12345678",
      journalPath: "/tmp/pi-flow-workflows/run-wf_12345678.jsonl",
    };
    const receipt = tool.renderResult?.(
      { content: [{ type: "text", text: "complete" }], details: completed },
      { expanded: true, isPartial: false },
      theme,
      { cwd },
    );
    const receiptText = renderToText(receipt!);
    expect(receiptText).toContain("Workflow evidence wf_12345678");
    expect(receiptText).toContain("Journal /tmp/pi-flow-workflows/run-wf_12345678.jsonl");
  });
});
