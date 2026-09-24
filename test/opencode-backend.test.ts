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
 * Source for a fake `opencode` binary with the two commands the adapter uses
 * (@opencode/cli 2.0.16).
 *
 * `run` records argv, the stdin prompt, the project directory inputs, and the
 * injected OPENCODE_CONFIG_CONTENT, then prints `body`'s events in the
 * `--format json` line shape (packages/cli/src/run/noninteractive.ts).
 *
 * `session export` prints the persisted session shape observed from the real
 * CLI: `{info, messages}` with user/assistant/idle messages. `exportBody`
 * builds it from `run` (the recorded run, or null before it) and `prior`
 * (messages from an earlier turn). By default, once the run happened, the
 * export holds a clean new turn for the recorded prompt, answered by the
 * agent the run was given, after `prior` when the run resumed.
 */
function fakeOpencode(infoPath: string, body: string, exportBody: string): string {
  return `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === 'session' && args[1] === 'export') {
  appendFileSync(${JSON.stringify(infoPath)} + '.exports', args[3] + '\\n');
  const run = existsSync(${JSON.stringify(infoPath)}) ? JSON.parse(readFileSync(${JSON.stringify(infoPath)}, 'utf8')) : null;
  const ran = run ? (run.args.includes('--agent') ? run.args[run.args.indexOf('--agent') + 1] : 'build') : undefined;
  const user = (id, text) => ({ id, type: 'user', text, time: { created: 1 } });
  const assistant = (id, text, extra = {}) => ({ id, type: 'assistant', agent: ran ?? 'build', finish: 'stop', time: { created: 2, completed: 3 }, content: [{ type: 'text', text }], tokens: { input: 7, output: 3, reasoning: 1, cache: { read: 5, write: 0 } }, cost: 0.02, ...extra });
  const idle = (outcome = 'succeeded') => ({ id: 'msg_idle_' + Math.random().toString(36).slice(2), type: 'idle', outcome, time: { created: 4 } });
  const prior = [user('msg_old_user', 'Earlier prompt.'), assistant('msg_old_answer', 'Earlier answer.', { agent: 'build' }), idle()];
  const session = (messages, info = {}) => console.log(JSON.stringify({ info: { id: args[3], outcome: 'succeeded', ...info }, messages }));
  ${exportBody}
  process.exit(0);
}
let stdin = '';
for await (const chunk of process.stdin) stdin += chunk;
writeFileSync(${JSON.stringify(infoPath)}, JSON.stringify({ args, stdin, pwd: process.env.PWD, cwd: process.cwd(), config: process.env.OPENCODE_CONFIG_CONTENT ?? null }));
const emit = (type, data, sessionID = ${JSON.stringify(SESSION)}) => console.log(JSON.stringify({ type, timestamp: 1, sessionID, ...data }));
const part = (fields, sessionID = ${JSON.stringify(SESSION)}) => ({ id: 'prt_' + Math.random().toString(36).slice(2), messageID: 'msg_1', sessionID, ...fields });
${body}
`;
}

// A resumed session keeps its earlier turn; a new session has only this run's.
const DEFAULT_EXPORT = `session(run ? [...(run.args.includes('--session') ? prior : []), user('msg_new_user', run.stdin), assistant('msg_new_answer', 'Final answer.'), idle()] : prior);`;
const STREAM = `emit('step_start', { part: part({ type: 'step-start' }) });
emit('text', { part: part({ type: 'text', text: 'streamed narration' }) });`;

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

  function installFake(name: string, body: string, exportBody = DEFAULT_EXPORT): string {
    const binDir = join(tempDir, `bin-${name}`);
    const infoPath = join(tempDir, `${name}-info.json`);
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, "opencode"), fakeOpencode(infoPath, body, exportBody));
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

  it("always runs standalone, selects the injected agent explicitly on restricted tiers, and refuses to clobber an existing inline config", () => {
    expect(buildOpencodeArgs({ profile: profile({ model: "anthropic/claude-sonnet-4-5", thinking: "high" }), permission: "danger", resumeSessionId: "ses_prior" }))
      .toEqual(["run", "--standalone", "--format", "json", "--session", "ses_prior", "--model", "anthropic/claude-sonnet-4-5#high", "--auto"]);
    expect(buildOpencodeArgs({ profile: profile(), permission: "readonly", resumeSessionId: "ses_prior", agent: "pi-flow-readonly-n1" }))
      .toEqual(["run", "--standalone", "--format", "json", "--session", "ses_prior", "--agent", "pi-flow-readonly-n1"]);

    const base = { PATH: "/bin" };
    expect(buildOpencodeEnv("danger", base, undefined)).toBe(base);
    const deny = { action: "*", resource: "*", effect: "deny" };
    const allow = (action: string) => ({ action, resource: "*", effect: "allow" });
    expect(JSON.parse(buildOpencodeEnv("readonly", base, "pi-flow-readonly-n1").OPENCODE_CONFIG_CONTENT!)).toEqual({
      agents: { "pi-flow-readonly-n1": { mode: "primary", permissions: [deny, allow("read"), allow("grep"), allow("glob")] } },
    });
    expect(JSON.parse(buildOpencodeEnv("edit", base, "pi-flow-edit-n2").OPENCODE_CONFIG_CONTENT!).agents["pi-flow-edit-n2"].permissions)
      .toEqual([deny, allow("read"), allow("grep"), allow("glob"), allow("edit")]);
    expect(() => buildOpencodeEnv("edit", { OPENCODE_CONFIG_CONTENT: "{}" }, "pi-flow-edit-n3")).toThrow(/already set/);
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


  it("takes the result and usage from the verified export, never from streamed narration, and runs as the injected agent", async () => {
    const infoPath = installFake("success", `${STREAM}
emit('tool_use', { part: part({ type: 'tool', tool: 'shell', state: { status: 'error', error: 'Permission denied: shell' } }) });
emit('text', { part: part({ type: 'text', text: 'late stale narration' }) });`);
    const result = await run({ profile: profile({ systemPrompt: "Be careful." }), permission: "readonly" });

    expect(result.details).toMatchObject({
      status: "done",
      result: "Final answer.",
      sessionId: SESSION,
      permissionDenials: 1,
      assistantOutput: { status: "final", messages: [{ text: "Final answer." }] },
    });
    expect(result.details.usage).toEqual({ input: 7, output: 4, cacheRead: 5, cacheWrite: 0, cost: 0.02, costKnown: true, costEstimated: false });
    const info = JSON.parse(readFileSync(infoPath, "utf8"));
    const agent = info.args[info.args.indexOf("--agent") + 1];
    expect(agent).toMatch(/^pi-flow-readonly-[0-9a-f]+$/);
    expect(Object.keys(JSON.parse(info.config).agents)).toEqual([agent]);
    expect(info).toMatchObject({ stdin: "Be careful.\n\nDo the task.", pwd: cwd });
    // A new session is exported once, after the run, not before.
    expect(readFileSync(`${infoPath}.exports`, "utf8")).toBe(`${SESSION}\n`);
  });

  it.each([
    ["an error event", `${STREAM}
emit('error', { error: { type: 'provider.no-route', message: 'Variant unavailable for a/b: max' } });
process.exitCode = 1;`, DEFAULT_EXPORT, /opencode failed: Variant unavailable for a\/b: max/],
    ["a session-less error before the run", `${STREAM}
emit('error', { error: { type: 'unknown', message: 'Session not found' } }, '');
process.exitCode = 1;`, DEFAULT_EXPORT, /opencode failed: Session not found/],
    ["a nonzero exit", `${STREAM}
console.error('boom');
process.exitCode = 1;`, DEFAULT_EXPORT, /exited with code 1: boom/],
    ["an auto-rejected permission ask that still exits 0", `${STREAM}
console.error('! permission requested: external_directory (/etc/*); auto-rejecting');`, DEFAULT_EXPORT, /auto-rejected a permission request/],
    ["a zero-exit interruption with streamed text", STREAM,
      `session([user('msg_new_user', run.stdin), assistant('msg_new_answer', 'Half done.', { finish: 'tool-calls' }), idle('interrupted')], { outcome: 'interrupted' });`,
      /outcome is "interrupted"/],
    ["an idle turn whose final assistant message stopped on tool calls", STREAM,
      `session([user('msg_new_user', run.stdin), assistant('msg_new_answer', 'Half done.', { finish: 'tool-calls' }), idle()]);`,
      /did not complete cleanly \(finish "tool-calls"\)/],
    ["a turn run by another agent than the injected one", STREAM,
      `session([user('msg_new_user', run.stdin), assistant('msg_new_answer', 'Done.', { agent: 'build' }), idle()]);`,
      /ran this turn as agent "build", not the injected pi-flow-readonly-/],
    ["an export that is not JSON", STREAM, `console.log('not json');`, /not a JSON object/],
  ])("fails on %s and keeps streamed text only as interrupted output", async (_label, body, exportBody, error) => {
    installFake("failure", body, exportBody);
    const result = await run({ permission: "readonly" });
    expect(result.details.status).toBe("error");
    expect(result.details.error).toMatch(error);
    expect(result.details.result).toBeUndefined();
    expect(result.details.assistantOutput).toEqual({ status: "interrupted", messages: [{ text: "streamed narration" }] });
  });

  it("resumes by exporting first, then verifies a new turn and counts only its usage", async () => {
    const infoPath = installFake("resume", STREAM);
    const resumed = await run({ resumeSessionId: SESSION, permission: "readonly" });
    expect(resumed.details).toMatchObject({ status: "done", result: "Final answer.", sessionId: SESSION });
    expect(resumed.details.usage).toMatchObject({ input: 7, cost: 0.02, costKnown: true });
    const args = JSON.parse(readFileSync(infoPath, "utf8")).args;
    expect(args.slice(0, 6)).toEqual(["run", "--standalone", "--format", "json", "--session", SESSION]);
    expect(args[6]).toBe("--agent");
    expect(readFileSync(`${infoPath}.exports`, "utf8")).toBe(`${SESSION}\n${SESSION}\n`);

    const forked = await run({ resumeSessionId: "ses_prior" });
    expect(forked.details.status).toBe("error");
    expect(forked.details.error).toMatch(/does not describe session ses_prior|not the resumed session ses_prior/);
  });

  it.each([
    // The earlier turn sent the very same prompt, so only its message ID tells it apart.
    ["only the earlier successful turn with the same prompt", `session([user('msg_old_user', 'Do the task.'), assistant('msg_old_answer', 'Earlier answer.'), idle()]);`, /no user turn from this invocation/],
    ["a new turn without its own idle terminal", `session(run ? [...prior, user('msg_new_user', run.stdin), assistant('msg_new_answer', 'Half done.')] : prior);`, /did not end in a succeeded idle outcome/],
  ])("rejects a resumed run whose export holds %s", async (_label, exportBody, error) => {
    installFake("stale", STREAM, exportBody);
    const result = await run({ resumeSessionId: SESSION, permission: "danger" });
    expect(result.details.status).toBe("error");
    expect(result.details.error).toMatch(error);
  });

  it.each([
    ["a danger resume of a session last run by an injected restricted agent", "danger", `session([...prior.slice(0, 1)], { agent: 'pi-flow-readonly-0a1b2c' });`, /Resume it at readonly or edit/],
    ["a restricted resume of a session with its own permission rules", "edit", `session(prior, { permissions: [{ action: '*', resource: '*', effect: 'allow' }] });`, /carries its own permission rules/],
  ] as const)("refuses %s before running", async (_label, permission, exportBody, error) => {
    const infoPath = installFake("refuse", STREAM, exportBody);
    const result = await run({ resumeSessionId: SESSION, permission });
    expect(result.details.status).toBe("error");
    expect(result.details.error).toMatch(error);
    expect(existsSync(infoPath)).toBe(false);
  });

  it("treats a subagent tool as nested activity and its uncounted child usage as unknown cost", async () => {
    const taskEvent = { type: "tool_use", sessionID: SESSION, part: { type: "tool", tool: "subagent", sessionID: SESSION, state: { status: "completed" } } };
    expect(hasNestedAgentActivity(taskEvent, "opencode")).toBe(true);
    expect(hasNestedAgentActivity({ ...taskEvent, part: { ...taskEvent.part, tool: "shell" } }, "opencode")).toBe(false);

    installFake("nested", STREAM, `session([user('msg_new_user', run.stdin), assistant('msg_tool', '', { finish: 'tool-calls', content: [{ type: 'tool', name: 'subagent', state: { status: 'completed' } }] }), assistant('msg_new_answer', 'Delegated.'), idle()]);`);
    const result = await run();
    expect(result.details.status).toBe("done");
    expect(result.details.usage).toMatchObject({ input: 14, cost: 0.04, costKnown: false });
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
`, `session([user('msg_new_user', run.stdin), assistant('msg_new_answer', 'opencode child done'), idle()]);`);
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
      backendEventCount: 2,
      permission: { tier: "danger", enforced: true },
      sessionId: SESSION,
      usage: { input: 7, output: 4, cost: 0.02, costKnown: true, costEstimated: false },
    });
    const page = await inspectRun({ runsDirectory: recordsRoot, runId: runId!, view: "output" });
    expect(page.items.map((item) => item.text)).toEqual(["opencode child done"]);
    disposeSession(session);
  });
});
