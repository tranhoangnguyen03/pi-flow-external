import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage, fauxToolCall, type Context } from "../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/index.js";
import type { SubagentProfile, SubagentUsage } from "../src/types.ts";
import {
  buildMuseArgs,
  extractMuseError,
  extractMuseFinalText,
  extractMuseSessionId,
  museActivityFromEvent,
  museHasNestedAgentActivity,
  normalizeMuseReasoningEffort,
  spawnMuseSubagent,
} from "../src/core/muse.ts";
import { inspectRun } from "../src/core/run-inspection.ts";
import { MAX_STDOUT_LINE_CHARS } from "../src/core/stream.ts";
import { setupPiSubagentTestHarness } from "./helpers/pi-subagent-harness.ts";

function envelope(payloadType: string, payload: Record<string, unknown>, streamId = "sess-stream-1"): Record<string, unknown> {
  return {
    schema_version: 1,
    id: "018f0000-0000-7000-8000-00000000c350",
    stream: { kind: "session", id: streamId },
    sequence: 1,
    recorded_at: 1,
    record_type: "event",
    durability: "durable",
    causation_id: "cmd-1",
    payload_type: payloadType,
    payload_schema_version: 1,
    payload,
  };
}

/**
 * Fake `muse` binaries below must emit a *realistic* root-linked envelope
 * stream — `runtime.command.accepted` then `session.run.linked` tying one
 * `command_id` to one `run_stream.id` — because the adapter now requires
 * that exact linkage before trusting any `run.terminal.*`/`run.output.delta`
 * envelope. This prelude (interpolated as source text into each fake
 * binary's script) provides `bootstrap()` to emit that pair, `root(payload)`
 * to stamp an envelope's payload with the established root identity, and
 * `rogue(payload)` to stamp one with a *different* command/run identity, for
 * tests proving nested/foreign envelopes are ignored.
 */
const MUSE_ROOT_SESSION_ID = "sess-root-1";
const MUSE_ROOT_COMMAND_ID = "cmd-root-1";
const MUSE_ROOT_RUN_ID = "run-root-1";
function museBinaryPrelude(sessionId = MUSE_ROOT_SESSION_ID, commandId = MUSE_ROOT_COMMAND_ID, runId = MUSE_ROOT_RUN_ID): string {
  return `
const SESSION_ID = ${JSON.stringify(sessionId)};
const ROOT_COMMAND_ID = ${JSON.stringify(commandId)};
const ROOT_RUN_ID = ${JSON.stringify(runId)};
let __seq = 0;
function env(payloadType, payload) {
  __seq += 1;
  return JSON.stringify({
    schema_version: 1, id: String(__seq), stream: { kind: 'session', id: SESSION_ID },
    sequence: __seq, recorded_at: __seq, record_type: 'event', durability: 'durable',
    causation_id: ROOT_COMMAND_ID, payload_type: payloadType, payload_schema_version: 1, payload,
  });
}
function root(payload) {
  return { command_id: ROOT_COMMAND_ID, run_stream: { kind: 'run', id: ROOT_RUN_ID }, ...payload };
}
function rogue(payload) {
  return { command_id: 'cmd-nested-rogue', run_stream: { kind: 'run', id: 'run-nested-rogue' }, ...payload };
}
function bootstrap() {
  console.log(env('runtime.command.accepted', { kind: 'command_accepted', command_id: ROOT_COMMAND_ID, client_id: null, command_kind: 'turn.submit' }));
  console.log(env('session.run.linked', root({ kind: 'session_run_linked' })));
}
`;
}
const MUSE_BINARY_PRELUDE = museBinaryPrelude();

describe("pi-subagent muse backend", () => {
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

  it("normalizes thinking effort to muse-accepted reasoning-effort levels", () => {
    expect(normalizeMuseReasoningEffort(undefined)).toBeUndefined();
    expect(normalizeMuseReasoningEffort("off")).toBe("none");
    expect(normalizeMuseReasoningEffort("minimal")).toBe("minimal");
    expect(normalizeMuseReasoningEffort("low")).toBe("low");
    expect(normalizeMuseReasoningEffort("medium")).toBe("medium");
    expect(normalizeMuseReasoningEffort("high")).toBe("high");
    expect(normalizeMuseReasoningEffort("xhigh")).toBe("xhigh");
    expect(normalizeMuseReasoningEffort("unsupported")).toBeUndefined();
  });

  it("builds exact muse argv for normal, resume, and structured-output modes across permission tiers", () => {
    const profile: SubagentProfile = {
      name: "muse-worker",
      description: "Muse worker",
      backend: "muse" as any,
      model: "muse-spark-1.3-contributor",
      systemPrompt: "unused by buildMuseArgs directly",
    };

    const normalArgs = buildMuseArgs({
      promptFilePath: "/tmp/prompt.txt",
      workspace: "/tmp/ws",
      profile,
      thinkingLevel: "minimal",
      permission: "danger",
    });
    expect(normalArgs).toEqual([
      "exec", "--json", "--provider", "meta", "--workspace", "/tmp/ws", "--prompt-file", "/tmp/prompt.txt",
      "--yolo",
      "--model", "muse-spark-1.3-contributor",
      "--reasoning-effort", "minimal",
    ]);

    const resumeArgs = buildMuseArgs({
      promptFilePath: "/tmp/prompt.txt",
      workspace: "/tmp/ws",
      profile,
      thinkingLevel: "high",
      permission: "edit",
      resumeSessionId: "session-abc-123",
    });
    expect(resumeArgs).toEqual([
      "exec", "--json", "--provider", "meta", "--workspace", "/tmp/ws", "--prompt-file", "/tmp/prompt.txt",
      "--session-id", "session-abc-123",
      "--disable-approval",
      "--model", "muse-spark-1.3-contributor",
      "--reasoning-effort", "high",
    ]);

    const structuredArgs = buildMuseArgs({
      promptFilePath: "/tmp/prompt.txt",
      schemaFilePath: "/tmp/output-schema.json",
      workspace: "/tmp/ws",
      profile,
      thinkingLevel: "xhigh",
      permission: "readonly",
    });
    expect(structuredArgs).toEqual([
      "exec", "--json", "--provider", "meta", "--workspace", "/tmp/ws", "--prompt-file", "/tmp/prompt.txt",
      "--output-schema", "/tmp/output-schema.json",
      "--disable-approval", "--disable-write", "--disable-shell",
      "--model", "muse-spark-1.3-contributor",
      "--reasoning-effort", "xhigh",
    ]);
  });

  it("omits --model when the profile leaves it unpinned", () => {
    const args = buildMuseArgs({
      promptFilePath: "/tmp/prompt.txt",
      workspace: "/tmp/ws",
      profile: { name: "muse-worker", description: "Muse worker", backend: "muse" as any },
      permission: "danger",
    });
    expect(args).not.toContain("--model");
    expect(args).not.toContain("--reasoning-effort");
  });

  it("rejects an effective thinking level of off instead of building an unsupported --reasoning-effort none", () => {
    // Profile-pinned: the profile's own frontmatter pins `thinking: off`
    // explicitly (no per-call thinkingLevel override supplied here).
    const profilePinnedOff: SubagentProfile = {
      name: "muse-pinned-off",
      description: "Muse worker pinned to off",
      backend: "muse" as any,
      thinking: "off",
    };
    expect(() =>
      buildMuseArgs({
        promptFilePath: "/tmp/prompt.txt",
        workspace: "/tmp/ws",
        profile: profilePinnedOff,
        permission: "danger",
      }),
    ).toThrow(/muse-pinned-off.*reasoning-effort none/s);

    // Session-inherited: the profile itself declares no thinking, but the
    // resolved thinkingLevel arriving from the caller is "off" — exactly
    // what pi-subagent.ts/workflow/tool.ts pass through when the parent
    // session's own thinking level was never raised above the pi-agent-core
    // SDK's own "off" default. Must be rejected identically.
    const profileWithoutThinking: SubagentProfile = {
      name: "muse-inherits-off",
      description: "Muse worker",
      backend: "muse" as any,
    };
    expect(() =>
      buildMuseArgs({
        promptFilePath: "/tmp/prompt.txt",
        workspace: "/tmp/ws",
        profile: profileWithoutThinking,
        thinkingLevel: "off",
        permission: "danger",
      }),
    ).toThrow(/minimal, low, medium, high, or xhigh/);

    // Supported levels remain unaffected.
    expect(() =>
      buildMuseArgs({
        promptFilePath: "/tmp/prompt.txt",
        workspace: "/tmp/ws",
        profile: profileWithoutThinking,
        thinkingLevel: "minimal",
        permission: "danger",
      }),
    ).not.toThrow();
  });

  it("extracts session id, final text, activity narration, and error from envelopes", () => {
    expect(extractMuseSessionId(envelope("run.lifecycle.started", {}, "sess-abc"))).toBe("sess-abc");
    expect(extractMuseSessionId({ stream: { kind: "run", id: "not-a-session" } })).toBeUndefined();

    expect(extractMuseFinalText(envelope("run.terminal.completed", { terminal: "completed", text: "60db8abf-e619-42b6-b9f3", reason: null })))
      .toBe("60db8abf-e619-42b6-b9f3");
    expect(extractMuseFinalText(envelope("run.terminal.failed", { terminal: "failed", text: "", reason: "boom" }))).toBeUndefined();
    expect(extractMuseFinalText(envelope("task.lifecycle.completed", { event: { kind: "completed" } }))).toBeUndefined();

    expect(extractMuseError(envelope("run.terminal.failed", {
      terminal: "failed",
      text: "",
      reason: "API error 402 [request_id=abc]: Billing verification failed. (billing_error)",
    }))).toBe("muse failed: API error 402 [request_id=abc]: Billing verification failed. (billing_error)");
    expect(extractMuseError(envelope("run.terminal.completed", { terminal: "completed", text: "ok" }))).toBeUndefined();

    expect(museActivityFromEvent(envelope("tool.result", {
      call_id: "call_1",
      text: "Read text file `nonce.txt`.\n1|abc",
      correlation_facts: { tool_name: "read_file", outcome: "success" },
    }))).toBe("read_file Read text file `nonce.txt`. 1|abc");

    expect(museActivityFromEvent(envelope("task.lifecycle.status", {
      event: { kind: "status", message: "retrying meta model stream in 60000ms (attempt 3/10)" },
    }))).toBe("retrying meta model stream in 60000ms (attempt 3/10)");

    expect(museActivityFromEvent(envelope("run.output.delta", { text: "60db8abf-e619-" }))).toBe("60db8abf-e619-");

    expect(museActivityFromEvent(envelope("task.lifecycle.accepted", { event: { kind: "accepted" } }))).toBeUndefined();
  });

  it("never reports nested agent activity for muse, even for a task_kind that looks like real delegation (no confirmed real event shape exists)", () => {
    expect(museHasNestedAgentActivity(envelope("task.lifecycle.proposed", {
      event: { kind: "proposed", task_kind: "reminder.agent.skill-reminder" },
    }))).toBe(false);
    expect(museHasNestedAgentActivity(envelope("task.lifecycle.status", {
      event: { kind: "status", task_kind: "agent.delegate" },
    }))).toBe(false);
    // Speculative task_kind matching was removed: even a plausible-looking
    // "agent.delegate" proposed/started event must not extend the nested
    // timeout, since no real muse delegation event has ever been observed.
    expect(museHasNestedAgentActivity(envelope("task.lifecycle.proposed", {
      event: { kind: "proposed", task_kind: "agent.delegate" },
    }))).toBe(false);
    expect(museHasNestedAgentActivity(envelope("task.lifecycle.started", {
      event: { kind: "started", task_kind: "agent.delegate" },
    }))).toBe(false);
  });

  it("runs a normal muse subagent with exact argv, envelope streaming, and temp file cleanup", async () => {
    const binDir = join(tempDir, "bin-muse-normal");
    const runInfoPath = join(tempDir, "muse-run-info.json");
    mkdirSync(binDir, { recursive: true });

    const fakeMusePath = join(binDir, "muse");
    writeFileSync(fakeMusePath, `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
for await (const _chunk of process.stdin) {}
const args = process.argv.slice(2);
const promptFileIdx = args.indexOf('--prompt-file');
const promptFilePath = promptFileIdx !== -1 ? args[promptFileIdx + 1] : null;
const promptContent = promptFilePath ? readFileSync(promptFilePath, 'utf8') : null;

writeFileSync(${JSON.stringify(runInfoPath)}, JSON.stringify({ args, promptFilePath, promptContent }));
${MUSE_BINARY_PRELUDE}
bootstrap();
console.log(env('run.model.configured', root({ provider_id: 'meta', model_id: 'muse-spark-1.3-contributor' })));
console.log(env('tool.result', root({ call_id: 'call_1', text: 'Inspecting repository...', correlation_facts: { tool_name: 'read_file' } })));
console.log(env('run.terminal.completed', root({ terminal: 'completed', text: 'Muse execution complete.', reason: null })));
`);
    chmodSync(fakeMusePath, 0o755);
    process.env.PATH = `${binDir}:${originalPathEnv ?? ""}`;

    const usageEvents: SubagentUsage[] = [];
    const backendEvents: unknown[] = [];

    const result = await spawnMuseSubagent({
      toolCallId: "call_muse_normal",
      description: "Muse normal run",
      prompt: "Implement the feature completely.",
      profile: {
        name: "muse-engineer",
        description: "Muse engineering agent",
        backend: "muse" as any,
        model: "muse-spark-1.3-contributor",
        systemPrompt: "You are an expert engineer.",
      },
      thinkingLevel: "high",
      ctx: { cwd } as ExtensionContext,
      signal: undefined,
      progressEnabled: true,
      onProgress: undefined,
      onUsage: (u) => usageEvents.push(u),
      onBackendEvent: (e) => backendEvents.push(e),
      permission: "danger",
    });

    expect(result.details.status).toBe("done");
    expect(result.details.result).toBe("Muse execution complete.");
    expect(result.details.sessionId).toBe(MUSE_ROOT_SESSION_ID);
    expect(result.details.usage).toEqual({
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, costKnown: false, costEstimated: false,
    });
    expect(result.details.assistantOutput).toEqual({
      status: "final",
      messages: [{ text: "Muse execution complete." }],
    });

    const runInfo = JSON.parse(readFileSync(runInfoPath, "utf8"));
    expect(runInfo.args).toEqual([
      "exec", "--json", "--provider", "meta", "--workspace", cwd, "--prompt-file", runInfo.promptFilePath,
      "--yolo",
      "--model", "muse-spark-1.3-contributor",
      "--reasoning-effort", "high",
    ]);
    // muse exec has no native system-prompt flag; it is folded into the prompt file.
    expect(runInfo.promptContent).toBe("You are an expert engineer.\n\nImplement the feature completely.");
    expect(existsSync(runInfo.promptFilePath)).toBe(false);
    // Bootstrap (runtime.command.accepted + session.run.linked) plus the 3 original events.
    expect(backendEvents).toHaveLength(5);
  });

  it("handles resume by forwarding --session-id and reports the same session id", async () => {
    const binDir = join(tempDir, "bin-muse-resume");
    const runInfoPath = join(tempDir, "muse-resume-info.json");
    mkdirSync(binDir, { recursive: true });

    const fakeMusePath = join(binDir, "muse");
    writeFileSync(fakeMusePath, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
for await (const _chunk of process.stdin) {}
writeFileSync(${JSON.stringify(runInfoPath)}, JSON.stringify({ args: process.argv.slice(2) }));
${museBinaryPrelude("prior-muse-sess")}
bootstrap();
console.log(env('run.terminal.completed', root({ terminal: 'completed', text: 'Resumed task done.', reason: null })));
`);
    chmodSync(fakeMusePath, 0o755);
    process.env.PATH = `${binDir}:${originalPathEnv ?? ""}`;

    const result = await spawnMuseSubagent({
      toolCallId: "call_muse_resume",
      description: "Muse resume run",
      prompt: "Continue the previous task.",
      profile: {
        name: "muse-resumer",
        description: "Muse resumer",
        backend: "muse" as any,
        model: "muse-spark-1.3-contributor",
      },
      thinkingLevel: "medium",
      ctx: { cwd } as ExtensionContext,
      signal: undefined,
      progressEnabled: false,
      onProgress: undefined,
      onUsage: () => undefined,
      resumeSessionId: "prior-muse-sess",
    });

    expect(result.details.status).toBe("done");
    expect(result.details.result).toBe("Resumed task done.");
    expect(result.details.sessionId).toBe("prior-muse-sess");

    const runInfo = JSON.parse(readFileSync(runInfoPath, "utf8"));
    expect(runInfo.args).toContain("--session-id");
    expect(runInfo.args[runInfo.args.indexOf("--session-id") + 1]).toBe("prior-muse-sess");
  });

  it("handles structured output via --output-schema, treating the terminal text as the pre-serialized JSON result", async () => {
    const binDir = join(tempDir, "bin-muse-structured");
    const runInfoPath = join(tempDir, "muse-structured-info.json");
    mkdirSync(binDir, { recursive: true });

    const fakeMusePath = join(binDir, "muse");
    writeFileSync(fakeMusePath, `#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
for await (const _chunk of process.stdin) {}
const args = process.argv.slice(2);
const schemaIdx = args.indexOf('--output-schema');
const schemaPath = schemaIdx !== -1 ? args[schemaIdx + 1] : null;
writeFileSync(${JSON.stringify(runInfoPath)}, JSON.stringify({ args, schemaExists: schemaPath ? existsSync(schemaPath) : false, schemaContent: schemaPath ? readFileSync(schemaPath, 'utf8') : null }));
${museBinaryPrelude("muse-struct-sess")}
bootstrap();
console.log(env('run.terminal.completed', root({ terminal: 'completed', text: JSON.stringify({ nonce: '60db8abf-e619-42b6' }), reason: null })));
`);
    chmodSync(fakeMusePath, 0o755);
    process.env.PATH = `${binDir}:${originalPathEnv ?? ""}`;

    const schema = { type: "object", properties: { nonce: { type: "string" } }, required: ["nonce"], additionalProperties: false };

    const result = await spawnMuseSubagent({
      toolCallId: "call_muse_structured",
      description: "Muse structured run",
      prompt: "Read nonce.txt and report the nonce.",
      profile: { name: "muse-evaluator", description: "Muse evaluator", backend: "muse" as any, model: "muse-spark-1.3-contributor" },
      thinkingLevel: "low",
      ctx: { cwd } as ExtensionContext,
      signal: undefined,
      progressEnabled: false,
      onProgress: undefined,
      onUsage: () => undefined,
      outputSchema: schema,
    });

    expect(result.details.status).toBe("done");
    expect(result.details.result).toBe(JSON.stringify({ nonce: "60db8abf-e619-42b6" }));
    expect(JSON.parse(result.details.result as string)).toEqual({ nonce: "60db8abf-e619-42b6" });

    const runInfo = JSON.parse(readFileSync(runInfoPath, "utf8"));
    expect(runInfo.args).toContain("--output-schema");
    expect(runInfo.schemaExists).toBe(true);
    expect(JSON.parse(runInfo.schemaContent)).toEqual(schema);
  });

  it("ignores a nested/foreign run's own terminal.completed and only finalizes on the root run's own terminal event", async () => {
    const binDir = join(tempDir, "bin-muse-nested-success");
    mkdirSync(binDir, { recursive: true });

    const fakeMusePath = join(binDir, "muse");
    writeFileSync(fakeMusePath, `#!/usr/bin/env node
for await (const _chunk of process.stdin) {}
${MUSE_BINARY_PRELUDE}
bootstrap();
console.log(env('run.output.delta', root({ text: 'root progress...' })));
console.log(env('run.terminal.completed', rogue({ terminal: 'completed', text: 'ROGUE NESTED TEXT MUST BE IGNORED', reason: null })));
console.log(env('run.terminal.completed', root({ terminal: 'completed', text: 'REAL ROOT RESULT', reason: null })));
`);
    chmodSync(fakeMusePath, 0o755);
    process.env.PATH = `${binDir}:${originalPathEnv ?? ""}`;

    const result = await spawnMuseSubagent({
      toolCallId: "call_muse_nested_success",
      description: "Muse nested success isolation",
      prompt: "Do work that involves a nested run.",
      profile: { name: "muse-nested", description: "Muse nested", backend: "muse" as any },
      thinkingLevel: "low",
      ctx: { cwd } as ExtensionContext,
      signal: undefined,
      progressEnabled: false,
      onProgress: undefined,
      onUsage: () => undefined,
    });

    expect(result.details.status).toBe("done");
    expect(result.details.result).toBe("REAL ROOT RESULT");
    expect(result.details.sessionId).toBe(MUSE_ROOT_SESSION_ID);
  });

  it("ignores a nested/foreign run's own terminal.failed and still finalizes success from the root run's own terminal event", async () => {
    const binDir = join(tempDir, "bin-muse-nested-failure");
    mkdirSync(binDir, { recursive: true });

    const fakeMusePath = join(binDir, "muse");
    writeFileSync(fakeMusePath, `#!/usr/bin/env node
for await (const _chunk of process.stdin) {}
${MUSE_BINARY_PRELUDE}
bootstrap();
console.log(env('run.terminal.failed', rogue({ terminal: 'failed', text: '', reason: 'nested failure must not propagate to the root result' })));
console.log(env('run.terminal.completed', root({ terminal: 'completed', text: 'root succeeded despite nested failure', reason: null })));
`);
    chmodSync(fakeMusePath, 0o755);
    process.env.PATH = `${binDir}:${originalPathEnv ?? ""}`;

    const result = await spawnMuseSubagent({
      toolCallId: "call_muse_nested_failure",
      description: "Muse nested failure isolation",
      prompt: "Do work that involves a nested run that fails.",
      profile: { name: "muse-nested-fail", description: "Muse nested fail", backend: "muse" as any },
      thinkingLevel: "low",
      ctx: { cwd } as ExtensionContext,
      signal: undefined,
      progressEnabled: false,
      onProgress: undefined,
      onUsage: () => undefined,
    });

    expect(result.details.status).toBe("done");
    expect(result.details.result).toBe("root succeeded despite nested failure");
    expect(result.details.error).toBeUndefined();
  });

  it("treats a terminal event whose run_stream does not match the established root as if it never arrived, failing closed", async () => {
    const binDir = join(tempDir, "bin-muse-mismatched-terminal");
    mkdirSync(binDir, { recursive: true });

    const fakeMusePath = join(binDir, "muse");
    writeFileSync(fakeMusePath, `#!/usr/bin/env node
for await (const _chunk of process.stdin) {}
${MUSE_BINARY_PRELUDE}
bootstrap();
console.log(env('run.terminal.completed', rogue({ terminal: 'completed', text: 'FOREIGN RUN TEXT, NEVER THE ROOT ANSWER', reason: null })));
`);
    chmodSync(fakeMusePath, 0o755);
    process.env.PATH = `${binDir}:${originalPathEnv ?? ""}`;

    const result = await spawnMuseSubagent({
      toolCallId: "call_muse_mismatched_terminal",
      description: "Muse mismatched terminal",
      prompt: "Trigger a foreign-run-only terminal.",
      profile: { name: "muse-mismatched", description: "Muse mismatched", backend: "muse" as any },
      thinkingLevel: "low",
      ctx: { cwd } as ExtensionContext,
      signal: undefined,
      progressEnabled: false,
      onProgress: undefined,
      onUsage: () => undefined,
    });

    expect(result.details.status).toBe("error");
    expect(result.details.error).toContain("muse exited without a terminal JSON event");
    expect(result.details.result).toBeUndefined();
  });

  it("rejects when muse exits without a terminal JSON event and preserves interrupted output", async () => {
    const binDir = join(tempDir, "bin-muse-no-terminal");
    const promptPathFile = join(tempDir, "prompt-path.txt");
    mkdirSync(binDir, { recursive: true });

    const fakeMusePath = join(binDir, "muse");
    writeFileSync(fakeMusePath, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
for await (const _chunk of process.stdin) {}
const args = process.argv.slice(2);
const promptFileIdx = args.indexOf('--prompt-file');
if (promptFileIdx !== -1) writeFileSync(${JSON.stringify(promptPathFile)}, args[promptFileIdx + 1]);
${MUSE_BINARY_PRELUDE}
bootstrap();
console.log(env('run.output.delta', root({ text: 'Partial analysis before unexpected exit.' })));
`);
    chmodSync(fakeMusePath, 0o755);
    process.env.PATH = `${binDir}:${originalPathEnv ?? ""}`;

    const result = await spawnMuseSubagent({
      toolCallId: "call_muse_no_term",
      description: "Muse no terminal",
      prompt: "Perform unfinished work.",
      profile: { name: "muse-crasher", description: "Muse crasher", backend: "muse" as any },
      thinkingLevel: "medium",
      ctx: { cwd } as ExtensionContext,
      signal: undefined,
      progressEnabled: false,
      onProgress: undefined,
      onUsage: () => undefined,
    });

    expect(result.details.status).toBe("error");
    expect(result.details.error).toContain("muse exited without a terminal JSON event");
    expect(result.details.assistantOutput).toEqual({
      status: "interrupted",
      messages: [{ text: "Partial analysis before unexpected exit." }],
    });
    expect(result.content[0].text).toContain("Interrupted output:\nPartial analysis before unexpected exit.");

    const promptPath = readFileSync(promptPathFile, "utf8");
    expect(existsSync(promptPath)).toBe(false);
  });

  it("rejects when the run's own terminal event reports failed, surfacing the billing-style reason", async () => {
    const binDir = join(tempDir, "bin-muse-terminal-fail");
    mkdirSync(binDir, { recursive: true });

    const fakeMusePath = join(binDir, "muse");
    writeFileSync(fakeMusePath, `#!/usr/bin/env node
for await (const _chunk of process.stdin) {}
${MUSE_BINARY_PRELUDE}
bootstrap();
console.log(env('run.terminal.failed', root({ terminal: 'failed', text: '', reason: 'API error 402 [request_id=abc]: Billing verification failed. Please check your payment method. (billing_error)' })));
`);
    chmodSync(fakeMusePath, 0o755);
    process.env.PATH = `${binDir}:${originalPathEnv ?? ""}`;

    const result = await spawnMuseSubagent({
      toolCallId: "call_muse_term_fail",
      description: "Muse terminal fail",
      prompt: "Trigger a billing failure.",
      profile: { name: "muse-failed", description: "Muse failed profile", backend: "muse" as any },
      thinkingLevel: "low",
      ctx: { cwd } as ExtensionContext,
      signal: undefined,
      progressEnabled: false,
      onProgress: undefined,
      onUsage: () => undefined,
    });

    expect(result.details.status).toBe("error");
    expect(result.details.error).toContain("muse failed: API error 402");
    expect(result.details.error).toContain("billing_error");
  });

  it("fails fast on profile-pinned off thinking without ever spawning the muse process", async () => {
    // An empty PATH prevents accidentally invoking the real provider if validation regresses.
    process.env.PATH = "";

    const result = await spawnMuseSubagent({
      toolCallId: "call_muse_off_thinking",
      description: "Muse profile-pinned off thinking",
      prompt: "Should never reach the muse binary.",
      profile: {
        name: "muse-pinned-off",
        description: "Muse worker pinned to off",
        backend: "muse" as any,
        thinking: "off",
      },
      thinkingLevel: undefined,
      ctx: { cwd } as ExtensionContext,
      signal: undefined,
      progressEnabled: false,
      onProgress: undefined,
      onUsage: () => undefined,
    });

    expect(result.details.status).toBe("error");
    expect(result.details.error).toContain("muse-pinned-off");
    expect(result.details.error).toContain("reasoning-effort none");
    expect(result.details.error).toContain("minimal, low, medium, high, or xhigh");
  });

  it("fails fast on a session-inherited off thinkingLevel (the pi-agent-core SDK's own default) without ever spawning muse", async () => {
    // Mirrors what pi-subagent.ts/workflow/tool.ts actually pass through:
    // an unset profile.thinking plus a resolved thinkingLevel of "off",
    // which is the pinned pi-agent-core session state's own default whenever
    // no one has explicitly raised thinking above off.
    process.env.PATH = "";

    const result = await spawnMuseSubagent({
      toolCallId: "call_muse_off_thinking_inherited",
      description: "Muse session-inherited off thinking",
      prompt: "Should never reach the muse binary.",
      profile: {
        name: "muse-inherits-off",
        description: "Muse worker",
        backend: "muse" as any,
      },
      thinkingLevel: "off",
      ctx: { cwd } as ExtensionContext,
      signal: undefined,
      progressEnabled: false,
      onProgress: undefined,
      onUsage: () => undefined,
    });

    expect(result.details.status).toBe("error");
    expect(result.details.error).toContain("muse-inherits-off");
    expect(result.details.error).toContain("reasoning-effort none");
    expect(result.details.error).toContain("minimal, low, medium, high, or xhigh");
  });

  it("reports a nonzero muse exit code along with captured stderr", async () => {
    const binDir = join(tempDir, "bin-muse-nonzero-exit");
    mkdirSync(binDir, { recursive: true });

    const fakeMusePath = join(binDir, "muse");
    writeFileSync(fakeMusePath, `#!/usr/bin/env node
for await (const _chunk of process.stdin) {}
process.stderr.write('muse: authentication token expired\\n');
process.exit(2);
`);
    chmodSync(fakeMusePath, 0o755);
    process.env.PATH = `${binDir}:${originalPathEnv ?? ""}`;

    const result = await spawnMuseSubagent({
      toolCallId: "call_muse_nonzero_exit",
      description: "Muse nonzero exit",
      prompt: "Trigger a crashing exit.",
      profile: { name: "muse-crashy", description: "Muse crashy profile", backend: "muse" as any },
      thinkingLevel: "low",
      ctx: { cwd } as ExtensionContext,
      signal: undefined,
      progressEnabled: false,
      onProgress: undefined,
      onUsage: () => undefined,
    });

    expect(result.details.status).toBe("error");
    expect(result.details.error).toContain("muse exited with code 2");
    expect(result.details.error).toContain("muse: authentication token expired");
  });

  it("kills child process and cleans up prompt file when aborted after spawn", async () => {
    const binDir = join(tempDir, "bin-muse-abort");
    const markerPath = join(tempDir, "muse-child-finished");
    const promptPathFile = join(tempDir, "abort-prompt-path.txt");
    mkdirSync(binDir, { recursive: true });

    const fakeMusePath = join(binDir, "muse");
    writeFileSync(fakeMusePath, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
process.stdin.resume();
const args = process.argv.slice(2);
const promptFileIdx = args.indexOf('--prompt-file');
if (promptFileIdx !== -1) writeFileSync(${JSON.stringify(promptPathFile)}, args[promptFileIdx + 1]);

setTimeout(() => {
  writeFileSync(${JSON.stringify(markerPath)}, 'finished');
  console.log(JSON.stringify({
    schema_version: 1, id: '1', stream: { kind: 'session', id: 'muse-abort' },
    sequence: 1, recorded_at: 1, record_type: 'event', durability: 'durable',
    causation_id: 'cmd-1', payload_type: 'run.terminal.completed', payload_schema_version: 1,
    payload: { terminal: 'completed', text: 'Should not happen', reason: null },
  }));
}, 800);
`);
    chmodSync(fakeMusePath, 0o755);
    process.env.PATH = `${binDir}:${originalPathEnv ?? ""}`;

    let abortedChecks = 0;
    const signal = {
      get aborted() {
        abortedChecks += 1;
        return abortedChecks >= 3;
      },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as AbortSignal;

    const result = await spawnMuseSubagent({
      toolCallId: "call_muse_abort",
      description: "Muse abort test",
      prompt: "Task that gets aborted.",
      profile: { name: "muse-aborter", description: "Muse aborter", backend: "muse" as any },
      thinkingLevel: "medium",
      ctx: { cwd } as ExtensionContext,
      signal,
      progressEnabled: false,
      onProgress: undefined,
      onUsage: () => undefined,
    });

    expect(result.details.status).toBe("aborted");
    expect(result.details.error).toContain("Subagent aborted before prompt start");

    await new Promise((resolve) => setTimeout(resolve, 950));
    expect(existsSync(markerPath)).toBe(false);

    if (existsSync(promptPathFile)) {
      const promptPath = readFileSync(promptPathFile, "utf8");
      expect(existsSync(promptPath)).toBe(false);
    }
  });

  it("fails clearly when muse emits an oversized stdout line and cleans up the temp files", async () => {
    const binDir = join(tempDir, "bin-muse-oversize");
    const promptPathFile = join(tempDir, "oversize-prompt-path.txt");
    mkdirSync(binDir, { recursive: true });

    const fakeMusePath = join(binDir, "muse");
    writeFileSync(fakeMusePath, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
for await (const _chunk of process.stdin) {}
const args = process.argv.slice(2);
const promptFileIdx = args.indexOf('--prompt-file');
if (promptFileIdx !== -1) writeFileSync(${JSON.stringify(promptPathFile)}, args[promptFileIdx + 1]);

console.log('m'.repeat(${MAX_STDOUT_LINE_CHARS + 1024}));
console.log(JSON.stringify({
  schema_version: 1, id: '1', stream: { kind: 'session', id: 'muse-oversize' },
  sequence: 1, recorded_at: 1, record_type: 'event', durability: 'durable',
  causation_id: 'cmd-1', payload_type: 'run.terminal.completed', payload_schema_version: 1,
  payload: { terminal: 'completed', text: 'must not reach', reason: null },
}));
`);
    chmodSync(fakeMusePath, 0o755);
    process.env.PATH = `${binDir}:${originalPathEnv ?? ""}`;

    const result = await spawnMuseSubagent({
      toolCallId: "call_muse_oversize",
      description: "Muse oversize test",
      prompt: "Trigger oversize line.",
      profile: { name: "muse-oversize", description: "Muse oversize profile", backend: "muse" as any },
      thinkingLevel: "low",
      ctx: { cwd } as ExtensionContext,
      signal: undefined,
      progressEnabled: false,
      onProgress: undefined,
      onUsage: () => undefined,
    });

    expect(result.details.status).toBe("error");
    expect(result.details.error).toContain("muse emitted a stdout line over");
    expect(result.details.error).toContain("chars");

    const promptPath = readFileSync(promptPathFile, "utf8");
    expect(existsSync(promptPath)).toBe(false);
  });

  it("runs a muse-backed subagent through the Agent tool with a session receipt and reconstructable output", async () => {
    const subagentsDir = join(agentDir, "subagents");
    const binDir = join(tempDir, "bin-muse-agent-tool");
    const runInfoPath = join(tempDir, "muse-agent-tool-info.json");
    mkdirSync(subagentsDir, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    writeFileSync(
      join(subagentsDir, "muse-worker.md"),
      "---\ndescription: Works through Muse Code.\nbackend: muse\nmodel: muse-spark-1.3-contributor\nthinking: high\n---\n\nMuse worker prompt.",
    );

    const fakeMusePath = join(binDir, "muse");
    writeFileSync(fakeMusePath, `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
for await (const _chunk of process.stdin) {}
const args = process.argv.slice(2);
const promptFileIdx = args.indexOf('--prompt-file');
const promptFilePath = promptFileIdx !== -1 ? args[promptFileIdx + 1] : null;
const promptContent = promptFilePath ? readFileSync(promptFilePath, 'utf8') : null;
writeFileSync(${JSON.stringify(runInfoPath)}, JSON.stringify({ args, promptContent }));
${museBinaryPrelude("muse-agent-tool-session")}
bootstrap();
console.log(env('run.output.delta', root({ text: 'muse ' })));
console.log(env('run.output.delta', root({ text: 'child done' })));
console.log(env('run.terminal.completed', root({ terminal: 'completed', text: 'muse child done', reason: null })));
`);
    chmodSync(fakeMusePath, 0o755);
    process.env.PATH = `${binDir}:${originalPathEnv ?? ""}`;

    const { session, registration } = await createSession();
    let rootContinuationContext: Context | undefined;
    registration.setResponses([
      fauxAssistantMessage([fauxToolCall("Agent", {
        description: "Muse work",
        role: "worker",
        harness: "muse",
        prompt: "Do the task.",
      })], { stopReason: "toolUse" }),
      (context) => {
        rootContinuationContext = context;
        return fauxAssistantMessage("reported");
      },
    ]);

    await session.prompt("Delegate to Muse.");

    const runInfo = JSON.parse(readFileSync(runInfoPath, "utf8"));
    // Unlike claude/codex/grok (native system-prompt flag), muse forwards the
    // profile's systemPrompt folded into the prompt file, same as agy.
    expect(runInfo.promptContent).toBe("Muse worker prompt.\n\nDo the task.");
    expect(JSON.stringify(rootContinuationContext?.messages)).toContain("muse child done");

    const recordsRoot = join(agentDir, "pi-flow-external", "runs");
    const runDirectories = readdirSync(recordsRoot);
    expect(runDirectories).toHaveLength(1);
    const recordDirectory = join(recordsRoot, runDirectories[0]!);
    const summary = JSON.parse(readFileSync(join(recordDirectory, "summary.json"), "utf8"));
    expect(summary.summary).toMatchObject({
      backend: "muse",
      profile: "muse-worker",
      status: "done",
      backendEventCount: 5,
      nestedActivitySeen: false,
      nestedAgentControl: "allowed-observed",
      permission: { tier: "danger", enforced: true },
      sessionId: "muse-agent-tool-session",
    });
    expect(summary.summary.usage).toMatchObject({ costKnown: false, costEstimated: false });

    let output = "";
    let cursor: string | undefined;
    do {
      const page = await inspectRun({ runsDirectory: recordsRoot, runId: runDirectories[0]!, view: "output", limitBytes: 4, cursor });
      output += page.items.map((item) => item.text).join("");
      cursor = page.nextCursor;
    } while (cursor);
    expect(output).toBe("muse child done");
    disposeSession(session);
  });
});
