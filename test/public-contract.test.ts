import { ExpectedFlowError } from "../src/core/errors.ts";
import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { agentOutputSchema, agentReceipt } from "../src/public-contract.ts";
import { RunRegistry } from "../src/core/run-registry.ts";

describe("Agent public receipt", () => {
  it.each([false, null, 0, ""])("preserves complete canonical value %j", async (value) => {
    const registry = new RunRegistry();
    const handle = registry.start({ runId: "run_test", kind: "agent", sessionId: "test", project: "/tmp", run: () => value });
    await handle.result;
    const receipt = agentReceipt({ entry: registry.get("run_test"), integrity: "unknown" });
    expect(Value.Check(agentOutputSchema, receipt)).toBe(true);
    expect(receipt.data.run?.output).toMatchObject({ delivery: "inline", value });
    expect(receipt.data.run?.live).toBe(false);
  });

  it("has no fabricated run for pre-registration failures", () => {
    const receipt = agentReceipt({ error: new ExpectedFlowError("selection_invalid", "Unknown role") });
    expect(receipt).toMatchObject({ ok: false, data: { run: null }, error: { code: "selection_invalid" } });
    expect(Value.Check(agentOutputSchema, receipt)).toBe(true);
    expect(Value.Check(agentOutputSchema, { ...receipt, error: undefined })).toBe(false);
  });

  it("omits unresolvable references and redacts canonical data", async () => {
    const registry = new RunRegistry();
    await registry.start({ runId: "run_redacted", kind: "agent", sessionId: "test", project: "/tmp", run: () => ({ apiKey: "private", text: "Bearer abc123" }) }).result;
    const receipt = agentReceipt({ entry: registry.get("run_redacted"), inspectable: false });
    expect(receipt.warnings).toContain("output_redacted");
    expect(receipt.data.run).not.toHaveProperty("refs");
    expect(JSON.stringify(receipt)).not.toContain("private");
    expect(JSON.stringify(receipt)).not.toContain("abc123");
    expect(Value.Check(agentOutputSchema, receipt)).toBe(true);
  });

  it.each([16384, 16385])("enforces the exact JSON byte boundary at %i", async bytes => {
    const registry = new RunRegistry();
    await registry.start({ runId: "run_boundary", kind: "agent", sessionId: "test", project: "/tmp", run: () => "x".repeat(bytes - 2) }).result;
    expect(agentReceipt({ entry: registry.get("run_boundary") }).data.run?.output.delivery).toBe(bytes === 16384 ? "inline" : "reference");
  });

  it("delivers large canonical values by reference, never a truncated value", async () => {
    const registry = new RunRegistry();
    await registry.start({ runId: "run_large", kind: "agent", sessionId: "test", project: "/tmp", run: () => "界".repeat(6000) }).result;
    const receipt = agentReceipt({ entry: registry.get("run_large"), integrity: "damaged" });
    expect(receipt.data.run?.output.delivery).toBe("reference");
    expect(receipt.data.run?.output).not.toHaveProperty("value");
    expect(receipt.data.run?.evidence.integrity).toBe("damaged");
    expect(Value.Check(agentOutputSchema, receipt)).toBe(true);
  });
});
