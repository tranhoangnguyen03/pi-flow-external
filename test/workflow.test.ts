import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SessionManager, Theme, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { captureParentContext } from "../src/core/parent-context.ts";
import { describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage, type AssistantMessage } from "../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/index.js";
import { setupPiSubagentTestHarness } from "./helpers/pi-subagent-harness.ts";
import { ConcurrencyLimiter } from "../src/core/concurrency.ts";
import { RunRegistry } from "../src/core/run-registry.ts";
import { createSubagentExtension } from "../src/pi-subagent.ts";
import type { WorkflowToolDetails } from "../src/types.ts";
import {
  ChildRunError,
  parseWorkflowScript,
  runWorkflow,
  type WorkflowAgentRunner,
} from "../src/workflow/runtime.ts";
import { loadSavedWorkflowRegistry, loadWorkflowScriptPath } from "../src/workflow/registry.ts";
import { createWorkflowTool, toWorkflowSubagentDescriptor } from "../src/workflow/tool.ts";
import { createWorkflowJournalWriter, createWorkflowRunIdentity, loadWorkflowJournal } from "../src/workflow/journal.ts";
import { prepareWorkflowToolSource } from "../src/workflow/source.ts";
import { createStructuredOutputTool, type StructuredOutputCapture } from "../src/workflow/structured-output.ts";
import { resolveExternalProfile } from "../src/profiles.ts";
import type { SubagentProfile } from "../src/types.ts";

const META = "export const meta = { apiVersion: 1, name: 'wf', description: 'a workflow' };\n";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeMockTheme(): Theme {
  const theme = new Theme({} as never, {} as never, "truecolor");
  (theme as unknown as { fg: (color: string, text: string) => string }).fg = (_color, text) => text;
  (theme as unknown as { bold: (text: string) => string }).bold = (text) => text;
  return theme;
}

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

function renderToText(component: { render: (width: number) => string[] }): string {
  return stripAnsi(component.render(200).join("\n"));
}

describe("parseWorkflowScript", () => {
  it("extracts meta and strips the export from the body", () => {
    const { meta, body } = parseWorkflowScript(`${META}return await agent('hi');`);
    expect(meta).toMatchObject({ name: "wf", description: "a workflow" });
    expect(body).not.toContain("export const meta");
    expect(body).toContain("agent('hi')");
  });

  it("requires the meta export as the first statement", () => {
    expect(() => parseWorkflowScript("const x = 1;\n")).toThrow(/export const meta/);
  });

  it("requires non-empty name and description", () => {
    expect(() => parseWorkflowScript("export const meta = { apiVersion: 1, name: 'x' };\n")).toThrow(/description/);
    expect(() => parseWorkflowScript("export const meta = { apiVersion: 1, description: 'y' };\n")).toThrow(/name/);
  });

  it("requires the current workflow API before execution", async () => {
    expect(() => parseWorkflowScript("export const meta = { name: 'x', description: 'y' };\n")).toThrow(/apiVersion: 1.*no children were launched/i);
    const runAgent = vi.fn<WorkflowAgentRunner>();
    await expect(runWorkflow(
      "export const meta = { apiVersion: 2, name: 'x', description: 'y' };\nreturn await agent('no');",
      { cwd: "/tmp", limiter: new ConcurrencyLimiter(1), runAgent },
    )).rejects.toThrow(/apiVersion: 1.*no children were launched/i);
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("rejects non-deterministic time/random APIs", () => {
    expect(() => parseWorkflowScript(`${META}const t = Date.now();`)).toThrow(/deterministic/);
    expect(() => parseWorkflowScript(`${META}const r = Math.random();`)).toThrow(/deterministic/);
    expect(() => parseWorkflowScript(`${META}const d = new Date();`)).toThrow(/deterministic/);
    expect(() => parseWorkflowScript(`${META}const now = Date.now; now();`)).toThrow(/deterministic|Date/i);
    expect(() => parseWorkflowScript(`${META}const D = Date; new D();`)).toThrow(/deterministic|Date/i);
    expect(() => parseWorkflowScript(`${META}const { random } = Math; random();`)).toThrow(/deterministic|Math\.random/i);
    expect(() => parseWorkflowScript(`${META}const M = Math; M.random();`)).toThrow(/deterministic|Math\.random/i);
  });

  it("allows deterministic Math aliases", () => {
    expect(() => parseWorkflowScript(`${META}const M = Math; const x = M.max(1, 2); return await agent(String(x));`)).not.toThrow();
  });

  it("allows Date as a deterministic data field name", () => {
    expect(() => parseWorkflowScript(`${META}const schema = { type: 'object', properties: { Date: { type: 'string' } } };\nreturn await agent('x', { schema });`)).not.toThrow();
  });

  it("rejects non-literal meta", () => {
    expect(() => parseWorkflowScript("export const meta = buildMeta();\n")).toThrow();
  });
});

describe("runWorkflow", () => {
  const echo: WorkflowAgentRunner = async (call) => call.prompt;

  it("runs a single agent and returns its result", async () => {
    const result = await runWorkflow(`${META}return await agent('hello', { label: 'greet' });`, {
      cwd: "/tmp",
      limiter: new ConcurrencyLimiter(4),
      runAgent: echo,
    });
    expect(result.result).toBe("hello");
    expect(result.meta.name).toBe("wf");
    expect(result.agentCount).toBe(1);
  });

  it("replays context-sharing children only when the selected snapshot is unchanged", async () => {
    const sm = SessionManager.inMemory();
    sm.appendMessage({ role: "user", content: "original requirement", timestamp: 0 });
    const parentMessages = captureParentContext(sm);
    const events: any[] = [];
    const script = `${META}return await parallel([() => agent('one', { context: { mode: 'full' } }), () => agent('two', { context: { mode: 'recent', turns: 1 } })]);`;
    const runner = vi.fn(async (call) => {
      sm.appendMessage({ role: "user", content: "new requirement", timestamp: 1 });
      return call.prompt;
    });
    const options = { cwd: "/tmp", limiter: new ConcurrencyLimiter(1), runAgent: runner, parentMessages };
    const first = await runWorkflow(script, { ...options, onAgentResult: (event) => { events.push(event); } });
    expect(JSON.stringify(first.result)).not.toContain("new requirement");
    expect(events.every((event) => event.context.sharedTurns === 1)).toBe(true);
    await runWorkflow(script, { ...options, resumeAgentResults: events });
    expect(runner).toHaveBeenCalledTimes(2);
    await runWorkflow(script, { ...options, parentMessages: captureParentContext(sm), resumeAgentResults: events });
    expect(runner).toHaveBeenCalledTimes(4);
  });

  it("requires at least one agent call", async () => {
    await expect(
      runWorkflow(`${META}return 'no agents';`, {
        cwd: "/tmp",
        limiter: new ConcurrencyLimiter(4),
        runAgent: echo,
      }),
    ).rejects.toThrow(/must call agent/i);
  });

  it("allows idiomatic computed member access (obj[key], arr[i], { [k]: v })", async () => {
    // The node:vm is explicitly not a security boundary (workflow subagents run
    // with full tools), so the former "dynamic code / constructor escape"
    // hardening was dropped. Its unavoidable side effect was banning all computed
    // access with a non-literal key, which broke ordinary data-shaping scripts
    // that models reach for constantly. Those must now parse and run.
    const result = await runWorkflow(
      `${META}const files = ['a', 'b'];\n` +
        `const out = {};\n` +
        `for (let i = 0; i < files.length; i++) {\n` +
        `  const r = await agent('x:' + files[i], { label: 'a' + i });\n` +
        `  out[files[i]] = r;\n` +
        `}\n` +
        `const dyn = { [files[0]]: out[files[0]] };\n` +
        `return { out, dyn, first: out[files[0]] };`,
      { cwd: "/tmp", limiter: new ConcurrencyLimiter(4), runAgent: echo },
    );
    expect(result.agentCount).toBe(2);
    expect(result.result).toEqual({
      out: { a: "x:a", b: "x:b" },
      dyn: { a: "x:a" },
      first: "x:a",
    });
  });

  it("still rejects nondeterminism reached through computed/aliased forms", () => {
    // Determinism stays enforced even though escape hardening is gone.
    expect(() => parseWorkflowScript(`${META}const r = Math.random();`)).toThrow(/deterministic/);
    expect(() => parseWorkflowScript(`${META}const d = new Date();`)).toThrow(/deterministic|Date/i);
  });

  it("waits for started but unawaited agent calls before failing", async () => {
    let completed = false;
    await expect(
      runWorkflow(`${META}agent('slow', { label: 'late' }).then(() => log('late done'));\nreturn 'early';`, {
        cwd: "/tmp",
        limiter: new ConcurrencyLimiter(4),
        runAgent: async () => {
          await delay(5);
          completed = true;
          return "late";
        },
      }),
    ).rejects.toThrow(/awaited before the workflow returns/);
    expect(completed).toBe(true);
  });

  it("does not allow promise reactions to start new agents after return", async () => {
    const completed: string[] = [];
    await expect(
      runWorkflow(
        `${META}agent('a', { label: 'a' }).then(() => agent('b', { label: 'b' }).then(() => log('b done')));\nreturn 'early';`,
        {
          cwd: "/tmp",
          limiter: new ConcurrencyLimiter(4),
          runAgent: async (call) => {
            completed.push(call.label);
            return call.label;
          },
        },
      ),
    ).rejects.toThrow(/awaited before the workflow returns|cannot be called after the workflow body has returned/);
    expect(completed).toEqual(["a"]);
  });

  it("fails when a discarded then-chain rejects before another awaited child finishes", async () => {
    const failure = runWorkflow(
      `${META}agent('fail', { label: 'fail' }).then(() => 'unused');\nreturn await agent('slow', { label: 'slow' });`,
      {
        cwd: "/tmp",
        limiter: new ConcurrencyLimiter(2),
        runAgent: async (call) => {
          if (call.label === "fail") throw new ChildRunError({ runId: "run_fail", outcome: "failed", message: "discarded failure" });
          await delay(20);
          return "slow success";
        },
      },
    );

    await expect(failure).rejects.toMatchObject({ name: "ChildRunError", runId: "run_fail" });

    await expect(runWorkflow(
      `${META}agent('fast', { label: 'fast' }).then(() => { throw undefined; });\nreturn await agent('slow', { label: 'slow' });`,
      {
        cwd: "/tmp",
        limiter: new ConcurrencyLimiter(2),
        runAgent: async (call) => {
          if (call.label === "slow") await delay(20);
          return call.label;
        },
      },
    )).rejects.toThrow("undefined");
  });


  it("defaults subagent_type to general-purpose and passes an explicit type through", async () => {
    const seen: string[] = [];
    const runAgent: WorkflowAgentRunner = async (call) => {
      seen.push(call.subagentType);
      return call.label;
    };
    await runWorkflow(
      `${META}await agent('a', { label: 'one' });\nawait agent('b', { label: 'two', subagent_type: 'explorer' });\nreturn null;`,
      { cwd: "/tmp", limiter: new ConcurrencyLimiter(4), runAgent },
    );
    expect(seen).toEqual(["general-purpose", "explorer"]);
  });

  it("requires subagent_type when the configured default is null", async () => {
    await expect(
      runWorkflow(`${META}return await agent('hello', { label: 'missing-type' });`, {
        cwd: "/tmp",
        limiter: new ConcurrencyLimiter(4),
        runAgent: echo,
        defaultSubagentType: null,
      }),
    ).rejects.toThrow(/agent role or legacy subagent_type is required/);
  });

  it("trims explicit subagent_type when the configured default is null", async () => {
    const seen: string[] = [];
    const result = await runWorkflow(`${META}return await agent('hello', { label: 'trim-type', subagent_type: ' claude-reviewer ' });`, {
      cwd: "/tmp",
      limiter: new ConcurrencyLimiter(4),
      runAgent: async (call) => {
        seen.push(call.subagentType);
        return call.subagentType;
      },
      defaultSubagentType: null,
    });

    expect(seen).toEqual(["claude-reviewer"]);
    expect(result.result).toBe("claude-reviewer");
  });

  it("resolves role/harness before workflow events and fingerprints", async () => {
    const profile = (name: string, backend: "agy" | "codex"): SubagentProfile => ({ name, backend, description: name });
    const profiles = new Map([
      ["agy-reviewer", profile("agy-reviewer", "agy")],
      ["codex-reviewer", profile("codex-reviewer", "codex")],
    ]);
    const resolveSubagentType = (selection: { role?: string; harness?: string; subagentType?: string }) =>
      resolveExternalProfile(profiles, selection, "agy").name;
    const firstEvents: any[] = [];
    const queued: string[] = [];
    const roleScript = `${META}return await agent('review', { label: 'review', role: 'reviewer' });`;

    const first = await runWorkflow(roleScript, {
      cwd: "/tmp",
      limiter: new ConcurrencyLimiter(1),
      runAgent: async (call) => call.subagentType,
      defaultSubagentType: null,
      resolveSubagentType,
      onAgentQueued: (event) => queued.push(event.subagentType),
      onAgentResult: (event) => {
        firstEvents.push(event);
      },
    });
    expect(first.result).toBe("agy-reviewer");
    expect(queued).toEqual(["agy-reviewer"]);
    expect(firstEvents[0]).toMatchObject({ subagentType: "agy-reviewer" });

    const runAgent = vi.fn<WorkflowAgentRunner>();
    const replay = await runWorkflow(`${META}return await agent('review', { label: 'review', subagent_type: 'agy-reviewer' });`, {
      cwd: "/tmp",
      limiter: new ConcurrencyLimiter(1),
      runAgent,
      defaultSubagentType: null,
      resolveSubagentType,
      resumeAgentResults: firstEvents.map(({ index, fingerprint, result }) => ({ index, fingerprint, result })),
    });
    expect(replay.result).toBe("agy-reviewer");
    expect(runAgent).not.toHaveBeenCalled();

    const override = await runWorkflow(`${META}return await agent('review', { role: 'reviewer', harness: 'codex' });`, {
      cwd: "/tmp",
      limiter: new ConcurrencyLimiter(1),
      runAgent: async (call) => call.subagentType,
      defaultSubagentType: null,
      resolveSubagentType,
    });
    expect(override.result).toBe("codex-reviewer");
  });

  it("widens the fingerprint with the resolved descriptor so a model/thinking/body/tools change invalidates cache", async () => {
    const script = `${META}return await agent('review', { label: 'review', subagent_type: 'x' });`;
    const runOnce = async (descriptor: Record<string, unknown>) => {
      const events: any[] = [];
      await runWorkflow(script, {
        cwd: "/tmp",
        limiter: new ConcurrencyLimiter(1),
        runAgent: async () => "result",
        describeSubagentType: () => descriptor as never,
        onAgentResult: (event) => { events.push(event); },
      });
      return events[0].fingerprint as string;
    };

    const base = { backend: "pi", harness: "pi-deepseek", model: "deepseek/deepseek-chat", thinking: "high", systemPrompt: "do x", tools: ["read"], maxBudgetUsd: 1 };
    const baseFingerprint = await runOnce(base);
    expect(await runOnce({ ...base })).toBe(baseFingerprint);
    expect(await runOnce({ ...base, model: "deepseek/other-model" })).not.toBe(baseFingerprint);
    expect(await runOnce({ ...base, thinking: "low" })).not.toBe(baseFingerprint);
    expect(await runOnce({ ...base, systemPrompt: "do y" })).not.toBe(baseFingerprint);
    expect(await runOnce({ ...base, tools: ["read", "grep"] })).not.toBe(baseFingerprint);
    expect(await runOnce({ ...base, maxBudgetUsd: 2 })).not.toBe(baseFingerprint);
    expect(await runOnce({ ...base, preset: "minimal" })).not.toBe(baseFingerprint);
    expect(await runOnce({ ...base, preset: "skills" })).not.toBe(await runOnce({ ...base, preset: "minimal" }));
  });

  it("reflects the resolved effectivePermission (not just the raw request) in the fingerprint", async () => {
    // Neither the call nor the descriptor names a permission, so the resolved
    // tier comes entirely from the settings-level default — varying only that
    // default changes effectivePermission while every directly-hashed field
    // (call.permission, descriptor.permission) stays identical. If the hash
    // did not separately include the resolved effectivePermission, these two
    // fingerprints would incorrectly match.
    const script = `${META}return await agent('review', { label: 'review', subagent_type: 'x-reviewer' });`;
    const descriptor = { backend: "pi", harness: "pi-deepseek" };
    const fingerprintFor = async (defaultPermission: "readonly" | "edit") => {
      const events: any[] = [];
      await runWorkflow(script, {
        cwd: "/tmp",
        limiter: new ConcurrencyLimiter(1),
        runAgent: async () => "result",
        describeSubagentType: () => descriptor as never,
        getDefaultPermission: () => defaultPermission,
        onAgentResult: (event) => { events.push(event); },
      });
      return events[0].fingerprint as string;
    };
    expect(await fingerprintFor("readonly")).not.toBe(await fingerprintFor("edit"));
  });

  it("falls back to hashing without descriptor fields when describeSubagentType is not provided", async () => {
    const script = `${META}return await agent('review', { label: 'review', subagent_type: 'x' });`;
    await expect(runWorkflow(script, {
      cwd: "/tmp",
      limiter: new ConcurrencyLimiter(1),
      runAgent: async () => "result",
    })).resolves.toMatchObject({ result: "result" });
  });

  it("fails the workflow before launch when role selection is invalid", async () => {
    const profiles = new Map<string, SubagentProfile>([
      ["claude-security", { name: "claude-security", backend: "claude", description: "security" }],
    ]);
    const runAgent = vi.fn<WorkflowAgentRunner>();
    await expect(runWorkflow(`${META}return await agent('review', { role: 'security' });`, {
      cwd: "/tmp",
      limiter: new ConcurrencyLimiter(1),
      runAgent,
      defaultSubagentType: null,
      resolveSubagentType: (selection) => resolveExternalProfile(profiles, selection, "agy").name,
    })).rejects.toThrow(/unavailable for harness "agy".*Supported harnesses.*claude/);
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("exposes args to the script", async () => {
    const result = await runWorkflow(`${META}return await agent('use ' + args.topic, { label: 'x' });`, {
      cwd: "/tmp",
      limiter: new ConcurrencyLimiter(1),
      runAgent: echo,
      args: { topic: "auth" },
    });
    expect(result.result).toBe("use auth");
  });

  it("caps concurrent agents at the shared limiter max", async () => {
    let current = 0;
    let peak = 0;
    const runAgent: WorkflowAgentRunner = async () => {
      current++;
      peak = Math.max(peak, current);
      await delay(5);
      current--;
      return "done";
    };
    const result = await runWorkflow(
      `${META}return await parallel([1, 2, 3, 4, 5].map((i) => () => agent('t' + i, { label: 'a' + i })));`,
      { cwd: "/tmp", limiter: new ConcurrencyLimiter(2), runAgent },
    );
    const values = result.result as string[];
    expect(values).toHaveLength(5);
    expect(values.every((value) => value === "done")).toBe(true);
    expect(peak).toBe(2);
    expect(result.agentCount).toBe(5);
  });

  it("pipelines each item through stages while items run concurrently", async () => {
    const upper: WorkflowAgentRunner = async (call) => call.prompt.toUpperCase();
    const result = await runWorkflow(
      `${META}return await pipeline(['a', 'b'], (item) => agent(item, { label: 's1-' + item }), (prev, item) => agent(prev + '-' + item, { label: 's2-' + item }));`,
      { cwd: "/tmp", limiter: new ConcurrencyLimiter(4), runAgent: upper },
    );
    expect(result.result).toEqual(["A-A", "B-B"]);
  });

  it("throws an uncaught structured child failure", async () => {
    const recorded: any[] = [];
    const failure = runWorkflow(`${META}return await agent('x', { label: 'boom' });`, {
      cwd: "/tmp",
      limiter: new ConcurrencyLimiter(4),
      runAgent: async () => {
        throw new ChildRunError({ runId: "run_boom", outcome: "failed", message: "kaboom" });
      },
      onAgentResult: (event) => { recorded.push(event); },
    });
    await expect(failure).rejects.toMatchObject({
      name: "ChildRunError",
      runId: "run_boom",
      outcome: "failed",
      message: "kaboom",
    });
    expect(recorded).toMatchObject([{
      failed: true,
      runId: "run_boom",
      error: { runId: "run_boom", outcome: "failed", message: "kaboom" },
    }]);
  });

  it("does not treat a successful null agent result as a failed agent", async () => {
    const ended: Array<{ result: unknown; failed?: boolean }> = [];
    const result = await runWorkflow(`${META}return await agent('x', { label: 'nullable' });`, {
      cwd: "/tmp",
      limiter: new ConcurrencyLimiter(4),
      runAgent: async () => null,
      onAgentEnd: (event) => ended.push({ result: event.result, failed: event.failed }),
    });
    expect(result.result).toBeNull();
    expect(ended).toEqual([{ result: null, failed: false }]);
  });

  it("lets the script catch a structured child failure and continue sibling work", async () => {
    const runAgent: WorkflowAgentRunner = async (call) => {
      if (call.label === "bad") {
        throw new ChildRunError({
          runId: "run_bad",
          outcome: "timed_out",
          message: "nope",
          outputRef: { runId: "run_bad", view: "output" },
          diagnosticsRef: { runId: "run_bad", view: "diagnostics" },
          assistantOutput: { status: "interrupted", messages: [{ text: "partial finding from bad child" }] },
          partialOutput: "partial finding from bad child",
        });
      }
      return call.label;
    };
    const result = await runWorkflow(
      `${META}const values = await parallel([
        () => agent('1', { label: 'ok1' }),
        async () => { try { return await agent('2', { label: 'bad' }); } catch (error) { return {
          name: error.name, runId: error.runId, outcome: error.outcome,
          outputRef: error.outputRef, diagnosticsRef: error.diagnosticsRef,
          assistantOutput: error.assistantOutput,
          partialOutput: error.partialOutput,
        }; } },
        () => agent('3', { label: 'ok2' }),
      ]); return values;`,
      { cwd: "/tmp", limiter: new ConcurrencyLimiter(4), runAgent },
    );
    expect(result.result).toEqual([
      "ok1",
      {
        name: "ChildRunError",
        runId: "run_bad",
        outcome: "timed_out",
        outputRef: { runId: "run_bad", view: "output" },
        diagnosticsRef: { runId: "run_bad", view: "diagnostics" },
        assistantOutput: { status: "interrupted", messages: [{ text: "partial finding from bad child" }] },
        partialOutput: "partial finding from bad child",
      },
      "ok2",
    ]);
  });

  it("treats targeted child cancellation as catchable without cancelling its sibling", async () => {
    const registry = new RunRegistry();
    let releaseSibling!: () => void;
    const sibling = new Promise<string>((resolve) => { releaseSibling = () => resolve("sibling done"); });
    const result = runWorkflow(
      `${META}const cancelled = agent('target', { label: 'target' }).catch((error) => error.outcome);
      const kept = agent('sibling', { label: 'sibling' });
      return [await cancelled, await kept];`,
      {
        cwd: "/tmp",
        limiter: new ConcurrencyLimiter(2),
        runAgent: async (call, signal) => call.label === "sibling"
          ? sibling
          : await new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(new ChildRunError({ runId: "run_target", outcome: "cancelled", message: "not needed" })), { once: true })),
        startAgentRun: (call, run) => registry.start({
          runId: `run_${call.label}`,
          kind: "agent",
          sessionId: "session",
          project: "/tmp",
          run,
        }).result,
      },
    );

    await vi.waitFor(() => expect(registry.get("run_target")?.state).toBe("running"));
    expect(registry.cancel("run_target", "not needed")).toBe("requested");
    releaseSibling();
    await expect(result).resolves.toMatchObject({ result: ["cancelled", "sibling done"] });
    expect(registry.get("run_target")?.outcome).toMatchObject({ outcome: "cancelled", error: "not needed" });
    expect(registry.get("run_sibling")?.outcome?.status).toBe("done");
  });

  it("preserves queued child cancellation reasons and evidence references", async () => {
    const limiter = new ConcurrencyLimiter(1);
    const release = await limiter.acquire();
    const registry = new RunRegistry();
    const result = runWorkflow(
      `${META}try { await agent('target', { label: 'target' }); } catch (error) { return { message: error.message, outcome: error.outcome, outputRef: error.outputRef, diagnosticsRef: error.diagnosticsRef }; }`,
      {
        cwd: "/tmp",
        limiter,
        runAgent: async () => "must not start",
        onAgentQueued: (event) => {
          event.runRecord = { runId: "run_target", event: async () => undefined, finish: async () => undefined } as any;
        },
        startAgentRun: (_call, run) => registry.start({
          runId: "run_target",
          kind: "agent",
          sessionId: "session",
          project: "/tmp",
          run,
        }).result,
      },
    );

    await vi.waitFor(() => expect(limiter.pendingCount).toBe(1));
    registry.cancel("run_target", "queued target is obsolete");
    release();
    await expect(result).resolves.toMatchObject({ result: {
      message: "queued target is obsolete",
      outcome: "cancelled",
      outputRef: { runId: "run_target", view: "output" },
      diagnosticsRef: { runId: "run_target", view: "diagnostics" },
    } });
  });

  it("aborts and drains siblings after an unhandled child failure", async () => {
    let slowDrained = false;
    const recorded: any[] = [];
    const failure = runWorkflow(
      `${META}return await parallel([
        () => agent('slow', { label: 'slow' }),
        () => agent('bad', { label: 'bad' }),
      ]);`,
      {
        cwd: "/tmp",
        limiter: new ConcurrencyLimiter(2),
        runAgent: async (call, signal) => {
          if (call.label === "bad") {
            throw new ChildRunError({ runId: "run_bad", outcome: "failed", message: "bad child" });
          }
          return await new Promise((_resolve, reject) => {
            signal?.addEventListener("abort", () => {
              slowDrained = true;
              reject(new Error("slow child aborted"));
            }, { once: true });
          });
        },
        onAgentQueued: (event) => {
          event.runRecord = { runId: `run_${event.label}`, event: async () => undefined, finish: async () => undefined } as any;
        },
        onAgentResult: (event) => { recorded.push(event); },
      },
    );

    await expect(failure).rejects.toMatchObject({ name: "ChildRunError", runId: "run_bad" });
    expect(slowDrained).toBe(true);
    expect(recorded).toEqual(expect.arrayContaining([
      expect.objectContaining({ runId: "run_bad", failed: true, error: expect.objectContaining({ outcome: "failed" }) }),
      expect.objectContaining({ runId: "run_slow", failed: true, error: expect.objectContaining({ outcome: "cancelled", outputRef: { runId: "run_slow", view: "output" }, diagnosticsRef: { runId: "run_slow", view: "diagnostics" } }) }),
    ]));
  });

  it("bounds fatal cleanup when a child ignores cancellation", async () => {
    const logs: string[] = [];
    const failure = runWorkflow(
      `${META}return await parallel([() => agent('stuck', { label: 'stuck' }), () => agent('bad', { label: 'bad' })]);`,
      {
        cwd: "/tmp",
        limiter: new ConcurrencyLimiter(2),
        limits: { abortGraceMs: 20 },
        onLog: (message) => logs.push(message),
        runAgent: async (call) => {
          if (call.label === "bad") throw new ChildRunError({ runId: "run_bad", outcome: "failed", message: "bad child" });
          return await new Promise(() => {});
        },
      },
    );

    const outcome = await Promise.race([
      failure.then(() => "resolved", (error) => error),
      delay(200).then(() => "cleanup timed out"),
    ]);
    expect(outcome).toMatchObject({ name: "ChildRunError", runId: "run_bad" });
    expect(logs).toContain("workflow cleanup remains uncertain after 20ms");
  });

  it("propagates abort raised mid-run", async () => {
    const controller = new AbortController();
    const runAgent: WorkflowAgentRunner = async () => {
      controller.abort();
      return "late";
    };
    await expect(
      runWorkflow(`${META}return await agent('x', { label: 'a' });`, {
        cwd: "/tmp",
        limiter: new ConcurrencyLimiter(1),
        runAgent,
        signal: controller.signal,
      }),
    ).rejects.toThrow(/abort/i);
  });

  it("does not let scripts swallow abort and report success", async () => {
    const controller = new AbortController();
    await expect(
      runWorkflow(`${META}try { await agent('x', { label: 'a' }); } catch { return 'ignored abort'; }`, {
        cwd: "/tmp",
        limiter: new ConcurrencyLimiter(1),
        runAgent: async () => {
          controller.abort();
          return "late";
        },
        signal: controller.signal,
      }),
    ).rejects.toThrow(/abort/i);
  });

  it("terminates an async script worker that stalls after an await", async () => {
    await expect(
      runWorkflow(`${META}await Promise.resolve();\nwhile (true) {}`, {
        cwd: "/tmp",
        limiter: new ConcurrencyLimiter(1),
        runAgent: echo,
        limits: { workerHeartbeatIntervalMs: 10, workerStallTimeoutMs: 50, abortGraceMs: 10 },
      }),
    ).rejects.toThrow(/stalled/i);
  });

  it("terminates a responsive script worker that stops making workflow progress", async () => {
    await expect(
      runWorkflow(`${META}await new Promise(() => {});`, {
        cwd: "/tmp",
        limiter: new ConcurrencyLimiter(1),
        runAgent: echo,
        limits: { workerHeartbeatIntervalMs: 10, workerStallTimeoutMs: 1_000, workerIdleTimeoutMs: 50 },
      }),
    ).rejects.toThrow(/no progress/i);
  });

  it("enforces a maximum number of workflow agent calls", async () => {
    await expect(
      runWorkflow(`${META}return await parallel([1, 2, 3].map((i) => () => agent('x' + i, { label: 'a' + i })));`, {
        cwd: "/tmp",
        limiter: new ConcurrencyLimiter(2),
        runAgent: echo,
        limits: { maxAgentCalls: 2 },
      }),
    ).rejects.toThrow(/maximum workflow agent calls/i);
  });

  it("requires workflow limits to be positive integers", async () => {
    await expect(
      runWorkflow(`${META}return await agent('x');`, {
        cwd: "/tmp",
        limiter: new ConcurrencyLimiter(1),
        runAgent: echo,
        limits: { maxAgentCalls: 0.5 },
      }),
    ).rejects.toThrow(/positive integer/i);
  });

  it("rejects workflow results that cannot be represented as JSON", async () => {
    await expect(
      runWorkflow(`${META}await agent('x', { label: 'a' });\nreturn 1n;`, {
        cwd: "/tmp",
        limiter: new ConcurrencyLimiter(1),
        runAgent: echo,
      }),
    ).rejects.toThrow(/JSON-serializable/i);
  });

  it("rejects class instances in workflow results instead of flattening them", async () => {
    await expect(
      runWorkflow(`${META}await agent('x', { label: 'a' });\nclass Box { constructor() { this.value = 1; } }\nreturn new Box();`, {
        cwd: "/tmp",
        limiter: new ConcurrencyLimiter(1),
        runAgent: echo,
      }),
    ).rejects.toThrow(/non-plain object Box/i);
  });

  it("rejects class instances returned by subagents as child failures", async () => {
    class Box {
      value = 1;
    }
    const failure = runWorkflow(`${META}return await agent('x', { label: 'a' });`, {
      cwd: "/tmp",
      limiter: new ConcurrencyLimiter(1),
      runAgent: async () => new Box(),
    });
    await expect(failure).rejects.toMatchObject({ name: "ChildRunError", message: expect.stringMatching(/non-plain object Box/i) });
  });

  it("normalizes JSON-like workflow results to canonical JSON", async () => {
    const result = await runWorkflow(`${META}await agent('x', { label: 'a' });\nreturn { ok: true, omitted: undefined, bad: NaN, list: [undefined, Infinity, 'x'] };`, {
      cwd: "/tmp",
      limiter: new ConcurrencyLimiter(1),
      runAgent: echo,
    });
    expect(result.result).toEqual({ ok: true, bad: null, list: [null, null, "x"] });
  });

  it("requires every agent call to be awaited or returned", async () => {
    await expect(
      runWorkflow(`${META}return { pending: agent('x', { label: 'a' }) };`, {
        cwd: "/tmp",
        limiter: new ConcurrencyLimiter(1),
        runAgent: echo,
      }),
    ).rejects.toThrow(/awaited or returned/);
  });

  it("logs agent-result hook failures without aborting sibling work", async () => {
    let completed = 0;
    const logs: string[] = [];
    const result = await runWorkflow(`${META}return await parallel([\n() => agent('fast', { label: 'fast' }),\n() => agent('slow', { label: 'slow' })\n]);`, {
      cwd: "/tmp",
      limiter: new ConcurrencyLimiter(4),
      runAgent: async (call) => {
        if (call.label === "slow") await delay(5);
        completed++;
        return call.label;
      },
      onAgentResult: (event) => {
        if (event.label === "fast") {
          throw new Error("journal full");
        }
      },
      onLog: (message) => logs.push(message),
    });
    expect(result.result).toEqual(["fast", "slow"]);
    expect(completed).toBe(2);
    expect(logs.some((line) => line.includes("journal full"))).toBe(true);
  });

  it("reuses cached agent results for the longest unchanged prefix on resume", async () => {
    const firstRunEvents: any[] = [];
    const firstRun = await runWorkflow(
      `${META}const a = await agent('first', { label: 'one' });\nconst b = await agent('second', { label: 'two' });\nreturn [a, b];`,
      {
        cwd: "/tmp",
        limiter: new ConcurrencyLimiter(4),
        runAgent: async (call) => `${call.prompt}:live1`,
        onAgentResult: (event) => {
          firstRunEvents.push(event);
        },
      },
    );
    expect(firstRun.result).toEqual(["first:live1", "second:live1"]);

    const secondRunEvents: any[] = [];
    const livePrompts: string[] = [];
    const secondRun = await runWorkflow(
      `${META}const a = await agent('first', { label: 'one' });\nconst b = await agent('second changed', { label: 'two' });\nreturn [a, b];`,
      {
        cwd: "/tmp",
        limiter: new ConcurrencyLimiter(4),
        runAgent: async (call) => {
          livePrompts.push(call.prompt);
          return `${call.prompt}:live2`;
        },
        resumeAgentResults: firstRunEvents.map(({ index, fingerprint, result }) => ({
          index,
          fingerprint,
          result,
          ...(index === 1 ? { runId: "run_first" } : {}),
        })),
        onAgentResult: (event) => {
          secondRunEvents.push(event);
        },
      },
    );

    expect(secondRun.result).toEqual(["first:live1", "second changed:live2"]);
    expect(livePrompts).toEqual(["second changed"]);
    expect(secondRunEvents.map((event) => event.cached)).toEqual([true, false]);
    expect(secondRunEvents[0].runId).toBe("run_first");
  });

  it("does not replay cached failed agent results on resume", async () => {
    const firstRunEvents: any[] = [];
    const script = `${META}const a = await agent('first', { label: 'one' });\nlet b;\ntry { b = await agent('second', { label: 'two' }); } catch (error) { b = error.outcome; }\nconst c = await agent('third', { label: 'three' });\nreturn [a, b, c];`;
    await runWorkflow(script, {
      cwd: "/tmp",
      limiter: new ConcurrencyLimiter(4),
      runAgent: async (call) => {
        if (call.label === "two") throw new ChildRunError({ runId: "run_two", outcome: "failed", message: "transient" });
        return `${call.prompt}:live1`;
      },
      onAgentResult: (event) => {
        firstRunEvents.push(event);
      },
    });

    const liveLabels: string[] = [];
    const secondRunEvents: any[] = [];
    const second = await runWorkflow(script, {
      cwd: "/tmp",
      limiter: new ConcurrencyLimiter(4),
      runAgent: async (call) => {
        liveLabels.push(call.label);
        return `${call.prompt}:live2`;
      },
      resumeAgentResults: firstRunEvents.map(({ index, fingerprint, result, failed }) => ({ index, fingerprint, result, failed })),
      onAgentResult: (event) => {
        secondRunEvents.push(event);
      },
    });

    expect(second.result).toEqual(["first:live1", "second:live2", "third:live2"]);
    expect(liveLabels).toEqual(["two", "three"]);
    expect(secondRunEvents.map((event) => event.cached)).toEqual([true, false, false]);
  });

  it("emits phase, agent start/end, and failure-log progress events in order", async () => {
    const events: string[] = [];
    const runAgent: WorkflowAgentRunner = async (call) => {
      if (call.label === "boom") {
        throw new Error("kaboom");
      }
      return call.label;
    };
    await runWorkflow(
      `${META}phase('scan');\nawait agent('a', { label: 'ok' });\ntry { await agent('b', { label: 'boom' }); } catch {}\nreturn null;`,
      {
        cwd: "/tmp",
        limiter: new ConcurrencyLimiter(4),
        runAgent,
        onPhase: (title) => events.push(`phase:${title}`),
        onAgentStart: (event) => events.push(`start:${event.label}`),
        onAgentEnd: (event) => events.push(`end:${event.label}:${event.failed ? "fail" : "ok"}`),
        onLog: () => events.push("log"),
      },
    );
    expect(events).toContain("phase:scan");
    expect(events).toContain("start:ok");
    expect(events).toContain("end:ok:ok");
    expect(events).toContain("start:boom");
    expect(events).toContain("end:boom:fail");
    expect(events).toContain("log");
    expect(events.indexOf("phase:scan")).toBeLessThan(events.indexOf("start:ok"));
    expect(events.indexOf("start:ok")).toBeLessThan(events.indexOf("end:ok:ok"));
  });

  it("assigns each agent a distinct index even when labels collide", async () => {
    const ended: Array<{ index: number; failed?: boolean }> = [];
    const runAgent: WorkflowAgentRunner = async (call) => {
      if (call.prompt === "boom") throw new Error("kaboom");
      return call.label;
    };
    await runWorkflow(
      `${META}await parallel([\n() => agent('ok', { label: 'dup' }),\nasync () => { try { return await agent('boom', { label: 'dup' }); } catch { return null; } },\n]);\nreturn null;`,
      {
        cwd: "/tmp",
        limiter: new ConcurrencyLimiter(4),
        runAgent,
        onAgentEnd: (event) => ended.push({ index: event.index, failed: event.failed }),
      },
    );
    // Same label, distinct indices: the UI keys on index so the failure mark lands on the right row.
    expect(ended.map((event) => event.index).sort()).toEqual([1, 2]);
    expect(ended.map((event) => event.failed).sort()).toEqual([false, true]);
  });
});

describe("structured output capture", () => {
  it("captures the first successful call and ignores duplicate calls", async () => {
    const capture: StructuredOutputCapture = { value: undefined, called: false, count: 0, duplicateCall: false };
    const tool = createStructuredOutputTool({ type: "object" }, capture) as unknown as {
      execute: (id: string, params: unknown) => Promise<{ content: Array<{ text: string }>; terminate?: boolean }>;
    };

    const first = await tool.execute("c1", { kind: "first" });
    expect(capture.value).toEqual({ kind: "first" });
    expect(capture.called).toBe(true);
    expect(first.terminate).toBe(true);
    expect(first.content[0].text).toContain("received");

    const second = await tool.execute("c2", { kind: "second" });
    expect(capture.value).toEqual({ kind: "first" }); // first wins; not overwritten
    expect(capture.count).toBe(2);
    expect(capture.duplicateCall).toBe(true);
    expect(second.content[0].text).toContain("ignoring duplicate");
  });
});

describe("saved workflow registry", () => {
  function withTempDir<T>(fn: (dir: string) => T): T {
    const dir = mkdtempSync(join(tmpdir(), "pi-subagent-workflows-"));
    try {
      return fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  function workflowScript(name: string, description = "saved workflow"): string {
    return `export const meta = { apiVersion: 1, name: '${name}', description: '${description}' };\nreturn await agent('hello');`;
  }

  it("loads global saved workflows from the agent dir", () => {
    withTempDir((dir) => {
      const agentDir = join(dir, "agent");
      mkdirSync(join(agentDir, "workflows"), { recursive: true });
      writeFileSync(join(agentDir, "workflows", "audit.js"), workflowScript("audit-todos", "Audit TODOs"));

      const registry = loadSavedWorkflowRegistry({ agentDir, cwd: join(dir, "project"), projectTrusted: false });

      expect([...registry.workflows.keys()]).toEqual(["audit-todos"]);
      expect(registry.workflows.get("audit-todos")?.description).toBe("Audit TODOs");
    });
  });

  it("loads project workflows only when the project is trusted and lets project override global", () => {
    withTempDir((dir) => {
      const agentDir = join(dir, "agent");
      const cwd = join(dir, "project");
      mkdirSync(join(agentDir, "workflows"), { recursive: true });
      mkdirSync(join(cwd, ".pi", "workflows"), { recursive: true });
      writeFileSync(join(agentDir, "workflows", "review.js"), workflowScript("review", "Global review"));
      writeFileSync(join(cwd, ".pi", "workflows", "review.js"), workflowScript("review", "Project review"));

      const untrusted = loadSavedWorkflowRegistry({ agentDir, cwd, projectTrusted: false });
      expect(untrusted.workflows.get("review")?.description).toBe("Global review");

      const trusted = loadSavedWorkflowRegistry({ agentDir, cwd, projectTrusted: true });
      expect(trusted.workflows.get("review")?.description).toBe("Project review");
      expect(trusted.workflows.get("review")?.scope).toBe("project");
    });
  });

  it("skips invalid workflows and symlinks escaping the workflow root", () => {
    withTempDir((dir) => {
      const agentDir = join(dir, "agent");
      const workflowsDir = join(agentDir, "workflows");
      mkdirSync(workflowsDir, { recursive: true });
      writeFileSync(join(workflowsDir, "bad-meta.js"), "export const meta = buildMeta();\n");
      writeFileSync(join(dir, "outside.js"), workflowScript("outside"));
      symlinkSync(join(dir, "outside.js"), join(workflowsDir, "escape.js"));

      const registry = loadSavedWorkflowRegistry({ agentDir, cwd: join(dir, "project"), projectTrusted: false });

      expect([...registry.workflows.keys()]).toEqual([]);
      expect(registry.warnings.some((warning) => warning.includes("bad-meta"))).toBe(true);
      expect(registry.warnings.some((warning) => warning.includes("outside") || warning.includes("escape"))).toBe(true);
    });
  });

  it("rejects scriptPath workflows in saved roots when meta.name is not a saved-workflow name", () => {
    withTempDir((dir) => {
      const agentDir = join(dir, "agent");
      const workflowsDir = join(agentDir, "workflows");
      mkdirSync(workflowsDir, { recursive: true });
      const scriptPath = join(workflowsDir, "bad-name.js");
      writeFileSync(scriptPath, workflowScript("Bad Name"));

      const result = loadWorkflowScriptPath(scriptPath, { agentDir, cwd: join(dir, "project"), projectTrusted: false });

      expect(result.ok).toBe(false);
      expect(result.ok ? "" : result.message).toContain("meta.name must match");
    });
  });

  it("loads a resume journal up to a malformed trailing line", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-subagent-workflows-"));
    try {
      const runId = "wf_resume_test";
      writeFileSync(
        join(dir, `run-${runId}.jsonl`),
        [
          JSON.stringify({ type: "run_start", version: 1, apiVersion: 1, runId }),
          JSON.stringify({ type: "agent_result", index: 1, fingerprint: "a", result: "one" }),
          "{ truncated",
          JSON.stringify({ type: "agent_result", index: 2, fingerprint: "b", result: "two" }),
        ].join("\n"),
      );

      const journal = await loadWorkflowJournal(dir, runId);

      expect(journal?.agentResults).toEqual([{ index: 1, fingerprint: "a", result: "one", failed: false }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects replay journals from another normalized project", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-subagent-workflows-"));
    try {
      const sessionFile = join(dir, "session.jsonl");
      const workflowDir = join(dir, "session.workflows");
      const scriptPath = join(workflowDir, "saved.js");
      const script = workflowScript("saved");
      mkdirSync(workflowDir, { recursive: true });
      writeFileSync(scriptPath, script);
      const identity = createWorkflowRunIdentity(script, null);
      const journal = await createWorkflowJournalWriter({ dir: workflowDir, identity, name: "saved", source: "path", project: join(dir, "project-a"), scriptPath });
      await journal.complete("done");
      const ctx = {
        cwd: join(dir, "project-b", "..", "project-b"),
        isProjectTrusted: () => false,
        sessionManager: { isPersisted: () => true, getSessionFile: () => sessionFile },
      } as any;

      const prepared = await prepareWorkflowToolSource({ scriptPath, resumeFromRunId: identity.runId }, ctx);

      expect(prepared.ok).toBe(false);
      expect(prepared.ok ? "" : prepared.details.error).toMatch(/different project.*no children were launched/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects replay from an incompatible workflow API", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-subagent-workflows-"));
    try {
      const runId = "wf_legacy_test";
      writeFileSync(join(dir, `run-${runId}.jsonl`), `${JSON.stringify({ type: "run_start", version: 1, runId })}\n`);
      await expect(loadWorkflowJournal(dir, runId)).rejects.toThrow(/meta\.apiVersion: 1.*no children were launched/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("workflow frozen Pi descriptor", () => {
  it("carries the registration preset for Pi profiles and omits it for CLI profiles", () => {
    const skills = toWorkflowSubagentDescriptor({
      name: "pi-deepseek-reviewer",
      description: "x",
      backend: "pi",
      harness: "pi-deepseek",
      preset: "skills",
    });
    const legacy = toWorkflowSubagentDescriptor({
      name: "pi-deepseek-reviewer",
      description: "x",
      backend: "pi",
      harness: "pi-deepseek",
    });
    const claude = toWorkflowSubagentDescriptor({
      name: "claude-reviewer",
      description: "x",
      backend: "claude",
    });
    expect(skills.preset).toBe("skills");
    expect(legacy.preset).toBe("minimal");
    expect(claude.preset).toBeUndefined();
  });
});

describe("workflow tool registration", () => {
  function fakeApi(names: string[]) {
    const flags = new Map<string, boolean | string>();
    return {
      registerTool: (tool: { name: string }) => names.push(tool.name),
      registerCommand: () => {},
      registerFlag: (name: string, options: { default?: boolean | string }) => {
        if (options.default !== undefined) flags.set(name, options.default);
      },
      getFlag: (name: string) => flags.get(name),
      on: () => {},
      getThinkingLevel: () => "high",
    };
  }

  it("registers both Agent and workflow by default", () => {
    const names: string[] = [];
    createSubagentExtension()(fakeApi(names) as never);
    expect(names).toContain("Agent");
    expect(names).toContain("external_help");
    expect(names).toContain("external_runs");
    expect(names).toContain("workflow");
  });

  it("omits the workflow tool when workflow is disabled", () => {
    const names: string[] = [];
    createSubagentExtension({ workflow: false })(fakeApi(names) as never);
    expect(names).toEqual(["Agent", "external_help", "external_runs", "pi_flow_role_create", "pi_flow_harness_create"]);
  });
});

describe("createWorkflowTool integration with pi custom profiles", () => {
  let agentDir = "";
  let cwd = "";
  const { createSession } = setupPiSubagentTestHarness((state) => {
    agentDir = state.agentDir;
    cwd = state.cwd;
  });

  function makeWorkflowTool(registry = new RunRegistry()) {
    return createWorkflowTool({
      registry,
      getLimiter: () => new ConcurrencyLimiter(2),
      getThinkingLevel: () => "high",
      getSubagentTimeoutMs: () => 60_000,
      getDefaultPermission: () => "edit",
      getDefaultHarness: () => "pi-deepseek",
      getDefaultMaxBudgetUsd: () => undefined,
      updateStatus: () => {},
    });
  }

  it("executes an on-disk pi custom profile omitting model/thinking without poisoning from a conflicting profile", async () => {
    const { session, modelRegistry, registration } = await createSession({
      piHarnesses: {
        "pi-deepseek": { modelId: "faux-thinker", thinking: "high" },
      },
    });
    registration.setResponses([() => fauxAssistantMessage("CUSTOM_PI_WORKFLOW_OK")]);

    const subagentsDir = join(agentDir, "pi-flow-external", "overrides");
    mkdirSync(subagentsDir, { recursive: true });

    // 1. An on-disk custom profile that omits model and thinking (inheriting from harness pi-deepseek)
    writeFileSync(
      join(subagentsDir, "pi-deepseek-custom.md"),
      [
        "---",
        "description: Custom reviewer",
        "backend: pi",
        "harness: pi-deepseek",
        "---",
        "You are a custom reviewer.",
      ].join("\n"),
    );

    // 2. An on-disk profile with a conflicting model
    writeFileSync(
      join(subagentsDir, "pi-deepseek-conflicting.md"),
      [
        "---",
        "description: Conflicting reviewer",
        "backend: pi",
        "harness: pi-deepseek",
        "model: openai/gpt-5",
        "---",
        "You are conflicting.",
      ].join("\n"),
    );

    const tool = makeWorkflowTool();
    const ctx = {
      cwd,
      modelRegistry,
      sessionManager: session.sessionManager,
      isProjectTrusted: () => true,
    } as unknown as ExtensionContext;

    // Run workflow that selects the custom profile omitting model/thinking:
    const result = await tool.execute(
      "call-custom-1",
      {
        script: `
          export const meta = { apiVersion: 1, name: "custom-run", description: "runs custom profile" };
          const resp = await agent("test task", { role: "custom", harness: "pi-deepseek" });
          return { resp };
        `,
      },
      undefined,
      undefined,
      ctx,
    );

    expect(result.details.status).toBe("completed");
    // Additive normalized field: a coordinating model reading either tool's
    // details sees the same "done" vocabulary Agent's own details.status
    // already uses, without workflow's internal "completed" state name
    // changing for existing readers (journal/replay/rendering).
    expect(result.details.lifecycleStatus).toBe("done");
    expect(result.details.result).toEqual({ resp: "CUSTOM_PI_WORKFLOW_OK" });
  });

  it("keeps a workflow child's queued state and queuedAt visible in the registry before its concurrency slot is granted", async () => {
    const { session, modelRegistry, registration } = await createSession({
      piHarnesses: { "pi-deepseek": { modelId: "faux-thinker", thinking: "high" } },
    });
    registration.setResponses([() => fauxAssistantMessage("done")]);

    const subagentsDir = join(agentDir, "pi-flow-external", "overrides");
    mkdirSync(subagentsDir, { recursive: true });
    writeFileSync(
      join(subagentsDir, "pi-deepseek-custom.md"),
      "---\ndescription: Custom reviewer.\nbackend: pi\nharness: pi-deepseek\n---\nCustom.\n",
    );

    const registry = new RunRegistry();
    // Saturate the only slot externally before the workflow ever queues its
    // own child, so the child is guaranteed to sit queued (not racing a real
    // backend response) until this test explicitly releases it.
    const limiter = new ConcurrencyLimiter(1);
    const releaseExternalSlot = await limiter.acquire();
    const tool = createWorkflowTool({
      registry,
      getLimiter: () => limiter,
      getThinkingLevel: () => "high",
      getSubagentTimeoutMs: () => 60_000,
      getDefaultPermission: () => "edit",
      getDefaultHarness: () => "pi-deepseek",
      getDefaultMaxBudgetUsd: () => undefined,
      updateStatus: () => {},
    });
    const ctx = {
      cwd,
      modelRegistry,
      sessionManager: session.sessionManager,
      isProjectTrusted: () => true,
    } as unknown as ExtensionContext;

    const runPromise = tool.execute(
      "queued-visibility",
      {
        script: `
          export const meta = { apiVersion: 1, name: "queued-visibility", description: "queue visibility" };
          const value = await agent("only child", { role: "custom", harness: "pi-deepseek", label: "only" });
          return { value };
        `,
      },
      undefined,
      undefined,
      ctx,
    );

    const sessionId = session.sessionManager.getSessionId();
    const project = resolve(cwd);
    let queuedEntry: { observation?: unknown } | undefined;
    await vi.waitFor(() => {
      queuedEntry = registry.list(sessionId, project).find((entry) => entry.kind === "agent");
      expect(queuedEntry).toBeDefined();
    }, { timeout: 5_000 });
    // This is the fix under test: without an initial registry.update() seed at
    // queue time (mirroring the direct Agent tool's own top-of-executeRun
    // update), a workflow child had no observation at all until its first
    // real progress event — after limiter acquisition — so a still-queued
    // child would default to reporting "running" with no queuedAt instead of
    // visibly queued.
    expect(queuedEntry?.observation).toMatchObject({ status: "queued", queuedAt: expect.any(Number) });

    releaseExternalSlot();
    const result = await runPromise;
    expect(result.details.status).toBe("completed");
    expect(result.details.result).toEqual({ value: "done" });
  });

  it("transitions a workflow child's OWN registry entry from queued to running with executionStartedAt immediately after its concurrency slot is granted, strictly before any backend progress arrives", async () => {
    const { session, modelRegistry, registration } = await createSession({
      piHarnesses: { "pi-deepseek": { modelId: "faux-thinker", thinking: "high" } },
    });
    // Hold the backend's only response indefinitely so nothing downstream of
    // session.prompt() (real backend progress) can possibly have happened yet
    // while this test inspects the registry.
    let resolveResponse!: (value: AssistantMessage) => void;
    const heldResponse = new Promise<AssistantMessage>((resolve) => { resolveResponse = resolve; });
    registration.setResponses([() => heldResponse]);

    const subagentsDir = join(agentDir, "pi-flow-external", "overrides");
    mkdirSync(subagentsDir, { recursive: true });
    writeFileSync(
      join(subagentsDir, "pi-deepseek-custom.md"),
      "---\ndescription: Custom reviewer.\nbackend: pi\nharness: pi-deepseek\n---\nCustom.\n",
    );

    const registry = new RunRegistry();
    let childRunId: string | undefined;
    const capturedUpdates: unknown[] = [];
    const originalUpdate = registry.update.bind(registry);
    vi.spyOn(registry, "update").mockImplementation((runId: string, observation: unknown) => {
      if (childRunId !== undefined && runId === childRunId) capturedUpdates.push(observation);
      return originalUpdate(runId, observation);
    });

    const limiter = new ConcurrencyLimiter(1);
    const releaseExternalSlot = await limiter.acquire();
    const tool = createWorkflowTool({
      registry,
      getLimiter: () => limiter,
      getThinkingLevel: () => "high",
      getSubagentTimeoutMs: () => 60_000,
      getDefaultPermission: () => "edit",
      getDefaultHarness: () => "pi-deepseek",
      getDefaultMaxBudgetUsd: () => undefined,
      updateStatus: () => {},
    });
    const ctx = {
      cwd,
      modelRegistry,
      sessionManager: session.sessionManager,
      isProjectTrusted: () => true,
    } as unknown as ExtensionContext;

    const runPromise = tool.execute(
      "execution-transition",
      {
        script: `
          export const meta = { apiVersion: 1, name: "execution-transition", description: "transition visibility" };
          const value = await agent("only child", { role: "custom", harness: "pi-deepseek", label: "only" });
          return { value };
        `,
      },
      undefined,
      undefined,
      ctx,
    );

    const sessionId = session.sessionManager.getSessionId();
    const project = resolve(cwd);
    await vi.waitFor(() => {
      const entry = registry.list(sessionId, project).find((item) => item.kind === "agent");
      expect(entry).toBeDefined();
      childRunId = entry!.runId;
      expect((entry!.observation as { status?: string } | undefined)?.status).toBe("queued");
    }, { timeout: 5_000 });

    releaseExternalSlot();

    // The child's own registry entry (not just the workflow's aggregate
    // snapshot) must leave "queued" for "running" while the backend response
    // is still held — i.e. strictly before any backend progress could have
    // arrived.
    await vi.waitFor(() => {
      const entry = registry.get(childRunId!);
      expect((entry?.observation as { status?: string } | undefined)?.status).toBe("running");
    }, { timeout: 5_000 });

    // The FIRST observation reporting "running" must be the small, explicit
    // update wired at the onAgentStart boundary ({status, executionStartedAt,
    // queuedAt, description, backend}) — not a full SubagentProgressNode
    // (which would carry `activity`/`id` fields) from spawnSubagent's own
    // onProgress. This is exactly the fix under test: without it, the
    // child's OWN registry entry only ever left "queued" once real backend
    // progress arrived deep inside spawnSubagent, well after the limiter had
    // already granted its slot.
    const firstRunning = capturedUpdates.find((observation) => (observation as { status?: string }).status === "running");
    expect(firstRunning).toMatchObject({ status: "running", executionStartedAt: expect.any(Number), queuedAt: expect.any(Number) });
    expect(firstRunning).not.toHaveProperty("activity");
    expect(firstRunning).not.toHaveProperty("id");

    resolveResponse(fauxAssistantMessage("done"));
    const result = await runPromise;
    expect(result.details.status).toBe("completed");
    expect(result.details.result).toEqual({ value: "done" });
  });

  it("fails only when conflicting profile is specifically selected", async () => {
    const { session, modelRegistry } = await createSession({
      piHarnesses: {
        "pi-deepseek": { modelId: "faux-thinker", thinking: "high" },
      },
    });

    const subagentsDir = join(agentDir, "pi-flow-external", "overrides");
    mkdirSync(subagentsDir, { recursive: true });

    writeFileSync(
      join(subagentsDir, "pi-deepseek-conflicting.md"),
      [
        "---",
        "description: Conflicting reviewer",
        "backend: pi",
        "harness: pi-deepseek",
        "model: openai/gpt-5",
        "---",
        "You are conflicting.",
      ].join("\n"),
    );

    const tool = makeWorkflowTool();
    const ctx = {
      cwd,
      modelRegistry,
      sessionManager: session.sessionManager,
      isProjectTrusted: () => true,
    } as unknown as ExtensionContext;

    // Selecting the conflicting profile via subagent_type
    const result = await tool.execute(
      "call-conflict-1",
      {
        script: `
          export const meta = { apiVersion: 1, name: "conflict-run", description: "runs conflicting profile" };
          return await agent("test task", { subagent_type: "pi-deepseek-conflicting" });
        `,
      },
      undefined,
      undefined,
      ctx,
    );

    expect(result.details.status).toBe("error");
    expect(result.details.error).toMatch(/conflicts with "pi-deepseek"'s registered model/);
  });

  it("exposes interrupted child output in the terminal workflow receipt when a child fails", async () => {
    const { session, modelRegistry, registration } = await createSession({
      piHarnesses: {
        "pi-deepseek": { modelId: "faux-thinker", thinking: "high" },
      },
    });
    registration.setResponses([
      () => fauxAssistantMessage("partial child analysis before fail", { stopReason: "error", errorMessage: "quota exceeded" }),
    ]);

    const tool = makeWorkflowTool();
    const ctx = {
      cwd,
      modelRegistry,
      sessionManager: session.sessionManager,
      isProjectTrusted: () => true,
    } as unknown as ExtensionContext;

    const result = await tool.execute(
      "call-fail-output",
      {
        script: `
          export const meta = { apiVersion: 1, name: "fail-run", description: "fails with output" };
          return await agent("failing task", { role: "worker", harness: "pi-deepseek" });
        `,
      },
      undefined,
      undefined,
      ctx,
    );

    expect(result.details.status).toBe("error");
    expect((result.content[0] as { text: string }).text).toContain("Interrupted child output");
    expect((result.content[0] as { text: string }).text).toContain("partial child analysis before fail");
  });
});
