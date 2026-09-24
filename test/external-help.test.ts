import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { ConcurrencyLimiter } from "../src/core/concurrency.ts";
import { createExternalHelpTool } from "../src/external-help.ts";
import { createExternalRunsTool } from "../src/external-runs.ts";
import { RunRegistry } from "../src/core/run-registry.ts";
import { agentToolParameters } from "../src/pi-subagent.ts";
import { loadExternalCatalog, resolveExternalProfile } from "../src/profiles.ts";
import {
  USAGE_BACKGROUND_AGENT,
  USAGE_INDEPENDENT_REVIEW,
  USAGE_ONE_AGENT,
  USAGE_RESTRICTED_AGENT,
  USAGE_RESUME_AGENT,
  USAGE_RUNS_FINAL,
  USAGE_WORKFLOW_CALLS,
  usageWorkflowScript,
} from "../src/prompts.ts";
import type { ExternalHarness } from "../src/types.ts";
import { normalizeAgentOptions } from "../src/workflow/runtime-values.ts";
import { workflowToolParameters } from "../src/workflow/source.ts";
import { ChildRunError, parseWorkflowScript, runWorkflow } from "../src/workflow/runtime.ts";

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
      join(agentDir, "pi-flow-external", "settings.json"),
      JSON.stringify({ version: 4, harnesses: { "pi-deepseek": { model: "deepseek/deepseek-chat", thinking: "high" } } }),
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
      join(agentDir, "pi-flow-external", "settings.json"),
      JSON.stringify({ version: 4, harnesses: { "pi-deepseek": { model: "deepseek/deepseek-chat", thinking: "high" } } }),
    );
    await withAgentDir(agentDir, async () => {
      const tool = makeTool();
      const result = await tool.execute("call-4", { topic: "permissions", harness: "pi-deepseek" }, undefined, undefined, fakeCtx(agentDir));
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain("pi-*");
      expect(text).not.toContain("external CLI");
    });
  });

  it("accepts a harness filter on the workflow topic without error, returning workflow help", async () => {
    const agentDir = tempAgentDir();
    await withAgentDir(agentDir, async () => {
      const tool = makeTool();
      const result = await tool.execute("call-5", { topic: "workflow", harness: "claude" }, undefined, undefined, fakeCtx(agentDir));
      expect((result.content[0] as { text: string }).text).toContain("blocking by default");
      expect(result.details).toEqual({ topic: "workflow", harness: "claude" });
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

function toolCall(name: string, args: object) {
  return { type: "toolCall" as const, id: `call-${name}`, name, arguments: args };
}

describe("external_help usage playbook", () => {
  const ordinaryAgents = [USAGE_ONE_AGENT, USAGE_INDEPENDENT_REVIEW, USAGE_BACKGROUND_AGENT, USAGE_RESUME_AGENT];
  const agentExamples = [...ordinaryAgents, USAGE_RESTRICTED_AGENT];

  it("accepts topic usage and rejects an unknown topic", () => {
    const tool = makeTool() as any;
    expect(validateToolArguments(tool, toolCall("external_help", { topic: "usage" }))).toEqual({ topic: "usage" });
    expect(() => validateToolArguments(tool, toolCall("external_help", { topic: "not_a_topic" }))).toThrow(/Validation failed for tool "external_help"/);
  });

  it("serves the canonical examples and ignores a harness selector", async () => {
    const agentDir = tempAgentDir();
    await withAgentDir(agentDir, async () => {
      const tool = makeTool();
      const result = await tool.execute("call-usage", { topic: "usage", harness: "not-a-real-harness" }, undefined, undefined, fakeCtx(agentDir));
      const text = (result.content[0] as { text: string }).text;
      expect(result.details).toEqual({ topic: "usage", harness: "not-a-real-harness" });
      expect(text).toContain(usageWorkflowScript());
      expect(text).toContain(JSON.stringify(USAGE_ONE_AGENT, null, 2));
      expect(text).toContain(JSON.stringify(USAGE_RESTRICTED_AGENT, null, 2));
      expect(text).toContain(JSON.stringify(USAGE_RUNS_FINAL, null, 2));

      const blank = await tool.execute("call-usage-blank", { topic: "usage", harness: "  " }, undefined, undefined, fakeCtx(agentDir));
      expect(blank.details).toEqual({ topic: "usage" });
    });
  });

  it("validates playbook selectors against the Agent, external_runs, and workflow schemas", () => {
    const agentTool = { name: "Agent", parameters: agentToolParameters } as any;
    for (const example of ordinaryAgents) {
      const validated = validateToolArguments(agentTool, toolCall("Agent", example));
      expect(validated).toMatchObject({ role: example.role, harness: example.harness });
      expect(validated).not.toHaveProperty("permission");
    }
    expect(validateToolArguments(agentTool, toolCall("Agent", USAGE_RESTRICTED_AGENT))).toMatchObject({
      role: USAGE_RESTRICTED_AGENT.role,
      harness: USAGE_RESTRICTED_AGENT.harness,
      permission: "readonly",
    });
    expect(() => validateToolArguments(agentTool, toolCall("Agent", {
      ...USAGE_ONE_AGENT,
      subagent_type: "claude-explorer",
    }))).toThrow(/Validation failed for tool "Agent"/);

    const runsTool = createExternalRunsTool({ registry: new RunRegistry(1), runsDirectory: () => "/tmp" }) as any;
    expect(validateToolArguments(runsTool, toolCall("external_runs", USAGE_RUNS_FINAL))).toEqual(USAGE_RUNS_FINAL);

    const script = usageWorkflowScript();
    const workflowTool = { name: "workflow", parameters: workflowToolParameters } as any;
    expect(validateToolArguments(workflowTool, toolCall("workflow", { script })).script).toBe(script);
    expect(parseWorkflowScript(script).meta).toMatchObject({ apiVersion: 1, name: "parallel-review" });
    for (const call of USAGE_WORKFLOW_CALLS) {
      const normalized = normalizeAgentOptions(call.options);
      expect(normalized).toMatchObject({
        label: call.options.description,
        role: call.options.role,
        harness: call.options.harness,
      });
      expect(normalized.permission).toBeUndefined();
    }
  });

  it("resolves playbook roles on the live catalog and keeps a caught sibling failure", async () => {
    const agentDir = tempAgentDir();
    await withAgentDir(agentDir, async () => {
      const catalog = loadExternalCatalog(agentDir);
      for (const example of [...agentExamples, ...USAGE_WORKFLOW_CALLS.map((call) => call.options)]) {
        const profile = resolveExternalProfile(catalog.profiles, { role: example.role, harness: example.harness }, "agy");
        expect(profile.name).toBe(`${example.harness}-${example.role}`);
        expect(profile.configurationError).toBeUndefined();
      }

      const result = await runWorkflow(usageWorkflowScript(), {
        cwd: agentDir,
        limiter: new ConcurrencyLimiter(4),
        resolveSubagentType: (selection) => resolveExternalProfile(catalog.profiles, selection, "agy").name,
        runAgent: async (call) => {
          if (call.label === "review") {
            throw new ChildRunError({ runId: "run_review", outcome: "failed", message: "review failed" });
          }
          return "mapped";
        },
      });
      expect(result.agentCount).toBe(2);
      expect(result.result).toEqual({
        settled: [
          { ok: true, value: "mapped" },
          { ok: false, runId: "run_review", outcome: "failed", message: "review failed" },
        ],
      });
    });
  });
});
