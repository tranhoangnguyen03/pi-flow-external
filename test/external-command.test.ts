import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { registerExternalCommand } from "../src/external-command.ts";
import { createExternalRunsTool } from "../src/external-runs.ts";
import { createRunRecord } from "../src/core/run-record.ts";
import { RunRegistry } from "../src/core/run-registry.ts";
import { createWorkflowJournalWriter, createWorkflowRunIdentity, getSessionWorkflowDir } from "../src/workflow/journal.ts";
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

  it("shows timing/output-availability row detail and Refresh resets pagination to page one without navigating into a run", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-flow-command-refresh-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = root;
    try {
      let command: { handler: (args: string, ctx: unknown) => Promise<void> } | undefined;
      const pi = { exec: vi.fn(), registerCommand: (_name: string, options: typeof command) => { command = options; } };
      const settings: LoadedExternalSettings = {
        path: join(root, "pi-flow-external", "settings.json"),
        settings: { version: 3, defaultHarness: "agy", maxConcurrentSubagents: 12, subagentTimeoutMs: 7200000, defaultPermission: "danger", defaultMaxBudgetUsd: null, maxRunRecords: 200 },
        diagnostics: [],
      };
      let listCalls = 0;
      const externalRuns = {
        execute: vi.fn(async (_id: string, params: any) => {
          listCalls++;
          return {
            content: [{ type: "text", text: "list" }],
            details: {
              workflows: [],
              runs: [
                {
                  runId: "run_1",
                  description: "Audit repo",
                  status: "done",
                  outputAvailable: true,
                  finalAvailable: true,
                  timing: { elapsedMs: 42_300 },
                  live: false,
                },
                {
                  runId: "run_queued_live",
                  description: "Still queued, registry-confirmed live",
                  status: "queued",
                  outputAvailable: false,
                  finalAvailable: false,
                  timing: { queuedAt: new Date(Date.now() - 5_000).toISOString() },
                  live: true,
                },
                {
                  runId: "run_queued_orphan",
                  description: "Queued-looking durable row with no live registry entry",
                  status: "queued",
                  outputAvailable: false,
                  finalAvailable: false,
                  timing: { queuedAt: new Date(Date.now() - 5_000).toISOString() },
                  live: false,
                },
              ],
              // Only the first call reports a further page, so a bug that
              // fails to reset the cursor on Refresh would surface as a
              // "Next run page" choice still present on the second call.
              nextCursor: listCalls === 1 ? "run-next" : undefined,
            },
          };
        }),
      };
      registerExternalCommand(pi as never, {
        settings,
        getRuntimeSettings: () => ({ maxConcurrentSubagents: 4, subagentTimeoutMs: 60_000 }),
        getMaxRunRecords: () => 200,
        startProfileInterview: vi.fn(async () => {}),
        externalRuns: externalRuns as never,
      });

      let selectCalls = 0;
      const ctx = {
        cwd: root,
        isProjectTrusted: () => false,
        hasUI: true,
        ui: {
          notify: vi.fn(),
          select: vi.fn(async (_title: string, choices: string[]) => {
            selectCalls++;
            if (selectCalls === 1) {
              expect(choices[0]).toContain("run_1");
              expect(choices[0]).toContain("Audit repo");
              expect(choices[0]).toContain("done");
              expect(choices[0]).toContain("elapsed");
              expect(choices[0]).toContain("final ready");
              // A registry-confirmed-live queued row shows a current queue
              // age computed from queuedAt (no queueDelayMs exists yet since
              // execution has not started); an orphaned durable row with the
              // same "queued" status but no live registry entry (live: false)
              // must never get a fabricated, ever-growing age.
              const liveQueuedRow = choices.find((choice) => choice.includes("run_queued_live"));
              expect(liveQueuedRow).toMatch(/queued \d/);
              const orphanQueuedRow = choices.find((choice) => choice.includes("run_queued_orphan"));
              expect(orphanQueuedRow).toBeDefined();
              expect(orphanQueuedRow).not.toMatch(/queued \d/);
              expect(choices).toContain("Next run page");
              expect(choices).toContain("Refresh");
              return "Refresh";
            }
            expect(choices).not.toContain("Next run page");
            return "Back";
          }),
        },
      };
      await command?.handler("runs", ctx as never);
      expect(listCalls).toBe(2);
      expect(externalRuns.execute).toHaveBeenNthCalledWith(1, expect.any(String), { action: "list", limit: 50 }, undefined, undefined, ctx);
      expect(externalRuns.execute).toHaveBeenNthCalledWith(2, expect.any(String), { action: "list", limit: 50 }, undefined, undefined, ctx);
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("prefixes the run-detail summary editor with a human-readable timing/output-availability header above the raw JSON", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-flow-command-summary-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = root;
    try {
      let command: { handler: (args: string, ctx: unknown) => Promise<void> } | undefined;
      const pi = { exec: vi.fn(), registerCommand: (_name: string, options: typeof command) => { command = options; } };
      const settings: LoadedExternalSettings = {
        path: join(root, "pi-flow-external", "settings.json"),
        settings: { version: 3, defaultHarness: "agy", maxConcurrentSubagents: 12, subagentTimeoutMs: 7200000, defaultPermission: "danger", defaultMaxBudgetUsd: null, maxRunRecords: 200 },
        diagnostics: [],
      };
      const summaryJson = JSON.stringify({
        runId: "run_1",
        state: { status: "done" },
        timing: { queueDelayMs: 500, elapsedMs: 42_300 },
        output: { available: true, finalAvailable: true },
      });
      const externalRuns = {
        execute: vi.fn(async (_id: string, params: any) => {
          if (params.action === "list") {
            return { content: [{ type: "text", text: "list" }], details: { workflows: [], runs: [{ runId: "run_1", status: "done" }] } };
          }
          return { content: [{ type: "text", text: summaryJson }], details: {} };
        }),
      };
      registerExternalCommand(pi as never, {
        settings,
        getRuntimeSettings: () => ({ maxConcurrentSubagents: 4, subagentTimeoutMs: 60_000 }),
        getMaxRunRecords: () => 200,
        startProfileInterview: vi.fn(async () => {}),
        externalRuns: externalRuns as never,
      });

      const editor = vi.fn(async (_title: string, _content: string) => "");
      let rootCalls = 0;
      let runDetailCalls = 0;
      const ctx = {
        cwd: root,
        isProjectTrusted: () => false,
        hasUI: true,
        ui: {
          notify: vi.fn(),
          editor,
          select: vi.fn(async (title: string, choices: string[]) => {
            if (title === "External runs") return rootCalls++ === 0 ? choices.find((choice) => choice.startsWith("Run run_1")) : "Back";
            if (title === "Run run_1") return runDetailCalls++ === 0 ? "Summary" : "Back";
            return "Back";
          }),
        },
      };
      await command?.handler("runs", ctx as never);
      expect(runDetailCalls).toBeGreaterThanOrEqual(2);
      expect(editor).toHaveBeenCalledWith("summary run_1", expect.stringContaining("status: done"));
      const [, content] = editor.mock.calls[0]!;
      expect(content).toContain("queue delay 500ms");
      expect(content).toContain("elapsed 42s");
      expect(content).toContain("final answer available");
      expect(JSON.parse(content.slice(content.indexOf("\n\n") + 2))).toEqual(JSON.parse(summaryJson));
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("routes the run-detail Final choice to inspect view: final, distinct from Output/Diagnostics", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-flow-command-final-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = root;
    try {
      let command: { handler: (args: string, ctx: unknown) => Promise<void> } | undefined;
      const pi = { exec: vi.fn(), registerCommand: (_name: string, options: typeof command) => { command = options; } };
      const settings: LoadedExternalSettings = {
        path: join(root, "pi-flow-external", "settings.json"),
        settings: { version: 3, defaultHarness: "agy", maxConcurrentSubagents: 12, subagentTimeoutMs: 7200000, defaultPermission: "danger", defaultMaxBudgetUsd: null, maxRunRecords: 200 },
        diagnostics: [],
      };
      const externalRuns = {
        execute: vi.fn(async (_id: string, params: any) => {
          if (params.action === "list") {
            return { content: [{ type: "text", text: "list" }], details: { workflows: [], runs: [{ runId: "run_1", status: "done" }] } };
          }
          if (params.action === "inspect" && params.view === "final") {
            return { content: [{ type: "text", text: "canonical final answer" }], details: { finalAvailable: true } };
          }
          return { content: [{ type: "text", text: JSON.stringify({ runId: "run_1", state: { status: "done" } }) }], details: {} };
        }),
      };
      registerExternalCommand(pi as never, {
        settings,
        getRuntimeSettings: () => ({ maxConcurrentSubagents: 4, subagentTimeoutMs: 60_000 }),
        getMaxRunRecords: () => 200,
        startProfileInterview: vi.fn(async () => {}),
        externalRuns: externalRuns as never,
      });

      const editor = vi.fn(async (_title: string, _content: string) => "");
      let rootCalls = 0;
      let runDetailCalls = 0;
      const ctx = {
        cwd: root,
        isProjectTrusted: () => false,
        hasUI: true,
        ui: {
          notify: vi.fn(),
          editor,
          select: vi.fn(async (title: string, choices: string[]) => {
            if (title === "External runs") return rootCalls++ === 0 ? choices.find((choice) => choice.startsWith("Run run_1")) : "Back";
            if (title === "Run run_1") {
              expect(choices).toContain("Final");
              return runDetailCalls++ === 0 ? "Final" : "Back";
            }
            if (title === "final run_1") return "Back";
            return "Back";
          }),
        },
      };
      await command?.handler("runs", ctx as never);
      expect(externalRuns.execute).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ action: "inspect", runId: "run_1", view: "final" }), undefined, undefined, ctx);
      expect(editor).toHaveBeenCalledWith("final run_1", "canonical final answer");
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("shows an informative notice (never a blank/raw editor) when Final is unavailable for a real agent or workflow run, while a legitimate null workflow result still opens as available", async () => {
    const runsDirectory = mkdtempSync(join(tmpdir(), "pi-flow-command-final-real-"));
    try {
      let command: { handler: (args: string, ctx: unknown) => Promise<void> } | undefined;
      const pi = { exec: vi.fn(), registerCommand: (_name: string, options: typeof command) => { command = options; } };
      const settings: LoadedExternalSettings = {
        path: join(runsDirectory, "pi-flow-external", "settings.json"),
        settings: { version: 3, defaultHarness: "agy", maxConcurrentSubagents: 12, subagentTimeoutMs: 7200000, defaultPermission: "danger", defaultMaxBudgetUsd: null, maxRunRecords: 200 },
        diagnostics: [],
      };
      // Real registry/tool — this is a command-route regression through
      // registerExternalCommand, not a stubbed externalRuns.execute.
      const registry = new RunRegistry();
      const externalRuns = createExternalRunsTool({ registry, runsDirectory: () => runsDirectory });
      registerExternalCommand(pi as never, {
        settings,
        getRuntimeSettings: () => ({ maxConcurrentSubagents: 4, subagentTimeoutMs: 60_000 }),
        getMaxRunRecords: () => 200,
        startProfileInterview: vi.fn(async () => {}),
        externalRuns: externalRuns as never,
      });

      const ctx = {
        cwd: "/project",
        isProjectTrusted: () => false,
        hasUI: true,
        sessionManager: { isPersisted: () => true, getSessionDir: () => runsDirectory, getSessionId: () => "session-a" },
        ui: {
          notify: vi.fn(),
          editor: vi.fn(async () => ""),
          select: vi.fn(),
        },
      };

      // Real evidence: a failed agent run (final unavailable).
      const failedAgent = createRunRecord({
        directory: runsDirectory,
        metadata: { parentSessionId: "session-a", project: "/project", description: "Failed agent" },
      });
      await failedAgent.finish({ status: "error", error: "boom" });

      // Real evidence: a failed workflow journal (final unavailable) and one
      // with a legitimate `null` result (final available).
      const workflowDir = getSessionWorkflowDir(ctx)!;
      const failedWorkflowIdentity = createWorkflowRunIdentity("failed workflow script", null);
      const failedWorkflowJournal = await createWorkflowJournalWriter({ dir: workflowDir, identity: failedWorkflowIdentity, name: "failed-workflow", source: "inline", project: "/project" });
      await failedWorkflowJournal.fail("boom", "failed");

      const nullWorkflowIdentity = createWorkflowRunIdentity("null workflow script", null);
      const nullWorkflowJournal = await createWorkflowJournalWriter({ dir: workflowDir, identity: nullWorkflowIdentity, name: "null-workflow", source: "inline", project: "/project" });
      await nullWorkflowJournal.complete(null);

      async function selectFinalFor(runId: string) {
        let rootChosen = false;
        let detailCalls = 0;
        (ctx.ui.select as ReturnType<typeof vi.fn>).mockReset();
        (ctx.ui.select as ReturnType<typeof vi.fn>).mockImplementation(async (title: string, choices: string[]) => {
          if (title === "External runs") {
            if (rootChosen) return "Back";
            rootChosen = true;
            return choices.find((choice) => choice.includes(runId)) ?? "Back";
          }
          if (title === `Run ${runId}`) {
            detailCalls++;
            if (detailCalls === 1) {
              expect(choices).toContain("Final");
              return "Final";
            }
            return "Back";
          }
          return "Back";
        });
        (ctx.ui.notify as ReturnType<typeof vi.fn>).mockClear();
        (ctx.ui.editor as ReturnType<typeof vi.fn>).mockClear();
        await command?.handler("runs", ctx as never);
      }

      await selectFinalFor(failedAgent.runId);
      expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringMatching(/no verified final answer.*available/i), "info");
      expect(ctx.ui.editor).not.toHaveBeenCalled();

      await selectFinalFor(failedWorkflowIdentity.runId);
      expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringMatching(/no verified final answer.*available/i), "info");
      expect(ctx.ui.editor).not.toHaveBeenCalled();

      // A legitimate settled `null` workflow result stays distinctly
      // "available": it opens in the editor with the real JSON (never
      // conflated with the unavailable notice above).
      await selectFinalFor(nullWorkflowIdentity.runId);
      expect(ctx.ui.notify).not.toHaveBeenCalled();
      expect(ctx.ui.editor).toHaveBeenCalledWith(`final ${nullWorkflowIdentity.runId}`, expect.stringContaining('"result":null'));
      expect(ctx.ui.editor).toHaveBeenCalledWith(`final ${nullWorkflowIdentity.runId}`, expect.stringContaining('"finalAvailable":true'));
    } finally {
      rmSync(runsDirectory, { recursive: true, force: true });
    }
  });
});
