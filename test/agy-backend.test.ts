import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage, fauxToolCall, type Context } from "../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/index.js";
import {
  agyUsageToSubagentUsage,
  buildAgyArgs,
  extractAgyTerminalResult,
  normalizeAgyEffort,
  spawnAgySubagent,
} from "../src/core/agy.ts";
import { setupPiSubagentTestHarness } from "./helpers/pi-subagent-harness.ts";
import { MAX_STDOUT_LINE_CHARS } from "../src/core/stream.ts";

describe("pi-subagent agy backend", () => {
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

  it("builds a current headless stream-json invocation", () => {
    const outputSchema = { type: "object", required: ["answer"] };
    const args = buildAgyArgs({
      profile: { name: "agy-reviewer", description: "Agy", backend: "agy", model: "best" },
      thinkingLevel: "high",
      outputSchema,
    });
    expect(args).toEqual([
      "--dangerously-skip-permissions",
      "--output-format",
      "stream-json",
      "--input-format",
      "stream-json",
      "--print-timeout",
      "15m",
      "--model",
      "best",
      "--effort",
      "high",
      "--json-schema",
      JSON.stringify(outputSchema),
    ]);
    expect(normalizeAgyEffort("xhigh")).toBe("high");
    expect(normalizeAgyEffort("minimal")).toBe("low");
    expect(normalizeAgyEffort("off")).toBeUndefined();
    expect(normalizeAgyEffort("backend-specific")).toBeUndefined();
  });

  it("extracts terminal metadata and maps token usage", () => {
    const terminal = extractAgyTerminalResult({
      event: "result",
      result: {
        conversation_id: "agy-conversation",
        status: "SUCCESS",
        response: "{\"answer\":\"done\"}",
        structured_output: { answer: "done" },
        usage: {
          input_tokens: 1_000,
          output_tokens: 50,
          thinking_tokens: 25,
          cache_read_tokens: 200,
          total_tokens: 1_075,
        },
      },
    });

    expect(terminal).toEqual({
      conversationId: "agy-conversation",
      status: "SUCCESS",
      response: "{\"answer\":\"done\"}",
      structuredOutput: { answer: "done" },
      error: undefined,
      usage: {
        inputTokens: 1_000,
        outputTokens: 50,
        thinkingTokens: 25,
        cacheReadTokens: 200,
        totalTokens: 1_075,
      },
    });
    expect(agyUsageToSubagentUsage(terminal!.usage!)).toMatchObject({
      input: 800,
      output: 75,
      cacheRead: 200,
      cacheWrite: 0,
      cost: 0,
      costKnown: false,
    });
  });

  it("runs an agy-backed subagent through the Agent tool", async () => {
    const subagentsDir = join(agentDir, "subagents");
    const binDir = join(tempDir, "bin-agy");
    const argsPath = join(tempDir, "agy-args.json");
    mkdirSync(subagentsDir, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(subagentsDir, "agy-reviewer.md"), `---\ndescription: Reviews through Antigravity.\nbackend: agy\nmodel: default\nthinking: high\n---\n\nAgy reviewer prompt.`);
    const fakeAgyPath = join(binDir, "agy");
    writeFileSync(fakeAgyPath, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
let stdin = '';
for await (const chunk of process.stdin) stdin += chunk;
writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify({ args: process.argv.slice(2), stdin }));
console.log(JSON.stringify({ event: 'init', conversation_id: 'agy-test-session', init: { permission_mode: 'always-proceed' } }));
await new Promise((resolve) => setTimeout(resolve, 20));
console.log(JSON.stringify({ event: 'step_update', step_update: { state: 'DONE', step_type: 'tool', tool_name: 'spawn_agent' } }));
console.log(JSON.stringify({ event: 'step_update', step_update: { state: 'DONE', step_type: 'agent_response', text_delta: 'agy child done' } }));
console.log(JSON.stringify({ event: 'result', result: { conversation_id: 'agy-test-session', status: 'SUCCESS', response: 'agy child done', usage: { input_tokens: 1000, output_tokens: 50, thinking_tokens: 25, cache_read_tokens: 200, total_tokens: 1075 } } }));
`);
    chmodSync(fakeAgyPath, 0o755);
    process.env.PATH = `${binDir}:${originalPathEnv ?? ""}`;

    const { session, registration } = await createSession();
    let rootContinuationContext: Context | undefined;
    registration.setResponses([
      fauxAssistantMessage([fauxToolCall("Agent", {
        description: "Agy review",
        subagent_type: "agy-reviewer",
        prompt: "Review the latest diff.",
      })], { stopReason: "toolUse" }),
      (context) => {
        rootContinuationContext = context;
        return fauxAssistantMessage("reported");
      },
    ]);

    await session.prompt("Delegate to Antigravity.");

    const agyRun = JSON.parse(readFileSync(argsPath, "utf8"));
    expect(agyRun.args).toEqual([
      "--dangerously-skip-permissions",
      "--output-format",
      "stream-json",
      "--input-format",
      "stream-json",
      "--print-timeout",
      "15m",
      "--model",
      "default",
      "--effort",
      "high",
    ]);
    expect(agyRun.stdin).toBe(`${JSON.stringify({
      event: "user",
      message: { content: "Agy reviewer prompt.\n\nReview the latest diff." },
    })}\n`);
    expect(agyRun.args.join(" ")).not.toContain("Review the latest diff.");
    expect(JSON.stringify(rootContinuationContext?.messages)).toContain("agy child done");

    const recordsRoot = join(agentDir, "pi-flow-external", "runs");
    const runDirectories = readdirSync(recordsRoot);
    expect(runDirectories).toHaveLength(1);
    const recordDirectory = join(recordsRoot, runDirectories[0]!);
    const summary = JSON.parse(readFileSync(join(recordDirectory, "summary.json"), "utf8"));
    const events = readFileSync(join(recordDirectory, "events.ndjson"), "utf8");
    expect(summary.summary).toMatchObject({
      backend: "agy",
      profile: "agy-reviewer",
      status: "done",
      backendEventCount: 4,
      nestedActivitySeen: true,
      nestedAgentControl: "allowed-observed",
      nestedTimeoutExtended: true,
      permission: { tier: "danger", enforced: true },
    });
    expect(summary.summary.effectiveTimeoutMs).toBeGreaterThan(summary.summary.configuredTimeoutMs);
    expect(events.match(/"type":"backend_event"/g)).toHaveLength(4);
    expect(events).toContain('"type":"nested_timeout_extended"');
    disposeSession(session);
  });

  it("uses structured terminal output and forwards every parsed backend event", async () => {
    const binDir = join(tempDir, "bin-agy-structured");
    mkdirSync(binDir, { recursive: true });
    const fakeAgyPath = join(binDir, "agy");
    writeFileSync(fakeAgyPath, `#!/usr/bin/env node
console.log(JSON.stringify({ event: 'init', conversation_id: 'agy-structured-session', init: { permission_mode: 'always-proceed' } }));
console.log(JSON.stringify({ event: 'step_update', step_update: { state: 'DONE', step_type: 'tool', tool_name: 'view_file' } }));
console.log(JSON.stringify({ event: 'result', result: { conversation_id: 'agy-structured-session', status: 'SUCCESS', response: '{"answer":"fallback"}', structured_output: { answer: 'structured' }, usage: { input_tokens: 1200, output_tokens: 60, thinking_tokens: 30, cache_read_tokens: 300, total_tokens: 1290 } } }));
`);
    chmodSync(fakeAgyPath, 0o755);
    process.env.PATH = `${binDir}:${originalPathEnv ?? ""}`;

    const backendEvents: unknown[] = [];
    const reportedUsage: unknown[] = [];
    const result = await spawnAgySubagent({
      toolCallId: "agy-structured",
      description: "Agy structured",
      prompt: "Return structured output.",
      profile: {
        name: "agy-structured",
        description: "Agy structured profile.",
        backend: "agy",
        model: "default",
      },
      thinkingLevel: "high",
      ctx: { cwd } as ExtensionContext,
      signal: undefined,
      progressEnabled: false,
      onProgress: undefined,
      onUsage: (usage) => reportedUsage.push(usage),
      onBackendEvent: (event) => {
        backendEvents.push(event);
        if ((event as { event?: string }).event === "step_update") throw new Error("observer failed");
      },
      outputSchema: { type: "object", required: ["answer"] },
    });

    expect(result.details).toMatchObject({
      status: "done",
      backend: "agy",
      result: JSON.stringify({ answer: "structured" }),
      conversationId: "agy-structured-session",
      usage: {
        input: 900,
        output: 90,
        cacheRead: 300,
        cost: 0,
        costKnown: false,
      },
    });
    expect(backendEvents).toHaveLength(3);
    expect(backendEvents).toContainEqual(expect.objectContaining({ event: "result" }));
    expect(reportedUsage.at(-1)).toMatchObject({ input: 900, output: 90, cacheRead: 300 });
  });

  it("fails a clean exit that has no terminal result", async () => {
    const binDir = join(tempDir, "bin-agy-missing-result");
    mkdirSync(binDir, { recursive: true });
    const fakeAgyPath = join(binDir, "agy");
    writeFileSync(fakeAgyPath, `#!/usr/bin/env node
console.log(JSON.stringify({ event: 'init', conversation_id: 'agy-missing-result' }));
console.log(JSON.stringify({ event: 'step_update', step_update: { state: 'DONE', step_type: 'agent_response', text_delta: 'not terminal' } }));
`);
    chmodSync(fakeAgyPath, 0o755);
    process.env.PATH = `${binDir}:${originalPathEnv ?? ""}`;

    const result = await spawnAgySubagent({
      toolCallId: "agy-missing-result",
      description: "Agy missing result",
      prompt: "Exit without a terminal result.",
      profile: { name: "agy-missing", description: "Agy missing.", backend: "agy" },
      thinkingLevel: undefined,
      ctx: { cwd } as ExtensionContext,
      signal: undefined,
      progressEnabled: false,
      onProgress: undefined,
      onUsage: () => undefined,
    });

    expect(result.details.status).toBe("error");
    expect(result.details.error).toContain("without a terminal result event");
  });

  it("retries an agy infrastructure failure once and reports the retry", async () => {
    const subagentsDir = join(agentDir, "subagents");
    const binDir = join(tempDir, "bin-agy-retry");
    const counterPath = join(tempDir, "agy-retry-count.txt");
    mkdirSync(subagentsDir, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(subagentsDir, "agy-reviewer.md"), `---\ndescription: Reviews through Antigravity.\nbackend: agy\nmodel: default\n---\n\nAgy reviewer prompt.`);
    const fakeAgyPath = join(binDir, "agy");
    writeFileSync(fakeAgyPath, `#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
let stdin = '';
for await (const chunk of process.stdin) stdin += chunk;
const count = existsSync(${JSON.stringify(counterPath)}) ? Number(readFileSync(${JSON.stringify(counterPath)}, 'utf8')) + 1 : 1;
writeFileSync(${JSON.stringify(counterPath)}, String(count));
if (count === 1) {
  process.exitCode = 1;
  console.log(JSON.stringify({ event: 'result', result: { conversation_id: 'agy-retry', status: 'ERROR', response: '', error: 'Eligibility check failed: Get "https://www.googleapis.com/oauth2/v2/userinfo": read: operation timed out', usage: { input_tokens: 5, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 5 } } }));
} else {
  console.log(JSON.stringify({ event: 'result', result: { conversation_id: 'agy-retry', status: 'SUCCESS', response: 'agy child done after retry', usage: { input_tokens: 1000, output_tokens: 50, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 1050 } } }));
}
`);
    chmodSync(fakeAgyPath, 0o755);
    process.env.PATH = `${binDir}:${originalPathEnv ?? ""}`;

    const { session, registration } = await createSession();
    let rootContinuationContext: Context | undefined;
    registration.setResponses([
      fauxAssistantMessage([fauxToolCall("Agent", {
        description: "Agy review",
        subagent_type: "agy-reviewer",
        prompt: "Review the latest diff.",
      })], { stopReason: "toolUse" }),
      (context) => {
        rootContinuationContext = context;
        return fauxAssistantMessage("reported");
      },
    ]);

    await session.prompt("Delegate to Antigravity.");

    expect(Number(readFileSync(counterPath, "utf8"))).toBe(2);
    const serialized = JSON.stringify(rootContinuationContext?.messages);
    expect(serialized).toContain("agy child done after retry");
    expect(serialized).toContain("\"retries\":1");
  });

  it("prefers the agy terminal failure over the exit code", async () => {
    const binDir = join(tempDir, "bin-agy-error-result");
    mkdirSync(binDir, { recursive: true });
    const fakeAgyPath = join(binDir, "agy");
    writeFileSync(fakeAgyPath, `#!/usr/bin/env node
process.exitCode = 1;
console.log(JSON.stringify({ event: 'result', result: { conversation_id: 'agy-error-result', status: 'ERROR', response: '', error: 'provider unavailable', usage: { input_tokens: 20, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 20 } } }));
`);
    chmodSync(fakeAgyPath, 0o755);
    process.env.PATH = `${binDir}:${originalPathEnv ?? ""}`;

    const result = await spawnAgySubagent({
      toolCallId: "agy-error-result",
      description: "Agy error result",
      prompt: "Return an error envelope.",
      profile: { name: "agy-error", description: "Agy error.", backend: "agy" },
      thinkingLevel: undefined,
      ctx: { cwd } as ExtensionContext,
      signal: undefined,
      progressEnabled: false,
      onProgress: undefined,
      onUsage: () => undefined,
    });

    expect(result.details.status).toBe("error");
    expect(result.details.error).toContain("status ERROR: provider unavailable");
    expect(result.details.error).toContain("exit code 1");
    expect(result.details).toMatchObject({ conversationId: "agy-error-result" });
  });

  it("fails clearly when agy emits an oversized newline-terminated stdout line", async () => {
    const binDir = join(tempDir, "bin-agy-oversize");
    mkdirSync(binDir, { recursive: true });
    const fakeAgyPath = join(binDir, "agy");
    writeFileSync(fakeAgyPath, `#!/usr/bin/env node
console.log('x'.repeat(${MAX_STDOUT_LINE_CHARS + 1024}));
console.log(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'must not pass' } }));
`);
    chmodSync(fakeAgyPath, 0o755);
    process.env.PATH = `${binDir}:${originalPathEnv ?? ""}`;

    const result = await spawnAgySubagent({
      toolCallId: "agy-oversize",
      description: "Agy oversize",
      prompt: "Trigger oversize stdout.",
      profile: { name: "agy-oversize", description: "Test.", backend: "agy" },
      thinkingLevel: undefined,
      ctx: { cwd } as ExtensionContext,
      signal: undefined,
      progressEnabled: false,
      onProgress: undefined,
      onUsage: () => undefined,
    });

    expect(result.details.status).toBe("error");
    expect(result.details.error).toContain("agy emitted a stdout line over");
  });

  it("kills an agy child if abort lands after process spawn", async () => {
    const binDir = join(tempDir, "bin-agy-abort-race");
    const markerPath = join(tempDir, "agy-child-completed");
    mkdirSync(binDir, { recursive: true });
    const fakeAgyPath = join(binDir, "agy");
    writeFileSync(fakeAgyPath, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
setTimeout(() => {
  writeFileSync(${JSON.stringify(markerPath)}, 'completed');
  console.log('should not complete');
}, 700);
`);
    chmodSync(fakeAgyPath, 0o755);
    process.env.PATH = `${binDir}:${originalPathEnv ?? ""}`;

    let abortedChecks = 0;
    const signal = {
      get aborted() {
        abortedChecks += 1;
        return abortedChecks >= 2;
      },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as AbortSignal;

    const result = await spawnAgySubagent({
      toolCallId: "agy-abort-race",
      description: "Agy abort race",
      prompt: "This should be aborted before the prompt is sent.",
      profile: {
        name: "agy-race",
        description: "Agy abort race profile.",
        backend: "agy",
        systemPrompt: "Agy race prompt.",
      },
      thinkingLevel: "medium",
      ctx: { cwd } as ExtensionContext,
      signal,
      progressEnabled: false,
      onProgress: undefined,
      onUsage: () => undefined,
    });

    expect(result.details.status).toBe("aborted");
    expect(result.details.backend).toBe("agy");
    expect(result.details.error).toContain("aborted before prompt start");
    expect(signal.addEventListener).toHaveBeenCalledWith("abort", expect.any(Function), { once: true });
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(existsSync(markerPath)).toBe(false);
  });
});
