import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  fauxAssistantMessage,
  fauxToolCall,
  registerFauxProvider,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/index.js";
import { describe, expect, it, vi } from "vitest";
import { createSubagentExtension } from "../src/pi-subagent.ts";
import { getSubagentProfiles } from "../src/profiles.ts";
import { buildClaudeArgs, claudeUsageToSubagentUsage, extractClaudeCostUsd, extractClaudeError, extractClaudeFinalText, extractClaudeUsage, spawnClaudeSubagent } from "../src/core/claude.ts";
import { buildCodexArgs, codexUsageToSubagentUsage, estimateCodexCostUsd, extractCodexFinalText, spawnCodexSubagent } from "../src/core/codex.ts";
import { packageRoot, setupPiSubagentTestHarness } from "./helpers/pi-subagent-harness.ts";

describe("pi-subagent agent contract", () => {
  let tempDir = "";
  let cwd = "";
  let agentDir = "";
  let originalPathEnv: string | undefined;
  let registrations: Array<{ unregister: () => void }> = [];

  const {
    trackSession,
    disposeSession,
    createSession,
    delegateOnce,
    makeMockTheme,
    stripAnsi,
    renderToText,
    formatTestTokens,
    makeExecutionContext,
    getToolNames,
  } = setupPiSubagentTestHarness((state) => {
    tempDir = state.tempDir;
    cwd = state.cwd;
    agentDir = state.agentDir;
    originalPathEnv = state.originalPathEnv;
    registrations = state.registrations;
  });
  it("registers the Claude-style Agent tool contract", async () => {
    const { session } = await createSession();

    const tool = session.getAllTools().find((candidate) => candidate.name === "Agent");
    expect(tool).toBeDefined();
    const properties = (tool?.parameters as { properties: Record<string, unknown> } | undefined)?.properties;
    expect(properties).toHaveProperty("description");
    expect(properties).toHaveProperty("prompt");
    expect(properties).toHaveProperty("subagent_type");
    expect(properties).not.toHaveProperty("run_in_background");
    expect(properties).not.toHaveProperty("resume");
    expect(properties).not.toHaveProperty("model");
    expect(properties).not.toHaveProperty("thinking");
    expect(properties).not.toHaveProperty("timeout");
    expect(properties).not.toHaveProperty("subagentTimeoutMs");
    expect(tool?.description).toContain("external Claude Code, Codex CLI, or Antigravity");
    expect(tool?.promptGuidelines).toContain(
      "Reach for Agent only when the user asks for Claude Code/Codex/Antigravity delegation or an available external profile matches the task.",
    );
    expect(tool?.promptGuidelines).toContain(
      "Every Agent call requires an explicit backend-qualified subagent_type.",
    );
    expect(tool?.promptGuidelines).toContain(
      "Do not automatically retry a failed or aborted external run; preserve its evidence and retry only when the user asks.",
    );

    disposeSession(session);
  });

  it("marks description, prompt, and subagent_type required, and adds no tag/label fields", async () => {
    const { session } = await createSession();

    const tool = session.getAllTools().find((candidate) => candidate.name === "Agent");
    const schema = tool?.parameters as { required?: string[]; properties: Record<string, unknown> } | undefined;
    expect(schema?.required).toContain("description");
    expect(schema?.required).toContain("prompt");
    expect(schema?.required).toContain("subagent_type");
    expect(schema?.properties.subagent_type).toMatchObject({ type: "string", minLength: 1 });
    expect(schema?.properties).not.toHaveProperty("tag");
    expect(schema?.properties).not.toHaveProperty("label");

    disposeSession(session);
  });

  it("loads as a pi package extension from package metadata", async () => {
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager: SettingsManager.inMemory({}),
      additionalExtensionPaths: [packageRoot],
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });

    await resourceLoader.reload();

    const extensions = resourceLoader.getExtensions();
    expect(extensions.errors).toEqual([]);
    expect(extensions.extensions).toHaveLength(1);
    expect(extensions.extensions[0]?.flags.has("max-concurrent-subagents")).toBe(true);
    expect(extensions.extensions[0]?.flags.has("subagent-timeout-ms")).toBe(true);
  });


  it("injects the coordinator prompt into the root agent's system prompt", async () => {
    const { session, registration } = await createSession();
    let rootContext: Context | undefined;

    registration.setResponses([
      (context) => {
        rootContext = context;
        return fauxAssistantMessage("noted");
      },
    ]);

    await session.prompt("Just say noted.");

    expect(rootContext?.systemPrompt).toContain("Agent is for external Claude Code, Codex CLI, and Antigravity profiles only");
    expect(rootContext?.systemPrompt).toContain("Every Agent call requires an explicit backend-qualified subagent_type");
    expect(rootContext?.systemPrompt).toContain("Do not automatically retry a failed or aborted external run");
    expect(getToolNames(rootContext)).toContain("Agent");
    expect(getToolNames(rootContext)).toContain("workflow");
    expect(getToolNames(rootContext)).not.toContain("pi_flow_profile_create");

    disposeSession(session);
  });

  it("advertises saved workflows in the root system prompt", async () => {
    mkdirSync(join(agentDir, "workflows"), { recursive: true });
    writeFileSync(
      join(agentDir, "workflows", "audit.js"),
      `export const meta = { name: 'audit-todos', description: 'Find TODOs and summarize debt. Use before cleanup planning.' };\nreturn await agent('audit');`,
    );

    const { session, registration } = await createSession();
    let rootContext: Context | undefined;

    registration.setResponses([
      (context) => {
        rootContext = context;
        return fauxAssistantMessage("noted");
      },
    ]);

    await session.prompt("Can you clean up technical debt?");

    expect(rootContext?.systemPrompt).toContain("Saved workflows");
    expect(rootContext?.systemPrompt).toContain("audit-todos: Find TODOs and summarize debt. Use before cleanup planning.");

    disposeSession(session);
  });


  it("registers the Agent tool when loaded via additionalExtensionPaths", async () => {
    const registration = registerFauxProvider({
      models: [{ id: "faux-thinker", name: "Faux Thinker", reasoning: true }],
    });
    registrations.push(registration);

    const model = registration.getModel("faux-thinker") as Model<string>;
    const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
    authStorage.setRuntimeApiKey(model.provider, "test-api-key");
    const modelRegistry = ModelRegistry.create(authStorage, join(agentDir, "models.json"));
    const settingsManager = SettingsManager.inMemory({});
    const sessionManager = SessionManager.inMemory(cwd);
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      additionalExtensionPaths: [packageRoot],
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await resourceLoader.reload();

    const { session } = await createAgentSession({
      cwd,
      agentDir,
      authStorage,
      modelRegistry,
      model,
      thinkingLevel: "high",
      settingsManager,
      sessionManager,
      resourceLoader,
    });
    trackSession(session);
    await session.bindExtensions({});

    const tool = session.getAllTools().find((candidate) => candidate.name === "Agent");
    expect(tool).toBeDefined();
    expect((tool?.parameters as { properties: Record<string, unknown> }).properties).toHaveProperty(
      "subagent_type",
    );

    disposeSession(session);
  });
});
