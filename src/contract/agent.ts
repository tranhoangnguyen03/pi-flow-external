import { type JsonObject } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { EXTERNAL_DELEGATE_TOOL } from "../tool-names.ts";
import { parentContextSchema } from "../core/parent-context.ts";
import type { RegisteredRunEntry } from "../core/run-registry.ts";
import { contractEnvelope, envelope, INLINE_RESULT_BYTES, type PublicError } from "./envelope.ts";
import { agentRunSchema, liveAgentRun, type EvidenceIntegrity } from "./run.ts";

const agentParameterFields = {
  context: Type.Optional(parentContextSchema),
  description: Type.String({
    description: "A short 3-5 word description of the task, used for UI display and routing context.",
  }),
  prompt: Type.String({
    description: "The task briefing to send to the subagent.",
  }),
  background: Type.Optional(Type.Boolean({
    description: "Defaults to false: wait for settlement. True returns a stable session-owned run handle after registration; work may already be settled. Pass true when you have independent local work to do first (do it, then call external_runs wait), or when the user asks to leave work running across turns (report the runId and do not call external_runs wait this turn). UI sessions show active background runs in the status bar and wake the session when an uncollected run settles across turns. Keep the owning session open.",
  })),
  role: Type.Optional(Type.String({
    minLength: 1,
    description: "The built-in or custom external role to use, such as reviewer. Required unless using legacy subagent_type.",
  })),
  harness: Type.Optional(Type.String({
    minLength: 1,
    description: "Optional harness override: agy, claude, codex, muse, or a registered named pi-* harness. Omit to use the effective default harness: a trusted project override (.pi/pi-flow-external/settings.json) when present, else the global defaultHarness setting.",
  })),
  subagent_type: Type.Optional(Type.String({
    minLength: 1,
    description: "Legacy exact-profile escape hatch. Cannot be combined with role or harness.",
  })),
  permission: Type.Optional(
    Type.Union([Type.Literal("readonly"), Type.Literal("edit"), Type.Literal("danger")], {
      description:
        "Optional permission tier. Omit to use the global defaultPermission (danger unless changed). A role does not grant or limit this. codex maps it to --sandbox, claude maps it to a headless permission mode, muse maps it to approval/sandbox flags, and pi maps it to a curated tool list (not an OS sandbox). Antigravity accepts only danger; readonly and edit are rejected.",
    }),
  ),
  max_budget_usd: Type.Optional(
    Type.Number({
      minimum: 0,
      description:
        "Optional USD spending cap for this run. Enforced mid-run on Claude Code (native flag); recorded and reported after the run elsewhere.",
    }),
  ),
  resume: Type.Optional(
    Type.String({
      description:
        "Prior run id (from a completed result's evidence id) whose backend conversation should be continued. Must use the same profile backend.",
    }),
  ),
};

// Pi's codemode declaration renderer evaluates a root anyOf before properties,
// so each selector branch repeats the shared properties and required fields.
export const agentToolParameters = Type.Object(agentParameterFields, {
  anyOf: [
    {
      properties: agentParameterFields,
      required: ["description", "prompt", "role"],
      not: { required: ["subagent_type"] },
    },
    {
      properties: agentParameterFields,
      required: ["description", "prompt", "subagent_type"],
      not: { anyOf: [{ required: ["role"] }, { required: ["harness"] }] },
    },
  ],
});

export type AgentToolParams = Static<typeof agentToolParameters>;

const agentData = Type.Object({ run: Type.Union([Type.Null(), agentRunSchema]) });
export const agentOutputSchema = contractEnvelope(EXTERNAL_DELEGATE_TOOL, Type.Literal("delegate"), agentData, agentData);
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
  return envelope({ tool: EXTERNAL_DELEGATE_TOOL, action: "delegate", data: { run }, warnings, error, redact: true }) as AgentReceipt & JsonObject;
}
