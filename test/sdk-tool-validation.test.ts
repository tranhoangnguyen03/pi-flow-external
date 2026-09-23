import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createRunRecord } from "../src/core/run-record.ts";
import { RunRegistry } from "../src/core/run-registry.ts";
import { prepareParentContext } from "../src/core/parent-context.ts";
import { createExternalRunsTool } from "../src/external-runs.ts";
import { createExternalHelpTool } from "../src/external-help.ts";
import { prepareWorkflowToolSource, workflowToolParameters } from "../src/workflow/source.ts";

describe("SDK tool validation and downstream placeholder compatibility (#62)", () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  function setupRuns() {
    const runsDirectory = mkdtempSync(join(tmpdir(), "sdk-val-runs-"));
    directories.push(runsDirectory);
    const registry = new RunRegistry(100);
    const tool = createExternalRunsTool({ registry, runsDirectory: () => runsDirectory }) as any;
    const ctx = {
      cwd: "/project",
      sessionManager: { isPersisted: () => true, getSessionDir: () => runsDirectory, getSessionId: () => "session-sdk" },
    } as any;
    return { tool, registry, runsDirectory, ctx };
  }

  async function completedRecord(runsDirectory: string) {
    const record = createRunRecord({
      directory: runsDirectory,
      metadata: { parentSessionId: "session-sdk", project: "/project", description: "SDK task" },
    });
    await record.event("backend_event", {
      backend: "codex",
      event: { type: "item.completed", item: { type: "agent_message", text: "sdk-output-text" } },
    });
    await record.finish({ status: "done", result: "sdk-output-text" });
    return record;
  }

  describe("external_runs", () => {
    it("validates empty runIds placeholder [] via validateToolArguments (minItems: 1 removed)", () => {
      const { tool } = setupRuns();
      const toolCall = {
        type: "toolCall" as const,
        id: "call-1",
        name: "external_runs",
        arguments: { action: "list", runIds: [] },
      };
      const validated = validateToolArguments(tool, toolCall);
      expect(validated).toEqual({ action: "list", runIds: [] });
    });

    it("validates and executes inspect with single-target runIds using output view", async () => {
      const { tool, runsDirectory, ctx } = setupRuns();
      const owned = await completedRecord(runsDirectory);

      const toolCall = {
        type: "toolCall" as const,
        id: "call-inspect",
        name: "external_runs",
        arguments: { action: "inspect", runIds: [owned.runId], view: "output" },
      };
      const validated = validateToolArguments(tool, toolCall);
      const res = await tool.execute("call-inspect", validated, undefined, undefined, ctx);
      expect(res.content[0].text).toBe("sdk-output-text");
      expect(res.details).toMatchObject({ runId: owned.runId, view: "output" });
    });

    it("validates and executes cancel with single-target runIds", async () => {
      const { tool, runsDirectory, ctx } = setupRuns();
      const owned = await completedRecord(runsDirectory);

      const toolCall = {
        type: "toolCall" as const,
        id: "call-cancel",
        name: "external_runs",
        arguments: { action: "cancel", runIds: [owned.runId] },
      };
      const validated = validateToolArguments(tool, toolCall);
      const res = await tool.execute("call-cancel", validated, undefined, undefined, ctx);
      expect(res.details).toMatchObject({ runId: owned.runId, status: "terminal" });
    });

    it("fails validation via validateToolArguments for invalid action", () => {
      const { tool } = setupRuns();
      const toolCall = {
        type: "toolCall" as const,
        id: "call-invalid",
        name: "external_runs",
        arguments: { action: "unsupported_action" },
      };
      expect(() => validateToolArguments(tool, toolCall)).toThrow(/Validation failed for tool "external_runs"/);
    });
  });

  describe("external_help", () => {
    function setupHelp() {
      const tool = createExternalHelpTool({ getDefaultHarness: () => "agy", workflowEnabled: true }) as any;
      const ctx = { cwd: "/project", isProjectTrusted: () => true } as any;
      return { tool, ctx };
    }

    it("validates empty harness placeholder \"\" via validateToolArguments (minLength: 1 removed)", async () => {
      const { tool, ctx } = setupHelp();
      const toolCall = {
        type: "toolCall" as const,
        id: "call-help-empty",
        name: "external_help",
        arguments: { topic: "workflow", harness: "" },
      };
      const validated = validateToolArguments(tool, toolCall);
      expect(validated).toEqual({ topic: "workflow", harness: "" });

      const res = await tool.execute("call-help-empty", validated, undefined, undefined, ctx);
      expect(res.content[0].text).toContain("The workflow tool is enabled");
      expect(res.details).toEqual({ topic: "workflow" });
    });

    it("validates and executes workflow help when harness is provided without throwing", async () => {
      const { tool, ctx } = setupHelp();
      const toolCall = {
        type: "toolCall" as const,
        id: "call-help-claude",
        name: "external_help",
        arguments: { topic: "workflow", harness: "claude" },
      };
      const validated = validateToolArguments(tool, toolCall);
      const res = await tool.execute("call-help-claude", validated, undefined, undefined, ctx);
      expect(res.content[0].text).toContain("The workflow tool is enabled");
      expect(res.content[0].text).toContain('Workflows orchestrate across multiple harnesses (including "claude")');
      expect(res.details).toEqual({ topic: "workflow", harness: "claude" });
    });

    it("fails validation for invalid topic", () => {
      const { tool } = setupHelp();
      const toolCall = {
        type: "toolCall" as const,
        id: "call-invalid-topic",
        name: "external_help",
        arguments: { topic: "not_a_topic" },
      };
      expect(() => validateToolArguments(tool, toolCall)).toThrow(/Validation failed for tool "external_help"/);
    });
  });

  describe("workflow tool source selectors", () => {
    it("validates and resolves inline script when empty string placeholders are provided", async () => {
      const dummyTool = {
        name: "workflow",
        parameters: workflowToolParameters,
      } as any;
      const toolCall = {
        type: "toolCall" as const,
        id: "call-wf",
        name: "workflow",
        arguments: {
          script: "export const meta = { apiVersion: 1, name: 'sdk_test', description: 'Testing SDK' }; return await agent('hi');",
          name: "",
          scriptPath: "",
          resumeFromRunId: "",
        },
      };
      const validated = validateToolArguments(dummyTool, toolCall);
      expect(validated.name).toBe("");
      expect(validated.scriptPath).toBe("");

      const ctx = {
        cwd: "/project",
        isProjectTrusted: () => true,
        sessionManager: { isPersisted: () => false },
      } as any;
      const prepared = await prepareWorkflowToolSource(validated, ctx);
      expect(prepared.ok).toBe(true);
      if (prepared.ok) {
        expect(prepared.value.metaName).toBe("sdk_test");
        expect(prepared.value.source).toBe("inline");
      }
    });

    it("preserves genuine conflict between multiple non-empty sources", async () => {
      const ctx = {
        cwd: "/project",
        isProjectTrusted: () => true,
        sessionManager: { isPersisted: () => false },
      } as any;
      const prepared = await prepareWorkflowToolSource(
        {
          script: "export const meta = { apiVersion: 1, name: 'a', description: 'b' };",
          name: "saved_wf",
        },
        ctx,
      );
      expect(prepared.ok).toBe(false);
      if (!prepared.ok) {
        expect(prepared.text).toContain("Workflow requires exactly one non-empty source");
      }
    });

    it("preserves genuine conflict when resumeFromRunId is used with inline script", async () => {
      const ctx = {
        cwd: "/project",
        isProjectTrusted: () => true,
        sessionManager: { isPersisted: () => false },
      } as any;
      const prepared = await prepareWorkflowToolSource(
        {
          script: "export const meta = { apiVersion: 1, name: 'a', description: 'b' };",
          resumeFromRunId: "wf_12345",
        },
        ctx,
      );
      expect(prepared.ok).toBe(false);
      if (!prepared.ok) {
        expect(prepared.text).toContain("resumeFromRunId can only be used with scriptPath");
      }
    });
  });

  describe("Agent selector placeholder tolerance", () => {
    it("tolerates blank resume placeholder without falsely conflicting with parent context", () => {
      const messages = [{ role: "user" as const, content: "Parent message", timestamp: 0 }];
      const dummyBriefing = prepareParentContext(
        "subagent prompt",
        { mode: "full" },
        messages,
        "call-agent-1",
        "", // blank resume placeholder
      );
      expect(dummyBriefing.prompt).toContain("Parent message");
    });

    it("preserves genuine conflict when non-empty resume is passed with active context", () => {
      const messages = [{ role: "user" as const, content: "Parent message", timestamp: 0 }];
      expect(() =>
        prepareParentContext(
          "subagent prompt",
          { mode: "full" },
          messages,
          "call-agent-2",
          "run_prior_session",
        ),
      ).toThrow(/context sharing cannot be combined with resume/);
    });
  });
});
