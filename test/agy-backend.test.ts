import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxToolCall, type Context } from "../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/index.js";
import { buildAgyArgs } from "../src/core/agy.ts";
import { setupPiSubagentTestHarness } from "./helpers/pi-subagent-harness.ts";

describe("pi-subagent agy backend", () => {
  let tempDir = "";
  let agentDir = "";
  let originalPathEnv: string | undefined;
  const { createSession, disposeSession } = setupPiSubagentTestHarness((state) => {
    tempDir = state.tempDir;
    agentDir = state.agentDir;
    originalPathEnv = state.originalPathEnv;
  });

  it("builds agy print args", () => {
    const args = buildAgyArgs({
      profile: { name: "agy-reviewer", description: "Agy", backend: "agy", model: "best" },
      thinkingLevel: "high",
    });
    expect(args).toContain("--print");
    expect(args).toContain("--dangerously-skip-permissions");
    expect(args).toContain("--model");
    expect(args).toContain("best");
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
    expect(agyRun.args).toContain("--print");
    expect(agyRun.args).toContain("--dangerously-skip-permissions");
    expect(agyRun.args).toContain("--model");
    expect(agyRun.args).toContain("default");
    expect(agyRun.stdin).toContain("Agy reviewer prompt.");
    expect(agyRun.stdin).toContain("Review the latest diff.");
    expect(JSON.stringify(rootContinuationContext?.messages)).toContain("agy child done");
    disposeSession(session);
  });
});
