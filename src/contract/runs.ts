import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { failureVariant, strings, successVariant } from "./envelope.ts";
import { supervisedRunSchema } from "./run.ts";

const TOOL = "external_runs";
const runs = Type.Array(supervisedRunSchema);
const cursor = Type.Optional(Type.String());

export const EXTERNAL_RUNS_ACTIONS = ["list", "inspect", "wait", "cancel"] as const;
export const SINGLE_INSPECT_VIEWS = ["summary", "output", "diagnostics", "final", "launch"] as const;
export const WAIT_MODES = ["any", "all"] as const;
export const MAX_WAIT_TARGETS = 100;
/**
 * Cap for `inspect`'s batch `runIds` mode. Intentionally lower than `wait`'s
 * MAX_WAIT_TARGETS (100): batch inspection returns full projections and may
 * touch live evidence reads per target, so it stays cheap by staying small.
 */
export const MAX_BATCH_INSPECT_TARGETS = 20;

export const externalRunsParameters = Type.Object({
  action: StringEnum(EXTERNAL_RUNS_ACTIONS, {
    description: "List session runs and workflow roots, inspect evidence, wait for settlement, or cancel a run. Supply only fields for the chosen action.",
  }),
  runIds: Type.Optional(Type.Array(Type.String(), {
    maxItems: MAX_WAIT_TARGETS,
    description: `Target IDs (run_… or wf_…). Required for inspect (1-${MAX_BATCH_INSPECT_TARGETS}), wait (1-${MAX_WAIT_TARGETS}), and cancel (1).`,
  })),
  view: Type.Optional(StringEnum(SINGLE_INSPECT_VIEWS, {
    description: "Inspect only. With runIds, omitted view or summary returns batch mode even for one ID; other views require one ID and return single mode. Output includes partial text; diagnostics shows activity/errors; final is empty until verified success. Launch contains sensitive prompt and context; inspect explicitly.",
  })),
  mode: Type.Optional(StringEnum(WAIT_MODES, {
    description: "Wait only: any returns at first settlement. All (default) waits for every target unless a selected workflow fails, is cancelled, or times out. Check data.pending; wait never cancels those runs.",
  })),
  cursor: Type.Optional(Type.String({
    description: "List runs or batch inspect: use data.nextCursor. Single inspect (data.mode = single): use data.page.nextCursor. Keep the same filters, IDs, and view.",
  })),
  workflowCursor: Type.Optional(Type.String({
    description: "Unfiltered list only. Use data.nextWorkflowCursor to page workflow roots; omit cursor to page only workflow roots.",
  })),
  limit: Type.Optional(Type.Integer({
    minimum: 1,
    maximum: 100,
    description: "List only: maximum entries per page.",
  })),
  limitBytes: Type.Optional(Type.Integer({
    minimum: 4,
    maximum: 65536,
    description: "UTF-8 byte limit per inspect page or shared across wait results in request order (wait default 32768). Follow cursors or result refs for more.",
  })),
  workflowRunId: Type.Optional(Type.String({
    description: "List only: show this wf_… workflow’s children instead of session runs and workflow roots. Page with cursor.",
  })),
  reason: Type.Optional(Type.String({
    maxLength: 512,
    description: "Cancel only: reason recorded with the run evidence.",
  })),
});

export type ExternalRunsParameterKey = keyof typeof externalRunsParameters.properties;

export const EXTERNAL_RUNS_PARAMETER_KEYS = Object.keys(
  externalRunsParameters.properties,
) as readonly ExternalRunsParameterKey[];

export const EXTERNAL_RUNS_EXAMPLES = {
  list: { action: "list" as const },
  listWorkflowChildren: { action: "list" as const, workflowRunId: "wf_example" },
  listRunsNextPage: { action: "list" as const, cursor: "cursor_from_nextCursor" },
  listWorkflowsNextPage: { action: "list" as const, workflowCursor: "cursor_from_nextWorkflowCursor" },
  inspectSingle: { action: "inspect" as const, runIds: ["run_example"], view: "final" as const },
  inspectBatch: { action: "inspect" as const, runIds: ["run_example_1", "run_example_2"] },
  wait: { action: "wait" as const, runIds: ["run_example"], mode: "all" as const },
  cancel: { action: "cancel" as const, runIds: ["run_example"] },
  cancelWithReason: { action: "cancel" as const, runIds: ["run_example"], reason: "No longer needed" },
};

export type ExternalRunsExample = (typeof EXTERNAL_RUNS_EXAMPLES)[keyof typeof EXTERNAL_RUNS_EXAMPLES];

export interface ExternalRunsActionSpec {
  id: "list" | "list_children" | "inspect_single" | "inspect_batch" | "wait" | "cancel";
  label: string;
  action: (typeof EXTERNAL_RUNS_ACTIONS)[number];
  required: readonly ExternalRunsParameterKey[];
  optional: readonly ExternalRunsParameterKey[];
  inapplicable: readonly ExternalRunsParameterKey[];
  rule: string;
  example: ExternalRunsExample;
}

function defineActionSpec(spec: Omit<ExternalRunsActionSpec, "inapplicable">): ExternalRunsActionSpec {
  const allowed = new Set<ExternalRunsParameterKey>([...spec.required, ...spec.optional]);
  return {
    ...spec,
    inapplicable: EXTERNAL_RUNS_PARAMETER_KEYS.filter((key) => !allowed.has(key)),
  };
}

export const EXTERNAL_RUNS_ACTION_SPECS: readonly ExternalRunsActionSpec[] = [
  defineActionSpec({
    id: "list",
    label: "list (session runs + workflow roots)",
    action: "list",
    required: ["action"],
    optional: ["limit", "cursor", "workflowCursor", "workflowRunId"],
    rule: "Pass data.nextCursor as cursor for runs and data.nextWorkflowCursor as workflowCursor for workflow roots. Passing workflowCursor without cursor pages workflow roots alone.",
    example: EXTERNAL_RUNS_EXAMPLES.list,
  }),
  defineActionSpec({
    id: "list_children",
    label: "list (workflow children via workflowRunId)",
    action: "list",
    required: ["action", "workflowRunId"],
    optional: ["limit", "cursor"],
    rule: "workflowRunId (wf_...) lists only that workflow's children; pass data.nextCursor as cursor, not workflowCursor.",
    example: EXTERNAL_RUNS_EXAMPLES.listWorkflowChildren,
  }),
  defineActionSpec({
    id: "inspect_single",
    label: "inspect (single run, paged evidence)",
    action: "inspect",
    required: ["action", "runIds"],
    optional: ["view", "cursor", "limitBytes"],
    rule: `Use 1 ID in runIds with view ${SINGLE_INSPECT_VIEWS.filter((view) => view !== "summary").join("|")}; pass data.page.nextCursor as cursor with the same ID and view. Legacy programmatic runId also accepts summary.`,
    example: EXTERNAL_RUNS_EXAMPLES.inspectSingle,
  }),
  defineActionSpec({
    id: "inspect_batch",
    label: `inspect (batch summary, 1-${MAX_BATCH_INSPECT_TARGETS} runs)`,
    action: "inspect",
    required: ["action", "runIds"],
    optional: ["view", "cursor", "limitBytes"],
    rule: `1-${MAX_BATCH_INSPECT_TARGETS} IDs in runIds with view omitted or "summary"; pass data.nextCursor as cursor with the identical runIds array.`,
    example: EXTERNAL_RUNS_EXAMPLES.inspectBatch,
  }),
  defineActionSpec({
    id: "wait",
    label: `wait (1-${MAX_WAIT_TARGETS} runs)`,
    action: "wait",
    required: ["action", "runIds"],
    optional: ["mode", "limitBytes"],
    rule: `1-${MAX_WAIT_TARGETS} IDs in runIds; mode is ${WAIT_MODES.join("|")} (default all). A selected workflow that fails, is cancelled, or times out ends the wait even in all mode; check data.pending for runs still in progress. limitBytes is shared in request order.`,
    example: EXTERNAL_RUNS_EXAMPLES.wait,
  }),
  defineActionSpec({
    id: "cancel",
    label: "cancel (1 run)",
    action: "cancel",
    required: ["action", "runIds"],
    optional: ["reason"],
    rule: "1 ID in runIds (legacy runId also accepted); reason is optional (<=512 chars).",
    example: EXTERNAL_RUNS_EXAMPLES.cancelWithReason,
  }),
];

/**
 * Compact per-action argument matrix and minimal valid examples generated from
 * `externalRunsParameters` and `EXTERNAL_RUNS_ACTION_SPECS` so on-demand help
 * cannot drift from the executable tool contract.
 */
export function formatExternalRunsActionGuidance(): string {
  const rows = EXTERNAL_RUNS_ACTION_SPECS.map((spec) => [
    `- ${spec.label}: required: ${spec.required.join(", ")} | optional: ${spec.optional.join(", ") || "none"} | omit: ${spec.inapplicable.join(", ") || "none"}`,
    `  Rule: ${spec.rule}`,
    `  Minimal call: ${JSON.stringify(spec.example)}`,
  ].join("\n"));
  return [
    "external_runs action-specific arguments (supply only the relevant fields; omit inapplicable ones):",
    ...rows,
    `List pagination examples: runs stream -> ${JSON.stringify(EXTERNAL_RUNS_EXAMPLES.listRunsNextPage)}; workflow roots stream -> ${JSON.stringify(EXTERNAL_RUNS_EXAMPLES.listWorkflowsNextPage)}.`,
  ].join("\n");
}

/** One success variant per action (inspect has batch and single shapes); every expected failure has `data: null`. */
export const externalRunsOutputSchema = Type.Union([
  successVariant(TOOL, Type.Literal("list"), Type.Object({ runs, workflows: runs, nextCursor: cursor, nextWorkflowCursor: cursor })),
  successVariant(TOOL, Type.Literal("inspect"), Type.Union([
    Type.Object({ mode: Type.Literal("batch"), entries: runs, nextCursor: cursor }),
    Type.Object({
      mode: Type.Literal("single"),
      runId: Type.String(),
      view: strings(...SINGLE_INSPECT_VIEWS),
      page: Type.Object({
        /** UTF-8 bytes bounded by limitBytes. JSON pages may be fragments: concatenate one cursor sequence before parsing. */
        text: Type.String(),
        encoding: strings("json", "text"),
        complete: Type.Boolean(),
        nextCursor: cursor,
      }),
      finalAvailable: Type.Optional(Type.Boolean()),
      outputStatus: Type.Optional(strings("preliminary", "final", "interrupted")),
    }),
  ])),
  successVariant(TOOL, Type.Literal("wait"), Type.Object({ mode: strings(...WAIT_MODES), completed: runs, pending: Type.Array(Type.String()) })),
  successVariant(TOOL, Type.Literal("cancel"), Type.Object({ runId: Type.String(), status: strings("requested", "terminal") })),
  failureVariant(TOOL, strings(...EXTERNAL_RUNS_ACTIONS), Type.Null()),
]);

