import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { Value } from "typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentOutputSchema, agentToolParameters } from "../src/contract/agent.ts";
import {
  capabilityRecordSchema,
  CONTRACT_INDEX_MAX_BYTES,
  externalHelpOutputSchema,
  externalHelpParameters,
  PUBLIC_TOOL_NAMES,
  PUBLIC_TOOLS,
} from "../src/contract/help.ts";
import { PI_TIER_ACTIVE_TOOLS } from "../src/core/permissions.ts";
import {
  EXTERNAL_RUNS_ACTION_SPECS,
  EXTERNAL_RUNS_EXAMPLES,
  EXTERNAL_RUNS_PARAMETER_KEYS,
  externalRunsOutputSchema,
  externalRunsParameters,
  formatExternalRunsActionGuidance,
} from "../src/contract/runs.ts";
import {
  AGENT_OPTION_KEYS,
  formatWorkflowHelpersLine,
  WORKFLOW_HELPERS,
  workflowOutputSchema,
} from "../src/contract/workflow.ts";
import { ConcurrencyLimiter } from "../src/core/concurrency.ts";
import { createExternalHelpTool } from "../src/external-help.ts";
import { createExternalRunsTool } from "../src/external-runs.ts";
import { RunRegistry } from "../src/core/run-registry.ts";
import { loadExternalCatalog, resolveExternalProfile } from "../src/profiles.ts";
import {
  USAGE_ONE_AGENT,
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
  vi.restoreAllMocks();
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

function makeTool(getDefaultHarness: (ctx: unknown) => string = () => "agy" as ExternalHarness, workflowEnabled = true) {
  return createExternalHelpTool({ getDefaultHarness: getDefaultHarness as never, workflowEnabled });
}

describe("external_help unknown harness filter", () => {
  it("returns selection_invalid and lists configured harnesses for an unknown roles filter, never falling back", async () => {
    const agentDir = tempAgentDir();
    await withAgentDir(agentDir, async () => {
      const tool = makeTool();
      const result = await tool.execute("call-1", { topic: "roles", harness: "not-a-real-harness" }, undefined, undefined, fakeCtx(agentDir));
      expect(result.isError).toBe(true);
      expect((result.content[0] as { text: string }).text).toMatch(
        /Unknown harness "not-a-real-harness"\. Configured harnesses: agy, claude, codex, grok, muse, opencode\./,
      );
      expect(result.structuredContent).toMatchObject({
        contractVersion: 1,
        tool: "external_help",
        action: "help",
        ok: false,
        data: null,
        error: { code: "selection_invalid" },
      });
      expect(Value.Check(externalHelpOutputSchema, result.structuredContent)).toBe(true);
    });
  });

  it("returns selection_invalid and lists configured harnesses for an unknown permissions filter, never silently describing it as pi", async () => {
    const agentDir = tempAgentDir();
    await withAgentDir(agentDir, async () => {
      const tool = makeTool();
      const result = await tool.execute("call-2", { topic: "permissions", harness: "not-a-real-harness" }, undefined, undefined, fakeCtx(agentDir));
      expect(result.isError).toBe(true);
      expect((result.content[0] as { text: string }).text).toMatch(/Unknown harness "not-a-real-harness"/);
      expect(result.structuredContent).toMatchObject({
        ok: false,
        data: null,
        error: { code: "selection_invalid" },
      });
      expect(Value.Check(externalHelpOutputSchema, result.structuredContent)).toBe(true);
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
      const result = await tool.execute("call-3", { topic: "permissions", harness: "pi-missing" }, undefined, undefined, fakeCtx(agentDir));
      expect(result.isError).toBe(true);
      expect((result.content[0] as { text: string }).text).toMatch(
        /Configured harnesses: agy, claude, codex, grok, muse, opencode, pi-deepseek\./,
      );
      expect(result.structuredContent).toMatchObject({
        ok: false,
        data: null,
        error: { code: "selection_invalid" },
      });
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
      expect(text).toContain(`readonly (${PI_TIER_ACTIVE_TOOLS.readonly.join("/")})`);
      expect(text).toContain(`edit (${PI_TIER_ACTIVE_TOOLS.edit.join("/")})`);
      expect(text).toContain(`danger (${PI_TIER_ACTIVE_TOOLS.danger.join("/")})`);
      expect(text).not.toContain("read/bash/edit/write/grep/find/ls");
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

});

function toolCall(name: string, args: import("@earendil-works/pi-ai").JsonObject) {
  return { type: "toolCall" as const, id: `call-${name}`, name, arguments: args };
}

describe("external_help usage playbook", () => {
  const agentExamples = [USAGE_ONE_AGENT];

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
      expect(text.length).toBeLessThan(4500);

      const blank = await tool.execute("call-usage-blank", { topic: "usage", harness: "  ", tool: "  " }, undefined, undefined, fakeCtx(agentDir));
      expect(blank.details).toEqual({ topic: "usage" });
      expect((blank.structuredContent as any).data).toMatchObject({ topic: "usage" });
      expect((blank.structuredContent as any).data).not.toHaveProperty("tool");

      const withTool = await tool.execute("call-usage-tool", { topic: "usage", tool: "external_delegate" }, undefined, undefined, fakeCtx(agentDir));
      expect(withTool.details).toEqual({ topic: "usage", tool: "external_delegate" });
      expect((withTool.structuredContent as any).data).toMatchObject({ topic: "usage", tool: "external_delegate" });
      expect(Value.Check(externalHelpOutputSchema, withTool.structuredContent)).toBe(true);
    });
  });

  it("validates playbook selectors and all external_runs action examples against the executable schemas", async () => {
    const agentTool = { name: "external_delegate", parameters: agentToolParameters } as any;
    for (const example of agentExamples) {
      const validated = validateToolArguments(agentTool, toolCall("external_delegate", { ...example }));
      expect(validated).toMatchObject({ role: example.role, harness: example.harness });
      expect(validated).not.toHaveProperty("permission");
    }
    const confined = { ...USAGE_ONE_AGENT, permission: "readonly" as const };
    expect(validateToolArguments(agentTool, toolCall("external_delegate", confined))).toMatchObject({
      role: USAGE_ONE_AGENT.role,
      harness: USAGE_ONE_AGENT.harness,
      permission: "readonly",
    });
    for (const [label, args] of [
      ["role + subagent_type", { ...USAGE_ONE_AGENT, subagent_type: "claude-explorer" }],
      ["subagent_type + harness", { description: "d", prompt: "p", subagent_type: "claude/explorer", harness: "claude" }],
      ["missing selector", { description: "d", prompt: "p" }],
      ["blank role", { description: "d", prompt: "p", role: "" }],
      ["blank harness", { ...USAGE_ONE_AGENT, harness: "" }],
      ["blank subagent_type", { description: "d", prompt: "p", subagent_type: "" }],
      ["role + blank subagent_type", { ...USAGE_ONE_AGENT, subagent_type: "" }],
    ] as const) {
      expect(() => validateToolArguments(agentTool, toolCall("external_delegate", args)), label).toThrow(
        /Validation failed for tool "external_delegate"/,
      );
    }
    expect(
      validateToolArguments(
        agentTool,
        toolCall("external_delegate_subagent_type", {
          description: "Exact profile",
          prompt: "Check /absolute/repo read-only.",
          subagent_type: "claude/explorer",
        }),
      ),
    ).toMatchObject({ subagent_type: "claude/explorer" });
    expect(
      validateToolArguments(
        agentTool,
        toolCall("external_delegate_blank_resume", {
          ...USAGE_ONE_AGENT,
          resume: "",
        }),
      ),
    ).toMatchObject({ role: USAGE_ONE_AGENT.role, resume: "" });

    const runsTool = createExternalRunsTool({ registry: new RunRegistry(1), runsDirectory: () => "/tmp" }) as any;
    const schemaPropertyKeys = Object.keys(runsTool.parameters.properties).sort();
    expect([...EXTERNAL_RUNS_PARAMETER_KEYS].sort()).toEqual(schemaPropertyKeys);

    for (const [name, example] of Object.entries(EXTERNAL_RUNS_EXAMPLES)) {
      const validated = validateToolArguments(runsTool, toolCall(`external_runs_${name}`, { ...example }));
      expect(validated).toEqual(example);
    }

    for (const spec of EXTERNAL_RUNS_ACTION_SPECS) {
      const partitioned = [...spec.required, ...spec.optional, ...spec.inapplicable];
      expect(new Set(partitioned).size).toBe(EXTERNAL_RUNS_PARAMETER_KEYS.length);
      expect([...partitioned].sort()).toEqual(schemaPropertyKeys);
      const allowed = new Set<string>([...spec.required, ...spec.optional]);
      for (const key of Object.keys(spec.example)) {
        expect(allowed.has(key)).toBe(true);
      }
      expect(validateToolArguments(runsTool, toolCall(`external_runs_spec_${spec.label}`, { ...spec.example }))).toEqual(spec.example);
    }

    const guidance = formatExternalRunsActionGuidance();
    expect(guidance).toContain("inspect (single run, any view)");
    expect(guidance).toContain("inspect (batch summary, 2-20 runs)");
    expect(guidance).toContain("workflowCursor");
    expect(guidance).toContain("workflowRunId");

    const helpTool = makeTool();
    const agentDir = tempAgentDir();
    await withAgentDir(agentDir, async () => {
      const usageRes = await helpTool.execute("call-usage", { topic: "usage" }, undefined, undefined, fakeCtx(agentDir));
      expect((usageRes.content[0] as { text: string }).text).toContain(JSON.stringify(USAGE_ONE_AGENT, null, 2));
      expect((usageRes.content[0] as { text: string }).text).not.toContain(guidance);
      const workflowRes = await helpTool.execute("call-wf", { topic: "workflow" }, undefined, undefined, fakeCtx(agentDir));
      expect((workflowRes.content[0] as { text: string }).text).toContain(guidance);
    });

    const script = usageWorkflowScript();
    const workflowTool = { name: "external_workflow", parameters: workflowToolParameters } as any;
    expect(validateToolArguments(workflowTool, toolCall("external_workflow", { script })).script).toBe(script);
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
        expect(profile.name).toBe(`${example.harness}/${example.role}`);
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

describe("external_help contracts discovery and workflow helpers", () => {
  it("keeps the contracts index bounded (<=1.5 KiB for both content and serialized data) and reflects workflowEnabled without probes or writes", async () => {
    const agentDir = tempAgentDir();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new Error("external_help must not call fetch");
    });
    const originalPath = process.env.PATH;
    process.env.PATH = "";
    try {
      await withAgentDir(agentDir, async () => {
        for (const workflowEnabled of [true, false]) {
          const tool = makeTool(() => "agy", workflowEnabled);
          const result = await tool.execute(
            `contracts-index-${workflowEnabled}`,
            { topic: "contracts", tool: "  ", harness: "  " },
            undefined,
            undefined,
            fakeCtx(agentDir),
          );
          expect(result.isError).toBe(false);
          expect(result.details).toEqual({ topic: "contracts" });
          expect(Value.Check(externalHelpOutputSchema, result.structuredContent)).toBe(true);
          const text = (result.content[0] as { text: string }).text;
          const data = (result.structuredContent as any).data;
          expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(CONTRACT_INDEX_MAX_BYTES);
          expect(Buffer.byteLength(JSON.stringify(data), "utf8")).toBeLessThanOrEqual(CONTRACT_INDEX_MAX_BYTES);
          expect(data.index.tools.map((entry: any) => entry.name)).toEqual([...PUBLIC_TOOL_NAMES]);
          const wfEntry = data.index.tools.find((entry: any) => entry.name === "external_workflow");
          expect(wfEntry.registered).toBe(workflowEnabled);
          expect(text).toContain(workflowEnabled ? "external_workflow [run] (registered)" : "external_workflow [run] (disabled)");
          expect(text).toContain("describeTool");
        }
        expect(readdirSync(agentDir)).toEqual([]);
      });
    } finally {
      process.env.PATH = originalPath;
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns exact executable input/output schemas and validated examples for every public tool, and selection_invalid for unknown tools", async () => {
    const agentDir = tempAgentDir();
    const expectedSchemas = {
      external_delegate: { input: agentToolParameters, output: agentOutputSchema },
      external_workflow: { input: workflowToolParameters, output: workflowOutputSchema },
      external_runs: { input: externalRunsParameters, output: externalRunsOutputSchema },
      external_help: { input: externalHelpParameters, output: externalHelpOutputSchema },
    } as const;
    await withAgentDir(agentDir, async () => {
      const helpTool = makeTool(() => "agy", false);
      for (const toolName of PUBLIC_TOOL_NAMES) {
        const spec = PUBLIC_TOOLS[toolName];
        expect(spec.input).toBe(expectedSchemas[toolName].input);
        expect(spec.output).toBe(expectedSchemas[toolName].output);

        const result = await helpTool.execute(
          `contract-${toolName}`,
          { topic: "contracts", tool: toolName },
          undefined,
          undefined,
          fakeCtx(agentDir),
        );
        expect(result.isError).toBe(false);
        expect(result.details).toEqual({ topic: "contracts", tool: toolName });
        expect(Value.Check(externalHelpOutputSchema, result.structuredContent)).toBe(true);
        const contract = (result.structuredContent as any).data.contract;
        expect(contract.tool).toBe(toolName);
        expect(contract.registered).toBe(toolName !== "external_workflow");
        expect(contract.input).toEqual(JSON.parse(JSON.stringify(expectedSchemas[toolName].input)));
        expect(contract.output).toEqual(JSON.parse(JSON.stringify(expectedSchemas[toolName].output)));
        expect(contract.examples.length).toBeGreaterThan(0);

        const toolDef = { name: toolName, parameters: expectedSchemas[toolName].input } as any;
        for (const example of contract.examples) {
          expect(validateToolArguments(toolDef, toolCall(`${toolName}_${example.label}`, { ...example.input }))).toEqual(
            example.input,
          );
          expect(Value.Check(expectedSchemas[toolName].input, example.input), `${toolName}:${example.label}:input`).toBe(true);
          expect(Value.Check(expectedSchemas[toolName].output, example.output), `${toolName}:${example.label}:output`).toBe(true);
        }

        if (toolName === "external_workflow") {
          expect(contract.helpers).toEqual({
            functions: { ...WORKFLOW_HELPERS.functions },
            globals: [...WORKFLOW_HELPERS.globals],
            agentOptions: [...WORKFLOW_HELPERS.agentOptions],
          });
          expect((result.content[0] as { text: string }).text).toContain("disabled for this extension instance");
          expect((result.content[0] as { text: string }).text).toContain(formatWorkflowHelpersLine());
        } else {
          expect(contract.helpers).toBeUndefined();
        }
      }

      for (const badTool of ["unknown_tool", "Agent", "workflow"]) {
        const bad = await helpTool.execute(
          `contract-bad-${badTool}`,
          { topic: "contracts", tool: badTool },
          undefined,
          undefined,
          fakeCtx(agentDir),
        );
        expect(bad.isError).toBe(true);
        expect(bad.structuredContent).toMatchObject({
          contractVersion: 1,
          tool: "external_help",
          action: "help",
          ok: false,
          data: null,
          error: {
            code: "selection_invalid",
            message: expect.stringContaining(`Unknown public tool "${badTool}". Public tools: external_delegate, external_workflow, external_runs, external_help.`),
          },
        });
        expect(Value.Check(externalHelpOutputSchema, bad.structuredContent)).toBe(true);
      }

      // Verify example failure messages match the actual live error messages.
      const catalog = loadExternalCatalog(agentDir);
      const expectedDelegateError = PUBLIC_TOOLS.external_delegate.examples.find(
        (e) => e.label === "typed_prelaunch_failure",
      )?.output.error as { code: string; message: string } | undefined;
      expect(expectedDelegateError?.message).toBeTruthy();
      let actualDelegateError: unknown;
      try {
        resolveExternalProfile(catalog.profiles, { role: "missing_role", harness: "claude" }, "agy");
      } catch (err) {
        actualDelegateError = err;
      }
      expect(actualDelegateError).toMatchObject({
        code: expectedDelegateError!.code,
        message: expectedDelegateError!.message,
      });
      const runsTool = createExternalRunsTool({ registry: new RunRegistry(1), runsDirectory: () => agentDir }) as any;
      const runsUnavailable = await runsTool.execute(
        "runs-unavail",
        { action: "inspect", runIds: ["run_missing"] },
        undefined,
        undefined,
        {
          cwd: agentDir,
          sessionManager: { isPersisted: () => true, getSessionDir: () => agentDir, getSessionId: () => "sess-1" },
        },
      );
      expect(runsUnavailable.structuredContent.error).toEqual(
        PUBLIC_TOOLS.external_runs.examples.find((e) => e.label === "typed_unavailable_failure")?.output.error,
      );
    });
  });

  it("keeps AGENT_OPTION_KEYS and WORKFLOW_HELPERS in two-way conformance with normalizeAgentOptions and script-worker globals", async () => {
    const sampleByOption: Record<(typeof AGENT_OPTION_KEYS)[number], { input: Record<string, unknown>; expected: Record<string, unknown> }> = {
      description: { input: { description: "task-desc" }, expected: { label: "task-desc" } },
      label: { input: { label: "task-label" }, expected: { label: "task-label" } },
      role: { input: { role: "reviewer" }, expected: { role: "reviewer" } },
      harness: { input: { harness: "codex" }, expected: { harness: "codex" } },
      subagent_type: { input: { subagent_type: "codex/reviewer" }, expected: { subagentType: "codex/reviewer" } },
      permission: { input: { permission: "readonly" }, expected: { permission: "readonly" } },
      max_budget_usd: { input: { max_budget_usd: 1.5 }, expected: { maxBudgetUsd: 1.5 } },
      resume: { input: { resume: "run_prev" }, expected: { resumeRunId: "run_prev" } },
      context: { input: { context: { mode: "recent", turns: 2 } }, expected: { context: { mode: "recent", turns: 2 } } },
      schema: { input: { schema: { type: "object" } }, expected: { schema: { type: "object" } } },
      phase: { input: { phase: "Check" }, expected: { phase: "Check" } },
    };
    expect(Object.keys(sampleByOption)).toEqual([...AGENT_OPTION_KEYS]);
    for (const key of AGENT_OPTION_KEYS) {
      const normalized = normalizeAgentOptions({ ...sampleByOption[key].input, unknown_ignored_key: "ignored" });
      expect(normalized, key).toMatchObject(sampleByOption[key].expected);
      expect(normalized).not.toHaveProperty("unknown_ignored_key");
    }

    const ambientBindings = new Set(["process", "console", "JSON", "Math", "Date", "eval", "Function", "Reflect", "globalThis"]);
    const probeScript = [
      'export const meta = { apiVersion: 1, name: "helper-conformance", description: "Verify installed worker helpers" };',
      "const contextKeys = (function () { return Object.keys(this); })();",
      "const echoed = await agent('probe', { role: 'worker', harness: 'claude' });",
      "return {",
      "  contextKeys,",
      "  functions: { agent: typeof agent, parallel: typeof parallel, pipeline: typeof pipeline, phase: typeof phase, log: typeof log },",
      "  globals: { args, cwd },",
      "  echoed,",
      "};",
    ].join("\n");
    const wfResult = await runWorkflow(probeScript, {
      cwd: "/repo/conformance",
      args: { flag: 1 },
      limiter: new ConcurrencyLimiter(1),
      resolveSubagentType: () => "claude/worker",
      runAgent: async () => "ok",
    });
    const payload = wfResult.result as {
      contextKeys: string[];
      functions: Record<string, string>;
      globals: Record<string, unknown>;
      echoed: string;
    };
    const workflowOwnedBindings = payload.contextKeys.filter((key) => !ambientBindings.has(key)).sort();
    const declaredBindings = [...Object.keys(WORKFLOW_HELPERS.functions), ...WORKFLOW_HELPERS.globals].sort();
    expect(workflowOwnedBindings).toEqual(declaredBindings);
    expect(payload.functions).toEqual(
      Object.fromEntries(Object.keys(WORKFLOW_HELPERS.functions).map((name) => [name, "function"])),
    );
    expect(payload.globals).toEqual({ args: { flag: 1 }, cwd: "/repo/conformance" });
    expect(payload.echoed).toBe("ok");
  });

  it("reports harness capabilities for configured, disabled, registered and malformed settings without probing readiness", async () => {
    const agentDir = tempAgentDir();
    mkdirSync(join(agentDir, "pi-flow-external"), { recursive: true });
    const settingsPath = join(agentDir, "pi-flow-external", "settings.json");
    writeFileSync(settingsPath, JSON.stringify({
      version: 5, defaultPermission: "edit", disabledHarnesses: ["grok"],
      harnesses: { "pi-skills": { model: "anthropic/claude-sonnet-4-5", thinking: "high", preset: "skills" } },
    }));
    await withAgentDir(agentDir, async () => {
      const tool = makeTool(() => "claude", true);
      const index = await tool.execute("cap-index", { topic: "capabilities", harness: "   " }, undefined, undefined, { cwd: agentDir, isProjectTrusted: () => true } as never);
      expect(Value.Check(externalHelpOutputSchema, index.structuredContent)).toBe(true);
      const records = (index.structuredContent as any).data.harnesses;
      expect(records.map((h: any) => h.harness)).toEqual(["agy", "claude", "codex", "grok", "muse", "opencode", "pi-skills"]);
      for (const record of records) {
        expect(Value.Check(capabilityRecordSchema, record)).toBe(true);
        expect(record.readiness).toBe("not_probed");
        expect(record.permissions.default).toBe("edit");
      }
      expect(records.find((h: any) => h.harness === "grok").configuration).toEqual({ state: "built_in", enabled: false });
      expect(records.find((h: any) => h.harness === "pi-skills")).toMatchObject({
        boundary: "pi_sdk", configuration: { state: "registered", enabled: true, preset: "skills" }, resources: { skills: "user_and_project" },
      });

      const untrusted = await tool.execute("cap-pi", { topic: "capabilities", harness: "pi-skills" }, undefined, undefined, { cwd: agentDir, isProjectTrusted: () => false } as never);
      expect((untrusted.structuredContent as any).data.harnesses[0].resources.skills).toBe("user");
    });

    writeFileSync(settingsPath, "{ malformed json");
    await withAgentDir(agentDir, async () => {
      const tool = makeTool(() => "claude", true);
      const blocked = await tool.execute("cap-blocked", { topic: "capabilities" }, undefined, undefined, fakeCtx(agentDir));
      const records = (blocked.structuredContent as any).data.harnesses;
      // A malformed file never guesses registered Pi names.
      expect(records.map((r: any) => r.harness)).toEqual(["agy", "claude", "codex", "grok", "muse", "opencode"]);
      expect(records.every((r: any) => r.configuration.state === "invalid" && r.configuration.enabled === false)).toBe(true);
    });
  });
});
