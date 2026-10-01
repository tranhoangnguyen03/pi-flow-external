import { StringEnum, type JsonObject } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { projectLiveAgent } from "./core/run-projection.ts";
import type { RegisteredRunEntry } from "./core/run-registry.ts";
import { FLOW_ERROR_CODES } from "./core/errors.ts";
import { redactSecrets } from "./core/run-record.ts";

export const INLINE_RESULT_BYTES = 16 * 1024;
const strings = <T extends string[]>(...values: T) => StringEnum(values);
const errorSchema = Type.Object({ code: StringEnum(FLOW_ERROR_CODES), message: Type.String() });
const inspectRef = Type.Object({ tool: Type.Literal("external_runs"), action: Type.Literal("inspect"), runIds: Type.Array(Type.String()), view: strings("summary", "final", "diagnostics") });
const runSchema = Type.Object({
  runId: Type.String(), kind: Type.Literal("agent"), live: Type.Boolean(),
  task: Type.Object({ description: Type.Optional(Type.String()), profile: Type.Optional(Type.String()), backend: Type.Optional(Type.String()), harness: Type.Optional(Type.String()) }),
  state: Type.Object({ status: strings("queued", "running", "done", "error", "aborted"), outcome: Type.Optional(strings("succeeded", "failed", "cancelled", "timed_out")) }),
  timing: Type.Object({
    queuedAt: Type.Optional(Type.String()), executionStartedAt: Type.Optional(Type.String()),
    processStartedAt: Type.Optional(Type.String()), firstActivityAt: Type.Optional(Type.String()),
    lastActivityAt: Type.Optional(Type.String()), finishedAt: Type.Optional(Type.String()),
    queueDelayMs: Type.Optional(Type.Number()), elapsedMs: Type.Optional(Type.Number()),
    activityAgeMs: Type.Optional(Type.Number()), processDurationMs: Type.Optional(Type.Number()),
  }),
  output: Type.Object({ available: Type.Boolean(), finalAvailable: Type.Boolean(), delivery: strings("inline", "reference", "none"), value: Type.Optional(Type.Unknown()) }),
  evidence: Type.Object({ integrity: strings("complete", "incomplete", "damaged", "unknown") }),
  refs: Type.Optional(Type.Object({ summary: inspectRef, final: inspectRef, diagnostics: inspectRef })),
});
const common = {
  contractVersion: Type.Literal(1), tool: Type.Literal("Agent"), action: Type.Literal("delegate"),
  observedAt: Type.String(), data: Type.Object({ run: Type.Union([Type.Null(), runSchema]) }),
  warnings: Type.Array(Type.String()),
};
export const agentOutputSchema = Type.Union([
  Type.Object({ ...common, ok: Type.Literal(true), error: Type.Optional(Type.Never()) }),
  Type.Object({ ...common, ok: Type.Literal(false), error: errorSchema }),
]);
export type AgentReceipt = Static<typeof agentOutputSchema>;
export type PublicError = Static<typeof errorSchema>;

/** Only registry-confirmed entries may supply a public handle. Never infer liveness from disk. */
export function agentReceipt({ entry, integrity = "unknown", error, inspectable = true }: {
  entry?: RegisteredRunEntry;
  integrity?: "complete" | "incomplete" | "damaged" | "unknown";
  error?: PublicError;
  inspectable?: boolean;
}): AgentReceipt & JsonObject {
  const warnings: string[] = [];
  let run: AgentReceipt["data"]["run"] = null;
  if (entry) {
    const projected = projectLiveAgent(entry);
    const value = entry.outcome?.result;
    const finalAvailable = projected.output.finalAvailable;
    let encoded: string | undefined;
    try { encoded = finalAvailable ? JSON.stringify(value) : undefined; } catch { /* Non-JSON values are never presented as complete. */ }
    const redacted = encoded === undefined ? undefined : redactSecrets(JSON.parse(encoded));
    const original = encoded;
    encoded = encoded === undefined ? undefined : JSON.stringify(redacted);
    if (encoded !== original) warnings.push("output_redacted");
    const inline = encoded !== undefined && Buffer.byteLength(encoded, "utf8") <= INLINE_RESULT_BYTES;
    const ref = (view: "summary" | "final" | "diagnostics") => ({ tool: "external_runs" as const, action: "inspect" as const, runIds: [entry.runId], view });
    run = {
      runId: entry.runId, kind: "agent", live: projected.live, task: projected.task,
      state: { status: projected.state.status as NonNullable<AgentReceipt["data"]["run"]>["state"]["status"], ...(entry.outcome ? { outcome: entry.outcome.outcome } : {}) },
      timing: projected.timing,
      output: { available: projected.output.available, finalAvailable, delivery: inline ? "inline" : finalAvailable && inspectable ? "reference" : "none", ...(inline ? { value: redacted } : {}) },
      evidence: { integrity }, ...(inspectable ? { refs: { summary: ref("summary"), final: ref("final"), diagnostics: ref("diagnostics") } } : {}),
    };
    if (!error && entry.outcome && entry.outcome.status !== "done") {
      error = { code: entry.outcome.outcome === "succeeded" ? "failed" : entry.outcome.outcome, message: entry.outcome.error ?? "Child execution failed" };
    }
  }
  const base = { contractVersion: 1 as const, tool: "Agent" as const, action: "delegate" as const, observedAt: new Date().toISOString(), data: { run }, warnings };
  return JSON.parse(JSON.stringify(redactSecrets(error ? { ...base, ok: false, error: { code: error.code, message: error.message } } : { ...base, ok: true }))) as AgentReceipt & JsonObject;
}
