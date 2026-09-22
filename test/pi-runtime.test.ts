import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AgentSession,
  AuthStorage,
  DefaultResourceLoader,
  ModelRegistry,
  SettingsManager,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, type Context } from "../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/index.js";
import { describe, expect, it, vi } from "vitest";
import { spawnSubagent } from "../src/core/spawn.ts";
import { resolveCapabilitySelection } from "../src/core/capabilities.ts";
import { runRecordsDirectory } from "../src/core/retention.ts";
import { setupPiSubagentTestHarness } from "./helpers/pi-subagent-harness.ts";
import type { SubagentProfile, SubagentToolDetails, SubagentUsage } from "../src/types.ts";

const noop = () => undefined;

function baseParams(overrides: Partial<Parameters<typeof spawnSubagent>[0]> = {}): Parameters<typeof spawnSubagent>[0] {
  return {
    toolCallId: "call-1",
    description: "Test task",
    prompt: "Do the thing.",
    profile: { name: "pi-test-worker", description: "x", backend: "pi", harness: "pi-test" },
    thinkingLevel: undefined,
    ctx: { cwd: "/tmp" } as ExtensionContext,
    signal: undefined,
    timeoutMs: 5_000,
    progressEnabled: false,
    onProgress: undefined,
    onUsage: noop as (usage: SubagentUsage) => void,
    recordRun: false,
    ...overrides,
  };
}

describe("pi runtime preflight", () => {
  let agentDir = "";
  const { createSession } = setupPiSubagentTestHarness((state) => {
    agentDir = state.agentDir;
  });

  it("fails cleanly with no fallback when the profile pins no model", async () => {
    const { modelRegistry } = await createSession();
    const result = await spawnSubagent(baseParams({
      profile: { name: "pi-test-worker", description: "x", backend: "pi", harness: "pi-test" },
      model: undefined,
      ctx: { cwd: "/tmp", modelRegistry } as ExtensionContext,
    }));
    const details = result.details as SubagentToolDetails;
    expect(details.status).toBe("error");
    expect(details.error).toBe("No model is selected");
  });

  it("fails cleanly when auth is not configured, distinct from a missing model", async () => {
    const { model } = await createSession();
    // The harness's models.json embeds a test apiKey directly in the provider
    // config (so ordinary runs work with zero extra setup); to exercise a
    // genuinely unauthenticated registry, mirror the same model definitions
    // into a sibling file with no apiKey, backed by a fresh, empty AuthStorage.
    const rawConfig = JSON.parse(readFileSync(join(agentDir, "models.json"), "utf8"));
    for (const provider of Object.values(rawConfig.providers) as Array<{ apiKey?: string }>) {
      delete provider.apiKey;
    }
    const unauthedModelsPath = join(agentDir, "models-no-auth.json");
    writeFileSync(unauthedModelsPath, JSON.stringify(rawConfig, null, 2));
    const unauthenticatedRegistry = ModelRegistry.create(
      AuthStorage.create(join(agentDir, "auth-empty.json")),
      unauthedModelsPath,
    );
    const result = await spawnSubagent(baseParams({
      model,
      ctx: { cwd: "/tmp", modelRegistry: unauthenticatedRegistry } as ExtensionContext,
    }));
    const details = result.details as SubagentToolDetails;
    expect(details.status).toBe("error");
    expect(details.error).toContain("No credentials configured");
    expect(details.error).not.toContain("No model is selected");
  });

  it("rejects a thinking value outside the six-literal set before any session work", async () => {
    const { model, modelRegistry } = await createSession();
    const result = await spawnSubagent(baseParams({
      model,
      thinkingLevel: "med",
      ctx: { cwd: "/tmp", modelRegistry } as ExtensionContext,
    }));
    const details = result.details as SubagentToolDetails;
    expect(details.status).toBe("error");
    expect(details.error).toContain("Unsupported thinking level");
    expect(details.error).toContain("off, minimal, low, medium, high, xhigh");
  });
});

describe("pi runtime completion contract", () => {
  let agentDir = "";
  let cwd = "";
  const { createSession, disposeSession } = setupPiSubagentTestHarness((state) => {
    agentDir = state.agentDir;
    cwd = state.cwd;
  });

  it("reports an empty final assistant turn as an error, not a hollow success", async () => {
    const { model, modelRegistry, registration } = await createSession();
    registration.setResponses([() => fauxAssistantMessage([])]);
    const result = await spawnSubagent(baseParams({
      model,
      ctx: { cwd, modelRegistry } as ExtensionContext,
    }));
    const details = result.details as SubagentToolDetails;
    expect(details.status).toBe("error");
    expect(details.error).toContain("no final assistant text");
  });

  it("reports a whitespace-only final assistant turn as an error", async () => {
    const { model, modelRegistry, registration } = await createSession();
    registration.setResponses([() => fauxAssistantMessage("   \n\t  ")]);
    const result = await spawnSubagent(baseParams({
      model,
      ctx: { cwd, modelRegistry } as ExtensionContext,
    }));
    const details = result.details as SubagentToolDetails;
    expect(details.status).toBe("error");
    expect(details.error).toContain("no final assistant text");
  });

  it("fails a run that completes with no observed agent_end event, even with valid final text", async () => {
    const { model, modelRegistry, registration } = await createSession();
    registration.setResponses([() => fauxAssistantMessage("looks fine")]);
    // Wrap subscribe so every listener (including spawn.ts's own) never sees
    // an agent_end event, simulating an event-stream malfunction where the
    // terminal event is never observed even though the turn itself finished.
    const originalSubscribe = AgentSession.prototype.subscribe;
    const subscribeSpy = vi.spyOn(AgentSession.prototype, "subscribe").mockImplementation(function (
      this: AgentSession,
      listener: Parameters<typeof originalSubscribe>[0],
    ) {
      return originalSubscribe.call(this, (event) => {
        if ((event as { type?: string }).type === "agent_end") return;
        listener(event);
      });
    });
    try {
      const result = await spawnSubagent(baseParams({
        model,
        ctx: { cwd, modelRegistry } as ExtensionContext,
      }));
      const details = result.details as SubagentToolDetails;
      expect(details.status).toBe("error");
      expect(details.error).toContain("without an observed agent_end event");
    } finally {
      subscribeSpy.mockRestore();
    }
  });

  it("fails a run whose observed terminal agent_end reports willRetry:true", async () => {
    const { model, modelRegistry, registration } = await createSession();
    registration.setResponses([() => fauxAssistantMessage("looks fine")]);
    // Rewrite the observed agent_end to simulate an SDK-reported pending
    // retry at the exact moment this code checks for one — this must be
    // treated as an unexpected, untrustworthy completion, not success.
    const originalSubscribe = AgentSession.prototype.subscribe;
    const subscribeSpy = vi.spyOn(AgentSession.prototype, "subscribe").mockImplementation(function (
      this: AgentSession,
      listener: Parameters<typeof originalSubscribe>[0],
    ) {
      return originalSubscribe.call(this, (event) => {
        if ((event as { type?: string }).type === "agent_end") {
          listener({ ...event, willRetry: true } as Parameters<typeof listener>[0]);
          return;
        }
        listener(event);
      });
    });
    try {
      const result = await spawnSubagent(baseParams({
        model,
        ctx: { cwd, modelRegistry } as ExtensionContext,
      }));
      const details = result.details as SubagentToolDetails;
      expect(details.status).toBe("error");
      expect(details.error).toContain("willRetry=true");
    } finally {
      subscribeSpy.mockRestore();
    }
  });

  it("wires onBackendEvent for a normal run (regression: was always 0 for pi)", async () => {
    const { model, modelRegistry, registration } = await createSession();
    registration.setResponses([() => fauxAssistantMessage("done text")]);
    const result = await spawnSubagent({
      ...baseParams({ model, ctx: { cwd, modelRegistry } as ExtensionContext }),
      recordRun: true,
    });
    // recordRun:true routes through the outer spawnSubagent, which wires
    // onBackendEvent itself and tracks backendEventCount on the result.
    const details = result.details as SubagentToolDetails;
    expect(details.status).toBe("done");
    expect(details.backendEventCount ?? 0).toBeGreaterThan(0);
  });

  it("discloses a legitimate model-capability thinking clamp as evidence and in the banner", async () => {
    // A model with reasoning:false supports only "off" (see pi-ai's
    // getSupportedThinkingLevels), so requesting "high" is guaranteed to be
    // clamped by createAgentSession itself — a real, deterministic clamp,
    // not a simulated one.
    const { model, modelRegistry, registration } = await createSession({
      models: [{ id: "faux-non-reasoning", name: "Faux Non-Reasoning", reasoning: false }],
      defaultModelId: "faux-non-reasoning",
    });
    registration.setResponses([() => fauxAssistantMessage("done text")]);
    const result = await spawnSubagent({
      ...baseParams({ model, thinkingLevel: "high", ctx: { cwd, modelRegistry } as ExtensionContext }),
      recordRun: true,
    });
    const details = result.details as SubagentToolDetails;
    expect(details.status).toBe("done");
    expect(details.thinkingClamped).toEqual({ requested: "high", effective: "off" });
    expect(details.progress?.thinkingClamped).toEqual({ requested: "high", effective: "off" });
    expect((result.content[0] as { text: string }).text).toContain("thinking clamped high→off");

    const runId = details.runId!;
    const summary = JSON.parse(readFileSync(join(runRecordsDirectory(), runId, "summary.json"), "utf8"));
    expect(summary.summary.thinkingClamped).toEqual({ requested: "high", effective: "off" });
  });

  it("does not silently retry a transient provider error (no-auto-retry contract)", async () => {
    const { model, modelRegistry, registration } = await createSession();
    let calls = 0;
    registration.setResponses([
      () => {
        calls++;
        return fauxAssistantMessage("partial analysis before rate limit", { stopReason: "error", errorMessage: "rate limit exceeded (429)" });
      },
    ]);
    const result = await spawnSubagent(baseParams({
      model,
      ctx: { cwd, modelRegistry } as ExtensionContext,
    }));
    const details = result.details as SubagentToolDetails;
    expect(details.status).toBe("error");
    expect(details.error).toContain("rate limit exceeded");
    expect(details.assistantOutput).toEqual({
      status: "interrupted",
      messages: [{ text: "partial analysis before rate limit" }],
    });
    expect(result.content[0].text).toContain("Interrupted output:\npartial analysis before rate limit");
    // If the SDK's own ambient auto-retry had been left enabled, this would
    // have consumed multiple queued responses (one per attempt) instead of
    // exactly one.
    expect(calls).toBe(1);
  });

  it("rewrites a timed-out run to aborted and preserves timeout status", async () => {
    const { model, modelRegistry, registration } = await createSession();
    registration.setResponses([
      () => new Promise((resolve) => {
        setTimeout(() => resolve(fauxAssistantMessage("late text")), 200);
      }),
    ]);
    const result = await spawnSubagent(baseParams({
      model,
      timeoutMs: 20,
      ctx: { cwd, modelRegistry } as ExtensionContext,
    }));
    const details = result.details as SubagentToolDetails;
    expect(details.status).toBe("aborted");
    expect(details.timedOut).toBe(true);
    expect(details.error).toContain("timed out after 20ms");
    expect((result.content[0] as { text: string }).text).toContain("aborted: Subagent timed out after 20ms");
  });

  it("overrides retry.enabled in memory while preserving real global settings and never touching disk", async () => {
    const { model, modelRegistry, registration } = await createSession();
    // A real, non-default global setting the pi child must still inherit.
    const settingsPath = join(agentDir, "settings.json");
    writeFileSync(settingsPath, JSON.stringify({ compaction: { enabled: false } }));
    const before = readFileSync(settingsPath, "utf8");

    const createSpy = vi.spyOn(SettingsManager, "create");
    registration.setResponses([() => fauxAssistantMessage("done text")]);
    const result = await spawnSubagent(baseParams({
      model,
      ctx: { cwd, modelRegistry } as ExtensionContext,
    }));

    expect((result.details as SubagentToolDetails).status).toBe("done");
    expect(createSpy).toHaveBeenCalled();
    const childSettingsManager = createSpy.mock.results.at(-1)?.value as SettingsManager;
    createSpy.mockRestore();
    // Real setting preserved (not discarded by building a from-scratch in-memory manager).
    expect(childSettingsManager.getCompactionEnabled()).toBe(false);
    // Retry overridden, in memory only.
    expect(childSettingsManager.getRetrySettings().enabled).toBe(false);
    // Never persisted: the real settings.json file is byte-for-byte unchanged.
    expect(readFileSync(settingsPath, "utf8")).toBe(before);
  });

  it("cancels before prompt start without reporting a partial run as done", async () => {
    const { model, modelRegistry } = await createSession();
    const controller = new AbortController();
    controller.abort();
    const result = await spawnSubagent(baseParams({
      model,
      signal: controller.signal,
      ctx: { cwd, modelRegistry } as ExtensionContext,
    }));
    const details = result.details as SubagentToolDetails;
    expect(details.status).toBe("aborted");
  });

  it("aborts in the window after resourceLoader.reload() but before session construction", async () => {
    const { model, modelRegistry, registration } = await createSession();
    registration.setResponses([() => fauxAssistantMessage("should not run")]);
    const controller = new AbortController();
    const originalReload = DefaultResourceLoader.prototype.reload;
    const reloadSpy = vi.spyOn(DefaultResourceLoader.prototype, "reload").mockImplementation(async function (this: DefaultResourceLoader, ...args: unknown[]) {
      const returned = await originalReload.apply(this, args as never);
      // Simulate an abort landing exactly in the window this guard exists
      // for: after the (potentially slow, file-I/O-doing) reload resolves,
      // before the heavier session construction begins.
      controller.abort();
      return returned;
    });
    try {
      const result = await spawnSubagent(baseParams({
        model,
        signal: controller.signal,
        ctx: { cwd, modelRegistry } as ExtensionContext,
      }));
      const details = result.details as SubagentToolDetails;
      expect(details.status).toBe("aborted");
      expect(details.result).toBeUndefined();
    } finally {
      reloadSpy.mockRestore();
    }
  });

  it("cleans up and reports a clean error when resourceLoader.reload() itself throws (e.g. malformed project config)", async () => {
    const { model, modelRegistry, registration } = await createSession();
    registration.setResponses([() => fauxAssistantMessage("should not run")]);
    const reloadSpy = vi.spyOn(DefaultResourceLoader.prototype, "reload").mockRejectedValueOnce(
      new Error("simulated malformed project config"),
    );
    try {
      // No session/resource-loader was ever fully constructed at the point of
      // this throw, so this must not crash spawnSubagent itself (it must
      // return a clean textResult) and must not leave anything to dispose.
      const result = await spawnSubagent(baseParams({
        model,
        ctx: { cwd, modelRegistry } as ExtensionContext,
      }));
      const details = result.details as SubagentToolDetails;
      expect(details.status).toBe("error");
      expect(details.error).toContain("simulated malformed project config");
      expect(details.result).toBeUndefined();
    } finally {
      reloadSpy.mockRestore();
    }
  });

  it("records budgetEnforceable:false for a pi profile with a budget cap", async () => {
    const { model, modelRegistry, registration } = await createSession();
    registration.setResponses([() => fauxAssistantMessage("done text")]);
    const result = await spawnSubagent({
      ...baseParams({ model, ctx: { cwd, modelRegistry } as ExtensionContext }),
      maxBudgetUsd: 5,
      recordRun: true,
    });
    const runId = (result.details as SubagentToolDetails).runId!;
    const summary = JSON.parse(readFileSync(join(runRecordsDirectory(), runId, "summary.json"), "utf8"));
    expect(summary.summary.budgetEnforceable).toBe(false);
  });

  it("produces the existing 'no session id to resume' error for a completed pi run", async () => {
    const { model, modelRegistry, registration } = await createSession();
    registration.setResponses([() => fauxAssistantMessage("done text")]);
    const first = await spawnSubagent({
      ...baseParams({ model, ctx: { cwd, modelRegistry } as ExtensionContext }),
      recordRun: true,
    });
    const runId = (first.details as SubagentToolDetails).runId!;
    registration.setResponses([() => fauxAssistantMessage("should not run")]);
    const resumed = await spawnSubagent({
      ...baseParams({ model, ctx: { cwd, modelRegistry } as ExtensionContext }),
      resumeRunId: runId,
      recordRun: false,
    });
    const details = resumed.details as SubagentToolDetails;
    expect(details.status).toBe("error");
    expect(details.error).toContain("no session id to resume");
  });
});

describe("pi runtime curated tool tiers", () => {
  let agentDir = "";
  let cwd = "";
  const { createSession, disposeSession } = setupPiSubagentTestHarness((state) => {
    agentDir = state.agentDir;
    cwd = state.cwd;
  });

  function getToolNames(context: Context | undefined): string[] {
    return [...new Set((context?.tools ?? [])
      .map((tool: { name?: string } | undefined) => tool?.name)
      .filter((name): name is string => typeof name === "string"))].sort();
  }

  async function delegateToPiHarness(permission: "readonly" | "edit" | "danger", profileOverrides: Partial<SubagentProfile> = {}) {
    const { session, model, modelRegistry, registration } = await createSession({
      piHarnesses: { "pi-test": { modelId: "faux-thinker" } },
    });
    let childContext: Context | undefined;
    registration.setResponses([
      (context) => {
        childContext = context;
        return fauxAssistantMessage("done");
      },
    ]);
    const result = await spawnSubagent(baseParams({
      model,
      permission,
      ctx: { cwd, modelRegistry } as ExtensionContext,
      // Deliberately not named *-worker/*-implementer/etc.: those match the
      // execution-role name convention and would trigger the edit->danger
      // floor (resolveEffectivePermissionTier), which is tested separately in
      // permissions.test.ts and would defeat this suite's tool-tier checks.
      profile: { name: "pi-test-reviewer", description: "x", backend: "pi", harness: "pi-test", ...profileOverrides },
    }));
    return { result, childContext, session };
  }

  it("gives a readonly pi child read/grep/find/ls only", async () => {
    const { childContext, result } = await delegateToPiHarness("readonly");
    expect((result.details as SubagentToolDetails).status).toBe("done");
    const names = getToolNames(childContext);
    expect(names).toEqual(["find", "grep", "ls", "read"]);
  });

  it("gives an edit-tier pi child read/grep/find/ls/edit/write but not bash", async () => {
    const { childContext } = await delegateToPiHarness("edit");
    const names = getToolNames(childContext);
    expect(names).toEqual(["edit", "find", "grep", "ls", "read", "write"]);
    expect(names).not.toContain("bash");
  });

  it("gives a danger-tier pi child the SDK default tools", async () => {
    const { childContext } = await delegateToPiHarness("danger");
    const names = getToolNames(childContext);
    expect(names).toEqual(["bash", "edit", "read", "write"]);
  });

  it("never lets an explicit tools: allow-list reintroduce a tier-excluded tool", async () => {
    const { childContext } = await delegateToPiHarness("readonly", { tools: ["read", "bash"] });
    const names = getToolNames(childContext);
    expect(names).not.toContain("bash");
  });

  it("never includes Agent or workflow regardless of tier", async () => {
    for (const tier of ["readonly", "edit", "danger"] as const) {
      const { childContext } = await delegateToPiHarness(tier);
      const names = getToolNames(childContext);
      expect(names).not.toContain("Agent");
      expect(names).not.toContain("workflow");
    }
  });
});

describe("pi child extension isolation (design §6 safety-critical claim)", () => {
  let agentDir = "";
  let cwd = "";
  const { createSession } = setupPiSubagentTestHarness((state) => {
    agentDir = state.agentDir;
    cwd = state.cwd;
  });

  function writeLeakProbeExtension() {
    const dir = join(agentDir, "extensions");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "leak-probe.ts"),
      "export default function leakProbe(pi) {\n" +
      "  pi.registerTool({ name: 'leak_check_tool', label: 'leak', description: 'x', parameters: {}, execute: async () => ({ content: [], details: {} }) });\n" +
      "}\n",
    );
  }

  it("confirms the fixture extension is real and discoverable without noExtensions", async () => {
    writeLeakProbeExtension();
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager: SettingsManager.inMemory({}),
    });
    await resourceLoader.reload();
    const extensions = resourceLoader.getExtensions();
    const toolNames = extensions.extensions.flatMap((extension) => [...extension.tools.keys()]);
    expect(toolNames).toContain("leak_check_tool");
  });

  it("loads zero extensions under the exact curated config the pi branch uses", async () => {
    writeLeakProbeExtension();
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager: SettingsManager.inMemory({ retry: { enabled: false } }),
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
    });
    await resourceLoader.reload();
    const extensions = resourceLoader.getExtensions();
    expect(extensions.extensions).toHaveLength(0);
    const toolNames = extensions.extensions.flatMap((extension) => [...extension.tools.keys()]);
    expect(toolNames).not.toContain("leak_check_tool");
  });

  it("keeps a pi child's real delegation tool set free of the fixture extension's tool", async () => {
    writeLeakProbeExtension();
    const { model, modelRegistry, registration } = await createSession({
      piHarnesses: { "pi-test": { modelId: "faux-thinker" } },
    });
    let childContext: Context | undefined;
    registration.setResponses([(context) => {
      childContext = context;
      return fauxAssistantMessage("done");
    }]);
    await spawnSubagent(baseParams({
      model,
      ctx: { cwd, modelRegistry } as ExtensionContext,
      profile: { name: "pi-test-worker", description: "x", backend: "pi", harness: "pi-test" },
    }));
    const names = (childContext?.tools ?? []).map((tool: { name?: string } | undefined) => tool?.name);
    expect(names).not.toContain("leak_check_tool");
  });
});

describe("workflow executes a synthesized pi role end-to-end", () => {
  const { createSession, disposeSession, makeExecutionContext } = setupPiSubagentTestHarness();

  it("runs role:reviewer harness:pi-test with no on-disk profile file", async () => {
    const { session, model, modelRegistry, registration } = await createSession({
      piHarnesses: { "pi-test": { modelId: "faux-thinker", thinking: "high" } },
    });
    const context = makeExecutionContext({ hasUI: false, model, modelRegistry }) as unknown as ExtensionContext;
    const workflow = session.getToolDefinition("workflow") as {
      execute: (id: string, params: unknown, signal: unknown, onUpdate: unknown, ctx: unknown) => Promise<{ details: Record<string, unknown> }>;
    };
    let sawChildModel = "";
    registration.setResponses([
      (_context, _options, _state, childModel) => {
        sawChildModel = childModel?.id ?? "";
        return fauxAssistantMessage("synthesized pi role ran");
      },
    ]);

    const result = await workflow.execute(
      "wf-pi-synth",
      {
        script:
          "export const meta = { apiVersion: 1, name: 'pi-synth', description: 'synthesized pi role' };" +
          "return await agent('review this', { label: 'review', role: 'reviewer', harness: 'pi-test' });",
      },
      undefined,
      undefined,
      context,
    );

    expect(result.details.status).toBe("completed");
    expect(result.details.result).toBe("synthesized pi role ran");
    expect(sawChildModel).toBe(model.id);
    disposeSession(session);
  });
});

describe("Agent tool reaches a synthesized pi role via legacy exact subagent_type", () => {
  const { createSession, disposeSession, makeExecutionContext } = setupPiSubagentTestHarness();

  it("resolves subagent_type:'pi-test-reviewer' with no on-disk profile file, matching the role+harness path", async () => {
    const { session, model, modelRegistry, registration } = await createSession({
      piHarnesses: { "pi-test": { modelId: "faux-thinker", thinking: "high" } },
    });
    const context = makeExecutionContext({ hasUI: false, model, modelRegistry }) as unknown as ExtensionContext;
    const agent = session.getToolDefinition("Agent") as {
      execute: (id: string, params: unknown, signal: unknown, onUpdate: unknown, ctx: unknown) => Promise<{ details: Record<string, unknown> }>;
    };
    registration.setResponses([() => fauxAssistantMessage("exact selector worked")]);

    const result = await agent.execute(
      "exact-pi-role",
      { description: "test", prompt: "do it", subagent_type: "pi-test-reviewer" },
      undefined,
      undefined,
      context,
    );

    expect(result.details.status).toBe("done");
    expect(result.details.result).toBe("exact selector worked");
    disposeSession(session);
  });
});

describe("capabilitySet resource loading in a pi child (issue #43 second slice)", () => {
  let agentDir = "";
  let cwd = "";
  const { createSession } = setupPiSubagentTestHarness((state) => {
    agentDir = state.agentDir;
    cwd = state.cwd;
  });

  function writeSkill(name: string, description: string): void {
    const dir = join(agentDir, "skills", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\nBody.\n`);
  }

  it("loads no skills into the child's system prompt by default (unchanged v1 behavior)", async () => {
    writeSkill("writer", "Writes docs, use for documentation tasks.");
    const { model, modelRegistry, registration } = await createSession();
    let capturedSystemPrompt = "";
    registration.setResponses([(context: Context) => {
      capturedSystemPrompt = context.systemPrompt ?? "";
      return fauxAssistantMessage("done");
    }]);
    const result = await spawnSubagent(baseParams({
      model,
      ctx: { cwd, modelRegistry } as ExtensionContext,
    }));
    expect((result.details as SubagentToolDetails).status).toBe("done");
    expect(capturedSystemPrompt).not.toContain("writer");
  });

  it("loads exactly the selected skill, not an unselected one, when a capabilitySet is resolved", async () => {
    writeSkill("writer", "Writes docs, use for documentation tasks.");
    writeSkill("other-skill", "Unrelated skill, must never be disclosed to the child.");
    const { model, modelRegistry, registration } = await createSession();
    let capturedSystemPrompt = "";
    registration.setResponses([(context: Context) => {
      capturedSystemPrompt = context.systemPrompt ?? "";
      return fauxAssistantMessage("done");
    }]);
    const result = await spawnSubagent(baseParams({
      model,
      ctx: { cwd, modelRegistry } as ExtensionContext,
      projectTrusted: false,
      capabilities: { set: "docs", skills: ["writer"], promptTemplates: [] },
    }));
    expect((result.details as SubagentToolDetails).status).toBe("done");
    expect(capturedSystemPrompt).toContain("writer");
    expect(capturedSystemPrompt).not.toContain("other-skill");
  });

  it("fails loudly at actual spawn time when a selected skill disappears after the caller's earlier freeze-time resolution, instead of silently loading fewer resources than declared", async () => {
    // Simulates the queue-drift window: a caller (Agent/workflow) resolves and
    // validates a capabilitySet once up front, then the resolved skill/prompt
    // names are handed to spawnSubagent, which may not actually run until
    // later (e.g. after waiting on the shared concurrency limiter). If the
    // skill disappears in that window, the authoritative loader used at
    // actual spawn time (loadCapabilityResources) must re-validate and fail
    // before any session/prompt exists, not just filter it out silently.
    const { model, modelRegistry, registration } = await createSession();
    registration.setResponses([() => fauxAssistantMessage("should never run")]);
    const result = await spawnSubagent(baseParams({
      model,
      ctx: { cwd, modelRegistry } as ExtensionContext,
      projectTrusted: false,
      capabilities: { set: "docs", skills: ["writer"], promptTemplates: [] },
    }));
    const details = result.details as SubagentToolDetails;
    expect(details.status).toBe("error");
    expect(details.error).toContain('capabilitySet "docs" is not fully resolvable');
    expect(details.error).toContain('skill "writer"');
  });

  it("fails at actual spawn time when a selected SKILL.md's content changed since the caller's earlier freeze-time resolution, even though the skill is still present", async () => {
    // The previous test covers a selected resource disappearing entirely,
    // which loadCapabilityResources' own missing-name check already catches.
    // This covers the other half of the same queue-drift window: the skill
    // stays discoverable under the same name, so only comparing the actually
    // loaded selection's contentHash against the caller's earlier-resolved
    // hash (not just re-checking presence) can catch that its instructions
    // changed underneath a run still waiting on the concurrency limiter.
    writeSkill("writer", "Writes docs, use for documentation tasks.");
    const resolved = await resolveCapabilitySelection({
      cwd,
      agentDir,
      projectTrusted: false,
      set: "docs",
      capabilitySet: { skills: ["writer"], promptTemplates: [] },
    });
    writeFileSync(
      join(agentDir, "skills", "writer", "SKILL.md"),
      "---\nname: writer\ndescription: Writes docs, use for documentation tasks.\n---\n\nA completely different body.\n",
    );

    const { model, modelRegistry, registration } = await createSession();
    registration.setResponses([() => fauxAssistantMessage("should never run")]);
    const result = await spawnSubagent(baseParams({
      model,
      ctx: { cwd, modelRegistry } as ExtensionContext,
      projectTrusted: false,
      capabilities: { set: "docs", skills: ["writer"], promptTemplates: [], contentHash: resolved.contentHash },
    }));
    const details = result.details as SubagentToolDetails;
    expect(details.status).toBe("error");
    expect(details.error).toContain('capabilitySet "docs" changed');
  });

  it("fails before session creation when a profile declares capabilitySet but the caller omitted resolved capabilities (internal wiring error)", async () => {
    const { model, modelRegistry, registration } = await createSession();
    registration.setResponses([() => fauxAssistantMessage("should never run")]);
    const result = await spawnSubagent(baseParams({
      model,
      ctx: { cwd, modelRegistry } as ExtensionContext,
      profile: { name: "pi-test-worker", description: "x", backend: "pi", harness: "pi-test", capabilitySet: "docs" },
    }));
    const details = result.details as SubagentToolDetails;
    expect(details.status).toBe("error");
    expect(details.error).toContain('declares capabilitySet "docs"');
    expect(details.error).toContain("internal wiring error");
  });

  it("fails before session creation when the resolved capabilities' set name does not match the profile's declared capabilitySet (internal wiring error)", async () => {
    const { model, modelRegistry, registration } = await createSession();
    registration.setResponses([() => fauxAssistantMessage("should never run")]);
    const result = await spawnSubagent(baseParams({
      model,
      ctx: { cwd, modelRegistry } as ExtensionContext,
      profile: { name: "pi-test-worker", description: "x", backend: "pi", harness: "pi-test", capabilitySet: "docs" },
      capabilities: { set: "some-other-set", skills: [], promptTemplates: [] },
    }));
    const details = result.details as SubagentToolDetails;
    expect(details.status).toBe("error");
    expect(details.error).toContain("internal wiring error");
  });

  it("records the resolved capabilities on the persisted run record, not only on the returned result", async () => {
    writeSkill("writer", "Writes docs, use for documentation tasks.");
    const { model, modelRegistry, registration } = await createSession();
    registration.setResponses([() => fauxAssistantMessage("done")]);
    const result = await spawnSubagent({
      ...baseParams({
        model,
        ctx: { cwd, modelRegistry } as ExtensionContext,
        projectTrusted: false,
        capabilities: { set: "docs", skills: ["writer"], promptTemplates: [] },
      }),
      recordRun: true,
    });
    const details = result.details as SubagentToolDetails;
    expect(details.status).toBe("done");
    expect(details.capabilities).toEqual({ set: "docs", skills: ["writer"], promptTemplates: [] });
    expect(details.progress?.capabilities).toEqual({ set: "docs", skills: ["writer"], promptTemplates: [] });

    const runId = details.runId!;
    const summary = JSON.parse(readFileSync(join(runRecordsDirectory(), runId, "summary.json"), "utf8"));
    expect(summary.summary.capabilities).toEqual({ set: "docs", skills: ["writer"], promptTemplates: [] });
  });

  it("records the resolved capabilities on the persisted run record even when the run fails", async () => {
    const { model, modelRegistry, registration } = await createSession();
    // No skill written on disk: resolution fails at actual spawn time.
    registration.setResponses([() => fauxAssistantMessage("should never run")]);
    const result = await spawnSubagent({
      ...baseParams({
        model,
        ctx: { cwd, modelRegistry } as ExtensionContext,
        projectTrusted: false,
        capabilities: { set: "docs", skills: ["writer"], promptTemplates: [] },
      }),
      recordRun: true,
    });
    const details = result.details as SubagentToolDetails;
    expect(details.status).toBe("error");
    expect(details.capabilities).toEqual({ set: "docs", skills: ["writer"], promptTemplates: [] });

    const runId = details.runId!;
    const summary = JSON.parse(readFileSync(join(runRecordsDirectory(), runId, "summary.json"), "utf8"));
    expect(summary.summary.capabilities).toEqual({ set: "docs", skills: ["writer"], promptTemplates: [] });
  });
});

/**
 * These tests exercise the installed pi-coding-agent SDK's own explicit
 * invocation semantics (session.prompt()'s "/template args" and "/skill:name
 * args" expansion, plus formatSkillsForPrompt's disable-model-invocation
 * exclusion — see node_modules/@earendil-works/pi-coding-agent/dist/core/
 * agent-session.js and skills.js) through a real spawnSubagent/createAgentSession
 * call, not a mock. A selected capabilitySet resource must stay reachable only
 * the same way the SDK already exposes it — explicit slash invocation for
 * prompt templates (never auto-injected into the system prompt), and either
 * autonomous system-prompt listing or explicit /skill:name for skills,
 * depending on the skill's own disable-model-invocation flag, which this
 * extension must never override.
 */
describe("capabilitySet resources preserve SDK-native explicit-invocation semantics", () => {
  let agentDir = "";
  let cwd = "";
  const { createSession } = setupPiSubagentTestHarness((state) => {
    agentDir = state.agentDir;
    cwd = state.cwd;
  });

  function writePromptTemplate(name: string, description: string, body: string): void {
    mkdirSync(join(agentDir, "prompts"), { recursive: true });
    writeFileSync(join(agentDir, "prompts", `${name}.md`), `---\ndescription: ${description}\n---\n\n${body}\n`);
  }

  function writeSkill(name: string, description: string, body: string, disableModelInvocation = false): void {
    const dir = join(agentDir, "skills", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "SKILL.md"),
      `---\nname: ${name}\ndescription: ${description}\n${disableModelInvocation ? "disable-model-invocation: true\n" : ""}---\n\n${body}\n`,
    );
  }

  function lastUserText(context: Context): string {
    const message = [...context.messages].reverse().find((m) => m.role === "user");
    if (!message) return "";
    return typeof message.content === "string"
      ? message.content
      : message.content.filter((c): c is { type: "text"; text: string } => c.type === "text").map((c) => c.text).join("\n");
  }

  it("expands a selected prompt template's explicit /name args invocation, but never auto-injects it into the system prompt", async () => {
    writePromptTemplate("greet", "Greet someone.", "Hello $1!");
    const { model, modelRegistry, registration } = await createSession();
    let captured: Context | undefined;
    registration.setResponses([(context: Context) => {
      captured = context;
      return fauxAssistantMessage("done");
    }]);
    const result = await spawnSubagent(baseParams({
      model,
      ctx: { cwd, modelRegistry } as ExtensionContext,
      prompt: "/greet World",
      capabilities: { set: "docs", skills: [], promptTemplates: ["greet"] },
    }));
    expect((result.details as SubagentToolDetails).status).toBe("done");
    expect(lastUserText(captured!)).toBe("Hello World!");
    // Prompt templates are never listed in the system prompt (unlike skills):
    // they only ever expand through an explicit "/name args" task, never
    // autonomous discovery.
    expect(captured!.systemPrompt ?? "").not.toContain("Hello $1");
    expect(captured!.systemPrompt ?? "").not.toContain("greet");
  });

  it("does not expand an unselected prompt template's explicit invocation, leaving the text literal", async () => {
    writePromptTemplate("greet", "Greet someone.", "Hello $1!");
    writePromptTemplate("farewell", "Say goodbye.", "Goodbye $1!");
    const { model, modelRegistry, registration } = await createSession();
    let captured: Context | undefined;
    registration.setResponses([(context: Context) => {
      captured = context;
      return fauxAssistantMessage("done");
    }]);
    // Only "greet" is selected; "farewell" exists on disk but is not part of
    // this capabilitySet, so the child's resourceLoader never discovers it and
    // expandPromptTemplate leaves an unmatched "/name" invocation untouched.
    const result = await spawnSubagent(baseParams({
      model,
      ctx: { cwd, modelRegistry } as ExtensionContext,
      prompt: "/farewell World",
      capabilities: { set: "docs", skills: [], promptTemplates: ["greet"] },
    }));
    expect((result.details as SubagentToolDetails).status).toBe("done");
    expect(lastUserText(captured!)).toBe("/farewell World");
  });

  it("excludes a disable-model-invocation skill from the system prompt (not auto-discovered) yet still expands its explicit /skill:name invocation", async () => {
    writeSkill("audit", "Security audit skill.", "Perform a security audit.", true);
    const { model, modelRegistry, registration } = await createSession();
    let captured: Context | undefined;
    registration.setResponses([(context: Context) => {
      captured = context;
      return fauxAssistantMessage("done");
    }]);
    const result = await spawnSubagent(baseParams({
      model,
      ctx: { cwd, modelRegistry } as ExtensionContext,
      prompt: "/skill:audit please review",
      capabilities: { set: "docs", skills: ["audit"], promptTemplates: [] },
    }));
    expect((result.details as SubagentToolDetails).status).toBe("done");
    // Not auto-discovered: disable-model-invocation excludes it from the
    // system prompt's skill listing (formatSkillsForPrompt), so the model
    // cannot stumble onto it on its own initiative.
    expect(captured!.systemPrompt ?? "").not.toContain("Security audit skill");
    // Still explicitly invocable: _expandSkillCommand looks the skill up by
    // exact name regardless of disable-model-invocation — that flag only
    // gates autonomous discovery, never explicit /skill:name access — and
    // this extension's capabilitySet filtering must never override it.
    const userText = lastUserText(captured!);
    expect(userText).toContain('<skill name="audit"');
    expect(userText).toContain("Perform a security audit.");
    expect(userText).toContain("please review");
  });

  it("does not expand an unselected skill's explicit /skill:name invocation, leaving the text literal", async () => {
    writeSkill("audit", "Security audit skill.", "Perform a security audit.");
    writeSkill("other-skill", "Unrelated.", "Do something else.");
    const { model, modelRegistry, registration } = await createSession();
    let captured: Context | undefined;
    registration.setResponses([(context: Context) => {
      captured = context;
      return fauxAssistantMessage("done");
    }]);
    const result = await spawnSubagent(baseParams({
      model,
      ctx: { cwd, modelRegistry } as ExtensionContext,
      prompt: "/skill:other-skill go",
      capabilities: { set: "docs", skills: ["audit"], promptTemplates: [] },
    }));
    expect((result.details as SubagentToolDetails).status).toBe("done");
    expect(lastUserText(captured!)).toBe("/skill:other-skill go");
  });
});

describe("stale default harness at delegation time", () => {
  let agentDir = "";
  const { createSession, disposeSession, makeExecutionContext } = setupPiSubagentTestHarness((state) => {
    agentDir = state.agentDir;
  });

  it("fails an Agent call with no explicit harness rather than silently substituting agy", async () => {
    mkdirSync(join(agentDir, "pi-flow-external"), { recursive: true });
    writeFileSync(
      join(agentDir, "pi-flow-external", "settings.json"),
      JSON.stringify({ version: 3, defaultHarness: "pi-missing", maxConcurrentSubagents: 12, subagentTimeoutMs: 1000, defaultPermission: "danger", defaultMaxBudgetUsd: null, maxRunRecords: 200 }),
    );
    const { session, model, modelRegistry } = await createSession();
    const context = makeExecutionContext({ hasUI: false, model, modelRegistry }) as unknown as ExtensionContext;
    const agent = session.getToolDefinition("Agent") as {
      execute: (id: string, params: unknown, signal: unknown, onUpdate: unknown, ctx: unknown) => Promise<{ details: Record<string, unknown> }>;
    };

    const result = await agent.execute(
      "stale-default",
      { description: "test", prompt: "do it", role: "worker" },
      undefined,
      undefined,
      context,
    );

    expect(result.details.status).toBe("error");
    expect(result.details.error).toContain('Default harness "pi-missing" is not registered');
    expect(result.details.error).not.toContain("agy");
    disposeSession(session);
  });
});
