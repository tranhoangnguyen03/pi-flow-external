import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { installFakeCli } from "./helpers/fake-cli.ts";
import { fauxAssistantMessage, fauxToolCall, type Context } from "@earendil-works/pi-ai";
import {
  agyUsageToSubagentUsage,
  agyPrintTimeout,
  buildAgyArgs,
  extractAgyTerminalResult,
  isTransientAgyFailure,
  normalizeAgyEffort,
  spawnAgySubagent,
} from "../src/core/agy.ts";
import { setupPiSubagentTestHarness } from "./helpers/pi-subagent-harness.ts";
import { MAX_STDOUT_LINE_CHARS } from "../src/core/stream.ts";
import { inspectRun } from "../src/core/run-inspection.ts";
import { spawnSubagent } from "../src/core/spawn.ts";
import type { SubagentToolDetails } from "../src/types.ts";

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
      timeoutMs: 7_200_000,
    });
    expect(args).toEqual([
      "--dangerously-skip-permissions",
      "--output-format",
      "stream-json",
      "--input-format",
      "stream-json",
      "--print-timeout",
      "2h",
      "--model",
      "best",
      "--effort",
      "high",
      "--json-schema",
      JSON.stringify(outputSchema),
    ]);
    expect(normalizeAgyEffort("xhigh")).toBe("high");
    expect(normalizeAgyEffort("max")).toBe("high");
    expect(normalizeAgyEffort("minimal")).toBe("low");
    expect(normalizeAgyEffort("off")).toBeUndefined();
    for (const effort of ["backend-specific", "", "native", "parent"]) {
      expect(() => normalizeAgyEffort(effort)).toThrow(/unsupported.*effort/i);
    }
  });

  it("requires explicit benchmark opt-in and preserves danger in both CLI comparison modes", () => {
    const binDir = join(tempDir, "agy-bench-bin");
    const callsPath = join(tempDir, "agy-bench-calls.ndjson");
    installFakeCli(binDir, "agy", `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
let stdin = '';
for await (const chunk of process.stdin) stdin += chunk;
appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({ args: process.argv.slice(2), stdin }) + '\\n');
console.log(JSON.stringify({ event: 'init', conversation_id: 'fixture-benchmark' }));
console.log(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'AGY_LATENCY_CHECK' } }));
`, originalPathEnv);
    const script = join(process.cwd(), "scripts", "e2e", "agy-latency.mjs");
    const help = execFileSync(process.execPath, [script], { encoding: "utf8" });
    expect(help).toContain("No provider calls occur");
    expect(existsSync(callsPath)).toBe(false);
    const output = execFileSync(process.execPath, [script, "--execute", "--rounds", "1", "--timeout-ms", "1000"], { encoding: "utf8" });
    const results = output.trim().split("\\n").map((line) => JSON.parse(line));
    expect(results.filter((result) => result.success)).toHaveLength(2);
    const calls = readFileSync(callsPath, "utf8").trim().split("\\n").map((line) => JSON.parse(line));
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.args.includes("--dangerously-skip-permissions"))).toBe(true);
    const stdinCall = calls.find((call) => call.args.includes("--input-format"));
    const printCall = calls.find((call) => call.args.includes("--print"));
    expect(stdinCall?.stdin).toContain("AGY_LATENCY_CHECK");
    expect(printCall?.args).toContain("AGY_LATENCY_CHECK");
    expect(printCall?.stdin).toBe("");
  });

  it("maps the subagent timeout to agy's Go duration print timeout", () => {
    expect(agyPrintTimeout(7_200_000)).toBe("2h");
    expect(agyPrintTimeout(5_400_000)).toBe("90m");
    expect(agyPrintTimeout(65_000)).toBe("65s");
    expect(agyPrintTimeout(2_500)).toBe("2500ms");
    expect(agyPrintTimeout(0)).toBe("8760h");
    expect(agyPrintTimeout(-1000)).toBe("8760h");
    expect(agyPrintTimeout(NaN)).toBeUndefined();
    expect(agyPrintTimeout(Infinity)).toBeUndefined();
    expect(agyPrintTimeout(undefined)).toBeUndefined();
  });

  it("omits --print-timeout when timeoutMs is undefined (agy's own default)", () => {
    const args = buildAgyArgs({
      profile: { name: "agy-reviewer", description: "Agy", backend: "agy", model: "best" },
      thinkingLevel: "high",
    });
    expect(args).not.toContain("--print-timeout");
  });

  it("does not retry agy's own print-wait timeout as an infra failure", () => {
    expect(isTransientAgyFailure(new Error("agy failed with status ERROR: timeout waiting for response (exit code 1)"))).toBe(false);
    expect(isTransientAgyFailure(new Error("Eligibility check failed: operation timed out"))).toBe(true);
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

  it("runs an agy-backed subagent through the external_delegate tool", async () => {
    const subagentsDir = join(agentDir, "pi-flow-external", "overrides");
    const binDir = join(tempDir, "bin-agy");
    const argsPath = join(tempDir, "agy-args.json");
    mkdirSync(subagentsDir, { recursive: true });
    writeFileSync(join(subagentsDir, "agy-reviewer.md"), `---\ndescription: Reviews through Antigravity.\nbackend: agy\nmodel: default\nthinking: high\n---\n\nAgy reviewer prompt.`);
    installFakeCli(binDir, "agy", `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
let stdin = '';
for await (const chunk of process.stdin) stdin += chunk;
writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify({ args: process.argv.slice(2), stdin }));
console.log(JSON.stringify({ event: 'init', conversation_id: 'agy-test-session', init: { permission_mode: 'always-proceed' } }));
await new Promise((resolve) => setTimeout(resolve, 20));
console.log(JSON.stringify({ event: 'step_update', step_update: { state: 'DONE', step_type: 'tool', tool_name: 'spawn_agent' } }));
console.log(JSON.stringify({ event: 'step_update', step_update: { step_id: 'answer', state: 'IN_PROGRESS', step_type: 'agent_response', text_delta: 'agy child ' } }));
console.log(JSON.stringify({ event: 'step_update', step_update: { step_id: 'answer', state: 'DONE', step_type: 'agent_response', text_delta: 'done' } }));
console.log(JSON.stringify({ event: 'result', result: { conversation_id: 'agy-test-session', status: 'SUCCESS', response: 'agy child done', usage: { input_tokens: 1000, output_tokens: 50, thinking_tokens: 25, cache_read_tokens: 200, total_tokens: 1075 } } }));
// Simulate CLI cleanup after the model has already produced its terminal event.
await new Promise((resolve) => setTimeout(resolve, 80));
`, originalPathEnv);

    const { session, registration } = await createSession();
    let rootContinuationContext: Context | undefined;
    registration.setResponses([
      fauxAssistantMessage([fauxToolCall("external_delegate", {
        description: "Agy review",
        role: "reviewer",
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
      // 2x the base 2h deadline: extendOnce() headroom; outer signal stays authoritative.
      "--print-timeout",
      "4h",
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
      profile: "agy/reviewer",
      status: "done",
      backendEventCount: 5,
      nestedActivitySeen: true,
      nestedAgentControl: "allowed-observed",
      nestedTimeoutExtended: true,
      permission: { tier: "danger", enforced: true },
    });
    expect(summary.summary.effectiveTimeoutMs).toBeGreaterThan(summary.summary.configuredTimeoutMs);
    expect(events.match(/"type":"backend_event"/g)).toHaveLength(5);
    expect(events).toContain('"type":"nested_timeout_extended"');
    const timingEvents = events.trim().split("\n").map((line) => JSON.parse(line))
      .filter((event) => event.type === "agy_attempt_timing");
    expect(timingEvents).toHaveLength(1);
    expect(timingEvents[0].data).toMatchObject({
      attempt: 1, eventCount: 5, processStarted: true, terminalSeen: true, exitCode: 0,
    });
    expect(timingEvents[0].data.spawnToInitMs).toBeGreaterThanOrEqual(0);
    expect(timingEvents[0].data.terminalToExitMs).toBeGreaterThanOrEqual(50);
    expect(timingEvents[0].data).not.toHaveProperty("prompt");
    let output = "";
    let cursor: string | undefined;
    do {
      const page = await inspectRun({ runsDirectory: recordsRoot, runId: runDirectories[0]!, view: "output", limitBytes: 4, cursor });
      output += page.items.map((item) => item.text).join("");
      cursor = page.nextCursor;
    } while (cursor);
    expect(output).toBe("agy child done");
    disposeSession(session);
  });

  it("uses structured terminal output and forwards every parsed backend event", async () => {
    const binDir = join(tempDir, "bin-agy-structured");
    installFakeCli(binDir, "agy", `#!/usr/bin/env node
console.log(JSON.stringify({ event: 'init', conversation_id: 'agy-structured-session', init: { permission_mode: 'always-proceed' } }));
console.log(JSON.stringify({ event: 'step_update', step_update: { state: 'DONE', step_type: 'tool', tool_name: 'view_file' } }));
console.log(JSON.stringify({ event: 'result', result: { conversation_id: 'agy-structured-session', status: 'SUCCESS', response: '{"answer":"fallback"}', structured_output: { answer: 'structured' }, usage: { input_tokens: 1200, output_tokens: 60, thinking_tokens: 30, cache_read_tokens: 300, total_tokens: 1290 } } }));
`, originalPathEnv);

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

  it("reports an actionable hint when the installed agy CLI rejects a flag", async () => {
    const binDir = join(tempDir, "bin-agy-old-flag");
    installFakeCli(binDir, "agy", `#!/usr/bin/env node
console.error("flag provided but not defined: -input-format");
console.error("Usage of agy:");
console.error("  --print Run a single prompt non-interactively");
process.exit(2);
`, originalPathEnv);

    const result = await spawnAgySubagent({
      toolCallId: "agy-old-flag",
      description: "Agy old flag",
      prompt: "Run against an old CLI.",
      profile: { name: "agy-old", description: "Agy old.", backend: "agy" },
      thinkingLevel: undefined,
      ctx: { cwd } as ExtensionContext,
      signal: undefined,
      progressEnabled: false,
      onProgress: undefined,
      onUsage: () => undefined,
    });

    expect(result.details.status).toBe("error");
    expect(result.details.error).toContain("flag provided but not defined: -input-format");
    expect(result.details.error).toContain("agy 1.1.15+");
    expect(result.details.error).toContain("agy update");
  });

  it("fails a clean exit that has no terminal result", async () => {
    const binDir = join(tempDir, "bin-agy-missing-result");
    installFakeCli(binDir, "agy", `#!/usr/bin/env node
console.log(JSON.stringify({ event: 'init', conversation_id: 'agy-missing-result' }));
console.log(JSON.stringify({ event: 'step_update', step_update: { state: 'DONE', step_type: 'agent_response', text_delta: 'not terminal' } }));
`, originalPathEnv);

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
    expect(result.details.assistantOutput).toEqual({
      status: "interrupted",
      messages: [{ text: "not terminal" }],
    });
    expect(result.content[0].text).toContain("Interrupted output:\nnot terminal");
  });

  it("retries an agy infrastructure failure once and reports the retry", async () => {
    const subagentsDir = join(agentDir, "pi-flow-external", "overrides");
    const binDir = join(tempDir, "bin-agy-retry");
    const counterPath = join(tempDir, "agy-retry-count.txt");
    const argsPath = join(tempDir, "agy-retry-args");
    mkdirSync(subagentsDir, { recursive: true });
    writeFileSync(join(subagentsDir, "agy-reviewer.md"), `---\ndescription: Reviews through Antigravity.\nbackend: agy\nmodel: default\n---\n\nAgy reviewer prompt.`);
    installFakeCli(binDir, "agy", `#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
let stdin = '';
for await (const chunk of process.stdin) stdin += chunk;
const count = existsSync(${JSON.stringify(counterPath)}) ? Number(readFileSync(${JSON.stringify(counterPath)}, 'utf8')) + 1 : 1;
writeFileSync(${JSON.stringify(counterPath)}, String(count));
writeFileSync(${JSON.stringify(argsPath)} + '.' + count, JSON.stringify({ args: process.argv.slice(2) }));
if (count === 1) {
  process.exitCode = 1;
  console.log(JSON.stringify({ event: 'result', result: { conversation_id: 'agy-retry', status: 'ERROR', response: '', error: 'Eligibility check failed: Get "https://www.googleapis.com/oauth2/v2/userinfo": read: operation timed out', usage: { input_tokens: 5, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 5 } } }));
} else {
  console.log(JSON.stringify({ event: 'result', result: { conversation_id: 'agy-retry', status: 'SUCCESS', response: 'agy child done after retry', usage: { input_tokens: 1000, output_tokens: 50, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 1050 } } }));
}
`, originalPathEnv);

    const { session, registration } = await createSession();
    let rootContinuationContext: Context | undefined;
    registration.setResponses([
      fauxAssistantMessage([fauxToolCall("external_delegate", {
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
    const secondAttemptArgs = JSON.parse(readFileSync(`${argsPath}.2`, "utf8")).args as string[];
    expect(secondAttemptArgs).toContain("--conversation");
    // Retry timing must expose two separate launches, not one misleading slow run.
    const timingRecordDir = join(agentDir, "pi-flow-external", "runs");
    const timingRunId = readdirSync(timingRecordDir)[0]!;
    const timingEvents = readFileSync(join(timingRecordDir, timingRunId, "events.ndjson"), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line))
      .filter((event) => event.type === "agy_attempt_timing");
    expect(timingEvents.map((event) => event.data.attempt)).toEqual([1, 2]);
    expect(secondAttemptArgs[secondAttemptArgs.indexOf("--conversation") + 1]).toBe("agy-retry");
    const serialized = JSON.stringify(rootContinuationContext?.messages);
    expect(serialized).toContain("agy child done after retry");
    expect(serialized).toContain("\"retries\":1");
  });

  it("does not retry a non-transient agy failure", async () => {
    const subagentsDir = join(agentDir, "pi-flow-external", "overrides");
    const binDir = join(tempDir, "bin-agy-no-retry");
    const counterPath = join(tempDir, "agy-no-retry-count.txt");
    mkdirSync(subagentsDir, { recursive: true });
    writeFileSync(join(subagentsDir, "agy-reviewer.md"), `---\ndescription: Reviews through Antigravity.\nbackend: agy\nmodel: default\n---\n\nAgy reviewer prompt.`);
    installFakeCli(binDir, "agy", `#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
let stdin = '';
for await (const chunk of process.stdin) stdin += chunk;
const count = existsSync(${JSON.stringify(counterPath)}) ? Number(readFileSync(${JSON.stringify(counterPath)}, 'utf8')) + 1 : 1;
writeFileSync(${JSON.stringify(counterPath)}, String(count));
process.exitCode = 1;
console.log(JSON.stringify({ event: 'result', result: { conversation_id: 'agy-no-retry', status: 'ERROR', response: '', error: 'provider unavailable', usage: { input_tokens: 5, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 5 } } }));
`, originalPathEnv);

    const { session, registration } = await createSession();
    let rootContinuationContext: Context | undefined;
    registration.setResponses([
      fauxAssistantMessage([fauxToolCall("external_delegate", {
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

    expect(Number(readFileSync(counterPath, "utf8"))).toBe(1);
    expect(JSON.stringify(rootContinuationContext?.messages)).toContain("status ERROR: provider unavailable");
  });

  it("retries a transient agy failure only once", async () => {
    const subagentsDir = join(agentDir, "pi-flow-external", "overrides");
    const binDir = join(tempDir, "bin-agy-retry-bounded");
    const counterPath = join(tempDir, "agy-retry-bounded-count.txt");
    mkdirSync(subagentsDir, { recursive: true });
    writeFileSync(join(subagentsDir, "agy-reviewer.md"), `---\ndescription: Reviews through Antigravity.\nbackend: agy\nmodel: default\n---\n\nAgy reviewer prompt.`);
    installFakeCli(binDir, "agy", `#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
let stdin = '';
for await (const chunk of process.stdin) stdin += chunk;
const count = existsSync(${JSON.stringify(counterPath)}) ? Number(readFileSync(${JSON.stringify(counterPath)}, 'utf8')) + 1 : 1;
writeFileSync(${JSON.stringify(counterPath)}, String(count));
process.exitCode = 1;
console.log(JSON.stringify({ event: 'result', result: { conversation_id: 'agy-retry-bounded', status: 'ERROR', response: '', error: 'authentication failed or timed out', usage: { input_tokens: 5, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 5 } } }));
`, originalPathEnv);

    const { session, registration } = await createSession();
    let rootContinuationContext: Context | undefined;
    registration.setResponses([
      fauxAssistantMessage([fauxToolCall("external_delegate", {
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
    expect(JSON.stringify(rootContinuationContext?.messages)).toContain("status ERROR: authentication failed or timed out");
  });

  it("prefers the agy terminal failure over the exit code", async () => {
    const binDir = join(tempDir, "bin-agy-error-result");
    installFakeCli(binDir, "agy", `#!/usr/bin/env node
process.exitCode = 1;
console.log(JSON.stringify({ event: 'step_update', step_update: { step_id: 'answer-1', step_type: 'agent_response', text_delta: 'useful partial finding' } }));
console.log(JSON.stringify({ event: 'result', result: { conversation_id: 'agy-error-result', status: 'ERROR', response: '', error: 'provider unavailable', usage: { input_tokens: 20, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 20 } } }));
`, originalPathEnv);

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
    expect(result.details.assistantOutput).toEqual({
      status: "interrupted",
      messages: [{ id: "answer-1", text: "useful partial finding" }],
    });
  });

  it("rejects an unsupported agy tier before process launch and keeps the receipt", async () => {
    const binDir = join(tempDir, "bin-agy-unsupported");
    const markerPath = join(tempDir, "agy-unsupported-launched");
    installFakeCli(binDir, "agy", `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(markerPath)}, 'launched');
`, originalPathEnv);
    const context = {
      mode: "recent" as const,
      requestedTurns: 2,
      sharedTurns: 1,
      messages: 2,
      bytes: 40,
      compacted: false,
    };

    const result = await spawnSubagent({
      toolCallId: "agy-unsupported-tier",
      description: "Restricted agy",
      prompt: "Stay read-only.",
      profile: { name: "agy-reviewer", description: "Review.", backend: "agy" },
      thinkingLevel: undefined,
      ctx: { cwd } as ExtensionContext,
      signal: undefined,
      timeoutMs: 5_000,
      progressEnabled: false,
      onProgress: undefined,
      onUsage: () => undefined,
      permission: undefined,
      defaultPermission: "readonly",
      maxBudgetUsd: 3,
      context,
    });

    const details = result.details as SubagentToolDetails;
    expect(details.status).toBe("error");
    expect(details.permission).toBe("readonly");
    expect(details.permissionEnforced).toBe(false);
    expect(details.maxBudgetUsd).toBe(3);
    expect(details.context).toEqual(context);
    expect(result.content[0]?.text).toMatch(/defaultPermission/);
    expect(result.content[0]?.text).not.toMatch(/omit/i);
    expect(existsSync(markerPath)).toBe(false);
    const summary = JSON.parse(readFileSync(join(details.recordPath!, "summary.json"), "utf8"));
    const events = readFileSync(join(details.recordPath!, "events.ndjson"), "utf8");
    expect(summary.summary).toMatchObject({
      status: "error",
      backendStarted: false,
      permission: { tier: "readonly", enforced: false, caveat: expect.stringContaining("unsupported") },
      maxBudgetUsd: 3,
      budgetEnforceable: false,
      context,
    });
    expect(summary.metadata).toMatchObject({
      permission: "readonly",
      maxBudgetUsd: 3,
      context,
    });
    expect(events).not.toContain("process_started");
  });
});
