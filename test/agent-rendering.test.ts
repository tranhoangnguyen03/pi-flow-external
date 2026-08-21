import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  fauxAssistantMessage,
  fauxToolCall,
  registerFauxProvider,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/index.js";
import { describe, expect, it, vi } from "vitest";
import { createSubagentExtension } from "../src/pi-subagent.ts";
import { getSubagentProfiles, loadBuiltinSubagentProfiles } from "../src/profiles.ts";
import { buildClaudeArgs, claudeUsageToSubagentUsage, extractClaudeCostUsd, extractClaudeError, extractClaudeFinalText, extractClaudeUsage, spawnClaudeSubagent } from "../src/core/claude.ts";
import { buildCodexArgs, codexUsageToSubagentUsage, estimateCodexCostUsd, extractCodexFinalText, spawnCodexSubagent } from "../src/core/codex.ts";
import { createProgressEmitter } from "../src/core/progress.ts";
import { packageRoot, setupPiSubagentTestHarness } from "./helpers/pi-subagent-harness.ts";

describe("pi-subagent rendering", () => {
  let tempDir = "";
  let cwd = "";
  let agentDir = "";
  let originalPathEnv: string | undefined;
  let registrations: Array<{ unregister: () => void }> = [];

  const {
    trackSession,
    disposeSession,
    createSession,
    delegateOnce,
    makeMockTheme,
    stripAnsi,
    renderToText,
    formatTestTokens,
    makeExecutionContext,
    getToolNames,
  } = setupPiSubagentTestHarness((state) => {
    tempDir = state.tempDir;
    cwd = state.cwd;
    agentDir = state.agentDir;
    originalPathEnv = state.originalPathEnv;
    registrations = state.registrations;
  });
  it("renders renderCall and renderResult with subagent type, description, and status", async () => {
    let captured: any;
    const flags = new Map<string, boolean | string>();
    const mockApi: any = {
      registerTool: (tool: any) => {
        if (tool.name === "Agent") {
          captured = tool;
        }
      },
      registerFlag: (name: string, options: { default?: boolean | string }) => {
        if (options.default !== undefined) flags.set(name, options.default);
      },
      registerCommand: () => {},
      getFlag: (name: string) => flags.get(name),
      on: () => {},
      getThinkingLevel: () => "high",
    };
    const factory = createSubagentExtension();
    await factory(mockApi);
    expect(captured).toBeDefined();
    expect(captured.renderCall).toBeDefined();
    expect(captured.renderResult).toBeDefined();

    const theme = makeMockTheme();

    const callText = renderToText(
      captured.renderCall(
        { description: "Find auth files", subagent_type: "explorer", prompt: "..." },
        theme,
        { executionStarted: false },
      ),
    );
    expect(callText).toContain("Pi Agent");
    expect(callText).toContain("explorer");
    expect(callText).toContain("Find auth files");

    const partialCallText = renderToText(
      captured.renderCall(
        { prompt: "..." },
        theme,
        { executionStarted: false },
      ),
    );
    expect(partialCallText).toContain("Agent");
    expect(partialCallText).not.toContain("undefined");

    const buildResult = (status: "done" | "error") => ({
      content: [{ type: "text" as const, text: "x" }],
      details: {
        description: "Find auth files",
        subagentType: "explorer" as const,
        backend: "pi" as const,
        status,
        ...(status === "done" ? { result: "ok" } : { error: "fail" }),
      },
    });

    const completedText = renderToText(captured.renderResult(buildResult("done"), {}, theme, {}));
    expect(completedText).toContain("Pi Agent");
    expect(completedText).toContain("explorer");
    expect(completedText).toContain("Find auth files");
    expect(completedText).toContain("✓");

    const errorText = renderToText(captured.renderResult(buildResult("error"), {}, theme, {}));
    expect(errorText).toContain("error: fail");

    const queuedText = renderToText(captured.renderResult({
      content: [{ type: "text" as const, text: "x" }],
      details: {
        description: "Wait turn",
        subagentType: "general-purpose" as const,
        backend: "pi" as const,
        status: "queued" as const,
        progress: {
          id: "queued-agent",
          description: "Wait turn",
          subagentType: "general-purpose" as const,
          backend: "pi" as const,
          status: "queued" as const,
          startedAt: Date.now(),
          activity: [],
          activityCount: 0,
        },
      },
    }, {}, theme, {}));
    expect(queuedText).toContain("◌ Pi Agent(general-purpose, Wait turn) queued");

    const abortedText = renderToText(captured.renderResult({
      content: [{ type: "text" as const, text: "x" }],
      details: {
        description: "Stop task",
        subagentType: "general-purpose" as const,
        backend: "pi" as const,
        status: "aborted" as const,
        error: "User aborted",
      },
    }, {}, theme, {}));
    expect(abortedText).toContain("⊘");
    expect(abortedText).toContain("aborted: User aborted");

    const timedOutText = renderToText(captured.renderResult({
      content: [{ type: "text" as const, text: "x" }],
      details: {
        description: "Slow task",
        subagentType: "general-purpose" as const,
        backend: "pi" as const,
        status: "aborted" as const,
        timedOut: true,
        error: "Subagent timed out after 10 minutes",
      },
    }, {}, theme, {}));
    expect(timedOutText).toContain("⏱");
    expect(timedOutText).toContain("timed out: Subagent timed out after 10 minutes");
    expect(timedOutText).not.toContain("⊘");

    const unknownCallText = renderToText(
      captured.renderCall(
        { description: "Bad", subagent_type: "ghost", prompt: "..." },
        theme,
        { executionStarted: false },
      ),
    );
    expect(unknownCallText).toContain("ghost");

    const executingCallText = renderToText(
      captured.renderCall(
        { description: "Find auth files", subagent_type: "explorer", prompt: "..." },
        theme,
        { executionStarted: true },
      ),
    );
    expect(executingCallText).toBe("");
  });

  it("renders compact progress with rolling activity and descriptions", async () => {
    let captured: any;
    const flags = new Map<string, boolean | string>();
    const mockApi: any = {
      registerTool: (tool: any) => {
        if (tool.name === "Agent") {
          captured = tool;
        }
      },
      registerFlag: (name: string, options: { default?: boolean | string }) => {
        if (options.default !== undefined) flags.set(name, options.default);
      },
      registerCommand: () => {},
      getFlag: (name: string) => flags.get(name),
      on: () => {},
      getThinkingLevel: () => "high",
    };
    const factory = createSubagentExtension();
    await factory(mockApi);

    const theme = makeMockTheme();
    const now = 1_700_000_000_000;
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      const result = {
        content: [{ type: "text" as const, text: "done" }],
        details: {
          description: "Research repo",
          subagentType: "explorer" as const,
          backend: "pi" as const,
          status: "running" as const,
          progress: {
            id: "root-progress",
            description: "Research repo",
            subagentType: "explorer" as const,
            backend: "pi" as const,
            status: "running" as const,
            startedAt: now - 2000,
            activity: ["Read src/types.ts", "Read app.py", "Read config.yaml"],
            activityCount: 5,
            usage: {
              input: 81_000,
              output: 4_900,
              cacheRead: 602_000,
              cacheWrite: 0,
              latestCacheHitRate: 94.666,
              cost: 0.85,
            },
          },
        },
      };

      const text = renderToText(captured.renderResult(result, {}, theme, {}));

      expect(text).toContain("Pi Agent(explorer: Research repo)");
      expect(text).toContain("2s ↑81k ↓4.9k R602k CH94.7%");
      expect(text).not.toContain("$0.850");
      expect(text).toContain("... +2 earlier events");
      expect(text).toContain("Read src/types.ts");
      expect(text).toContain("Read app.py");
      expect(text).toContain("Read config.yaml");

      const compactRunning = {
        ...result,
        details: {
          ...result.details,
          activeCount: 5,
          progress: {
            ...result.details.progress,
            activity: ["Read src/types.ts", "Comparing token validation paths"],
            activityCount: 2,
          },
        },
      };
      const compactRunningText = renderToText(captured.renderResult(compactRunning, {}, theme, {}));
      expect(compactRunningText).toContain("-- Comparing token validation paths");
      expect(compactRunningText).not.toContain("Read src/types.ts");

      const compactDone = {
        content: [{ type: "text" as const, text: "done" }],
        details: {
          description: "Review permissions",
          subagentType: "reviewer" as const,
          backend: "claude" as const,
          status: "done" as const,
          result: "\n\nFound 2 missing checks\nFull details follow",
        },
      };
      const compactDoneText = renderToText(captured.renderResult(compactDone, {}, theme, {}));
      expect(compactDoneText).toContain("-> Found 2 missing checks");
      expect(compactDoneText).not.toContain("Full details follow");

      const hiddenTail = "COMPACT_TAIL_MUST_NOT_RENDER";
      const longActivity = `${"Inspecting nested token validation paths ".repeat(8)}${hiddenTail}`;
      const compactLong = {
        ...compactRunning,
        details: {
          ...compactRunning.details,
          progress: {
            ...compactRunning.details.progress,
            activity: [longActivity],
            activityCount: 1,
          },
        },
      };
      const compactLongText = renderToText(captured.renderResult(compactLong, {}, theme, {}));
      expect(compactLongText).not.toContain(hiddenTail);
    } finally {
      dateNow.mockRestore();
    }
  });

  it("retains the four latest progress events", () => {
    const emitter = createProgressEmitter({
      toolCallId: "rolling-progress",
      description: "Inspect repo",
      subagentType: "explorer",
      enabled: true,
      onProgress: undefined,
    });

    for (const line of ["one", "two", "three", "four", "five"]) {
      emitter.addActivity(line);
    }

    expect(emitter.progress?.activity).toEqual(["two", "three", "four", "five"]);
  });

  it("folds long progress activity lines only in the rendered subagent window", async () => {
    let captured: any;
    const flags = new Map<string, boolean | string>();
    const mockApi: any = {
      registerTool: (tool: any) => {
        if (tool.name === "Agent") {
          captured = tool;
        }
      },
      registerFlag: (name: string, options: { default?: boolean | string }) => {
        if (options.default !== undefined) flags.set(name, options.default);
      },
      registerCommand: () => {},
      getFlag: (name: string) => flags.get(name),
      on: () => {},
      getThinkingLevel: () => "high",
    };
    const factory = createSubagentExtension();
    await factory(mockApi);

    const theme = makeMockTheme();
    const hiddenTail = "TAIL_MARKER_SHOULD_STAY_OUT_OF_RENDERED_PREVIEW";
    const longCommand = `bash uv run python - <<'PY' ${"print('long progress payload') ".repeat(30)}${hiddenTail} PY`;
    const result = {
      content: [{ type: "text" as const, text: "running" }],
      details: {
        description: "Long tool call",
        subagentType: "general-purpose" as const,
        status: "running" as const,
        progress: {
          id: "long-progress",
          description: "Long tool call",
          subagentType: "general-purpose" as const,
          status: "running" as const,
          startedAt: Date.now(),
          activity: [longCommand],
          activityCount: 1,
        },
      },
    };

    const text = renderToText(captured.renderResult(result, {}, theme, {}));

    expect(text).toContain("bash uv run python");
    expect(text).toContain("... (+");
    expect(text).toContain("chars)");
    expect(text).not.toContain(hiddenTail);
    expect(result.details.progress.activity[0]).toBe(longCommand);

    const narrowLines = captured
      .renderResult(result, {}, theme, {})
      .render(80)
      .map((line: string) => stripAnsi(line))
      .filter((line: string) => line.trim());
    expect(narrowLines).toHaveLength(2);
  });
});
