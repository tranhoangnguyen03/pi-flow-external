import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  HARNESS_INTERVIEW_PROMPT,
  HARNESS_TOOL_NAME,
  ROLE_INTERVIEW_PROMPT,
  ROLE_TOOL_NAME,
  compileSharedRole,
  installSharedRole,
  registerProfileCreator,
  startHarnessInterview,
  startRoleInterview,
} from "../src/profile-creator.ts";
import { ConcurrencyLimiter } from "../src/core/concurrency.ts";
import { parseSubagentProfileContent } from "../src/profiles.ts";

const tempDirs: string[] = [];

async function makeAgentDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-flow-role-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const role = {
  name: "security-reviewer",
  description: "Reviews code containing: YAML # hazards.",
  permission: "readonly" as const,
  systemPrompt: "Review code for concrete security defects. Do not modify files.",
};

type CreatorTool = { execute: (...args: any[]) => Promise<any> };

function makeCreatorTools(limiter = new ConcurrencyLimiter(12)): Map<string, CreatorTool & { name: string }> {
  const tools = new Map<string, CreatorTool & { name: string }>();
  let activeTools: string[] = [];
  const pi = {
    getActiveTools: () => activeTools,
    setActiveTools: (names: string[]) => { activeTools = names; },
    on: vi.fn(),
    registerCommand: vi.fn(),
    registerTool: (definition: CreatorTool & { name: string }) => { tools.set(definition.name, definition); },
  } as unknown as ExtensionAPI;
  registerProfileCreator(pi, {
    getLimiter: () => limiter,
    getSubagentTimeoutMs: () => 5000,
    getThinkingLevel: () => "high",
    updateStatus: () => undefined,
  });
  return tools;
}

function makeRoleCreatorTool(limiter = new ConcurrencyLimiter(12)): CreatorTool {
  return makeCreatorTools(limiter).get(ROLE_TOOL_NAME)!;
}

function makeHarnessCreatorTool(limiter = new ConcurrencyLimiter(12)): CreatorTool {
  return makeCreatorTools(limiter).get(HARNESS_TOOL_NAME)!;
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

describe("shared role authoring", () => {
  it("compiles a shared role with no backend/model/thinking pin", () => {
    const content = compileSharedRole(role);

    expect(content).toContain(`description: ${JSON.stringify(role.description)}`);
    expect(content).toContain(`permission: "readonly"`);
    expect(content).not.toContain("backend:");
    expect(content).not.toContain("model:");
    expect(content).not.toContain("thinking:");
    expect(content).not.toContain("owner:");
    const parsed = parseSubagentProfileContent(content, role.name, { requireBody: true });
    expect(parsed?.description).toBe(role.description);
    expect(parsed?.permission).toBe("readonly");
  });

  it("a bare reviewer name is valid without a harness prefix", () => {
    const content = compileSharedRole({ ...role, name: "reviewer" });
    expect(content).toContain('description: "Reviews code containing: YAML # hazards."');
  });

  it("rejects invalid names, missing description/instructions, and bad permission", () => {
    expect(() => compileSharedRole({ ...role, name: "Bad Name" })).toThrow("lowercase letters");
    expect(() => compileSharedRole({ ...role, description: "  " })).toThrow("description is required");
    expect(() => compileSharedRole({ ...role, systemPrompt: "  " })).toThrow("instructions are required");
    expect(() => compileSharedRole({ ...role, permission: "sometimes" as never })).toThrow("readonly, edit, danger");
  });

  it("installs offline with no backend smoke test", async () => {
    const agentDir = await makeAgentDir();
    const finalPath = join(agentDir, "pi-flow-external", "roles", `${role.name}.md`);

    const createdPath = await installSharedRole({ agentDir, role });

    expect(createdPath).toBe(finalPath);
    expect(readFileSync(finalPath, "utf8")).toContain(role.systemPrompt);
    expect(readdirSync(join(agentDir, "pi-flow-external", "roles")).filter((name) => name.endsWith(".staged"))).toEqual([]);
  });

  it("never overwrites an existing role", async () => {
    const agentDir = await makeAgentDir();
    const dir = join(agentDir, "pi-flow-external", "roles");
    const finalPath = join(dir, `${role.name}.md`);
    await mkdir(dir, { recursive: true });
    writeFileSync(finalPath, "keep me");

    await expect(installSharedRole({ agentDir, role })).rejects.toThrow("already exists");
    expect(readFileSync(finalPath, "utf8")).toBe("keep me");
  });

  it("does not write when cancellation arrives before install", async () => {
    const agentDir = await makeAgentDir();
    const controller = new AbortController();
    controller.abort();

    await expect(installSharedRole({ agentDir, role, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(existsSync(join(agentDir, "pi-flow-external", "roles", `${role.name}.md`))).toBe(false);
  });
});

describe("pi_flow_role_create tool", () => {
  it("rejects invalid input before confirmation", async () => {
    const agentDir = await makeAgentDir();
    await withAgentDir(agentDir, async () => {
      const tool = makeRoleCreatorTool();
      const ctx = {
        hasUI: true,
        cwd: agentDir,
        ui: { confirm: vi.fn(), notify: vi.fn() },
      } as unknown as ExtensionCommandContext;

      const result = await tool.execute("bad-role", { ...role, name: "Bad Name" }, undefined, undefined, ctx);

      expect(result.details.status).toBe("error");
      expect(ctx.ui.confirm).not.toHaveBeenCalled();
      expect(existsSync(join(agentDir, "pi-flow-external", "roles", "Bad Name.md"))).toBe(false);
    });
  });

  it("does not write when confirmation is rejected", async () => {
    const agentDir = await makeAgentDir();
    await withAgentDir(agentDir, async () => {
      const tool = makeRoleCreatorTool();
      const ctx = {
        hasUI: true,
        cwd: agentDir,
        ui: { confirm: vi.fn(async () => false), notify: vi.fn() },
      } as unknown as ExtensionCommandContext;

      const result = await tool.execute("reject-role", role, undefined, undefined, ctx);

      expect(result.details.status).toBe("aborted");
      expect(existsSync(join(agentDir, "pi-flow-external", "roles", `${role.name}.md`))).toBe(false);
    });
  });

  it("does not write or prompt without review UI", async () => {
    const agentDir = await makeAgentDir();
    await withAgentDir(agentDir, async () => {
      const tool = makeRoleCreatorTool();
      const confirm = vi.fn();
      const ctx = {
        hasUI: false,
        cwd: agentDir,
        ui: { confirm, notify: vi.fn() },
      } as unknown as ExtensionCommandContext;

      const result = await tool.execute("headless-role", role, undefined, undefined, ctx);

      expect(result.details.status).toBe("error");
      expect(confirm).not.toHaveBeenCalled();
      expect(existsSync(join(agentDir, "pi-flow-external", "roles", `${role.name}.md`))).toBe(false);
    });
  });

  it("makes the review confirmation cancellable by the tool signal", async () => {
    const agentDir = await makeAgentDir();
    await withAgentDir(agentDir, async () => {
      const controller = new AbortController();
      const confirm = vi.fn(async () => false);
      const tool = makeRoleCreatorTool();
      const ctx = {
        hasUI: true,
        cwd: agentDir,
        ui: { confirm, notify: vi.fn() },
      } as unknown as ExtensionCommandContext;

      await tool.execute("cancel-confirmation", role, controller.signal, undefined, ctx);

      expect(confirm).toHaveBeenCalledWith(`Create role ${role.name}?`, expect.any(String), { signal: controller.signal });
    });
  });

  it("writes the shared role offline on confirmation without a smoke test", async () => {
    const agentDir = await makeAgentDir();
    await withAgentDir(agentDir, async () => {
      const tool = makeRoleCreatorTool();
      const ctx = {
        hasUI: true,
        cwd: agentDir,
        ui: { confirm: vi.fn(async () => true), notify: vi.fn() },
      } as unknown as ExtensionCommandContext;

      const result = await tool.execute("create-role", role, undefined, undefined, ctx);

      expect(result.details.status).toBe("done");
      const finalPath = join(agentDir, "pi-flow-external", "roles", `${role.name}.md`);
      expect(existsSync(finalPath)).toBe(true);
      expect(readFileSync(finalPath, "utf8")).toContain(role.systemPrompt);
      expect(ctx.ui.confirm).toHaveBeenCalledWith(`Create role ${role.name}?`, expect.stringContaining("Shared role"), { signal: undefined });
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("It works with any harness from the next invocation"),
        "info",
      );
    });
  });
});

describe("pi_flow_harness_create tool", () => {
  function harnessCtx(overrides: { confirm?: () => Promise<boolean>; findModel?: unknown } = {}) {
    const model = "findModel" in overrides ? overrides.findModel : { id: "deepseek-chat", provider: "deepseek" };
    return {
      hasUI: true,
      cwd: "/tmp/does-not-matter",
      modelRegistry: { find: vi.fn(() => model), hasConfiguredAuth: vi.fn(() => true) },
      ui: { confirm: vi.fn(overrides.confirm ?? (async () => true)), notify: vi.fn() },
    } as unknown as ExtensionCommandContext;
  }

  it("rejects an invalid harness name before confirmation or the smoke test", async () => {
    const agentDir = await makeAgentDir();
    await withAgentDir(agentDir, async () => {
      const tool = makeHarnessCreatorTool();
      const ctx = harnessCtx();
      const result = await tool.execute("bad-name", { name: "deepseek", model: "deepseek/deepseek-chat" }, undefined, undefined, ctx);
      expect(result.details.status).toBe("error");
      expect(ctx.ui.confirm).not.toHaveBeenCalled();
    });
  });

  it("rejects an unsupported thinking level before confirmation", async () => {
    const agentDir = await makeAgentDir();
    await withAgentDir(agentDir, async () => {
      const tool = makeHarnessCreatorTool();
      const ctx = harnessCtx();
      const result = await tool.execute("bad-thinking", { name: "pi-deepseek", model: "deepseek/deepseek-chat", thinking: "med" }, undefined, undefined, ctx);
      expect(result.details.status).toBe("error");
      expect(result.details.error).toContain("off, minimal, low, medium, high, xhigh");
      expect(ctx.ui.confirm).not.toHaveBeenCalled();
    });
  });

  it("rejects a model that does not resolve in the registry before confirmation", async () => {
    const agentDir = await makeAgentDir();
    await withAgentDir(agentDir, async () => {
      const tool = makeHarnessCreatorTool();
      const ctx = harnessCtx({ findModel: undefined });
      const result = await tool.execute("bad-model", { name: "pi-deepseek", model: "deepseek/deepseek-chat" }, undefined, undefined, ctx);
      expect(result.details.status).toBe("error");
      expect(result.details.error).toContain("not found in the registry");
      expect(ctx.ui.confirm).not.toHaveBeenCalled();
    });
  });

  it("writes nothing when the user rejects the confirmation", async () => {
    const agentDir = await makeAgentDir();
    await withAgentDir(agentDir, async () => {
      const tool = makeHarnessCreatorTool();
      const ctx = harnessCtx({ confirm: async () => false });
      const result = await tool.execute("declined", { name: "pi-deepseek", model: "deepseek/deepseek-chat" }, undefined, undefined, ctx);
      expect(result.details.status).toBe("aborted");
      expect(existsSync(join(agentDir, "pi-flow-external", "harnesses.json"))).toBe(false);
    });
  });
});

describe("creator interviews", () => {
  function interviewHarness() {
    let activeTools: string[] = [];
    const events = new Map<string, (event: any) => void>();
    const commands = new Map<string, unknown>();
    const pi = {
      getActiveTools: () => activeTools,
      setActiveTools: (names: string[]) => { activeTools = names; },
      on: (name: string, handler: (event: any) => void) => { events.set(name, handler); },
      registerCommand: (name: string, options: unknown) => { commands.set(name, options); },
      registerTool: () => { activeTools.push("registered"); },
    } as unknown as ExtensionAPI;
    registerProfileCreator(pi, {
      getLimiter: () => new ConcurrencyLimiter(12),
      getSubagentTimeoutMs: () => 1000,
      getThinkingLevel: () => "high",
      updateStatus: () => undefined,
    });
    return { activeTools: () => activeTools, events, commands };
  }

  function interviewCtx(sent: string[]) {
    const newSession = vi.fn(async (options: { withSession?: (ctx: { sendUserMessage: (text: string) => Promise<void> }) => Promise<void> }) => {
      await options.withSession?.({ sendUserMessage: async (text) => { sent.push(text); } });
      return { cancelled: false };
    });
    return {
      hasUI: true,
      model: { id: "current-model" },
      sessionManager: { getSessionFile: () => "/tmp/parent.jsonl" },
      newSession,
      ui: { notify: vi.fn() },
    } as unknown as ExtensionCommandContext & { newSession: typeof newSession };
  }

  it("registers both creator tools", () => {
    const tools = makeCreatorTools();
    expect(tools.has(ROLE_TOOL_NAME)).toBe(true);
    expect(tools.has(HARNESS_TOOL_NAME)).toBe(true);
  });

  it("registers no pi-flow-profile command", () => {
    const { commands } = interviewHarness();
    expect(commands.has("pi-flow-profile")).toBe(false);
  });

  it("role and harness interviews send distinct prompts", async () => {
    const roleSent: string[] = [];
    const roleCtx = interviewCtx(roleSent);
    await startRoleInterview(roleCtx);
    expect(roleSent).toEqual([ROLE_INTERVIEW_PROMPT]);
    expect(ROLE_INTERVIEW_PROMPT).toContain(ROLE_TOOL_NAME);
    expect(ROLE_INTERVIEW_PROMPT).not.toContain("profile create");

    const harnessSent: string[] = [];
    const harnessCtx = interviewCtx(harnessSent);
    await startHarnessInterview(harnessCtx);
    expect(harnessSent).toEqual([HARNESS_INTERVIEW_PROMPT]);
    expect(HARNESS_INTERVIEW_PROMPT).toContain(HARNESS_TOOL_NAME);
  });

  it("each interview prompt activates only its own finalizer; session start deactivates", () => {
    const { activeTools, events } = interviewHarness();
    events.get("session_start")?.({});
    expect(activeTools()).not.toContain(ROLE_TOOL_NAME);
    expect(activeTools()).not.toContain(HARNESS_TOOL_NAME);
    events.get("input")?.({ source: "extension", text: ROLE_INTERVIEW_PROMPT });
    expect(activeTools()).toContain(ROLE_TOOL_NAME);
    expect(activeTools()).not.toContain(HARNESS_TOOL_NAME);
    events.get("session_start")?.({});
    expect(activeTools()).not.toContain(ROLE_TOOL_NAME);
    events.get("input")?.({ source: "extension", text: HARNESS_INTERVIEW_PROMPT });
    expect(activeTools()).not.toContain(ROLE_TOOL_NAME);
    expect(activeTools()).toContain(HARNESS_TOOL_NAME);
  });
});
