// Shipped orchestration recipes and guide examples are adaptable samples, not
// product code. Each gets one run that proves it executes and keeps the
// guidance's central promise: failed or missing work stays visible and nothing
// is auto-accepted. Exhaustive input-validation cases are deliberately absent.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ConcurrencyLimiter } from "../src/core/concurrency.ts";
import { buildCoordinatorPrompt, formatUsagePlaybook, usageWorkflowScript } from "../src/prompts.ts";
import { ChildRunError, parseWorkflowScript, runWorkflow, type WorkflowAgentCall } from "../src/workflow/runtime.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const skill = resolve(root, "skills/pi-flow-orchestration");
const recipe = (name: string) => readFileSync(resolve(skill, "recipes", name + ".js"), "utf8");
const guideScripts = (name: string) =>
  [...readFileSync(resolve(skill, "patterns", name + ".md"), "utf8").matchAll(/```js\n([\s\S]*?)\n```/g)].map((m) => m[1]!);
const guide = (name: string) => guideScripts(name)[0]!;
const failed = () => new ChildRunError({ runId: "run_test_failure", outcome: "failed", message: "fixture unavailable" });

function run(script: string, args: Record<string, unknown>, runAgent: (call: WorkflowAgentCall) => Promise<unknown>, limit = 4) {
  return runWorkflow(script, {
    args, cwd: root, limiter: new ConcurrencyLimiter(limit),
    resolveSubagentType: ({ role, harness }) => (harness ?? "codex") + "/" + (role ?? "worker"),
    runAgent,
  });
}

describe("orchestration skill package", () => {
  it("packages the skill, resolves every local link, and parses every recipe and complete guide example", () => {
    const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
    expect(pkg.pi.skills).toContain("./skills/pi-flow-orchestration");
    expect(pkg.files).toContain("skills");
    const docs = [resolve(root, "docs/orchestration-playbook.md")];
    for (const dir of [skill, resolve(skill, "patterns"), resolve(skill, "references")]) {
      docs.push(...readdirSync(dir).filter((n) => n.endsWith(".md")).map((n) => resolve(dir, n)));
    }
    for (const file of docs) {
      for (const match of readFileSync(file, "utf8").matchAll(/\]\(([^)]+)\)/g)) {
        const link = match[1]!.split("#")[0]!;
        if (link && !/^(https?:|mailto:)/.test(link)) expect(existsSync(resolve(dirname(file), link)), `${file}: ${link}`).toBe(true);
      }
    }
    for (const name of readdirSync(resolve(skill, "recipes"))) {
      expect(parseWorkflowScript(recipe(name.replace(/\.js$/, ""))).meta.apiVersion, name).toBe(1);
    }
    for (const name of readdirSync(resolve(skill, "patterns"))) {
      for (const script of guideScripts(name.replace(/\.md$/, "")).filter((s) => s.startsWith("export const meta"))) {
        expect(parseWorkflowScript(script).meta.apiVersion, name).toBe(1);
      }
    }
  });

  it("keeps ambient guidance within its deliberate size budget", () => {
    expect(buildCoordinatorPrompt(new Map(), "codex", ["codex"]).length).toBeLessThan(3200);
    const usage = formatUsagePlaybook();
    expect(usage).toContain(usageWorkflowScript());
    expect(usage.length).toBeLessThan(4500);
    expect(readFileSync(resolve(skill, "SKILL.md"), "utf8").length).toBeLessThan(5000);
  });
});

describe("recipes", () => {
  it("parallel-sweep reports a failed scope instead of claiming it was checked", async () => {
    const calls: WorkflowAgentCall[] = [];
    const result = await run(recipe("parallel-sweep"), { task: "Audit auth", scopes: ["routes", "middleware", "tokens"] }, async (call) => {
      calls.push(call);
      if (call.prompt.includes("middleware")) throw failed();
      return "evidence";
    });
    expect(calls.every((call) => call.permission === "readonly")).toBe(true);
    expect(result.result).toMatchObject({ coveredScopes: ["routes", "tokens"], failedScopes: ["middleware"] });
  });

  it("branch-and-converge tells the synthesizer about a failed branch and never claims full coverage", async () => {
    const calls: WorkflowAgentCall[] = [];
    const result = await run(recipe("branch-and-converge"), { task: "Analyze", scopes: ["cost", "risk"] }, async (call) => {
      calls.push(call);
      if (call.label === "Research risk") throw failed();
      return call.label === "Converge evidence" ? "partial verdict" : "cost evidence";
    });
    expect(calls.at(-1)!.prompt).toContain("UNTRUSTED DATA");
    expect(calls.at(-1)!.prompt).toContain('"scope":"risk"');
    expect(result.result).toMatchObject({ coverageComplete: false, acceptedByParent: false, missing: [{ scope: "risk", outcome: "failed" }] });
  });

  it("adversarial-review hands the draft to a read-only critic as untrusted data", async () => {
    const calls: WorkflowAgentCall[] = [];
    const result = await run(recipe("adversarial-review"), { task: "Review plan" }, async (call) => {
      calls.push(call);
      return call.label === "Produce draft" ? "Risk is low" : "Needs checks";
    });
    expect(calls[1]!.prompt).toContain("Do not trust the draft");
    expect(calls[1]!.permission).toBe("readonly");
    expect((result.result as any).acceptedByParent).toBe(false);
  });

  it("independent-review keeps reviewers isolated and retains a failed assessment as missing coverage", async () => {
    const calls: WorkflowAgentCall[] = [];
    const result = await run(recipe("independent-review"), { target: "/work/design.md", questions: ["clarity", "fit", "risk"] }, async (call) => {
      calls.push(call);
      if (call.label === "Review 2") throw failed();
      return "verdict-" + call.label;
    });
    expect(calls.some((call) => call.prompt.includes("verdict-"))).toBe(false);
    expect(calls.every((call) => !call.context && call.permission === "readonly")).toBe(true);
    expect(result.result).toMatchObject({ status: "partial", acceptedByParent: false });
    expect((result.result as any).missing).toHaveLength(1);
  });

  it("bounded-repair needs prior authorization, stops on a QA pass, and stops when attempts run out", async () => {
    const calls: WorkflowAgentCall[] = [];
    await expect(run(recipe("bounded-repair"), { task: "Fix", checks: "Run tests", maxAttempts: 2 }, async (call) => { calls.push(call); return ""; }))
      .rejects.toThrow(/authorization/);
    expect(calls).toHaveLength(0);

    let checks = 0;
    const passed = await run(recipe("bounded-repair"), { task: "Fix", checks: "Run tests", approved: true, maxAttempts: 3 }, async (call) => {
      calls.push(call);
      if (call.label.startsWith("Repair")) return "patched";
      return ++checks === 1 ? { passed: false, evidence: "test A fails" } : { passed: true, evidence: "pass" };
    });
    expect(calls.map((call) => call.permission)).toEqual(["edit", "readonly", "edit", "readonly"]);
    expect(calls[2]!.prompt).toContain("test A fails");
    expect(passed.result).toMatchObject({ passed: true, acceptedByParent: false });

    const exhausted = await run(recipe("bounded-repair"), { task: "Fix", checks: "Run tests", approved: true, maxAttempts: 2 }, async (call) =>
      call.label.startsWith("Repair") ? "changed" : { passed: false, evidence: "still fails" });
    expect(exhausted.agentCount).toBe(4);
    expect(exhausted.result).toMatchObject({ passed: false, reason: "Authorized attempts exhausted" });
  });

  it("batch-map-reduce bounds concurrency, keeps every input ID, and reduces only available material", async () => {
    const items = Array.from({ length: 6 }, (_, i) => ({ id: "T" + i, source: "/work/T" + i, estimatedChars: 200 }));
    const manifest = (call: WorkflowAgentCall) => JSON.parse(call.prompt.split("\nSOURCE_MANIFEST\n")[1]!) as typeof items;
    let active = 0, peak = 0;
    const reducerInputs: string[] = [];
    const result = await run(recipe("batch-map-reduce"), { task: "Summarize", items, batchItems: 1, concurrency: 2, reduceFanIn: 3 }, async (call) => {
      active++; peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 1));
      active--;
      if (call.label.startsWith("Reduce")) { reducerInputs.push(call.prompt); return "Combined"; }
      const id = manifest(call)[0]!.id;
      if (id === "T0") throw failed();
      if (id === "T1") return { records: [{ id: "invented", status: "summarized", summary: "bad", evidence: [] }] };
      return { records: [{ id, status: "summarized", summary: "Finding " + id, evidence: ["/work/" + id + ":1"] }] };
    });
    const value = result.result as any;
    expect(peak).toBeLessThanOrEqual(2);
    expect(value.records.map((r: any) => r.id)).toEqual(items.map((i) => i.id));
    expect(value.coverage).toMatchObject({ total: 6, summarized: 4, failed: 2 });
    expect(value.status).toBe("partial");
    expect(value.summary).toBe("Combined");
    const reducedIds = reducerInputs.flatMap((prompt) => JSON.parse(prompt.split("\nEVIDENCE\n")[1]!).flatMap((unit: any) => unit.ids));
    expect([...new Set(reducedIds)].sort()).toEqual(["T2", "T3", "T4", "T5"]);
  });
});

describe("guide examples", () => {
  it("pipeline passes real evidence forward and does not draft after a failed extraction", async () => {
    const calls: WorkflowAgentCall[] = [];
    await run(guide("pipeline"), { source: "/work/T1.txt" }, async (call) => { calls.push(call); return calls.length === 1 ? "evidence-42" : "draft"; });
    expect(calls[1]!.prompt).toContain("evidence-42");
    let attempts = 0;
    await expect(run(guide("pipeline"), { source: "/work/T1.txt" }, async () => { attempts++; throw failed(); })).rejects.toThrow();
    expect(attempts).toBe(1);
  });

  it("routing runs only the selected route and rejects unknown kinds before launch", async () => {
    const calls: WorkflowAgentCall[] = [];
    expect((await run(guide("routing"), { kind: "bug", target: "/work/shop" }, async (call) => { calls.push(call); return "causes"; })).result)
      .toMatchObject({ route: "bug" });
    await expect(run(guide("routing"), { kind: "__proto__", target: "/work/shop" }, async (call) => { calls.push(call); return ""; })).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });

  it("discover-and-delegate investigates each discovered scope and keeps a failed one as missing", async () => {
    const calls: WorkflowAgentCall[] = [];
    const result = await run(guide("discover-and-delegate"), { task: "Find risks", target: "/work/shop" }, async (call) => {
      calls.push(call);
      if (call.label === "Discover scopes") return { reason: "Two parts", tasks: [{ id: "A", question: "Check A" }, { id: "B", question: "Check B" }] };
      if (call.label === "Investigate B") throw failed();
      return "A evidence";
    });
    expect(calls).toHaveLength(3);
    expect(calls[1]!.prompt).toContain("Check A");
    expect((result.result as any).missing).toEqual(["B"]);
    expect(calls.every((call) => call.permission === "readonly")).toBe(true);
  });
});
