import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createExternalHelpTool } from "../src/external-help.ts";
import type { ExternalHarness } from "../src/types.ts";

const tempDirs: string[] = [];

function tempAgentDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-flow-external-help-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function fakeCtx(agentDir: string) {
  return {
    cwd: agentDir,
    modelRegistry: undefined,
    isProjectTrusted: () => false,
  } as never;
}

async function withAgentDir<T>(agentDir: string, run: () => Promise<T>): Promise<T> {
  const original = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    return await run();
  } finally {
    if (original === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = original;
  }
}

function makeTool(getDefaultHarness: (ctx: unknown) => string = () => "agy" as ExternalHarness) {
  return createExternalHelpTool({ getDefaultHarness: getDefaultHarness as never, workflowEnabled: true });
}

describe("external_help unknown harness filter", () => {
  it("errors and lists configured harnesses for an unknown roles filter, never falling back", async () => {
    const agentDir = tempAgentDir();
    await withAgentDir(agentDir, async () => {
      const tool = makeTool();
      await expect(tool.execute("call-1", { topic: "roles", harness: "not-a-real-harness" }, undefined, undefined, fakeCtx(agentDir)))
        .rejects.toThrow(/Unknown harness "not-a-real-harness"\. Configured harnesses: agy, claude, codex, grok, muse\./);
    });
  });

  it("errors and lists configured harnesses for an unknown permissions filter, never silently describing it as pi", async () => {
    const agentDir = tempAgentDir();
    await withAgentDir(agentDir, async () => {
      const tool = makeTool();
      await expect(tool.execute("call-2", { topic: "permissions", harness: "not-a-real-harness" }, undefined, undefined, fakeCtx(agentDir)))
        .rejects.toThrow(/Unknown harness "not-a-real-harness"/);
    });
  });

  it("includes registered pi-* harnesses in the configured list once any are registered", async () => {
    const agentDir = tempAgentDir();
    mkdirSync(join(agentDir, "pi-flow-external"), { recursive: true });
    writeFileSync(
      join(agentDir, "pi-flow-external", "harnesses.json"),
      JSON.stringify({ version: 1, harnesses: { "pi-deepseek": { model: "deepseek/deepseek-chat", thinking: "high" } } }),
    );
    await withAgentDir(agentDir, async () => {
      const tool = makeTool();
      await expect(tool.execute("call-3", { topic: "permissions", harness: "pi-missing" }, undefined, undefined, fakeCtx(agentDir)))
        .rejects.toThrow(/Configured harnesses: agy, claude, codex, grok, muse, pi-deepseek\./);
    });
  });

  it("succeeds for a registered pi-* harness and describes it accurately, not as an external CLI", async () => {
    const agentDir = tempAgentDir();
    mkdirSync(join(agentDir, "pi-flow-external"), { recursive: true });
    writeFileSync(
      join(agentDir, "pi-flow-external", "harnesses.json"),
      JSON.stringify({ version: 1, harnesses: { "pi-deepseek": { model: "deepseek/deepseek-chat", thinking: "high" } } }),
    );
    await withAgentDir(agentDir, async () => {
      const tool = makeTool();
      const result = await tool.execute("call-4", { topic: "permissions", harness: "pi-deepseek" }, undefined, undefined, fakeCtx(agentDir));
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain("pi-*");
      expect(text).not.toContain("external CLI");
    });
  });

  it("still rejects an explicit harness filter on the workflow topic regardless of validity", async () => {
    const agentDir = tempAgentDir();
    await withAgentDir(agentDir, async () => {
      const tool = makeTool();
      await expect(tool.execute("call-5", { topic: "workflow", harness: "claude" }, undefined, undefined, fakeCtx(agentDir)))
        .rejects.toThrow(/only valid for roles or permissions/);
    });
  });

  it("treats a blank harness as omitted rather than an invalid filter, matching the #62 forced-placeholder reproduction", async () => {
    const agentDir = tempAgentDir();
    await withAgentDir(agentDir, async () => {
      const tool = makeTool();
      // A downstream schema-conversion layer may present `harness` as
      // required even on the workflow topic, where it is never valid
      // (#62); a model forced to fill it in typically sends an empty
      // string. That must not be rejected as an explicit filter.
      const workflowResult = await tool.execute("call-7", { topic: "workflow", harness: "" }, undefined, undefined, fakeCtx(agentDir));
      expect((workflowResult.content[0] as { text: string }).text).toContain("blocking by default");

      // The same forced-blank placeholder on roles/permissions must not be
      // rejected as an unknown harness filter either.
      const rolesResult = await tool.execute("call-8", { topic: "roles", harness: "" }, undefined, undefined, fakeCtx(agentDir));
      expect(rolesResult.details).toEqual({ topic: "roles" });
      const permissionsResult = await tool.execute("call-9", { topic: "permissions", harness: "" }, undefined, undefined, fakeCtx(agentDir));
      expect(permissionsResult.details).toEqual({ topic: "permissions" });
    });
  });

  it("states blocking default with explicit background opt-in and same-harness parallelism", async () => {
    const agentDir = tempAgentDir();
    await withAgentDir(agentDir, async () => {
      const tool = makeTool();
      const result = await tool.execute("call-6", { topic: "workflow" }, undefined, undefined, fakeCtx(agentDir));
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain("blocking by default");
      expect(text).toContain("parallel([() => agent(...), ...])");
      expect(text).toContain("background: true");
    });
  });
});
