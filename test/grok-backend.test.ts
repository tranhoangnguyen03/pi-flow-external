import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage, fauxToolCall, type Context } from "../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/index.js";
import type { SubagentProfile, SubagentUsage } from "../src/types.ts";
import {
  buildGrokArgs,
  extractGrokCostUsd,
  extractGrokError,
  extractGrokFinalText,
  extractGrokSessionId,
  extractGrokUsage,
  grokActivityFromEvent,
  grokUsageToSubagentUsage,
  normalizeGrokReasoningEffort,
  spawnGrokSubagent,
  diagnoseGrokSandboxError,
} from "../src/core/grok.ts";
import { inspectRun } from "../src/core/run-inspection.ts";
import { MAX_STDOUT_LINE_CHARS } from "../src/core/stream.ts";
import { setupPiSubagentTestHarness } from "./helpers/pi-subagent-harness.ts";

describe("pi-subagent grok backend", () => {
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

  it("normalizes thinking effort to grok-accepted levels", () => {
    expect(normalizeGrokReasoningEffort(undefined)).toBeUndefined();
    expect(normalizeGrokReasoningEffort("off")).toBe("low");
    expect(normalizeGrokReasoningEffort("minimal")).toBe("low");
    expect(normalizeGrokReasoningEffort("low")).toBe("low");
    expect(normalizeGrokReasoningEffort("medium")).toBe("medium");
    expect(normalizeGrokReasoningEffort("high")).toBe("high");
    expect(normalizeGrokReasoningEffort("xhigh")).toBe("xhigh");
    expect(normalizeGrokReasoningEffort("unsupported")).toBeUndefined();
  });

  it("builds exact grok argv for normal, thinking, resume, and outputSchema modes", () => {
    const normalProfile: SubagentProfile = {
      name: "grok-worker",
      description: "Grok worker",
      backend: "grok" as any,
      model: "grok-4.6",
      systemPrompt: "You are Grok.",
    };

    const normalArgs = buildGrokArgs({
      promptFilePath: "/tmp/prompt.txt",
      profile: normalProfile,
      thinkingLevel: "minimal",
      permission: "danger",
    });

    expect(normalArgs).toEqual([
      "--prompt-file",
      "/tmp/prompt.txt",
      "--output-format",
      "streaming-messages-json",
      "--sandbox",
      "off",
      "--permission-mode",
      "bypassPermissions",
      "--system-prompt-override",
      "You are Grok.",
      "-m",
      "grok-4.6",
      "--reasoning-effort",
      "low",
    ]);

    const resumeArgs = buildGrokArgs({
      promptFilePath: "/tmp/prompt.txt",
      profile: normalProfile,
      permission: "edit",
      resumeSessionId: "session-abc-123",
      thinkingLevel: "high",
    });

    expect(resumeArgs).toEqual([
      "--prompt-file",
      "/tmp/prompt.txt",
      "--output-format",
      "streaming-messages-json",
      "--resume",
      "session-abc-123",
      "--sandbox",
      "workspace",
      "--permission-mode",
      "bypassPermissions",
      "--system-prompt-override",
      "You are Grok.",
      "-m",
      "grok-4.6",
      "--reasoning-effort",
      "high",
    ]);

    const schema = { type: "object", required: ["answer"], properties: { answer: { type: "string" } } };
    const structuredArgs = buildGrokArgs({
      promptFilePath: "/tmp/prompt.txt",
      profile: normalProfile,
      permission: "readonly",
      outputSchema: schema,
      thinkingLevel: "xhigh",
    });

    expect(structuredArgs).toEqual([
      "--prompt-file",
      "/tmp/prompt.txt",
      "--json-schema",
      JSON.stringify(schema),
      "--sandbox",
      "read-only",
      "--permission-mode",
      "bypassPermissions",
      "--system-prompt-override",
      "You are Grok.",
      "-m",
      "grok-4.6",
      "--reasoning-effort",
      "xhigh",
    ]);
  });

  it("maps grok usage and native total cost without estimation", () => {
    const usage = grokUsageToSubagentUsage({
      inputTokens: 100,
      cacheReadInputTokens: 200,
      cacheCreationInputTokens: 300,
      outputTokens: 50,
    }, 0.0128);

    expect(usage).toEqual({
      input: 100,
      cacheRead: 200,
      cacheWrite: 300,
      output: 50,
      cost: 0.0128,
      costKnown: true,
      costEstimated: false,
      latestCacheHitRate: (200 / (100 + 200 + 300)) * 100,
    });

    const noCostUsage = grokUsageToSubagentUsage({
      inputTokens: 50,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      outputTokens: 25,
    }, undefined);

    expect(noCostUsage).toMatchObject({
      input: 50,
      output: 25,
      cost: 0,
      costKnown: false,
      costEstimated: false,
    });

    const resultEvent = {
      type: "result",
      subtype: "success",
      stop_reason: "end_turn",
      total_cost_usd: 0.025,
      usage: {
        input_tokens: 150,
        cache_read_input_tokens: 50,
        cache_creation_input_tokens: 10,
        output_tokens: 45,
      },
      session_id: "sess-grok-result",
    };

    expect(extractGrokUsage(resultEvent)).toEqual({
      inputTokens: 150,
      cacheReadInputTokens: 50,
      cacheCreationInputTokens: 10,
      outputTokens: 45,
    });
    expect(extractGrokCostUsd(resultEvent)).toBe(0.025);
    expect(extractGrokSessionId(resultEvent)).toBe("sess-grok-result");

    const modelUsageEvent = {
      type: "result",
      subtype: "success",
      stop_reason: "end_turn",
      modelUsage: {
        "grok-4.6": { inputTokens: 100, cacheReadInputTokens: 20, cacheCreationInputTokens: 5, outputTokens: 30, costUSD: 0.01 },
        "grok-4.6-mini": { inputTokens: 40, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, outputTokens: 10, costUSD: 0.002 },
      },
    };
    expect(extractGrokUsage(modelUsageEvent)).toEqual({
      inputTokens: 140,
      cacheReadInputTokens: 20,
      cacheCreationInputTokens: 5,
      outputTokens: 40,
    });
    expect(extractGrokCostUsd(modelUsageEvent)).toBeCloseTo(0.012);
  });

  it("extracts session_id, final text, activity, and error from events", () => {
    expect(extractGrokSessionId({ type: "system", subtype: "init", session_id: "init-sess-1" })).toBe("init-sess-1");
    expect(extractGrokSessionId({ sessionId: "camel-sess-2" })).toBe("camel-sess-2");

    expect(extractGrokFinalText({
      type: "assistant",
      message: { content: [{ type: "text", text: "Assistant stream chunk" }] },
    })).toBe("Assistant stream chunk");

    expect(extractGrokFinalText({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "Final canonical result",
    })).toBe("Final canonical result");

    expect(grokActivityFromEvent({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", name: "read_file", input: { file_path: "src/core/grok.ts" } },
        ],
      },
    })).toBe("read_file src/core/grok.ts");

    expect(extractGrokError({
      type: "result",
      subtype: "failure",
      is_error: true,
      errors: ["Quota exhausted"],
    })).toBe("Grok failed: Quota exhausted");

    expect(extractGrokError({
      type: "error",
      message: "Network unreachable",
    })).toBe("Grok error: Network unreachable");
  });

  it("runs a normal grok subagent with exact argv, streaming events, and temp prompt cleanup", async () => {
    const binDir = join(tempDir, "bin-grok-normal");
    const runInfoPath = join(tempDir, "grok-run-info.json");
    mkdirSync(binDir, { recursive: true });

    const fakeGrokPath = join(binDir, "grok");
    writeFileSync(fakeGrokPath, `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
for await (const _chunk of process.stdin) {}
const args = process.argv.slice(2);
const promptFileIdx = args.indexOf('--prompt-file');
const promptFilePath = promptFileIdx !== -1 ? args[promptFileIdx + 1] : null;
const promptContent = promptFilePath ? readFileSync(promptFilePath, 'utf8') : null;

writeFileSync(${JSON.stringify(runInfoPath)}, JSON.stringify({ args, promptFilePath, promptContent }));

console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'grok-test-session' }));
console.log(JSON.stringify({
  type: 'assistant',
  message: {
    id: 'msg_1',
    content: [
      { type: 'text', text: 'Inspecting repository...' },
      { type: 'tool_use', name: 'read_file', input: { path: 'src/index.ts' } }
    ]
  }
}));
console.log(JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'Grok execution complete.',
  stop_reason: 'end_turn',
  total_cost_usd: 0.0128,
  usage: {
    input_tokens: 200,
    output_tokens: 60,
    cache_read_input_tokens: 80,
    cache_creation_input_tokens: 20
  },
  session_id: 'grok-test-session'
}));
`);
    chmodSync(fakeGrokPath, 0o755);
    process.env.PATH = `${binDir}:${originalPathEnv ?? ""}`;

    const usageEvents: SubagentUsage[] = [];
    const backendEvents: unknown[] = [];

    const result = await spawnGrokSubagent({
      toolCallId: "call_grok_normal",
      description: "Grok normal run",
      prompt: "Implement the feature completely.",
      profile: {
        name: "grok-engineer",
        description: "Grok engineering agent",
        backend: "grok" as any,
        model: "grok-4.6",
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
    expect(result.details.result).toBe("Grok execution complete.");
    expect(result.details.sessionId).toBe("grok-test-session");
    expect(result.details.usage).toEqual({
      input: 200,
      output: 60,
      cacheRead: 80,
      cacheWrite: 20,
      cost: 0.0128,
      costKnown: true,
      costEstimated: false,
      latestCacheHitRate: (80 / (200 + 80 + 20)) * 100,
    });
    expect(result.details.assistantOutput).toEqual({
      status: "final",
      messages: [
        { id: "msg_1", text: "Inspecting repository..." },
        { text: "Grok execution complete." },
      ],
    });

    const runInfo = JSON.parse(readFileSync(runInfoPath, "utf8"));
    expect(runInfo.args).toEqual([
      "--prompt-file",
      runInfo.promptFilePath,
      "--output-format",
      "streaming-messages-json",
      "--sandbox",
      "off",
      "--permission-mode",
      "bypassPermissions",
      "--system-prompt-override",
      "You are an expert engineer.",
      "-m",
      "grok-4.6",
      "--reasoning-effort",
      "high",
    ]);
    expect(runInfo.promptContent).toBe("Implement the feature completely.");
    expect(existsSync(runInfo.promptFilePath)).toBe(false);
    expect(backendEvents).toHaveLength(3);
  });

  it("handles resume by forwarding --resume sessionId", async () => {
    const binDir = join(tempDir, "bin-grok-resume");
    const runInfoPath = join(tempDir, "grok-resume-info.json");
    mkdirSync(binDir, { recursive: true });

    const fakeGrokPath = join(binDir, "grok");
    writeFileSync(fakeGrokPath, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
for await (const _chunk of process.stdin) {}
writeFileSync(${JSON.stringify(runInfoPath)}, JSON.stringify({ args: process.argv.slice(2) }));
console.log(JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'Resumed task done.',
  stop_reason: 'end_turn',
  total_cost_usd: 0.004,
  usage: { input_tokens: 50, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  session_id: 'prior-grok-sess'
}));
`);
    chmodSync(fakeGrokPath, 0o755);
    process.env.PATH = `${binDir}:${originalPathEnv ?? ""}`;

    const result = await spawnGrokSubagent({
      toolCallId: "call_grok_resume",
      description: "Grok resume run",
      prompt: "Continue the previous task.",
      profile: {
        name: "grok-resumer",
        description: "Grok resumer",
        backend: "grok" as any,
        model: "grok-4.6",
      },
      thinkingLevel: "medium",
      ctx: { cwd } as ExtensionContext,
      signal: undefined,
      progressEnabled: false,
      onProgress: undefined,
      onUsage: () => undefined,
      resumeSessionId: "prior-grok-sess",
    });

    expect(result.details.status).toBe("done");
    expect(result.details.result).toBe("Resumed task done.");
    expect(result.details.sessionId).toBe("prior-grok-sess");

    const runInfo = JSON.parse(readFileSync(runInfoPath, "utf8"));
    expect(runInfo.args).toContain("--resume");
    expect(runInfo.args[runInfo.args.indexOf("--resume") + 1]).toBe("prior-grok-sess");
  });

  it("handles structured output with --json-schema and parses nonstreaming JSON document at close", async () => {
    const binDir = join(tempDir, "bin-grok-structured");
    const runInfoPath = join(tempDir, "grok-structured-info.json");
    mkdirSync(binDir, { recursive: true });

    const fakeGrokPath = join(binDir, "grok");
    writeFileSync(fakeGrokPath, `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
for await (const _chunk of process.stdin) {}
const args = process.argv.slice(2);
const promptFileIdx = args.indexOf('--prompt-file');
const promptFilePath = promptFileIdx !== -1 ? args[promptFileIdx + 1] : null;
writeFileSync(${JSON.stringify(runInfoPath)}, JSON.stringify({ args, promptFilePath }));

const doc = {
  text: 'Structured completion',
  stopReason: 'end_turn',
  sessionId: 'grok-struct-sess',
  usage: {
    input_tokens: 300,
    output_tokens: 80,
    cache_read_input_tokens: 100,
    cache_creation_input_tokens: 0
  },
  total_cost_usd: 0.015,
  structuredOutput: {
    decision: 'approved',
    confidence: 0.98
  }
};
console.log(JSON.stringify(doc, null, 2));
`);
    chmodSync(fakeGrokPath, 0o755);
    process.env.PATH = `${binDir}:${originalPathEnv ?? ""}`;

    const schema = {
      type: "object",
      required: ["decision", "confidence"],
      properties: { decision: { type: "string" }, confidence: { type: "number" } },
    };

    const result = await spawnGrokSubagent({
      toolCallId: "call_grok_structured",
      description: "Grok structured run",
      prompt: "Evaluate the proposed patch.",
      profile: {
        name: "grok-evaluator",
        description: "Grok evaluator",
        backend: "grok" as any,
        model: "grok-4.6",
      },
      thinkingLevel: "low",
      ctx: { cwd } as ExtensionContext,
      signal: undefined,
      progressEnabled: false,
      onProgress: undefined,
      onUsage: () => undefined,
      outputSchema: schema,
    });

    expect(result.details.status).toBe("done");
    expect(result.details.result).toBe(JSON.stringify({ decision: "approved", confidence: 0.98 }));
    expect(result.details.sessionId).toBe("grok-struct-sess");
    expect(result.details.usage).toEqual({
      input: 300,
      output: 80,
      cacheRead: 100,
      cacheWrite: 0,
      cost: 0.015,
      costKnown: true,
      costEstimated: false,
      latestCacheHitRate: (100 / (300 + 100)) * 100,
    });

    const runInfo = JSON.parse(readFileSync(runInfoPath, "utf8"));
    expect(runInfo.args).toContain("--json-schema");
    expect(runInfo.args).not.toContain("--output-format");
    expect(existsSync(runInfo.promptFilePath)).toBe(false);
  });

  it("surfaces the backend's own structuredOutputError when structuredOutput is missing", async () => {
    const binDir = join(tempDir, "bin-grok-structured-error");
    mkdirSync(binDir, { recursive: true });

    const fakeGrokPath = join(binDir, "grok");
    writeFileSync(fakeGrokPath, `#!/usr/bin/env node
for await (const _chunk of process.stdin) {}
console.log(JSON.stringify({
  stopReason: 'end_turn',
  structuredOutputError: 'schema validation failed: missing required property "decision"'
}));
`);
    chmodSync(fakeGrokPath, 0o755);
    process.env.PATH = `${binDir}:${originalPathEnv ?? ""}`;

    const schema = {
      type: "object",
      required: ["decision"],
      properties: { decision: { type: "string" } },
    };

    const result = await spawnGrokSubagent({
      toolCallId: "call_grok_structured_error",
      description: "Grok structured error run",
      prompt: "Evaluate the proposed patch.",
      profile: {
        name: "grok-evaluator",
        description: "Grok evaluator",
        backend: "grok" as any,
        model: "grok-4.6",
      },
      thinkingLevel: "low",
      ctx: { cwd } as ExtensionContext,
      signal: undefined,
      progressEnabled: false,
      onProgress: undefined,
      onUsage: () => undefined,
      outputSchema: schema,
    });

    expect(result.details.status).toBe("error");
    expect(result.details.error).toBe(
      'Grok structured output failed: schema validation failed: missing required property "decision"',
    );
  });

  it("rejects when grok exits without a terminal JSON event and preserves interrupted output", async () => {
    const binDir = join(tempDir, "bin-grok-no-terminal");
    const promptPathFile = join(tempDir, "prompt-path.txt");
    mkdirSync(binDir, { recursive: true });

    const fakeGrokPath = join(binDir, "grok");
    writeFileSync(fakeGrokPath, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
for await (const _chunk of process.stdin) {}
const args = process.argv.slice(2);
const promptFileIdx = args.indexOf('--prompt-file');
if (promptFileIdx !== -1) writeFileSync(${JSON.stringify(promptPathFile)}, args[promptFileIdx + 1]);

console.log(JSON.stringify({
  type: 'assistant',
  message: {
    content: [{ type: 'text', text: 'Partial analysis before unexpected exit.' }]
  }
}));
`);
    chmodSync(fakeGrokPath, 0o755);
    process.env.PATH = `${binDir}:${originalPathEnv ?? ""}`;

    const result = await spawnGrokSubagent({
      toolCallId: "call_grok_no_term",
      description: "Grok no terminal",
      prompt: "Perform unfinished work.",
      profile: {
        name: "grok-crasher",
        description: "Grok crasher",
        backend: "grok" as any,
      },
      thinkingLevel: "medium",
      ctx: { cwd } as ExtensionContext,
      signal: undefined,
      progressEnabled: false,
      onProgress: undefined,
      onUsage: () => undefined,
    });

    expect(result.details.status).toBe("error");
    expect(result.details.error).toContain("grok exited without a terminal JSON event");
    expect(result.details.assistantOutput).toEqual({
      status: "interrupted",
      messages: [{ text: "Partial analysis before unexpected exit." }],
    });
    expect(result.content[0].text).toContain("Interrupted output:\nPartial analysis before unexpected exit.");

    const promptPath = readFileSync(promptPathFile, "utf8");
    expect(existsSync(promptPath)).toBe(false);
  });

  it("rejects when terminal event does not affirm success or stop_reason is not end_turn", async () => {
    const binDir = join(tempDir, "bin-grok-terminal-fail");
    mkdirSync(binDir, { recursive: true });

    const fakeGrokPath = join(binDir, "grok");
    writeFileSync(fakeGrokPath, `#!/usr/bin/env node
for await (const _chunk of process.stdin) {}
console.log(JSON.stringify({
  type: 'result',
  subtype: 'failure',
  is_error: true,
  errors: ['Budget exceeded or model refused'],
  stop_reason: 'refusal',
  result: ''
}));
`);
    chmodSync(fakeGrokPath, 0o755);
    process.env.PATH = `${binDir}:${originalPathEnv ?? ""}`;

    const result = await spawnGrokSubagent({
      toolCallId: "call_grok_term_fail",
      description: "Grok terminal fail",
      prompt: "Refused prompt.",
      profile: {
        name: "grok-failed",
        description: "Grok failed profile",
        backend: "grok" as any,
      },
      thinkingLevel: "low",
      ctx: { cwd } as ExtensionContext,
      signal: undefined,
      progressEnabled: false,
      onProgress: undefined,
      onUsage: () => undefined,
    });

    expect(result.details.status).toBe("error");
    expect(result.details.error).toContain("Grok failed: Budget exceeded or model refused");
  });

  it("reports a nonzero grok exit code along with captured stderr", async () => {
    const binDir = join(tempDir, "bin-grok-nonzero-exit");
    mkdirSync(binDir, { recursive: true });

    const fakeGrokPath = join(binDir, "grok");
    writeFileSync(fakeGrokPath, `#!/usr/bin/env node
for await (const _chunk of process.stdin) {}
process.stderr.write('grok: authentication token expired\\n');
process.exit(2);
`);
    chmodSync(fakeGrokPath, 0o755);
    process.env.PATH = `${binDir}:${originalPathEnv ?? ""}`;

    const result = await spawnGrokSubagent({
      toolCallId: "call_grok_nonzero_exit",
      description: "Grok nonzero exit",
      prompt: "Trigger a crashing exit.",
      profile: {
        name: "grok-crashy",
        description: "Grok crashy profile",
        backend: "grok" as any,
      },
      thinkingLevel: "low",
      ctx: { cwd } as ExtensionContext,
      signal: undefined,
      progressEnabled: false,
      onProgress: undefined,
      onUsage: () => undefined,
    });

    expect(result.details.status).toBe("error");
    expect(result.details.error).toContain("grok exited with code 2");
    expect(result.details.error).toContain("grok: authentication token expired");
  });

  it("kills child process and cleans up prompt file when aborted after spawn", async () => {
    const binDir = join(tempDir, "bin-grok-abort");
    const markerPath = join(tempDir, "grok-child-finished");
    const promptPathFile = join(tempDir, "abort-prompt-path.txt");
    mkdirSync(binDir, { recursive: true });

    const fakeGrokPath = join(binDir, "grok");
    writeFileSync(fakeGrokPath, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
process.stdin.resume();
const args = process.argv.slice(2);
const promptFileIdx = args.indexOf('--prompt-file');
if (promptFileIdx !== -1) writeFileSync(${JSON.stringify(promptPathFile)}, args[promptFileIdx + 1]);

setTimeout(() => {
  writeFileSync(${JSON.stringify(markerPath)}, 'finished');
  console.log(JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'Should not happen',
    stop_reason: 'end_turn'
  }));
}, 800);
`);
    chmodSync(fakeGrokPath, 0o755);
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

    const result = await spawnGrokSubagent({
      toolCallId: "call_grok_abort",
      description: "Grok abort test",
      prompt: "Task that gets aborted.",
      profile: {
        name: "grok-aborter",
        description: "Grok aborter",
        backend: "grok" as any,
      },
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

  it("fails clearly when grok emits an oversized stdout line and cleans up prompt file", async () => {
    const binDir = join(tempDir, "bin-grok-oversize");
    const promptPathFile = join(tempDir, "oversize-prompt-path.txt");
    mkdirSync(binDir, { recursive: true });

    const fakeGrokPath = join(binDir, "grok");
    writeFileSync(fakeGrokPath, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
for await (const _chunk of process.stdin) {}
const args = process.argv.slice(2);
const promptFileIdx = args.indexOf('--prompt-file');
if (promptFileIdx !== -1) writeFileSync(${JSON.stringify(promptPathFile)}, args[promptFileIdx + 1]);

console.log('g'.repeat(${MAX_STDOUT_LINE_CHARS + 1024}));
console.log(JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'must not reach',
  stop_reason: 'end_turn'
}));
`);
    chmodSync(fakeGrokPath, 0o755);
    process.env.PATH = `${binDir}:${originalPathEnv ?? ""}`;

    const result = await spawnGrokSubagent({
      toolCallId: "call_grok_oversize",
      description: "Grok oversize test",
      prompt: "Trigger oversize line.",
      profile: {
        name: "grok-oversize",
        description: "Grok oversize profile",
        backend: "grok" as any,
      },
      thinkingLevel: "low",
      ctx: { cwd } as ExtensionContext,
      signal: undefined,
      progressEnabled: false,
      onProgress: undefined,
      onUsage: () => undefined,
    });

    expect(result.details.status).toBe("error");
    expect(result.details.error).toContain("grok emitted a stdout line over");
    expect(result.details.error).toContain("chars");

    const promptPath = readFileSync(promptPathFile, "utf8");
    expect(existsSync(promptPath)).toBe(false);
  });

  it("runs a grok-backed subagent through the Agent tool with nested activity and a session receipt", async () => {
    const subagentsDir = join(agentDir, "pi-flow-external", "overrides");
    const binDir = join(tempDir, "bin-grok-agent-tool");
    const runInfoPath = join(tempDir, "grok-agent-tool-info.json");
    mkdirSync(subagentsDir, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    writeFileSync(
      join(subagentsDir, "grok-worker.md"),
      "---\ndescription: Works through Grok CLI.\nbackend: grok\nmodel: grok-4.6\nthinking: high\n---\n\nGrok worker prompt.",
    );

    const fakeGrokPath = join(binDir, "grok");
    writeFileSync(fakeGrokPath, `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
for await (const _chunk of process.stdin) {}
const args = process.argv.slice(2);
const promptFileIdx = args.indexOf('--prompt-file');
const promptFilePath = promptFileIdx !== -1 ? args[promptFileIdx + 1] : null;
const promptContent = promptFilePath ? readFileSync(promptFilePath, 'utf8') : null;
writeFileSync(${JSON.stringify(runInfoPath)}, JSON.stringify({ args, promptContent }));

console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'grok-agent-tool-session' }));
console.log(JSON.stringify({
  type: 'assistant',
  message: { id: 'm1', content: [{ type: 'tool_use', name: 'spawn_subagent', input: { description: 'nested lookup' } }] }
}));
console.log(JSON.stringify({
  type: 'assistant',
  message: { id: 'm2', content: [{ type: 'text', text: 'grok child done' }] }
}));
console.log(JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'grok child done',
  stop_reason: 'end_turn',
  session_id: 'grok-agent-tool-session',
  total_cost_usd: 0.01,
  usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
}));
`);
    chmodSync(fakeGrokPath, 0o755);
    process.env.PATH = `${binDir}:${originalPathEnv ?? ""}`;

    const { session, registration } = await createSession();
    let rootContinuationContext: Context | undefined;
    registration.setResponses([
      fauxAssistantMessage([fauxToolCall("Agent", {
        description: "Grok work",
        role: "worker",
        harness: "grok",
        prompt: "Do the task.",
      })], { stopReason: "toolUse" }),
      (context) => {
        rootContinuationContext = context;
        return fauxAssistantMessage("reported");
      },
    ]);

    await session.prompt("Delegate to Grok.");

    const runInfo = JSON.parse(readFileSync(runInfoPath, "utf8"));
    // Unlike agy (no native system-prompt flag), grok forwards the profile's
    // systemPrompt natively via --system-prompt-override; the prompt file
    // carries only the task prompt.
    expect(runInfo.promptContent).toBe("Do the task.");
    expect(runInfo.args).toContain("--system-prompt-override");
    expect(runInfo.args[runInfo.args.indexOf("--system-prompt-override") + 1]).toBe("Grok worker prompt.");
    expect(JSON.stringify(rootContinuationContext?.messages)).toContain("grok child done");

    const recordsRoot = join(agentDir, "pi-flow-external", "runs");
    const runDirectories = readdirSync(recordsRoot);
    expect(runDirectories).toHaveLength(1);
    const recordDirectory = join(recordsRoot, runDirectories[0]!);
    const summary = JSON.parse(readFileSync(join(recordDirectory, "summary.json"), "utf8"));
    expect(summary.summary).toMatchObject({
      backend: "grok",
      profile: "grok-worker",
      status: "done",
      backendEventCount: 4,
      nestedActivitySeen: true,
      nestedAgentControl: "allowed-observed",
      permission: { tier: "danger", enforced: true },
      sessionId: "grok-agent-tool-session",
    });

    let output = "";
    let cursor: string | undefined;
    do {
      const page = await inspectRun({ runsDirectory: recordsRoot, runId: runDirectories[0]!, view: "output", limitBytes: 4, cursor });
      output += page.items.map((item) => item.text).join("");
      cursor = page.nextCursor;
    } while (cursor);
    expect(output).toBe("grok child done");
    disposeSession(session);
  });

  it("does not attach sandbox diagnosis when stderr does not match both required markers", () => {
    expect(diagnoseGrokSandboxError("grok: authentication token expired")).toBeUndefined();
    expect(diagnoseGrokSandboxError("could not resolve runtime-socket deny path /var/run/docker.sock")).toBeUndefined();
    expect(diagnoseGrokSandboxError("endpoint is a symlink")).toBeUndefined();
  });

  it("preserves requested readonly permission receipt and surfaces actionable diagnosis on runtime socket symlink failure", async () => {
    const binDir = join(tempDir, "bin-grok-symlink-receipt");
    mkdirSync(binDir, { recursive: true });

    const invocationLogPath = join(tempDir, "grok-symlink-invocations.json");
    const fakeGrokPath = join(binDir, "grok");
    writeFileSync(fakeGrokPath, `#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
for await (const _chunk of process.stdin) {}
const invocations = existsSync(${JSON.stringify(invocationLogPath)})
  ? JSON.parse(readFileSync(${JSON.stringify(invocationLogPath)}, 'utf8'))
  : [];
invocations.push(process.argv.slice(2));
writeFileSync(${JSON.stringify(invocationLogPath)}, JSON.stringify(invocations));

process.stderr.write(
  "warning: sandbox could not be applied: socket deny resolution failed: could not resolve runtime-socket deny path /var/run/docker.sock: endpoint is a symlink\\n" +
  "error: could not apply the 'read-only' sandbox profile; see the warning above for the cause. Refusing to start with its protections missing.\\n"
);
process.exit(1);
`);
    chmodSync(fakeGrokPath, 0o755);
    process.env.PATH = `${binDir}:${originalPathEnv ?? ""}`;

    const { session, registration } = await createSession();
    let rootContinuationContext: Context | undefined;
    registration.setResponses([
      fauxAssistantMessage([fauxToolCall("Agent", {
        description: "Grok read-only review",
        role: "reviewer",
        harness: "grok",
        permission: "readonly",
        prompt: "Review PR changes.",
      })], { stopReason: "toolUse" }),
      (context) => {
        rootContinuationContext = context;
        return fauxAssistantMessage("acknowledged failure");
      },
    ]);

    await session.prompt("Run review with Grok.");

    // Exactly one invocation: never automatically retried
    const invocations = JSON.parse(readFileSync(invocationLogPath, "utf8"));
    expect(invocations).toHaveLength(1);
    // Verified read-only sandbox args: never downgraded to off
    expect(invocations[0]).toContain("--sandbox");
    expect(invocations[0][invocations[0].indexOf("--sandbox") + 1]).toBe("read-only");
    expect(invocations[0]).toContain("--permission-mode");
    expect(invocations[0][invocations[0].indexOf("--permission-mode") + 1]).toBe("bypassPermissions");

    const recordsRoot = join(agentDir, "pi-flow-external", "runs");
    const runDirectories = readdirSync(recordsRoot);
    expect(runDirectories).toHaveLength(1);
    const recordDirectory = join(recordsRoot, runDirectories[0]!);
    const summary = JSON.parse(readFileSync(join(recordDirectory, "summary.json"), "utf8"));

    // Receipt preserves requested readonly permission tier and enforcement
    expect(summary.summary).toMatchObject({
      backend: "grok",
      status: "error",
      permission: { tier: "readonly", enforced: true },
    });

    // Summary error preserves full exact stderr and appends the actionable diagnostic hint
    expect(summary.summary.error).toContain(
      "warning: sandbox could not be applied: socket deny resolution failed: could not resolve runtime-socket deny path /var/run/docker.sock: endpoint is a symlink",
    );
    expect(summary.summary.error).toContain(
      "error: could not apply the 'read-only' sandbox profile; see the warning above for the cause. Refusing to start with its protections missing.",
    );
    expect(summary.summary.error).toContain(
      "Diagnostic: Grok sandbox initialization failed because a runtime socket deny path is a symlink.",
    );
    expect(summary.summary.error).toContain(
      "Do not remove or alter the socket as a runner workaround.",
    );
    expect(summary.summary.error).toContain(
      "pi-flow-external preserves requested sandbox permissions and will not automatically downgrade or retry with protections disabled.",
    );
    expect(summary.summary.error).toContain(
      "Run on a compatible host or upgrade to an upstream Grok release that resolves socket symlinks.",
    );

    // Parent context message also received the failure with the exact stderr and hint
    const continuationText = JSON.stringify(rootContinuationContext?.messages);
    expect(continuationText).toContain("socket deny resolution failed");
    expect(continuationText).toContain("Grok sandbox initialization failed because a runtime socket deny path is a symlink");

    disposeSession(session);
  });
});
