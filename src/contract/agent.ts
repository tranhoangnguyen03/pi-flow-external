import { type JsonObject } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import type { RegisteredRunEntry } from "../core/run-registry.ts";
import { contractEnvelope, envelope, INLINE_RESULT_BYTES, type PublicError } from "./envelope.ts";
import { agentRunSchema, liveAgentRun, type EvidenceIntegrity } from "./run.ts";

const agentData = Type.Object({ run: Type.Union([Type.Null(), agentRunSchema]) });
export const agentOutputSchema = contractEnvelope("Agent", Type.Literal("delegate"), agentData, agentData);
export type AgentReceipt = Static<typeof agentOutputSchema>;

/** Only registry-confirmed entries may supply a public handle. Never infer liveness from disk. */
export function agentReceipt({ entry, integrity = "unknown", error, inspectable = true }: {
  entry?: RegisteredRunEntry;
  integrity?: EvidenceIntegrity;
  error?: PublicError;
  inspectable?: boolean;
}): AgentReceipt & JsonObject {
  const warnings: string[] = [];
  let run = null;
  if (entry) {
    const built = liveAgentRun(entry, { integrity, inlineBudget: INLINE_RESULT_BYTES, inspectable });
    run = built.run;
    if (built.redacted) warnings.push("output_redacted");
    if (!error && entry.outcome && entry.outcome.status !== "done") {
      error = { code: entry.outcome.outcome === "succeeded" ? "failed" : entry.outcome.outcome, message: entry.outcome.error ?? "Child execution failed" };
    }
  }
  return envelope({ tool: "Agent", action: "delegate", data: { run }, warnings, error, redact: true }) as AgentReceipt & JsonObject;
}
