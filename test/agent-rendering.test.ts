import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Component } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { createSubagentExtension } from "../src/pi-subagent.ts";
import { buildCoordinatorPrompt } from "../src/prompts.ts";
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
      role: "explorer",
      harness: "claude",
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
    expect(callText).not.toContain("Context");
    const sharedCall = tool.renderCall?.({ ...callArgs, context: { mode: "recent", turns: 5 } }, theme, { ...callContext, state: {} });
    expect(renderToText(sharedCall!)).toContain("Context recent · up to 5 user turns");

    unlinkSync(profilePath);
    const cachedCall = tool.renderCall?.(callArgs, theme, callContext);
    expect(renderToText(cachedCall!)).toContain("Why Repository exploration through Claude Code.");

    const running: SubagentToolDetails = {
      description: "Map repository architecture",
      subagentType: "claude-explorer",
      backend: "claude",
      status: "running",
    };
    const progress = {
        id: "live",
        description: "Map repository architecture",
        subagentType: "claude-explorer",
        backend: "claude" as const,
        status: "running" as const,
        startedAt: Date.now() - 10_000,
        lastActivityAt: Date.now() - 5_000,
        activity: ["Reading source"],
        activityCount: 1,
      };
    const live = tool.renderResult?.(
      { content: [{ type: "text", text: "running" }], details: { ...running, progress } },
      { expanded: false, isPartial: true },
      theme,
      { cwd },
    );
    expect(renderToText(live!)).toContain("external host access");
    expect(renderToText(live!)).toMatch(/activity \d+s ago/);
    const sharedLive = tool.renderResult?.(
      { content: [{ type: "text", text: "running" }], details: { ...running, progress: { ...progress, context: { mode: "recent", requestedTurns: 5, sharedTurns: 2, messages: 6, bytes: 512, compacted: false } } } },
      { expanded: false, isPartial: true },
      theme,
      { cwd },
    );
    expect(renderToText(sharedLive!)).toContain("context recent 2/5 turns");

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
    expect(receiptText).toContain("Final output");
    expect(receiptText).toContain("Architecture mapped.");
    expect(receiptText).toContain("/external runs");
    expect(receiptText).toContain("claude_12345678");
  });

  it("discloses a pi-harness delegation as an in-process child, never as an external CLI", () => {
    mkdirSync(join(agentDir, "pi-flow-external"), { recursive: true });
    writeFileSync(
      join(agentDir, "pi-flow-external", "harnesses.json"),
      JSON.stringify({ version: 1, harnesses: { "pi-deepseek": { model: "deepseek/deepseek-chat", thinking: "high" } } }),
    );
    const tool = captureTools().find((candidate) => (candidate as RenderableTool & { name?: string }).name === "Agent")!;
    const theme = makeMockTheme() as never;

    const callArgs = {
      description: "Review a diff",
      prompt: "Review the diff read-only.",
      role: "reviewer",
      harness: "pi-deepseek",
    };
    const callContext = { cwd, executionStarted: true, state: {} };
    const call = tool.renderCall?.(callArgs, theme, callContext);
    const callText = renderToText(call!);
    expect(callText).toContain("Delegating");
    expect(callText).toContain("pi-deepseek-reviewer");
    expect(callText).toContain("Pi SDK child");
    expect(callText).not.toContain("external CLI");
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
      agents: [
        ...live.agents.map((agent) => ({ ...agent, status: agent.status === "error" ? "error" as const : "done" as const })),
        ...Array.from({ length: 4 }, (_, index) => ({ index: index + 5, label: `extra-${index + 5}`, status: "done" as const })),
      ],
      runId: "wf_12345678",
      journalPath: "/tmp/pi-flow-workflows/run-wf_12345678.jsonl",
      result: { answer: "Architecture approved." },
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
    expect(receiptText).toContain("Architecture approved.");
    expect(receiptText).toContain("2 agent(s) not shown");
    expect(receiptText).toContain("/external runs");
  });
});

describe("delegation roster lane disclosure", () => {
  it("shows a compact role catalog with restricted and exact-only availability", () => {
    const profiles = new Map([
      ["claude-implementer", {
        name: "claude-implementer",
        description: "Code implementation through Claude Code.",
        backend: "claude" as const,
        permission: "danger" as const,
      }],
      ["agy-reviewer", {
        name: "agy-reviewer",
        description: "Code review through Antigravity.",
        backend: "agy" as const,
        permission: "readonly" as const,
      }],
      ["claude-reviewer", {
        name: "claude-reviewer",
        description: "Different reviewer instructions remain profile-specific.",
        backend: "claude" as const,
        permission: "danger" as const,
      }],
      ["specialist", {
        name: "specialist",
        description: "Legacy exact profile.",
        backend: "codex" as const,
      }],
    ]);
    const roster = buildCoordinatorPrompt(profiles, "agy");
    expect(roster).toContain("Harnesses: agy (default), claude, codex, grok, muse.");
    expect(roster).toContain("Roles: implementer (claude only), reviewer (agy, claude only).");
    expect(roster).toContain("Exact-only profiles: specialist (codex).");
    expect(roster).toContain("Catalog availability reflects configured profiles");
    expect(roster).toContain("use external CLIs and registered Pi harnesses");
    expect(roster).not.toContain("Code review through Antigravity.");
  });
});
