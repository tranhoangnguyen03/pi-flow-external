import type { Component } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { createSubagentExtension } from "../src/pi-subagent.ts";
import { setupPiSubagentTestHarness } from "./helpers/pi-subagent-harness.ts";

type RenderableTool = {
  name?: string;
  renderShell?: "default" | "self";
  renderCall?: (args: Record<string, unknown>, theme: never, context: Record<string, unknown>) => Component;
  renderResult?: (
    result: { content: Array<{ type: "text"; text: string }>; details: unknown },
    options: { expanded: boolean; isPartial: boolean },
    theme: never,
    context: Record<string, unknown>,
  ) => Component;
};

/**
 * Mirrors `preservesOriginalRenderer` from the installed ccstyle host
 * (pi-cc-extensions' extensions/renderer/default-mode.ts, cited in
 * docs/plans/2026-09-21-unified-run-experience-design.md): a tool keeps its
 * own rendering under ccstyle only when its name is in the host's configured
 * `excludeRenderers` AND it actually defines its own renderCall/renderResult
 * (or renderShell:"self"). Reimplemented here (not imported — pi-cc-extensions
 * is an end-user host install, not a project dependency) purely to verify our
 * own tool definitions satisfy that documented contract, so "add
 * excludeRenderers" is a real integration boundary and not an unverified
 * assumption.
 */
function preservesOriginalRenderer(tool: RenderableTool, excludeRenderers: readonly string[]): boolean {
  if (!tool.name || !excludeRenderers.includes(tool.name)) return false;
  return tool.renderShell === "self" || typeof tool.renderCall === "function" || typeof tool.renderResult === "function";
}

describe("external_runs rendering", () => {
  let cwd = "";
  let agentDir = "";
  const { makeMockTheme, renderToText } = setupPiSubagentTestHarness((state) => {
    cwd = state.cwd;
    agentDir = state.agentDir;
  });

  beforeAll(() => {
    initTheme("dark");
  });

  function captureTools(): RenderableTool[] {
    const tools: RenderableTool[] = [];
    const flags = new Map<string, string | boolean>();
    createSubagentExtension()({
      registerTool: (tool: RenderableTool) => tools.push(tool),
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

  function findTool(name: string): RenderableTool {
    const tool = captureTools().find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`tool ${name} was not registered`);
    return tool;
  }

  it("registers its own renderCall/renderResult for every action, matching Agent and workflow's dedicated-renderer contract", () => {
    const externalRuns = findTool("external_runs");
    const agent = findTool("Agent");
    const workflow = findTool("workflow");
    expect(typeof externalRuns.renderCall).toBe("function");
    expect(typeof externalRuns.renderResult).toBe("function");
    // Every run tool this issue covers qualifies for a supported
    // excludeRenderers entry — see host-integration section in README.
    const excludeRenderers = ["Agent", "workflow", "external_runs"];
    for (const tool of [agent, workflow, externalRuns]) {
      expect(preservesOriginalRenderer(tool, excludeRenderers)).toBe(true);
    }
    // Without the config entry, ccstyle's own gate would not preserve them —
    // proving the config is load-bearing, not decorative.
    expect(preservesOriginalRenderer(externalRuns, [])).toBe(false);
  });

  it("renders a call intent naming the action for list, wait, inspect, and cancel", () => {
    const externalRuns = findTool("external_runs");
    const theme = makeMockTheme() as never;
    const render = (args: Record<string, unknown>) => renderToText(externalRuns.renderCall!(args, theme, { cwd }) as never);

    expect(render({ action: "list" })).toContain("list");
    expect(render({ action: "wait", runIds: ["run_a", "run_b"], mode: "any" })).toContain("waiting for 2 task(s)");
    expect(render({ action: "inspect", runId: "run_a", view: "output" })).toContain("inspect run_a");
    expect(render({ action: "cancel", runId: "run_a" })).toContain("cancel run_a");
  });

  it("renders a list result as workflow/run rows using the same row format as /external runs", () => {
    const externalRuns = findTool("external_runs");
    const theme = makeMockTheme() as never;
    const details = {
      workflows: [{ runId: "wf_1", task: { name: "Review" }, state: { status: "running" } }],
      runs: [{ runId: "run_1", description: "Map repo", status: "done", finalAvailable: true }],
    };
    const text = renderToText(externalRuns.renderResult!({ content: [{ type: "text", text: "{}" }], details }, { expanded: false, isPartial: false }, theme, { cwd }) as never);
    expect(text).toContain("1 workflow(s)");
    expect(text).toContain("1 run(s)");
    expect(text).toContain("wf_1");
    expect(text).toContain("Map repo");
    expect(text).toContain("final ready");
  });

  it("renders a live wait result identifying watched targets and progress, distinct from a terminal receipt", () => {
    const externalRuns = findTool("external_runs");
    const theme = makeMockTheme() as never;
    const live = {
      action: "wait",
      mode: "all",
      live: true,
      targets: [{ runId: "run_a", description: "Review Grok adapter", status: "running", lastActivityAt: Date.now() }],
      outcomes: [],
      pending: ["run_a"],
    };
    const liveText = renderToText(externalRuns.renderResult!({ content: [{ type: "text", text: "" }], details: live }, { expanded: false, isPartial: true }, theme, { cwd }) as never);
    expect(liveText).toContain("Waiting for 1 of 1 task(s)");
    expect(liveText).toContain("Review Grok adapter");

    const settled = {
      action: "wait",
      mode: "all",
      live: false,
      targets: [{ runId: "run_a", status: "done", outcome: "succeeded" }],
      outcomes: [{ runId: "run_a", status: "done", outcome: "succeeded" }],
      pending: [],
    };
    const settledText = renderToText(externalRuns.renderResult!({ content: [{ type: "text", text: "" }], details: settled }, { expanded: false, isPartial: false }, theme, { cwd }) as never);
    expect(settledText).toContain("Wait complete");
  });

  it("renders single-run inspect output text, expandable for the full answer", () => {
    const externalRuns = findTool("external_runs");
    const theme = makeMockTheme() as never;
    const details = { runId: "run_a", view: "output", text: "The review found no issues." };
    const text = renderToText(externalRuns.renderResult!({ content: [{ type: "text", text: "The review found no issues." }], details }, { expanded: true, isPartial: false }, theme, { cwd }) as never);
    expect(text).toContain("Inspecting run_a");
    expect(text).toContain("The review found no issues.");
  });
});
