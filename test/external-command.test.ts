import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { registerExternalCommand } from "../src/external-command.ts";
import type { LoadedExternalSettings } from "../src/settings.ts";

describe("/external command", () => {
  it("registers the complete surface and routes operational checks without model turns", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-flow-command-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = root;
    mkdirSync(join(root, "subagents"), { recursive: true });
    writeFileSync(join(root, "subagents", "claude-reviewer.md"), "---\ndescription: Review code.\nbackend: claude\n---\nReview read-only.\n");
    writeFileSync(join(root, "subagents", "scout.md"), "---\ndescription: Native Pi scout.\nbackend: pi\n---\nNative work.\n");
    try {
      let command: { getArgumentCompletions: (prefix: string) => Array<{ value: string }> | null; handler: (args: string, ctx: unknown) => Promise<void> } | undefined;
      const exec = vi.fn(async (program: string) => program === "claude"
        ? { code: 0, killed: false, stdout: "claude 1.2.3\n", stderr: "" }
        : { code: 0, killed: false, stdout: JSON.stringify({ runs: 2, byStatus: { done: 2 }, incompleteRecords: 0, recentFailures: [] }), stderr: "" });
      const pi = {
        exec,
        registerCommand(name: string, options: typeof command) {
          expect(name).toBe("external");
          command = options;
        },
      };
      const settings: LoadedExternalSettings = {
        path: join(root, "pi-flow-external", "settings.json"),
        settings: {
          version: 3,
          defaultHarness: "agy",
          maxConcurrentSubagents: 12,
          subagentTimeoutMs: 7200000,
          defaultPermission: "danger",
          defaultMaxBudgetUsd: null,
          maxRunRecords: 200,
        },
        diagnostics: ['Unknown setting "futureOption".'],
      };
      const startProfileInterview = vi.fn(async () => {});
      const workflowSummary = JSON.stringify({
        runId: "wf_all",
        kind: "workflow",
        state: { status: "running" },
        children: Array.from({ length: 60 }, (_, index) => ({ runId: `run_${index + 1}`, label: `child ${index + 1}`, status: "done" })),
      });
      const summarySplit = workflowSummary.indexOf('"runId":"run_31"');
      const externalRuns = {
        execute: vi.fn(async (_id: string, params: any) => {
          if (params.action === "list") return params.workflowCursor
            ? { content: [{ type: "text", text: "list" }], details: { workflows: [{ runId: "wf_all", task: { name: "wide" }, state: { status: "running" } }], runs: [] } }
            : { content: [{ type: "text", text: "list" }], details: { workflows: [{ runId: "wf_first", task: { name: "first" }, state: { status: "done" } }], runs: [], nextWorkflowCursor: "wf-next" } };
          if (params.action === "cancel") return { content: [{ type: "text", text: "cancelled" }], details: { status: "requested" } };
          if (params.runId === "wf_all") return params.cursor
            ? { content: [{ type: "text", text: workflowSummary.slice(summarySplit) }], details: { text: workflowSummary.slice(summarySplit) } }
            : { content: [{ type: "text", text: workflowSummary.slice(0, summarySplit) }], details: { text: workflowSummary.slice(0, summarySplit), nextCursor: "summary-2" } };
          if (params.view === "summary") return { content: [{ type: "text", text: JSON.stringify({ runId: params.runId, state: { status: "running" }, output: { available: true } }) }], details: {} };
          return params.cursor
            ? { content: [{ type: "text", text: "output page two" }], details: {} }
            : { content: [{ type: "text", text: "output page one" }], details: { nextCursor: "output-2" } };
        }),
      };
      registerExternalCommand(pi as never, {
        settings,
        getRuntimeSettings: () => ({ maxConcurrentSubagents: 4, subagentTimeoutMs: 60_000 }),
        getMaxRunRecords: () => 200,
        startProfileInterview,
        externalRuns: externalRuns as never,
      });

      expect(command?.getArgumentCompletions("")?.map((item) => item.value)).toEqual([
        "doctor", "settings", "profiles", "profile create", "workflows", "runs", "runs summary", "runs --prune", "help",
      ]);

      const notices: string[] = [];
      const ctx = { cwd: root, isProjectTrusted: () => false, ui: { notify: (message: string) => notices.push(message) } };
      await command?.handler("settings", ctx);
      expect(notices.at(-1)).toContain("maxConcurrentSubagents: 4");
      expect(notices.at(-1)).toContain("defaultHarness: agy (global)");
      expect(notices.at(-1)).toContain(settings.path);

      // A trusted project override wins over the global default and names its source.
      mkdirSync(join(root, ".pi", "pi-flow-external"), { recursive: true });
      writeFileSync(join(root, ".pi", "pi-flow-external", "settings.json"), JSON.stringify({ defaultHarness: "claude" }));
      await command?.handler("settings", { ...ctx, isProjectTrusted: () => true });
      expect(notices.at(-1)).toContain("defaultHarness: claude (project: ");
      expect(notices.at(-1)).toContain(join(".pi", "pi-flow-external", "settings.json"));
      // Untrusted: the override is ignored and disclosed.
      await command?.handler("settings", ctx);
      expect(notices.at(-1)).toContain("defaultHarness: agy (global)");
      expect(notices.at(-1)).toMatch(/not trusted/);

      await command?.handler("doctor", ctx);
      expect(notices.at(-1)).toContain("⚠ Settings:");
      expect(notices.at(-1)).toContain("claude 1.2.3");
      expect(exec).toHaveBeenCalledWith("claude", ["--version"], { timeout: 10_000 });

      await command?.handler("runs", ctx);
      expect(notices.at(-1)).toContain("Runs: 2");

      let childActions = 0;
      let workflowActions = 0;
      let rootActions = 0;
      const editor = vi.fn(async () => "");
      const interactiveCtx = {
        ...ctx,
        hasUI: true,
        ui: {
          notify: (message: string) => notices.push(message),
          editor,
          confirm: vi.fn(async () => true),
          select: vi.fn(async (title: string, choices: string[]) => {
            if (title === "External runs") return rootActions++ === 0
              ? "Next workflow page"
              : rootActions === 2
                ? choices.find((choice) => choice.includes("wf_all"))
                : "Back";
            if (title.includes("wf_all")) return workflowActions++ === 0
              ? choices.find((choice) => choice.includes("run_60"))
              : choices.find((choice) => choice === "Back");
            if (title.includes("output")) return "Next page";
            if (title.includes("run_60")) return childActions++ === 0 ? "Output" : "Cancel run";
          }),
        },
      };
      await command?.handler("runs", interactiveCtx);
      expect(externalRuns.execute).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ action: "list", workflowCursor: "wf-next" }), undefined, undefined, interactiveCtx);
      expect(externalRuns.execute).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ action: "inspect", runId: "wf_all", view: "summary", cursor: "summary-2" }), undefined, undefined, interactiveCtx);
      expect(externalRuns.execute).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ action: "inspect", runId: "run_60", view: "output", cursor: "output-2" }), undefined, undefined, interactiveCtx);
      expect(externalRuns.execute).toHaveBeenCalledWith(expect.any(String), { action: "cancel", runId: "run_60", reason: "cancelled from /external runs" }, undefined, undefined, interactiveCtx);
      expect(editor.mock.calls.map((call) => call.at(1))).toEqual(["output page one", "output page two"]);

      await command?.handler("profile create", ctx);
      expect(startProfileInterview).toHaveBeenCalledOnce();
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports registered pi harnesses without spawning a subprocess, and discloses a stale default", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-flow-command-pi-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = root;
    mkdirSync(join(root, "pi-flow-external"), { recursive: true });
    writeFileSync(
      join(root, "pi-flow-external", "harnesses.json"),
      JSON.stringify({
        version: 1,
        harnesses: {
          "pi-deepseek": { model: "deepseek/deepseek-chat", thinking: "high" },
          "pi-unauthed": { model: "deepseek/other-model", thinking: "off" },
        },
      }),
    );
    try {
      let command: { handler: (args: string, ctx: unknown) => Promise<void> } | undefined;
      const exec = vi.fn(async () => ({ code: 0, killed: false, stdout: "", stderr: "" }));
      const pi = { exec, registerCommand: (_name: string, options: typeof command) => { command = options; } };
      const settings: LoadedExternalSettings = {
        path: join(root, "pi-flow-external", "settings.json"),
        settings: {
          version: 3,
          defaultHarness: "pi-missing",
          maxConcurrentSubagents: 12,
          subagentTimeoutMs: 7200000,
          defaultPermission: "danger",
          defaultMaxBudgetUsd: null,
          maxRunRecords: 200,
        },
        diagnostics: [],
      };
      registerExternalCommand(pi as never, {
        settings,
        getRuntimeSettings: () => ({ maxConcurrentSubagents: 12, subagentTimeoutMs: 7_200_000 }),
        getMaxRunRecords: () => 200,
        startProfileInterview: vi.fn(async () => {}),
        externalRuns: { execute: vi.fn() } as never,
      });

      const notices: string[] = [];
      const modelRegistry = {
        find: (provider: string, id: string) => provider === "deepseek" && id === "deepseek-chat" ? { provider, id } : undefined,
        hasConfiguredAuth: () => true,
      };
      const ctx = { cwd: root, isProjectTrusted: () => false, modelRegistry, ui: { notify: (message: string) => notices.push(message) } };

      await command?.handler("doctor", ctx);
      expect(exec).not.toHaveBeenCalled();
      expect(notices.at(-1)).toContain("✓ pi-deepseek: deepseek/deepseek-chat (auth configured)");
      expect(notices.at(-1)).toContain('✗ pi-unauthed: model "deepseek/other-model" not found in the registry');

      await command?.handler("settings", ctx);
      expect(notices.at(-1)).toContain("Pi harnesses: pi-deepseek (deepseek/deepseek-chat · high), pi-unauthed (deepseek/other-model · default thinking)");
      expect(notices.at(-1)).toContain('Configured default harness "pi-missing" is not currently registered.');
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
