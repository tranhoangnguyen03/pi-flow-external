import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static, type TSchema } from "typebox";
import { buildCapabilityRecord } from "../core/capabilities.ts";
import { EXTERNAL_DELEGATE_TOOL, EXTERNAL_WORKFLOW_TOOL } from "../tool-names.ts";
import { USAGE_ONE_AGENT, usageWorkflowScript } from "../prompts.ts";
import { workflowToolParameters } from "../workflow/source.ts";
import { agentOutputSchema, agentToolParameters } from "./agent.ts";
import { contractEnvelope, strings } from "./envelope.ts";
import { EXTERNAL_RUNS_ACTION_SPECS, EXTERNAL_RUNS_EXAMPLES, externalRunsOutputSchema, externalRunsParameters } from "./runs.ts";
import { formatWorkflowHelpersLine, HANDLED_CHILD_FAILURES, WORKFLOW_HELPERS, workflowOutputSchema } from "./workflow.ts";

export const EXTERNAL_HELP_TOOL = "external_help" as const;
export const EXTERNAL_HELP_TOPICS = ["usage", "roles", "permissions", "workflow", "contracts", "capabilities"] as const;
export const PUBLIC_TOOL_NAMES = [
  EXTERNAL_DELEGATE_TOOL,
  EXTERNAL_WORKFLOW_TOOL,
  "external_runs",
  EXTERNAL_HELP_TOOL,
] as const;

export type PublicToolName = (typeof PUBLIC_TOOL_NAMES)[number];

/** Maximum UTF-8 byte budget for both `content` text and serialized `data` on the contracts index. */
export const CONTRACT_INDEX_MAX_BYTES = 1536;

export const externalHelpParameters = Type.Object({
  topic: StringEnum(EXTERNAL_HELP_TOPICS, {
    description:
      "Help topic: usage playbook, role descriptions/configured profile availability, harness permissions, workflow syntax and saved workflows, public tool contracts, or per-harness capabilities.",
  }),
  harness: Type.Optional(Type.String({
    description:
      "Optional harness filter for roles, permissions, or capabilities: agy, claude, codex, muse, or a registered pi-* harness. Omit on capabilities for the compact index. usage, workflow, and contracts describe every harness.",
  })),
  tool: Type.Optional(Type.String({
    description:
      "Optional public tool name for topic 'contracts': external_delegate, external_workflow, external_runs, or external_help. Omit for the compact contracts index.",
  })),
});

export type ExternalHelpParams = Static<typeof externalHelpParameters>;

const schemaObject = Type.Record(Type.String(), Type.Unknown());

export const contractIndexToolSchema = Type.Object({
  name: strings(...PUBLIC_TOOL_NAMES),
  actions: Type.Array(Type.String()),
  contractVersion: Type.Literal(1),
  purpose: Type.String(),
  registered: Type.Boolean(),
});

export const contractIndexSchema = Type.Object({
  contractVersion: Type.Literal(1),
  tools: Type.Array(contractIndexToolSchema),
  rules: Type.Array(Type.String()),
  nativeDiscovery: Type.String(),
});

export type ContractIndex = Static<typeof contractIndexSchema>;

export const contractExampleSchema = Type.Object({
  label: Type.String(),
  input: schemaObject,
  output: schemaObject,
});

export type ContractExample = Static<typeof contractExampleSchema>;

export const workflowHelpersSchema = Type.Object({
  functions: Type.Object({
    agent: Type.String(),
    parallel: Type.String(),
    pipeline: Type.String(),
    phase: Type.String(),
    log: Type.String(),
  }),
  globals: Type.Array(Type.String()),
  agentOptions: Type.Array(Type.String()),
});

export const toolContractDetailSchema = Type.Object({
  tool: strings(...PUBLIC_TOOL_NAMES),
  contractVersion: Type.Literal(1),
  registered: Type.Boolean(),
  actions: Type.Array(Type.String()),
  purpose: Type.String(),
  input: schemaObject,
  output: schemaObject,
  semantics: Type.Array(Type.String()),
  examples: Type.Array(contractExampleSchema),
  helpers: Type.Optional(workflowHelpersSchema),
});

export type ToolContractDetail = Static<typeof toolContractDetailSchema>;

const proseTopicDataSchema = Type.Object({
  topic: strings("usage", "roles", "permissions", "workflow"),
  harness: Type.Optional(Type.String()),
  tool: Type.Optional(Type.String()),
  text: Type.String(),
});

const contractsTopicDataSchema = Type.Union([
  Type.Object({
    topic: Type.Literal("contracts"),
    index: contractIndexSchema,
  }),
  Type.Object({
    topic: Type.Literal("contracts"),
    tool: strings(...PUBLIC_TOOL_NAMES),
    contract: toolContractDetailSchema,
  }),
]);

export const permissionTierCapabilitySchema = Type.Object({
  supported: Type.Boolean(),
  enforced: Type.Boolean(),
  caveat: Type.Optional(Type.String()),
  tools: Type.Optional(Type.Array(Type.String())),
});

export const capabilityRecordSchema = Type.Object({
  harness: Type.String(),
  backend: strings("agy", "claude", "codex", "muse", "pi"),
  boundary: strings("external_cli", "pi_sdk"),
  configuration: Type.Object({
    state: strings("built_in", "registered", "invalid"),
    enabled: Type.Boolean(),
    diagnostics: Type.Optional(Type.Array(Type.String())),
    model: Type.Optional(Type.String()),
    thinking: Type.Optional(Type.String()),
    preset: Type.Optional(strings("minimal", "skills")),
  }),
  readiness: Type.Literal("not_probed"),
  workflowChildSchema: Type.Object({
    support: strings("supported", "unsupported"),
    mechanism: strings("cli_flag", "schema_file", "injected_tool", "none"),
  }),
  resume: Type.Object({
    support: strings("supported", "unsupported"),
    mechanism: Type.Optional(Type.String()),
    conditions: Type.Array(Type.String()),
  }),
  budget: strings("enforced", "not_enforced"),
  cost: Type.Object({
    kind: strings("native", "estimated", "partial", "unknown"),
    conditions: Type.Array(Type.String()),
  }),
  retries: Type.Object({
    extension: strings("none", "once_on_infrastructure"),
    native: strings("none", "internal", "unknown"),
  }),
  nestedAgentDetection: Type.Boolean(),
  permissions: Type.Object({
    default: strings("readonly", "edit", "danger"),
    tiers: Type.Object({
      readonly: permissionTierCapabilitySchema,
      edit: permissionTierCapabilitySchema,
      danger: permissionTierCapabilitySchema,
    }),
    caveats: Type.Array(Type.String()),
  }),
  context: Type.Object({
    modes: Type.Tuple([Type.Literal("none"), Type.Literal("recent"), Type.Literal("full")]),
    maxBytes: Type.Integer({ minimum: 1 }),
    resumeConflict: Type.Literal(true),
  }),
  resources: Type.Optional(
    Type.Object({
      skills: strings("none", "user", "user_and_project"),
      extensions: Type.Literal("none"),
      promptTemplates: Type.Literal("none"),
      themes: Type.Literal("none"),
    }),
  ),
});

export type CapabilityRecordSchema = Static<typeof capabilityRecordSchema>;

const capabilitiesTopicDataSchema = Type.Object({
  topic: Type.Literal("capabilities"),
  harness: Type.Optional(Type.String()),
  harnesses: Type.Array(capabilityRecordSchema),
});

export const externalHelpOutputSchema = contractEnvelope(
  EXTERNAL_HELP_TOOL,
  Type.Literal("help"),
  Type.Union([proseTopicDataSchema, contractsTopicDataSchema, capabilitiesTopicDataSchema]),
  Type.Null(),
);

export type ExternalHelpReceipt = Static<typeof externalHelpOutputSchema>;

export const CONTRACT_INDEX_RULES = [
  "Check receipt.ok on every call; expected failures resolve with ok:false and error:{code,message}.",
  "Host schema validation, tool_call blocks, interrupted waits, and unexpected bugs still throw.",
  "Canonical output is inline (<=16 KiB UTF-8 JSON after redaction) or delivery:'reference' via refs.final.",
  "Background ok:true means accepted, not finished; supervise with external_runs.",
  "Follow cursors to completion; concatenate JSON page fragments before parsing.",
  "Operation ok, target state.outcome, and task acceptance are distinct: inspecting or waiting on a failed run is ok:true.",
] as const;

export const CONTRACT_NATIVE_DISCOVERY_NOTE =
  "Use native searchTools/describeTool for TS declarations; pass tool:'<name>' here for schemas and examples.";

const EXAMPLE_OBSERVED_AT = "2026-10-02T00:00:00.000Z";

const EXAMPLE_AGENT_RUN = {
  runId: "run_example",
  kind: "agent" as const,
  live: false,
  task: {
    description: USAGE_ONE_AGENT.description,
    profile: "claude/explorer",
    backend: "claude",
    harness: "claude",
  },
  state: { status: "done" as const, outcome: "succeeded" as const },
  timing: { queuedAt: EXAMPLE_OBSERVED_AT, finishedAt: EXAMPLE_OBSERVED_AT, processDurationMs: 120 },
  output: { available: true, finalAvailable: true, delivery: "inline" as const, value: "Entry points: index.ts, src/pi-subagent.ts" },
  evidence: { integrity: "complete" as const },
  refs: {
    summary: { tool: "external_runs" as const, action: "inspect" as const, runIds: ["run_example"], view: "summary" as const },
    final: { tool: "external_runs" as const, action: "inspect" as const, runIds: ["run_example"], view: "final" as const },
    diagnostics: { tool: "external_runs" as const, action: "inspect" as const, runIds: ["run_example"], view: "diagnostics" as const },
  },
};

const EXAMPLE_WORKFLOW_RUN = {
  runId: "wf_example",
  kind: "workflow" as const,
  live: false,
  task: { name: "parallel-review", source: "inline" as const },
  state: { status: "done" as const, outcome: "succeeded" as const },
  timing: { queuedAt: EXAMPLE_OBSERVED_AT, finishedAt: EXAMPLE_OBSERVED_AT },
  output: {
    available: true,
    finalAvailable: true,
    delivery: "inline" as const,
    value: { settled: [{ ok: true, value: "mapped" }, { ok: false, runId: "run_review", outcome: "failed", message: "review failed" }] },
  },
  evidence: { integrity: "complete" as const },
  children: { count: 2, failed: 1 },
  refs: {
    summary: { tool: "external_runs" as const, action: "inspect" as const, runIds: ["wf_example"], view: "summary" as const },
    final: { tool: "external_runs" as const, action: "inspect" as const, runIds: ["wf_example"], view: "final" as const },
    diagnostics: { tool: "external_runs" as const, action: "inspect" as const, runIds: ["wf_example"], view: "diagnostics" as const },
  },
};

export interface PublicToolSpec {
  tool: PublicToolName;
  contractVersion: 1;
  actions: readonly string[];
  purpose: string;
  input: TSchema;
  output: TSchema;
  semantics: readonly string[];
  examples: readonly ContractExample[];
  helpers?: typeof WORKFLOW_HELPERS;
}

export const PUBLIC_TOOLS: Record<PublicToolName, PublicToolSpec> = {
  [EXTERNAL_DELEGATE_TOOL]: {
    tool: EXTERNAL_DELEGATE_TOOL,
    contractVersion: 1,
    actions: ["delegate"],
    purpose: "Delegate one task to an external CLI or registered Pi role.",
    input: agentToolParameters,
    output: agentOutputSchema,
    semantics: [
      "Select role (with optional harness) or legacy exact subagent_type, never both; subagent_type also forbids harness.",
      "Foreground ok:true means the child settled with status:'done' and a non-empty canonical result; background ok:true means accepted and registered.",
      "Foreground child failure, cancellation, or timeout resolves with ok:false, error.code set to that outcome, and data.run preserved for inspection.",
      "Pre-registration validation/configuration failures resolve with ok:false and data.run:null.",
      "Canonical output is inline up to 16 KiB UTF-8 JSON after secret redaction (warning 'output_redacted' when changed), else delivery:'reference' via refs.final.",
      "Context sharing ({mode:'recent',turns} or {mode:'full'}) excludes thinking, system instructions, and pending calls, rejects images/>1 MiB, and cannot combine with resume.",
    ],
    examples: [
      {
        label: "foreground_success",
        input: { ...USAGE_ONE_AGENT },
        output: {
          contractVersion: 1,
          tool: EXTERNAL_DELEGATE_TOOL,
          action: "delegate",
          observedAt: EXAMPLE_OBSERVED_AT,
          ok: true,
          data: { run: EXAMPLE_AGENT_RUN },
          warnings: [],
        },
      },
      {
        label: "typed_prelaunch_failure",
        input: {
          description: "Unknown role",
          prompt: "Check /absolute/repo read-only.",
          role: "missing_role",
          harness: "claude",
        },
        output: {
          contractVersion: 1,
          tool: EXTERNAL_DELEGATE_TOOL,
          action: "delegate",
          observedAt: EXAMPLE_OBSERVED_AT,
          ok: false,
          data: { run: null },
          warnings: [],
          error: {
            code: "selection_invalid",
            message:
              'Unknown external role "missing_role". Available roles: explorer, implementer, planner, qa, reviewer, worker. Nonstandard profile names must be selected with legacy subagent_type.',
          },
        },
      },
    ],
  },
  [EXTERNAL_WORKFLOW_TOOL]: {
    tool: EXTERNAL_WORKFLOW_TOOL,
    contractVersion: 1,
    actions: ["run"],
    purpose: "Run trusted JS orchestration across external roles.",
    input: workflowToolParameters,
    output: workflowOutputSchema,
    semantics: [
      "Provide exactly one non-empty source: script, name, or scriptPath; resumeFromRunId requires scriptPath.",
      "Every script starts with export const meta = { apiVersion: 1, name, description }, calls agent() at least once, awaits every started call, and returns JSON-serializable data.",
      "Foreground ok:true means the workflow root succeeded; if the script caught child failures, children.failed > 0 and warnings includes 'handled_child_failures'.",
      "Uncaught child failures or fatal errors resolve with ok:false and keep data.run; pre-registration source/script failures return data.run:null.",
      "All workflow children share one frozen invocation-time catalog and parent-context snapshot; earlier child results must be passed explicitly in prompts.",
    ],
    examples: [
      {
        label: "handled_child_failure_success",
        input: { script: usageWorkflowScript() },
        output: {
          contractVersion: 1,
          tool: EXTERNAL_WORKFLOW_TOOL,
          action: "run",
          observedAt: EXAMPLE_OBSERVED_AT,
          ok: true,
          data: { run: EXAMPLE_WORKFLOW_RUN },
          warnings: [HANDLED_CHILD_FAILURES],
        },
      },
      {
        label: "unknown_saved_workflow",
        input: { name: "missing-workflow" },
        output: {
          contractVersion: 1,
          tool: EXTERNAL_WORKFLOW_TOOL,
          action: "run",
          observedAt: EXAMPLE_OBSERVED_AT,
          ok: false,
          data: { run: null },
          warnings: [],
          error: { code: "selection_invalid", message: 'Unknown saved workflow "missing-workflow". Available workflows: none.' },
        },
      },
    ],
    helpers: WORKFLOW_HELPERS,
  },
  external_runs: {
    tool: "external_runs",
    contractVersion: 1,
    actions: ["list", "inspect", "wait", "cancel"],
    purpose: "List, inspect, wait for, or cancel session-owned runs.",
    input: externalRunsParameters,
    output: externalRunsOutputSchema,
    semantics: [
      "ok:true means the supervision operation succeeded, even when an inspected or waited target run failed, was cancelled, or timed out.",
      ...EXTERNAL_RUNS_ACTION_SPECS.map((spec) => `${spec.label}: required [${spec.required.join(", ")}], optional [${spec.optional.join(", ") || "none"}]. ${spec.rule}`),
      "Batch inspect measures each entry in both legacy text and structured JSON against limitBytes; if one entry cannot fit, it returns ok:false with code 'page_too_small'.",
      "Single inspect returns page:{text,encoding,complete,nextCursor?}; concatenate all pages of a JSON cursor sequence before parsing, and note output/diagnostics join messages with '\\n'.",
      "wait spends its structured limitBytes copy in request order for in-memory non-truncated results (<=16 KiB JSON); all other and durable results use delivery:'reference'.",
      "Interrupting wait throws 'Run wait aborted' without cancelling pending runs.",
    ],
    examples: [
      {
        label: "inspect_batch",
        input: { ...EXTERNAL_RUNS_EXAMPLES.inspectBatch },
        output: {
          contractVersion: 1,
          tool: "external_runs",
          action: "inspect",
          observedAt: EXAMPLE_OBSERVED_AT,
          ok: true,
          data: { mode: "batch", entries: [EXAMPLE_AGENT_RUN] },
          warnings: [],
        },
      },
      {
        label: "inspect_single_final",
        input: { ...EXTERNAL_RUNS_EXAMPLES.inspectSingle },
        output: {
          contractVersion: 1,
          tool: "external_runs",
          action: "inspect",
          observedAt: EXAMPLE_OBSERVED_AT,
          ok: true,
          data: {
            mode: "single",
            runId: "run_example",
            view: "final",
            page: { text: "Entry points: index.ts, src/pi-subagent.ts", encoding: "text", complete: true },
            finalAvailable: true,
            outputStatus: "final",
          },
          warnings: [],
        },
      },
      {
        label: "wait_all",
        input: { ...EXTERNAL_RUNS_EXAMPLES.wait },
        output: {
          contractVersion: 1,
          tool: "external_runs",
          action: "wait",
          observedAt: EXAMPLE_OBSERVED_AT,
          ok: true,
          data: { mode: "all", completed: [EXAMPLE_AGENT_RUN], pending: [] },
          warnings: [],
        },
      },
      {
        label: "typed_unavailable_failure",
        input: { action: "inspect", runIds: ["run_missing"] },
        output: {
          contractVersion: 1,
          tool: "external_runs",
          action: "inspect",
          observedAt: EXAMPLE_OBSERVED_AT,
          ok: false,
          data: null,
          warnings: [],
          error: { code: "run_unavailable", message: "Run is unknown or unavailable in this session" },
        },
      },
    ],
  },
  [EXTERNAL_HELP_TOOL]: {
    tool: EXTERNAL_HELP_TOOL,
    contractVersion: 1,
    actions: ["help"],
    purpose: "Read-only help for usage, roles, permissions, workflows, contracts, and capabilities.",
    input: externalHelpParameters,
    output: externalHelpOutputSchema,
    semantics: [
      "Read-only discovery: spawns no CLIs, reads no credentials, calls no providers, and writes no files.",
      "Blank/whitespace harness and tool placeholders normalize to omitted (#62).",
      "Unknown harness on roles/permissions/capabilities or unknown tool on contracts returns ok:false with code 'selection_invalid' and data:null.",
      "Prose topics (usage, roles, permissions, workflow) return data:{topic, harness?, text}; contracts returns data:{topic:'contracts', index} or data:{topic:'contracts', tool, contract}; capabilities returns data:{topic:'capabilities', harness?, harnesses}.",
      "Capability readiness is always 'not_probed' (configuration does not prove installation or authentication); every harness returns PublicRun receipts while workflowChildSchema describes workflow agent({ schema }) support.",
    ],
    examples: [
      {
        label: "contracts_index",
        input: { topic: "contracts" },
        output: {
          contractVersion: 1,
          tool: EXTERNAL_HELP_TOOL,
          action: "help",
          observedAt: EXAMPLE_OBSERVED_AT,
          ok: true,
          data: {
            topic: "contracts",
            index: {
              contractVersion: 1,
              tools: [
                {
                  name: EXTERNAL_DELEGATE_TOOL,
                  actions: ["delegate"],
                  contractVersion: 1,
                  purpose: "Delegate one task to an external CLI or registered Pi role.",
                  registered: true,
                },
              ],
              rules: [CONTRACT_INDEX_RULES[0]],
              nativeDiscovery: CONTRACT_NATIVE_DISCOVERY_NOTE,
            },
          },
          warnings: [],
        },
      },
      {
        label: "capabilities_detail",
        input: { topic: "capabilities", harness: "claude" },
        output: {
          contractVersion: 1,
          tool: EXTERNAL_HELP_TOOL,
          action: "help",
          observedAt: EXAMPLE_OBSERVED_AT,
          ok: true,
          data: {
            topic: "capabilities",
            harness: "claude",
            harnesses: [
              buildCapabilityRecord({
                harness: "claude",
                backend: "claude",
                configuration: { state: "built_in", enabled: true },
                options: { effectiveUid: 501, defaultPermission: "danger" },
              }),
            ],
          },
          warnings: [],
        },
      },
      {
        label: "unknown_tool_selector",
        input: { topic: "contracts", tool: "unknown_tool" },
        output: {
          contractVersion: 1,
          tool: EXTERNAL_HELP_TOOL,
          action: "help",
          observedAt: EXAMPLE_OBSERVED_AT,
          ok: false,
          data: null,
          warnings: [],
          error: {
            code: "selection_invalid",
            message: 'Unknown public tool "unknown_tool". Public tools: external_delegate, external_workflow, external_runs, external_help.',
          },
        },
      },
    ],
  },
};

export function buildContractIndex(workflowEnabled: boolean): ContractIndex {
  return {
    contractVersion: 1,
    tools: PUBLIC_TOOL_NAMES.map((name) => {
      const spec = PUBLIC_TOOLS[name];
      return {
        name: spec.tool,
        actions: [...spec.actions],
        contractVersion: spec.contractVersion,
        purpose: spec.purpose,
        registered: name === EXTERNAL_WORKFLOW_TOOL ? workflowEnabled : true,
      };
    }),
    rules: [...CONTRACT_INDEX_RULES],
    nativeDiscovery: CONTRACT_NATIVE_DISCOVERY_NOTE,
  };
}

export function formatContractIndex(index: ContractIndex): string {
  const toolLines = index.tools.map(
    (tool) => `- ${tool.name} [${tool.actions.join(", ")}] (${tool.registered ? "registered" : "disabled"}): ${tool.purpose}`,
  );
  const ruleLines = index.rules.map((rule) => `- ${rule}`);
  return [
    `Flow public contracts (contractVersion ${index.contractVersion}):`,
    ...toolLines,
    "",
    "Rules:",
    ...ruleLines,
    "",
    index.nativeDiscovery,
  ].join("\n");
}

export function buildToolContractDetail(tool: PublicToolName, workflowEnabled: boolean): ToolContractDetail {
  const spec = PUBLIC_TOOLS[tool];
  return {
    tool: spec.tool,
    contractVersion: spec.contractVersion,
    registered: tool === EXTERNAL_WORKFLOW_TOOL ? workflowEnabled : true,
    actions: [...spec.actions],
    purpose: spec.purpose,
    input: spec.input as unknown as Record<string, unknown>,
    output: spec.output as unknown as Record<string, unknown>,
    semantics: [...spec.semantics],
    examples: spec.examples.map((example) => ({
      label: example.label,
      input: example.input,
      output: example.output,
    })),
    ...(spec.helpers
      ? {
          helpers: {
            functions: { ...spec.helpers.functions },
            globals: [...spec.helpers.globals],
            agentOptions: [...spec.helpers.agentOptions],
          },
        }
      : {}),
  };
}

export function formatToolContractDetail(detail: ToolContractDetail): string {
  const availability = detail.registered
    ? "registered"
    : "disabled for this extension instance";
  const lines = [
    `${detail.tool} (contractVersion ${detail.contractVersion}, actions: ${detail.actions.join(", ")}, ${availability}): ${detail.purpose}`,
    "",
    "Semantics:",
    ...detail.semantics.map((line) => `- ${line}`),
  ];
  if (detail.helpers) {
    lines.push("", `Workflow helpers: ${formatWorkflowHelpersLine()}`);
  }
  lines.push(
    "",
    "Validated examples:",
    ...detail.examples.map(
      (example) => `- ${example.label}:\n  input: ${JSON.stringify(example.input)}\n  output: ${JSON.stringify(example.output)}`,
    ),
    "",
    `Raw JSON Schemas are in structuredContent.data.contract.{input,output}; use describeTool(${JSON.stringify(detail.tool)}) in codemode for TypeScript declarations.`,
  );
  return lines.join("\n");
}
