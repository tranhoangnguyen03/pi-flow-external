import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ConcurrencyLimiter } from "../src/core/concurrency.ts";
import { ChildRunError, runWorkflow, type WorkflowAgentCall } from "../src/workflow/runtime.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const skill = root + "skills/pi-flow-orchestration/";
const recipe = (name: string) => readFileSync(skill + "recipes/" + name + ".js", "utf8");
function example(name: string) {
  const code = readFileSync(skill + "patterns/" + name + ".md", "utf8").match(/```js\n([\s\S]*?)\n```/);
  if (!code) throw new Error("Missing runnable example: " + name);
  return code[1]!;
}
function options(args: Record<string, unknown>, runAgent: (call: WorkflowAgentCall) => Promise<unknown>) {
  return { args, cwd: root, limiter: new ConcurrencyLimiter(2),
    resolveSubagentType: ({ role, harness }: { role?: string; harness?: string }) => (harness ?? "codex") + "/" + (role ?? "worker"), runAgent };
}
const record = (id: string) => ({ id, status: "summarized", summary: "Source finding", evidence: ["/work/" + id + ":1"] });

describe("advertised pattern edge cases", () => {
  it.each([
    { name: "missing record", value: { records: [record("A")] } },
    { name: "duplicate ID", value: { records: [record("A"), record("A")] } },
    { name: "unknown ID", value: { records: [record("A"), record("C")] } },
    { name: "extra record", value: { records: [record("A"), record("B"), record("C")] } },
    { name: "invalid status", value: { records: [record("A"), { ...record("B"), status: "probably" }] } },
    { name: "empty summary", value: { records: [record("A"), { ...record("B"), summary: " " }] } },
    { name: "non-array evidence", value: { records: [record("A"), { ...record("B"), evidence: "citation" }] } },
    { name: "blank evidence item", value: { records: [record("A"), { ...record("B"), evidence: [""] }] } },
    { name: "non-object record", value: { records: [record("A"), null] } },
    { name: "missing records array", value: {} },
  ])("rejects map output with $name without dropping input IDs or synthesizing", async ({ value }) => {
    let calls = 0;
    const result = await runWorkflow(recipe("batch-map-reduce"), options({ task: "Summarize",
      items: ["A", "B"].map((id) => ({ id, source: "/work/" + id, estimatedChars: 500 })),
    }, async () => { calls++; return value; }));
    const output = result.result as any;
    expect(calls).toBe(1);
    expect(output.status).toBe("failed");
    expect(output.records.map((item: any) => item.id)).toEqual(["A", "B"]);
    expect(output.records.every((item: any) => item.status === "failed" && item.error.outcome === "invalid_output")).toBe(true);
    expect(output.summary).toBeNull();
    expect(output.reduction.status).toBe("no_material");
  });

  it("counts each summarized source once per theme without Codex's rejected uniqueItems keyword", async () => {
    const guide = readFileSync(skill + "patterns/batch-map-reduce.md", "utf8");
    const fragment = guide.match(/```js\n([\s\S]*?)\n```/)![1]!;
    const records = [
      { status: "summarized", themes: ["BILLING", "BILLING", "LOGIN"] },
      { status: "summarized", themes: ["LOGIN"] },
      { status: "summarized", themes: [] },
      { status: "unreadable", themes: ["SUPPORT"] },
      { status: "failed", themes: ["BILLING"] },
    ];
    const result = await runWorkflow(
      'export const meta = { apiVersion: 1, name: "theme-counts", description: "Check guide adaptation" };\n' +
      fragment + '\nawait agent("Extract themes", { role: "worker", harness: "codex", schema: { type: "object", additionalProperties: false, required: ["themes"], properties: { themes: themeSchema } } });\nreturn countThemes(args.records);',
      options({ records }, async (call) => {
        expect((call.schema as any).properties.themes).toEqual({
          type: "array", items: { type: "string", enum: ["BILLING", "LOGIN", "SUPPORT"] },
        });
        return { themes: [] };
      }),
    );
    expect(result.result).toEqual({ BILLING: 1, LOGIN: 2, SUPPORT: 0 });
  });

  it("returns oversized pipeline evidence intact without launching the dependent stage", async () => {
    const evidence = "source text ".repeat(3000);
    let calls = 0;
    const result = await runWorkflow(example("pipeline"), options({ source: "/work/source.txt" }, async () => { calls++; return evidence; }));
    expect(calls).toBe(1);
    expect(result.result).toEqual({ status: "needs_narrower_handoff", evidence, draft: null });
  });

  it.each(["bug", "feature"])("executes only the selected %s route", async (kind) => {
    const calls: WorkflowAgentCall[] = [];
    const result = await runWorkflow(example("routing"), options({ kind, target: "/work/shop" }, async (call) => { calls.push(call); return "handled " + kind; }));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.label).toBe("Handle " + kind);
    expect(calls[0]!.permission).toBe("readonly");
    expect(result.result).toEqual({ route: kind, result: "handled " + kind });
  });

  it.each([1, 2, 3])("stops bounded repair after exactly %i unsuccessful authorized attempts", async (maxAttempts) => {
    const calls: WorkflowAgentCall[] = [];
    const result = await runWorkflow(recipe("bounded-repair"), options({ task: "Fix parser", checks: "Run tests", approved: true, harness: "codex", maxAttempts }, async (call) => {
      calls.push(call);
      return call.label.startsWith("Repair") ? "changed" : { passed: false, evidence: "check still fails" };
    }));
    const output = result.result as any;
    expect(calls).toHaveLength(2 * maxAttempts);
    expect(output.passed).toBe(false);
    expect(output.reason).toBe("Authorized attempts exhausted");
    expect(output.attempts).toHaveLength(maxAttempts);
    expect(output.attempts.every((attempt: any) => attempt.valid && attempt.check.passed === false)).toBe(true);
  });

  it("stops a repair on an execution failure rather than interpreting the attempt budget as retry authority", async () => {
    let calls = 0;
    await expect(runWorkflow(recipe("bounded-repair"), options({ task: "Fix parser", checks: "Run tests", approved: true, maxAttempts: 3 }, async () => {
      calls++; throw new ChildRunError({ runId: "run_failed", outcome: "failed", message: "backend unavailable" });
    }))).rejects.toThrow();
    expect(calls).toBe(1);
  });
});
