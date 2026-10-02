import { expect, it, vi, afterEach } from "vitest";
import * as evidence from "../src/core/run-inspection.ts";
import { Value } from "typebox/value";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { setupPiSubagentTestHarness } from "./helpers/pi-subagent-harness.ts";
import { agentOutputSchema } from "../src/contract/agent.ts";
import { externalRunsOutputSchema } from "../src/contract/runs.ts";
import { workflowOutputSchema } from "../src/contract/workflow.ts";

afterEach(() => vi.restoreAllMocks());
const { createSession } = setupPiSubagentTestHarness();
it("calls the registered Agent through native codemode and receives a typed prelaunch failure", async () => {
  let receipt: unknown;
  let isError: boolean | undefined;
  const { session, registration } = await createSession({ codemode: true, extensions: [(pi) => {
    pi.on("tool_result", (event) => {
      if (event.toolName === "Agent") {
        receipt = event.structuredContent;
        isError = event.isError;
      }
    });
  }] });
  registration.setResponses([
    () => fauxAssistantMessage([fauxToolCall("codemode", { code: 'const r = await tools.Agent({description:"Missing role",prompt:"test",role:"nonexistent",harness:"claude"}); if (r.ok !== false || r.data.run !== null) throw new Error("Bad receipt"); return r.error.code;' })]),
    () => fauxAssistantMessage("done"),
  ]);
  await session.prompt("Run the offline contract probe.");
  expect(isError).toBe(true);
  expect(receipt).toMatchObject({ contractVersion: 1, ok: false, data: { run: null } });
  expect(Value.Check(agentOutputSchema, receipt)).toBe(true);
  const messages = session.state.messages;
  expect(JSON.stringify(messages)).toContain("selection_invalid");

});


it.each(["success", "failure", "background"])("native codemode exposes %s without confusing acceptance with completion", async (mode) => {
  const receipts: unknown[] = [];
  const errors: boolean[] = [];
  const { session, registration } = await createSession({ codemode: true,
    piHarnesses: { "pi-test": { modelId: "faux-thinker" } },
    extensions: [(pi) => { pi.on("tool_result", (event) => {
      if (event.toolName === "Agent") { receipts.push(event.structuredContent); errors.push(event.isError); }
    }); }],
  });
  registration.setResponses([
    (context) => context.messages.some(m => m.role === "user" && JSON.stringify(m).includes("CHILD_PROBE"))
      ? fauxAssistantMessage(mode === "failure" ? "" : "child verified", mode === "failure" ? { stopReason: "error", errorMessage: "fake failure" } : {})
      : fauxAssistantMessage([fauxToolCall("codemode", { code: `const r = await tools.Agent({description:"Offline child",prompt:"CHILD_PROBE",role:"worker",harness:"pi-test",background:${mode === "background"}}); if(r.ok !== ${mode !== "failure"}) throw new Error("Wrong ok"); return "RECEIPT_CHECKED";` })]),
    () => fauxAssistantMessage(mode === "failure" ? "" : "child verified", mode === "failure" ? { stopReason: "error", errorMessage: "fake failure" } : {}),
    () => fauxAssistantMessage("done"),
  ]);
  await session.prompt("Run the child probe.");
  expect(receipts).toHaveLength(1);
  expect(errors).toEqual([mode === "failure"]);
  expect(scriptOutput(session)).toBe("RECEIPT_CHECKED");
  expect(Value.Check(agentOutputSchema, receipts[0])).toBe(true);
  expect(receipts[0]).toMatchObject({ ok: mode !== "failure", data: { run: { kind: "agent" } } });
  if (mode !== "background") expect(receipts[0]).toMatchObject({ data: { run: { live: false, state: { outcome: mode === "failure" ? "failed" : "succeeded" } } } });
});


it.each(["validation", "blocked", "throw", "redaction"])("keeps %s separate from typed error data", async (mode) => {
  const { session, registration } = await createSession({ codemode: true, extensions: [(pi) => {
    if (mode === "blocked") pi.on("tool_call", (event) => {
      if (event.toolName === "Agent") return { block: true, reason: "blocked probe" };
    });
    if (mode === "redaction") pi.on("tool_result", (event) => {
      if (event.toolName === "Agent") return { content: [{ type: "text", text: "REDACTED_PROBE" }], isError: false };
    });
  }] });
  if (mode === "throw") session.getToolDefinition("Agent")!.execute = async () => { throw new Error("programming probe"); };
  const args = mode === "validation" ? { description: "invalid" } : { description: "probe", prompt: "test", role: "missing", harness: "claude" };
  registration.setResponses([
    () => fauxAssistantMessage([fauxToolCall("codemode", { code: `try { const r = await tools.Agent(${JSON.stringify(args)}); return {caught:false,value:r}; } catch(e) { return {caught:true,message:String(e.message)}; }` })]),
    () => fauxAssistantMessage("done"),
  ]);
  await session.prompt("Run boundary probe.");
  const output = JSON.parse(scriptOutput(session));
  if (mode === "redaction") {
    expect(output).toEqual({caught:false, value:"REDACTED_PROBE"});
  } else {
    expect(output.caught).toBe(true);
    expect(output.message).toContain(mode === "blocked" ? "blocked probe" : mode === "throw" ? "programming probe" : "Validation failed");
  }
});

function scriptOutput(session: Awaited<ReturnType<typeof createSession>>["session"]): string {
  const result = session.state.messages.find(m => m.role === "toolResult" && m.toolName === "codemode");
  if (!result || result.role !== "toolResult") throw new Error("Missing codemode result");
  expect(result.isError).not.toBe(true);
  const text = result.content.filter(b => b.type === "text").map(b => b.text);
  expect(text[0]).toContain("Script completed");
  return text.slice(1).join("\n");
}

it("discovers the actual Agent return declaration through native codemode", async () => {
  const { session, registration } = await createSession({ codemode:true });
  registration.setResponses([
    () => fauxAssistantMessage([fauxToolCall("codemode", {code:'return describeTool("Agent");'})]),
    () => fauxAssistantMessage("done"),
  ]);
  await session.prompt("Describe Agent.");
  const declaration = scriptOutput(session);
  expect(declaration).toContain("ok: true");
  expect(declaration).toContain("ok: false");
  expect(declaration).not.toContain("Promise<unknown>");
  expect(Buffer.byteLength(declaration)).toBeLessThan(12000);
  console.info(`Native Agent declaration: ${Buffer.byteLength(declaration)} UTF-8 bytes`);
});


it.each(["settles", "unreadable"])("observes background state after evidence I/O: %s", async (mode) => {
  let childFinished!: () => void;
  const finished = new Promise<void>(resolve => { childFinished = resolve; });
  const original = evidence.getRunRecord;
  vi.spyOn(evidence, "getRunRecord").mockImplementation(async (...args) => {
    await finished;
    await new Promise(resolve => setTimeout(resolve, 30));
    if (mode === "unreadable") throw new Error("EACCES evidence probe");
    return original(...args);
  });
  let receipt: any;
  const {session, registration} = await createSession({codemode:true,
    piHarnesses:{"pi-test":{modelId:"faux-thinker"}},
    extensions:[pi => { pi.on("tool_result", event => {if(event.toolName === "Agent") receipt=event.structuredContent;}); }],
  });
  registration.setResponses([
    () => fauxAssistantMessage([fauxToolCall("codemode", {code:'return await tools.Agent({description:"Race probe",prompt:"child",role:"worker",harness:"pi-test",background:true});'})]),
    () => { childFinished(); return fauxAssistantMessage("child done"); },
    () => fauxAssistantMessage("done"),
  ]);
  await session.prompt("Run race probe.");
  expect(receipt).toMatchObject({ok:true,data:{run:{live:false,state:{status:"done"},output:{value:"child done"},evidence:{integrity:mode === "unreadable" ? "unknown" : "complete"}}}});
});


it("resolves workflow and external_runs typed failures and successes in native codemode instead of throwing", async () => {
  const results: Record<string, { structuredContent: unknown; isError: boolean | undefined }[]> = { workflow: [], external_runs: [] };
  const { session, registration } = await createSession({ codemode: true,
    piHarnesses: { "pi-test": { modelId: "faux-thinker" } },
    extensions: [(pi) => { pi.on("tool_result", (event) => {
      if (event.toolName in results) results[event.toolName]!.push({ structuredContent: event.structuredContent, isError: event.isError });
    }); }],
  });
  const code = `
    const missing = await tools.workflow({ name: "missing-saved-workflow" });
    const unknown = await tools.external_runs({ action: "inspect", runIds: ["run_missing"] });
    const ran = await tools.workflow({ script: 'export const meta = { apiVersion: 1, name: "probe", description: "d" };\\nreturn await agent("WF_CHILD", { role: "worker", harness: "pi-test" });' });
    const waited = await tools.external_runs({ action: "wait", runIds: [ran.data.run.runId] });
    return [missing.ok, missing.error.code, unknown.ok, unknown.error.code, ran.ok, ran.data.run.output.value, waited.data.completed[0].output.value].join(",");`;
  registration.setResponses([
    () => fauxAssistantMessage([fauxToolCall("codemode", { code })]),
    () => fauxAssistantMessage("child ok"),
    () => fauxAssistantMessage("done"),
  ]);
  await session.prompt("Run the workflow contract probe.");
  expect(scriptOutput(session)).toBe("false,selection_invalid,false,run_unavailable,true,child ok,child ok");
  expect(results.workflow.map((result) => result.isError)).toEqual([true, false]);
  expect(results.external_runs.map((result) => result.isError)).toEqual([true, false]);
  for (const result of results.workflow) expect(Value.Check(workflowOutputSchema, result.structuredContent)).toBe(true);
  for (const result of results.external_runs) expect(Value.Check(externalRunsOutputSchema, result.structuredContent)).toBe(true);
});

it.each(["workflow", "external_runs"])("discovers the %s return declaration through native codemode", async (tool) => {
  const { session, registration } = await createSession({ codemode: true });
  registration.setResponses([
    () => fauxAssistantMessage([fauxToolCall("codemode", { code: `return describeTool(${JSON.stringify(tool)});` })]),
    () => fauxAssistantMessage("done"),
  ]);
  await session.prompt(`Describe ${tool}.`);
  const declaration = scriptOutput(session);
  expect(declaration).toContain("ok: true");
  expect(declaration).toContain("ok: false");
  expect(declaration).not.toContain("Promise<unknown>");
  console.info(`Native ${tool} declaration: ${Buffer.byteLength(declaration)} UTF-8 bytes`);
});
