import { Type } from "typebox";
import { failureVariant, strings, successVariant } from "./envelope.ts";
import { supervisedRunSchema } from "./run.ts";

const TOOL = "external_runs";
const runs = Type.Array(supervisedRunSchema);
const cursor = Type.Optional(Type.String());

export const SINGLE_INSPECT_VIEWS = ["summary", "output", "diagnostics", "final", "launch"] as const;

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
  successVariant(TOOL, Type.Literal("wait"), Type.Object({ mode: strings("any", "all"), completed: runs, pending: Type.Array(Type.String()) })),
  successVariant(TOOL, Type.Literal("cancel"), Type.Object({ runId: Type.String(), status: strings("requested", "terminal") })),
  failureVariant(TOOL, strings("list", "inspect", "wait", "cancel"), Type.Null()),
]);
