import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage, fauxToolCall, type Context } from "../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/index.js";
import { buildAgyArgs, spawnAgySubagent } from "../src/core/agy.ts";
import { setupPiSubagentTestHarness } from "./helpers/pi-subagent-harness.ts";

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

  it("passes the complete print prompt as the final argv element", () => {
    const prompt = "--leading-dash with spaces\nand a newline\n{\"type\":\"object\"}";
    const args = buildAgyArgs({
      profile: { name: "agy-reviewer", description: "Agy", backend: "agy", model: "best" },
      thinkingLevel: "high",
      prompt,
    });
    expect(args).toEqual([
      "--dangerously-skip-permissions",
      "--model",
      "best",
      "-p",
      prompt,
    ]);
  });

  it("runs an agy-backed subagent through the Agent tool", async () => {
    const subagentsDir = join(agentDir, "subagents");
    const binDir = join(tempDir, "bin-agy");
    const argsPath = join(tempDir, "agy-args.json");
    mkdirSync(subagentsDir, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(subagentsDir, "agy-reviewer.md"), `---\ndescription: Reviews through Antigravity.\nbackend: agy\nmodel: default\nthinking: high\n---\n\nAgy reviewer prompt.`);
    const fakeAgyPath = join(binDir, "agy");
    writeFileSync(fakeAgyPath, `#!/usr/bin/env node\nimport { writeFileSync } from 'node:fs';\nlet stdin = '';\nfor await (const chunk of process.stdin) stdin += chunk;\nwriteFileSync(${JSON.stringify(argsPath)}, JSON.stringify({ args: process.argv.slice(2), stdin }));\nconsole.log('agy child done');\n`);
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
      "--model",
      "default",
      "-p",
      "Agy reviewer prompt.\n\nReview the latest diff.\n\nRequested reasoning effort: high",
    ]);
    expect(agyRun.stdin).toBe("");
    expect(JSON.stringify(rootContinuationContext?.messages)).toContain("agy child done");
    disposeSession(session);
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
