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
    expect(properties).toHaveProperty("role");
    expect(properties).toHaveProperty("harness");
    expect(properties).toHaveProperty("subagent_type");
    expect(properties).toHaveProperty("background");
    expect(properties).not.toHaveProperty("model");
    expect(properties).not.toHaveProperty("thinking");
    expect(properties).not.toHaveProperty("timeout");
    expect(properties).not.toHaveProperty("subagentTimeoutMs");
    expect(tool?.description).toContain("external Claude Code, Codex CLI, or Antigravity");
    expect(tool?.promptGuidelines).toBeUndefined();

    const help = session.getAllTools().find((candidate) => candidate.name === "external_help");
    expect(help?.description).toContain("Read-only help");
    expect((help?.parameters as { properties: Record<string, unknown> }).properties).toEqual(
      expect.objectContaining({ topic: expect.anything(), harness: expect.anything() }),
    );
    expect(session.getAllTools().find((candidate) => candidate.name === "external_runs")).toBeDefined();

    disposeSession(session);
  });

  it("requires description and prompt while exposing role-first and legacy selectors", async () => {
    const { session } = await createSession();

    const tool = session.getAllTools().find((candidate) => candidate.name === "Agent");
    const schema = tool?.parameters as { required?: string[]; properties: Record<string, unknown>; anyOf?: unknown[] } | undefined;
    expect(schema?.required).toContain("description");
    expect(schema?.required).toContain("prompt");
    expect(schema?.required).not.toContain("role");
    expect(schema?.required).not.toContain("harness");
    expect(schema?.required).not.toContain("subagent_type");
    expect(schema?.properties.role).toMatchObject({ type: "string", minLength: 1 });
    expect(schema?.properties.subagent_type).toMatchObject({ type: "string", minLength: 1 });
    expect(schema?.anyOf).toHaveLength(2);
    expect(schema?.properties).not.toHaveProperty("tag");
    expect(schema?.properties).not.toHaveProperty("label");

    disposeSession(session);
  });

  it("settles workflow child evidence when resume validation fails", async () => {
    mkdirSync(join(agentDir, "subagents"), { recursive: true });
    writeFileSync(join(agentDir, "subagents", "codex-worker.md"), "---\ndescription: Codex worker.\nbackend: codex\n---\n");
    const { session, model, modelRegistry } = await createSession();
    const workflow = session.getToolDefinition("workflow") as any;
    const result = await workflow.execute(
      "resume-validation",
      {
        script: "export const meta = { apiVersion: 1, name: 'resume-validation', description: 'Resume validation' }; return await agent('work', { subagent_type: 'codex-worker', resume: '../bad' });",
      },
      undefined,
      undefined,
      makeExecutionContext({ hasUI: false, model, modelRegistry }),
    );

    expect(result.details.agents, JSON.stringify(result.details)).toHaveLength(1);
    const child = result.details.agents[0];
    expect(child).toMatchObject({ status: "error", externalRunId: expect.stringMatching(/^run_/), recordPath: expect.any(String) });
    const summary = JSON.parse(readFileSync(join(child.recordPath, "summary.json"), "utf8"));
    expect(summary.runId).toBe(child.externalRunId);
    expect(summary.summary).toMatchObject({ status: "error", backendStarted: false });

    disposeSession(session);
  });

  it("launches Agent and workflow work in the background without retaining tool callbacks", async () => {
    const subagentsDir = join(agentDir, "subagents");
    const binDir = join(tempDir, "bin-background");
    const startedPath = join(tempDir, "background-started");
    const directRelease = join(tempDir, "release-direct");
    const workflowRelease = join(tempDir, "release-workflow");
    mkdirSync(subagentsDir, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(subagentsDir, "codex-worker.md"), "---\ndescription: Background worker.\nbackend: codex\n---\n");
    const fakeCodex = join(binDir, "codex");
    writeFileSync(fakeCodex, `#!/usr/bin/env node
import { appendFileSync, existsSync } from 'node:fs';
let stdin = '';
for await (const chunk of process.stdin) stdin += chunk;
appendFileSync(${JSON.stringify(startedPath)}, stdin + '\\n');
const release = stdin.includes('workflow') ? ${JSON.stringify(workflowRelease)} : ${JSON.stringify(directRelease)};
while (!existsSync(release)) await new Promise((resolve) => setTimeout(resolve, 10));
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'background-test' }));
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'finished ' + stdin } }));
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } }));
`);
    chmodSync(fakeCodex, 0o755);
    process.env.PATH = `${binDir}:${originalPathEnv ?? ""}`;

    const { session, model, modelRegistry } = await createSession();
    const context = makeExecutionContext({ hasUI: false, model, modelRegistry, persistedSession: true }) as any;
    context.sessionManager.getBranch = () => [];
    const agent = session.getToolDefinition("Agent") as any;
    const directUpdate = vi.fn();
    const direct = await agent.execute(
      "background-agent",
      { description: "Background agent", prompt: "direct background", role: "worker", harness: "codex", background: true },
      undefined,
      directUpdate,
      context,
    );
    expect(direct.details).toMatchObject({ status: "queued", runId: expect.stringMatching(/^run_/) });
    await vi.waitFor(() => {
      expect(existsSync(startedPath)).toBe(true);
      expect(readFileSync(startedPath, "utf8")).toContain("direct background");
    }, { timeout: 5_000 });
    expect(existsSync(directRelease)).toBe(false);
    expect(directUpdate).not.toHaveBeenCalled();

    writeFileSync(directRelease, "go");
    await vi.waitFor(() => {
      const summary = JSON.parse(readFileSync(join(direct.details.recordPath, "summary.json"), "utf8"));
      expect(summary.summary.status).toBe("done");
    });

    const blocking = await agent.execute(
      "blocking-agent",
      { description: "Blocking agent", prompt: "direct blocking", role: "worker", harness: "codex" },
      undefined,
      undefined,
      context,
    );
    expect(blocking.details).toMatchObject({ status: "done", result: "finished direct blocking" });

    const workflow = session.getToolDefinition("workflow") as any;
    const workflowUpdate = vi.fn();
    const backgroundWorkflow = await workflow.execute(
      "background-workflow",
      {
        background: true,
        script: "export const meta = { apiVersion: 1, name: 'background', description: 'Background workflow' }; return await agent('workflow background', { role: 'worker', harness: 'codex' });",
      },
      undefined,
      workflowUpdate,
      context,
    );
    expect(backgroundWorkflow.details).toMatchObject({ status: "running", runId: expect.stringMatching(/^wf_/) });
    await vi.waitFor(() => {
      expect(existsSync(startedPath)).toBe(true);
      expect(readFileSync(startedPath, "utf8")).toContain("workflow background");
    }, { timeout: 5_000 });
    expect(existsSync(workflowRelease)).toBe(false);
    expect(workflowUpdate).not.toHaveBeenCalled();
    writeFileSync(workflowRelease, "go");
    await vi.waitFor(() => expect(readFileSync(backgroundWorkflow.details.journalPath, "utf8")).toContain('"type":"run_complete"'));

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

    expect(rootContext?.systemPrompt).toContain("# External delegation");
    expect(rootContext?.systemPrompt).toContain("Harnesses: agy (default), claude, codex");
    expect(rootContext?.systemPrompt).toContain("agy alone may make one disclosed infrastructure retry");
    expect(getToolNames(rootContext)).toContain("Agent");
    expect(getToolNames(rootContext)).toContain("external_help");
    expect(getToolNames(rootContext)).toContain("external_runs");
    expect(getToolNames(rootContext)).toContain("workflow");
    expect(getToolNames(rootContext)).not.toContain("pi_flow_profile_create");

    disposeSession(session);
  });

  it("resolves roles against a trusted project default-harness override", async () => {
    mkdirSync(join(agentDir, "subagents"), { recursive: true });
    writeFileSync(
      join(agentDir, "subagents", "claude-security-reviewer.md"),
      "---\ndescription: Custom security review through Claude.\nbackend: claude\n---\n\nReview security read-only.\n",
    );
    mkdirSync(join(cwd, ".pi", "pi-flow-external"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "pi-flow-external", "settings.json"), JSON.stringify({ defaultHarness: "codex" }));

    // Trusted session: the coordinator prompt names the project default, and a
    // claude-only role resolved without an explicit harness fails against the
    // project default instead of the global agy default.
    const trusted = await createSession({ projectTrusted: true });
    let trustedPrompt = "";
    trusted.registration.setResponses([
      (context) => {
        trustedPrompt = context.systemPrompt ?? "";
        return fauxAssistantMessage("noted");
      },
    ]);
    await trusted.session.prompt("Just say noted.");
    expect(trustedPrompt).toContain("Harnesses: agy, claude, codex (default)");
    const trustedAgent = trusted.session.getToolDefinition("Agent") as any;
    const trustedResult = await trustedAgent.execute(
      "project-default",
      { description: "Review security", prompt: "Review.", role: "security-reviewer" },
      undefined,
      undefined,
      makeExecutionContext({ hasUI: false, model: trusted.model, modelRegistry: trusted.modelRegistry, projectTrusted: true }),
    );
    expect(trustedResult.content[0].text).toMatch(/unavailable for harness "codex".*Supported harnesses for this role: claude/s);
    disposeSession(trusted.session);

    // Untrusted session: the same call resolves against the global agy default.
    const untrusted = await createSession();
    const untrustedAgent = untrusted.session.getToolDefinition("Agent") as any;
    const untrustedResult = await untrustedAgent.execute(
      "global-default",
      { description: "Review security", prompt: "Review.", role: "security-reviewer" },
      undefined,
      undefined,
      makeExecutionContext({ hasUI: false, model: untrusted.model, modelRegistry: untrusted.modelRegistry }),
    );
    expect(untrustedResult.content[0].text).toMatch(/unavailable for harness "agy".*Supported harnesses for this role: claude/s);
    disposeSession(untrusted.session);
  });

  it("discovers saved workflows through help without trusting project workflows implicitly", async () => {
    mkdirSync(join(agentDir, "workflows"), { recursive: true });
    writeFileSync(
      join(agentDir, "workflows", "audit.js"),
      `export const meta = { apiVersion: 1, name: 'audit-todos', description: 'Find TODOs and summarize debt. Use before cleanup planning.' };\nreturn await agent('audit');`,
    );
    mkdirSync(join(cwd, ".pi", "workflows"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi", "workflows", "project.js"),
      `export const meta = { apiVersion: 1, name: 'project-review', description: 'Project-only review.' };\nreturn await agent('review');`,
    );

    const { session, model, modelRegistry } = await createSession();
    const help = session.getToolDefinition("external_help") as any;
    const execute = (projectTrusted: boolean) => help.execute(
      "workflow-help",
      { topic: "workflow" },
      undefined,
      undefined,
      makeExecutionContext({ hasUI: false, model, modelRegistry, projectTrusted }),
    );
    const untrusted = await execute(false);
    expect(untrusted.content[0].text).toContain("audit-todos (global)");
    expect(untrusted.content[0].text).not.toContain("project-review");
    const trusted = await execute(true);
    expect(trusted.content[0].text).toContain("project-review (project)");

    disposeSession(session);
  });

  it("returns role descriptions and exact-profile availability through help", async () => {
    mkdirSync(join(agentDir, "subagents"), { recursive: true });
    writeFileSync(
      join(agentDir, "subagents", "claude-security-reviewer.md"),
      "---\ndescription: Custom security review through Claude.\nbackend: claude\n---\n\nReview security read-only.\n",
    );
    writeFileSync(
      join(agentDir, "subagents", "specialist.md"),
      "---\ndescription: Exact-only Codex specialist.\nbackend: codex\n---\n\nSpecialist task.\n",
    );

    const { session, model, modelRegistry } = await createSession();
    const help = session.getToolDefinition("external_help") as any;
    const result = await help.execute(
      "role-help",
      { topic: "roles" },
      undefined,
      undefined,
      makeExecutionContext({ hasUI: false, model, modelRegistry }),
    );
    expect(result.content[0].text).toContain("security-reviewer (claude)");
    expect(result.content[0].text).toContain("claude-security-reviewer: Custom security review through Claude.");
    expect(result.content[0].text).toContain("specialist (codex): Exact-only Codex specialist.");

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
