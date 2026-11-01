import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ConcurrencyLimiter } from "../src/core/concurrency.ts";
import { ORCHESTRATOR_MODE_PROMPT, formatUsagePlaybook, usageWorkflowScript } from "../src/prompts.ts";
import {
  ChildRunError,
  parseWorkflowScript,
  runWorkflow,
  type WorkflowAgentCall,
} from "../src/workflow/runtime.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const skill = "skills/pi-flow-orchestration/";

function recipe(name: string): string {
  return readFileSync(root + skill + "recipes/" + name + ".js", "utf8");
}

function opts(args: Record<string, unknown>, runAgent: (call: WorkflowAgentCall) => Promise<unknown>) {
  return {
    args,
    cwd: root,
    limiter: new ConcurrencyLimiter(4),
    resolveSubagentType: ({ role, harness }: { role?: string; harness?: string }) =>
      (harness ?? "codex") + "/" + (role ?? "worker"),
    runAgent,
  };
}

describe("installed orchestration skill", () => {
  it("ships a native Pi skill with its recipes and tests them against the executable parser", () => {
    const pkg = JSON.parse(readFileSync(root + "package.json", "utf8"));
    expect(pkg.pi.skills).toContain("./skills/pi-flow-orchestration");
    expect(pkg.files).toContain("skills");
    const markdown = readFileSync(root + skill + "SKILL.md", "utf8");
    expect(markdown).toMatch(/^---\nname: pi-flow-orchestration\n/);
    for (const name of ["parallel-sweep", "branch-and-converge", "adversarial-review", "bounded-repair"]) {
      const script = recipe(name);
      const parsed = parseWorkflowScript(script);
      expect(parsed.meta.apiVersion).toBe(1);
      expect(parsed.meta.name).toBe(name);
      expect(parsed.meta.phases?.length).toBeGreaterThan(0);
      expect(parsed.body).toContain("agent(");
    }
  });
});


describe("agent-first help contracts", () => {
  it("keeps the opt-in orchestration nudge compact", () => {
    expect(ORCHESTRATOR_MODE_PROMPT.length).toBeLessThan(1000);
  });

  it("provides runnable workflow examples without forcing a long usage manual", () => {
    const usage = formatUsagePlaybook();
    expect(usage).toContain(usageWorkflowScript());
    expect(parseWorkflowScript(usageWorkflowScript()).meta.apiVersion).toBe(1);
    expect(usage.length).toBeLessThan(4500);
  });

  it("links to actual bundled recipe files rather than inventing saved workflow names", () => {
    const sourceFiles = [
      root + skill + "SKILL.md",
      root + skill + "references/pattern-selection.md",
      root + "docs/orchestration-playbook.md",
    ];
    for (const file of sourceFiles) {
      const markdown = readFileSync(file, "utf8");
      const referencedRecipes = [...markdown.matchAll(/\]\(([^)]+\.js)\)/g)].map(match => match[1]!);
      expect(referencedRecipes.length).toBeGreaterThan(0);
      for (const reference of referencedRecipes) {
        const resolved = resolve(dirname(file), reference);
        expect(existsSync(resolved), `${file} references missing ${reference}`).toBe(true);
      }
    }
  });
});

describe("orchestration recipe outcomes", () => {
  it("covers independent scopes and preserves a failed branch without claiming it was checked", async () => {
    const calls: WorkflowAgentCall[] = [];
    const result = await runWorkflow(recipe("parallel-sweep"), opts(
      { task: "Audit auth checks", scopes: ["routes", "middleware", "tokens"] },
      async (call) => {
        calls.push(call);
        if (call.prompt.includes("middleware")) {
          throw new ChildRunError({ runId: "run_failed", outcome: "failed", message: "Test child failure" });
        }
        return "evidence: " + call.label;
      },
    ));
    expect(result.agentCount).toBe(3);
    expect(calls).toHaveLength(3);
    expect(calls.every((call) => call.permission === "readonly")).toBe(true);
    expect(result.result).toMatchObject({ coveredScopes: ["routes", "tokens"], failedScopes: ["middleware"] });
    expect((result.result as any).results[1]).toMatchObject({ ok: false, outcome: "failed" });
  });

  it("converges after all branches and explicitly sends bounded, untrusted evidence", async () => {
    const calls: WorkflowAgentCall[] = [];
    const result = await runWorkflow(recipe("branch-and-converge"), opts(
      { task: "Investigate policy", scopes: ["internal", "external"], maxEvidenceChars: 1000 },
      async (call) => {
        calls.push(call);
        if (call.label === "Converge evidence") return "compared claims";
        return "evidence:" + "x".repeat(1600);
      },
    ));
    expect(result.agentCount).toBe(3);
    expect(calls[2].label).toBe("Converge evidence");
    expect(calls[2].prompt).toContain("UNTRUSTED DATA");
    expect(calls[2].prompt).toContain("omittedChars");
    expect((result.result as any).synthesis).toBe("compared claims");
    expect((result.result as any).coverageComplete).toBe(false);
    expect((result.result as any).acceptedByParent).toBe(false);
    expect((result.result as any).truncatedScopes).toEqual(["internal", "external"]);
    expect(calls.every((call) => call.permission === "readonly")).toBe(true);
  });

  it("tells the synthesizer about failed branches and does not claim full coverage", async () => {
    const result = await runWorkflow(recipe("branch-and-converge"), opts(
      { task: "Analyze options", scopes: ["cost", "risk"] },
      async (call) => {
        if (call.label === "Research risk") {
          throw new ChildRunError({ runId: "run_unavailable", outcome: "failed", message: "not available" });
        }
        if (call.label === "Converge evidence") {
          expect(call.prompt).toContain('"scope":"risk"');
          return "partial verdict";
        }
        return "cost evidence";
      },
    ));
    expect((result.result as any).coverageComplete).toBe(false);
    expect((result.result as any).acceptedByParent).toBe(false);
    expect((result.result as any).missing).toEqual([{ scope: "risk", outcome: "failed" }]);
  });

  it("gives an independent reviewer the draft as untrusted data without accepting it automatically", async () => {
    const calls: WorkflowAgentCall[] = [];
    const result = await runWorkflow(recipe("adversarial-review"), opts(
      { task: "Review migration plan" },
      async (call) => {
        calls.push(call);
        return call.label === "Produce draft" ? "Risk is low" : "Risk needs more checks";
      },
    ));
    expect(calls.map((call) => call.label)).toEqual(["Produce draft", "Independent critique"]);
    expect(calls[1].prompt).toContain("Do not trust the draft");
    expect(calls[1].prompt).toContain("Risk is low");
    expect((result.result as any).acceptedByParent).toBe(false);
    expect(calls[1].permission).toBe("readonly");
  });

  it.each(["opencode", "claude", "muse", "grok", "agy", "pi-test", "", null])(
    "rejects repair harness %j before starting an editor",
    async (harness) => {
      const calls: WorkflowAgentCall[] = [];
      await expect(runWorkflow(recipe("bounded-repair"), opts(
        { task: "Fix parser", checks: "Run tests", approved: true, maxAttempts: 2, harness },
        async (call) => { calls.push(call); return "unexpected edit"; },
      ))).rejects.toThrow(/requires.*codex/i);
      expect(calls).toHaveLength(0);
    },
  );

  it.each([undefined, "codex"])("allows bounded repair with harness %j only until structured QA reports a pass", async (harness) => {
    const calls: WorkflowAgentCall[] = [];
    let checked = 0;
    const result = await runWorkflow(recipe("bounded-repair"), opts(
      { task: "Fix a parser", checks: "Run parser tests", approved: true, maxAttempts: 3, harness },
      async (call) => {
        calls.push(call);
        if (call.label.startsWith("Repair")) return "patched parser";
        checked++;
        return checked === 1 ? { passed: false, evidence: "test A fails" } :
          { passed: true, evidence: "test A and B pass" };
      },
    ));
    expect(result.agentCount).toBe(4);
    expect(calls.map((call) => call.permission)).toEqual(["edit", "readonly", "edit", "readonly"]);
    expect(calls.map((call) => call.subagentType)).toEqual([
      "codex/implementer", "codex/qa", "codex/implementer", "codex/qa",
    ]);
    expect(calls[2].prompt).toContain("test A fails");
    expect(calls[1].prompt).toContain("exit codes");
    expect((result.result as any).passed).toBe(true);
    expect((result.result as any).acceptedByParent).toBe(false);
    expect((result.result as any).attempts).toHaveLength(2);
  });

  it("fails closed on malformed QA output and never starts another edit", async () => {
    const result = await runWorkflow(recipe("bounded-repair"), opts(
      { task: "Fix parser", checks: "Run tests", approved: true, maxAttempts: 3 },
      async (call) => call.label.startsWith("Repair") ? "changed" : "PASS", // no schema-valid verdict
    ));
    expect(result.agentCount).toBe(2);
    expect((result.result as any).passed).toBe(false);
    expect((result.result as any).reason).toMatch(/invalid/);
  });

  it("rejects an edit loop without prior authorization and starts no children", async () => {
    const calls: WorkflowAgentCall[] = [];
    await expect(runWorkflow(recipe("bounded-repair"), opts(
      { task: "Fix parser", checks: "Run tests", maxAttempts: 2 },
      async (call) => { calls.push(call); return "unexpected"; },
    ))).rejects.toThrow(/authorization/);
    expect(calls).toHaveLength(0);
  });
});
