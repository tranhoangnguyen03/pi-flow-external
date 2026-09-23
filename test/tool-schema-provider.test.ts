import { streamSimple, type Model } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import { createExternalRunsTool } from "../src/external-runs.ts";
import { createExternalHelpTool } from "../src/external-help.ts";
import { RunRegistry } from "../src/core/run-registry.ts";

it("preserves optional selectors in the actual openai-completions provider payload (#62)", async () => {
  const tools = [
    createExternalRunsTool({ registry: new RunRegistry(), runsDirectory: () => "/unused" }),
    createExternalHelpTool({ getDefaultHarness: () => "agy", workflowEnabled: true }),
  ];
  const model: Model<"openai-completions"> = {
    id: "gpt-6-astra", name: "Schema probe", provider: "9-router",
    api: "openai-completions", baseUrl: "http://127.0.0.1:0/v1",
    reasoning: false, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000, maxTokens: 16384,
    compat: { sendSessionAffinityHeaders: true },
  };
  let captured: unknown;
  const sentinel = "offline schema capture complete";
  const response = streamSimple(model, {
    messages: [{ role: "user", content: "Probe", timestamp: 0 }], tools,
  }, {
    apiKey: "fake-offline-token",
    onPayload(payload) {
      captured = JSON.parse(JSON.stringify(payload));
      // Stop before HTTP, not just before a response. No provider access needed.
      throw new Error(sentinel);
    },
  });
  const result = await response.result();
  expect(result.errorMessage).toContain(sentinel);
  const payload = captured as { tools: { function: { name: string; strict: boolean; parameters: { required: string[]; properties: Record<string, unknown> } } }[] };
  expect(payload.tools).toHaveLength(2);
  for (const [index, required, optional] of [[0, "action", ["runIds"]], [1, "topic", ["harness"]]] as const) {
    const fn = payload.tools[index]!.function;
    expect(fn.name).toBe(tools[index]!.name);
    expect(fn.strict).toBe(false);
    expect(fn.parameters.required).toEqual([required]);
    for (const field of optional) expect(fn.parameters.properties).toHaveProperty(field);
  }
});
