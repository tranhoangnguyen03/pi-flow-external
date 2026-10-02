import { Type } from "typebox";
import type { RegisteredRunEntry } from "../core/run-registry.ts";
import { contractEnvelope, INLINE_RESULT_BYTES, type PublicError } from "./envelope.ts";
import { liveWorkflowRun, workflowRunSchema, type EvidenceIntegrity, type PublicRun } from "./run.ts";

const workflowData = Type.Object({ run: Type.Union([Type.Null(), workflowRunSchema]) });
/** `ok` describes the workflow operation: a background launch is accepted, a foreground one settled successfully. */
export const workflowOutputSchema = contractEnvelope("workflow", Type.Literal("run"), workflowData, workflowData);

export const HANDLED_CHILD_FAILURES = "handled_child_failures";

/**
 * The public receipt for one registered workflow. A foreground root that
 * succeeded after handling child failures stays ok, with a warning; an
 * unsuccessful root is a failed operation that keeps its run evidence.
 */
export function workflowReceipt(entry: RegisteredRunEntry, { integrity, inspectable }: { integrity?: EvidenceIntegrity; inspectable: boolean }): {
  data: { run: PublicRun };
  warnings: string[];
  error?: PublicError;
} {
  const built = liveWorkflowRun(entry, { integrity, inlineBudget: INLINE_RESULT_BYTES, inspectable });
  const warnings: string[] = [];
  if (built.redacted) warnings.push("output_redacted");
  const outcome = entry.outcome;
  if (outcome && outcome.status !== "done") {
    return { data: { run: built.run }, warnings, error: { code: outcome.outcome === "succeeded" ? "failed" : outcome.outcome, message: outcome.error ?? "Workflow failed" } };
  }
  if (outcome && (built.run.children?.failed ?? 0) > 0) warnings.push(HANDLED_CHILD_FAILURES);
  return { data: { run: built.run }, warnings };
}
