import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxToolCall, type Context } from "../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/index.js";
import type { SubagentProfile } from "../src/types.ts";
import { buildOpencodeArgs, buildOpencodeEnv, spawnOpencodeSubagent } from "../src/core/opencode.ts";
import { hasNestedAgentActivity } from "../src/core/spawn.ts";
import { inspectRun } from "../src/core/run-inspection.ts";
import { loadExternalCatalog, resolveExternalProfile } from "../src/profiles.ts";
import { setupPiSubagentTestHarness } from "./helpers/pi-subagent-harness.ts";

const SESSION = "ses_root";

/**
 * Source for a fake `opencode` binary. It records argv, the stdin prompt,
 * the project directory inputs, and the injected OPENCODE_CONFIG_CONTENT,
 * then prints the given events in the `opencode run --format json` line
 * shape (@opencode/cli 2.0.16 packages/cli/src/run/noninteractive.ts:
 * `{type, timestamp, sessionID, ...data}`).
 */
function fakeOpencode(infoPath: string, body: string): string {
  return `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
let stdin = '';
for await (const chunk of process.stdin) stdin += chunk;
writeFileSync(${JSON.stringify(infoPath)}, JSON.stringify({ args: process.argv.slice(2), stdin, pwd: process.env.PWD, cwd: process.cwd(), config: process.env.OPENCODE_CONFIG_CONTENT ?? null }));
const emit = (type, data, sessionID = ${JSON.stringify(SESSION)}) => console.log(JSON.stringify({ type, timestamp: 1, sessionID, ...data }));
const part = (fields, sessionID = ${JSON.stringify(SESSION)}) => ({ id: 'prt_' + Math.random().toString(36).slice(2), messageID: 'msg_1', sessionID, ...fields });
${body}
`;
}

const profile = (fields: Partial<SubagentProfile> = {}): SubagentProfile => ({
  name: "opencode-worker",
  description: "OpenCode worker",
  backend: "opencode",
  ...fields,
});

describe("opencode backend", () => {
  let tempDir = "";
  let cwd = "";
  let agentDir = "";
  let originalPathEnv: string | undefined;

  const { createSession, disposeSession } = setupPiSubagentTestHarness((state) => {
    tempDir = state.tempDir;
    cwd = state.cwd;
    agentDir = state.agentDir;
    originalPathEnv = state.originalPathEnv;
  });

  function installFake(name: string, body: string): string {
    const binDir = join(tempDir, `bin-${name}`);
    const infoPath = join(tempDir, `${name}-info.json`);
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, "opencode"), fakeOpencode(infoPath, body));
    chmodSync(join(binDir, "opencode"), 0o755);
    process.env.PATH = `${binDir}:${originalPathEnv ?? ""}`;
    return infoPath;
  }

  function run(overrides: Partial<Parameters<typeof spawnOpencodeSubagent>[0]> = {}) {
    return spawnOpencodeSubagent({
      toolCallId: "call_opencode",
      description: "OpenCode run",
      prompt: "Do the task.",
      profile: profile(),
      ctx: { cwd } as ExtensionContext,
      signal: undefined,
      progressEnabled: false,
      onProgress: undefined,
      onUsage: () => undefined,
      ...overrides,
    });
  }

  it("always runs standalone, maps tiers to --auto or a per-run deny-by-default agent, and refuses to clobber an existing inline config", () => {
    expect(buildOpencodeArgs({ profile: profile({ model: "anthropic/claude-sonnet-4-5", thinking: "high" }), permission: "danger", resumeSessionId: "ses_prior" }))
      .toEqual(["run", "--standalone", "--format", "json", "--session", "ses_prior", "--model", "anthropic/claude-sonnet-4-5#high", "--auto"]);
    expect(buildOpencodeArgs({ profile: profile(), permission: "readonly" }))
      .toEqual(["run", "--standalone", "--format", "json"]);

    const base = { PATH: "/bin" };
    expect(buildOpencodeEnv("danger", base)).toBe(base);
    const deny = { action: "*", resource: "*", effect: "deny" };
    const allow = (action: string) => ({ action, resource: "*", effect: "allow" });
    expect(JSON.parse(buildOpencodeEnv("readonly", base, "n1").OPENCODE_CONFIG_CONTENT!)).toEqual({
      default_agent: "pi-flow-readonly-n1",
      agents: { "pi-flow-readonly-n1": { mode: "primary", permissions: [deny, allow("read"), allow("grep"), allow("glob")] } },
    });
    expect(JSON.parse(buildOpencodeEnv("edit", base, "n2").OPENCODE_CONFIG_CONTENT!).agents["pi-flow-edit-n2"].permissions)
      .toEqual([deny, allow("read"), allow("grep"), allow("glob"), allow("edit")]);
    // The agent name is unpredictable, so a project file cannot pre-seed rules for it.
    expect(buildOpencodeEnv("readonly", base).OPENCODE_CONFIG_CONTENT).not.toBe(buildOpencodeEnv("readonly", base).OPENCODE_CONFIG_CONTENT);
    expect(() => buildOpencodeEnv("edit", { OPENCODE_CONFIG_CONTENT: "{}" })).toThrow(/already set/);
  });

  it("blocks an opencode override whose thinking has no model to be a variant of, or whose model lacks a provider", () => {
    const overrides = join(agentDir, "pi-flow-external", "overrides");
    mkdirSync(overrides, { recursive: true });
    writeFileSync(join(agentDir, "pi-flow-external", "settings.json"), JSON.stringify({ version: 4 }));
    writeFileSync(join(overrides, "opencode-reviewer.md"), "---\ndescription: Review\nbackend: opencode\nthinking: high\n---\nReview.");
    writeFileSync(join(overrides, "opencode-planner.md"), "---\ndescription: Plan\nbackend: opencode\nmodel: sonnet\n---\nPlan.");
    writeFileSync(join(overrides, "opencode-explorer.md"), "---\ndescription: Explore\nbackend: opencode\nmodel: openai/gpt-5#low\nthinking: high\n---\nExplore.");
    writeFileSync(join(overrides, "opencode-qa.md"), "---\ndescription: QA\nbackend: opencode\nmodel: openrouter/anthropic/claude\nthinking: max\n---\nQA.");
    const catalog = loadExternalCatalog(agentDir);
    expect(() => resolveExternalProfile(catalog.profiles, { role: "reviewer", harness: "opencode" }, "agy")).toThrow(/without a model/);
    expect(() => resolveExternalProfile(catalog.profiles, { role: "planner", harness: "opencode" }, "agy")).toThrow(/provider\/model/);
    expect(() => resolveExternalProfile(catalog.profiles, { role: "explorer", harness: "opencode" }, "agy")).toThrow(/Keep one/);
    expect(resolveExternalProfile(catalog.profiles, { role: "qa", harness: "opencode" }, "agy")).toMatchObject({ model: "openrouter/anthropic/claude", thinking: "max" });
  });

  it("finalizes on exit 0 with the root session's last-step text even when OpenCode drops the final step_finish", async () => {
    // Recorded 2.0.16 shape: the final step_finish is often missing because
    // the CLI stops forwarding step events once session.wait resolves.
    const infoPath = installFake("success", `
emit('step_start', { part: part({ type: 'step-start' }) });
emit('text', { part: part({ type: 'text', text: 'Looking first.' }) });
emit('tool_use', { part: part({ type: 'tool', tool: 'shell', state: { status: 'error', error: 'Permission denied: shell' } }) });
emit('step_finish', { part: part({ type: 'step-finish', reason: 'tool-calls', tokens: { input: 100, output: 10, reasoning: 5, cache: { read: 40, write: 2 } }, cost: 0.01 }) });
emit('text', { part: part({ type: 'text', text: 'foreign answer' }, 'ses_other') }, 'ses_other');
emit('error', { error: { type: 'unknown', message: 'foreign failure' } }, 'ses_other');
emit('step_start', { part: part({ type: 'step-start' }) });
emit('text', { part: part({ type: 'text', text: 'Final answer.' }) });
`);
    const result = await run({ profile: profile({ systemPrompt: "Be careful." }), permission: "readonly" });

    expect(result.details).toMatchObject({
      status: "done",
      result: "Final answer.",
      sessionId: SESSION,
      permissionDenials: 1,
      assistantOutput: { status: "final", messages: [{ text: "Final answer." }] },
    });
    // The final step's usage never arrived, so the root total is not known.
    expect(result.details.usage).toEqual({ input: 100, output: 15, cacheRead: 40, cacheWrite: 2, cost: 0.01, costKnown: false, costEstimated: false });
    const info = JSON.parse(readFileSync(infoPath, "utf8"));
    expect(info.args).toEqual(["run", "--standalone", "--format", "json"]);
    expect(info).toMatchObject({ stdin: "Be careful.\n\nDo the task.", pwd: cwd });
    expect(JSON.parse(info.config).agents).toBeDefined();
  });

  it.each([
    ["a final tool-calls step", `emit('step_start', { part: part({ type: 'step-start' }) });
emit('text', { part: part({ type: 'text', text: 'partial work' }) });
emit('step_finish', { part: part({ type: 'step-finish', reason: 'tool-calls' }) });`, /reason "tool-calls", not "stop"/],
    ["an exit without any model step", `emit('text', { part: part({ type: 'text', text: 'partial work' }) });`, /without running a model step/],
    ["an error event", `emit('text', { part: part({ type: 'text', text: 'partial work' }) });
emit('error', { error: { type: 'provider.no-route', message: 'Variant unavailable for a/b: max' } });
process.exitCode = 1;`, /opencode failed: Variant unavailable for a\/b: max/],
    ["a session-less error before the run", `emit('text', { part: part({ type: 'text', text: 'partial work' }) });
emit('error', { error: { type: 'unknown', message: 'Session not found' } }, '');
process.exitCode = 1;`, /opencode failed: Session not found/],
    ["a nonzero exit", `emit('text', { part: part({ type: 'text', text: 'partial work' }) });
console.error('boom');
process.exitCode = 1;`, /exited with code 1: boom/],
    ["an auto-rejected permission ask that still exits 0", `emit('step_start', { part: part({ type: 'step-start' }) });
emit('text', { part: part({ type: 'text', text: 'partial work' }) });
console.error('! permission requested: external_directory (/etc/*); auto-rejecting');`, /auto-rejected a permission request/],
  ])("fails on %s and keeps partial text as interrupted output", async (_label, body, error) => {
    installFake("failure", body);
    const result = await run();
    expect(result.details.status).toBe("error");
    expect(result.details.error).toMatch(error);
    expect(result.details.assistantOutput).toEqual({ status: "interrupted", messages: [{ text: "partial work" }] });
  });

  it("resumes with --session and rejects a stream for a different session", async () => {
    const infoPath = installFake("resume", `
emit('step_start', { part: part({ type: 'step-start' }) });
emit('text', { part: part({ type: 'text', text: 'Resumed.' }) });
emit('step_finish', { part: part({ type: 'step-finish', reason: 'stop' }) });
`);
    const resumed = await run({ resumeSessionId: SESSION, permission: "danger" });
    expect(resumed.details).toMatchObject({ status: "done", sessionId: SESSION });
    expect(JSON.parse(readFileSync(infoPath, "utf8")).args).toEqual(["run", "--standalone", "--format", "json", "--session", SESSION, "--auto"]);

    const forked = await run({ resumeSessionId: "ses_prior" });
    expect(forked.details.status).toBe("error");
    expect(forked.details.error).toContain("not the resumed session ses_prior");
  });

  it("treats a subagent tool as nested activity and its unstreamed child usage as unknown cost", async () => {
    const taskEvent = { type: "tool_use", sessionID: SESSION, part: { type: "tool", tool: "subagent", sessionID: SESSION, state: { status: "completed" } } };
    expect(hasNestedAgentActivity(taskEvent, "opencode")).toBe(true);
    expect(hasNestedAgentActivity({ ...taskEvent, part: { ...taskEvent.part, tool: "shell" } }, "opencode")).toBe(false);

    installFake("nested", `
emit('step_start', { part: part({ type: 'step-start' }) });
emit('tool_use', { part: part({ type: 'tool', tool: 'subagent', state: { status: 'completed' } }) });
emit('text', { part: part({ type: 'text', text: 'Delegated.' }) });
emit('step_finish', { part: part({ type: 'step-finish', reason: 'stop', tokens: { input: 5, output: 1 }, cost: 0.001 }) });
`);
    const result = await run();
    expect(result.details.status).toBe("done");
    expect(result.details.usage).toMatchObject({ input: 5, cost: 0.001, costKnown: false });
  });

  it("rejects a structured-output schema before launching opencode", async () => {
    const infoPath = installFake("schema", "");
    const result = await run({ outputSchema: { type: "object" } });
    expect(result.details.status).toBe("error");
    expect(result.details.error).toMatch(/no native output-schema option/);
    expect(existsSync(infoPath)).toBe(false);
  });

  it("kills the opencode process tree on abort and keeps streamed text", async () => {
    const pidPath = join(tempDir, "grandchild.pid");
    installFake("abort", `
import { spawn } from 'node:child_process';
const grandchild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
writeFileSync(${JSON.stringify(pidPath)}, String(grandchild.pid));
emit('step_start', { part: part({ type: 'step-start' }) });
emit('text', { part: part({ type: 'text', text: 'working on it' }) });
setTimeout(() => {}, 60000);
`);
    const controller = new AbortController();
    const pending = run({
      signal: controller.signal,
      progressEnabled: true,
      onProgress: (partial) => {
        if ((partial.details.progress?.activity ?? []).some((line) => line.includes("working on it"))) controller.abort();
      },
    });
    const result = await pending;
    expect(result.details.status).toBe("aborted");
    expect(result.details.assistantOutput).toEqual({ status: "interrupted", messages: [{ text: "working on it" }] });
    const grandchild = Number(readFileSync(pidPath, "utf8"));
    await expect.poll(() => {
      try {
        process.kill(grandchild, 0);
        return "alive";
      } catch {
        return "gone";
      }
    }, { timeout: 5000 }).toBe("gone");
  });

  it("runs through the Agent tool with a session receipt and reconstructable output", async () => {
    installFake("agent-tool", `
emit('step_start', { part: part({ type: 'step-start' }) });
emit('text', { part: part({ type: 'text', text: 'opencode child done' }) });
emit('step_finish', { part: part({ type: 'step-finish', reason: 'stop', tokens: { input: 3, output: 2 }, cost: 0 }) });
`);
    const { session, registration } = await createSession();
    let rootContinuationContext: Context | undefined;
    registration.setResponses([
      fauxAssistantMessage([fauxToolCall("Agent", { description: "OpenCode work", role: "worker", harness: "opencode", prompt: "Do the task." })], { stopReason: "toolUse" }),
      (context) => {
        rootContinuationContext = context;
        return fauxAssistantMessage("reported");
      },
    ]);

    await session.prompt("Delegate to OpenCode.");

    expect(JSON.stringify(rootContinuationContext?.messages)).toContain("opencode child done");
    const recordsRoot = join(agentDir, "pi-flow-external", "runs");
    const [runId] = readdirSync(recordsRoot);
    const summary = JSON.parse(readFileSync(join(recordsRoot, runId!, "summary.json"), "utf8")).summary;
    expect(summary).toMatchObject({
      backend: "opencode",
      profile: "opencode-worker",
      status: "done",
      backendEventCount: 3,
      permission: { tier: "danger", enforced: true },
      sessionId: SESSION,
      usage: { input: 3, output: 2, cost: 0, costKnown: true, costEstimated: false },
    });
    const page = await inspectRun({ runsDirectory: recordsRoot, runId: runId!, view: "output" });
    expect(page.items.map((item) => item.text)).toEqual(["opencode child done"]);
    disposeSession(session);
  });
});
