# Design: one public contract, three coordinated views

## 1. Constraints and principles

The execution runtime is unchanged. Existing `RunRegistry`, projections, run records, workflow journals, permission resolvers, and adapters remain authoritative. Add a thin public boundary, not another state machine. The new JSON contract is a proposal for this feature; it is not present in the inspected source.

Keep four concepts separate:

| Concept | Question |
|---|---|
| Invocation | Did this requested tool operation succeed? |
| Run lifecycle | Is the worker queued/running/terminal, and with what outcome? |
| Evidence | What is retained, available, complete, and inspectable? |
| Acceptance | Does the work meet the user's objective? This remains a main-agent/user judgment. |

An inspection succeeds even when it reveals a failed worker. A script succeeds even when a returned target is unsuccessful. A worker can exit successfully while producing inadequate work. None of these imply acceptance.

## 2. Host boundary

Each public tool declares an `outputSchema`. Its executor returns:

```ts
{
  content,                  // readable model-facing text
  details,                  // preserve existing renderer/progress payload
  structuredContent: receipt, // validated public data, not raw details
  isError: !receipt.ok
}
```

Use Pi's actual current types; this is the intended shape, not a drop-in implementation. Do not replace the existing `details` object with the public envelope: that would break renderers. Do not treat `details` as a public API.

The inspected Pi adapter passes structured results through even for data-bearing errors. Therefore callers must check `receipt.ok`; `try/catch` alone is insufficient. Host-side argument validation, blocked permission hooks, transport faults, and executor bugs can still throw or produce host-shaped failures. Both paths need tests. [S04, S13]

Validate the public shape in Flow's own serializer/tests; a declared JSON Schema is not a promise that all hosts validate outgoing values. Unexpected programming failures should fail loudly, not be converted into empty successful data. Never invent a run ID for a failure before registration.

## 3. Envelope

Normative draft shape (JSON Schema and fixtures are in `contracts/`):

```ts
type FlowResult = {
  contractVersion: 1;
  tool: "Agent" | "workflow" | "external_runs" | "external_help";
  action: "run" | "list" | "inspect" | "wait" | "cancel" | "help";
  ok: boolean;
  observedAt: string; // ISO timestamp when this response was projected
  data: ToolSpecificData | null;
  warnings: Array<{ code: string; message: string }>;
  error?: { code: string; message: string; runId?: string };
};
```

`error` is required iff `ok:false`. `observedAt` is receipt freshness, not proof of recent worker activity. When data exists on an error, keep it. An unavailable historical field is omitted or explicitly unknown; it must not be reconstructed from today's settings. No full prompts, secrets, tokens, environment values, or user-config snapshots in the default envelope.

Contract version 1 describes the output boundary only. Do not increment settings v4, workflow `meta.apiVersion`, or journal versions merely to add it. Readers must check `contractVersion`; future unknown versions fail actionably rather than falling back to status-text scraping.

## 4. Run receipt/projection

Reuse `projectLiveAgent`, `projectDurableAgent`, `projectWorkflowRun`, and `normalizeRunStatus` as the inputs to a small public serializer. These functions already separate live/durable facts and normalize workflow `completed` to `done`. [S06]

The stable public run fields are:

```ts
type PublicRun = {
  runId: string;
  kind: "agent" | "workflow";
  live: boolean; // backed by current registry ownership, never a stale file label
  task: { description?: string; name?: string; backend?: string;
          harness?: string; profile?: string; workflowRunId?: string };
  state: { status: "queued" | "running" | "done" | "error" | "aborted"
                    | "interrupted_or_uncertain";
           outcome?: "succeeded" | "failed" | "cancelled" | "timed_out";
           error?: string };
  timing: { queueDelayMs?: number; elapsedMs?: number;
            activityAgeMs?: number; processDurationMs?: number };
  output: { available: boolean; finalAvailable: boolean;
            delivery: "none" | "inline" | "reference";
            value?: unknown };
  evidence: { integrity: "complete" | "incomplete" | "unknown";
              refs: Array<{ runId: string; view: "summary" | "output"
                             | "diagnostics" | "final" | "launch" }> };
  handledFailures?: number;
};
```

Normalize only at the public boundary; do not change internal lifecycle vocabularies. Outcome is absent for queued/running or genuinely unknown history. Use existing settled outcomes for failure subtype; do not infer `timed_out` from an error string. A success-valued workflow `null` remains `value:null` with `finalAvailable:true`.

Keep public data small. Proposed default: inline a canonical terminal value up to 16 KiB of UTF-8 JSON representation; above that use `delivery:"reference"`, omit `value`, and return the existing final/output route. A summary/list row never embeds full child output. Do not clip an object and pretend it is valid structured data. `none` means no value is available/returned at this stage; `reference` means retrieval is required. An inline canonical value requires `finalAvailable:true`; partial text belongs to an explicit inspection page, not this field.

`integrity` comes from actual evidence state, not merely terminal status. `unknown` is preferable to a made-up guarantee. `refs` are bounded routing handles; a final route can be queried before a final exists and then reports unavailable. Ref existence alone does not establish content availability. Default refs need not include `launch`; keep launch inspection explicit and sensitive.

No raw `recordPath` is required for machine composition. Keep local filesystem paths in the existing advanced inspector where appropriate. References remain subject to existing session/project ownership, retention, and stale-cursor rules.

## 5. Tool-specific data and errors

### Agent / workflow

`data:{run:PublicRun|null}`. Before registration, `run:null`. Background registration returns `ok:true` and a queued/running run. Foreground success returns a terminal run and an inline value or reference. Foreground failed/cancelled/timed-out outcomes return `ok:false`, error data, and evidence when available.

A workflow that explicitly handles a child failure can succeed: preserve `ok:true` and successful root state, while exposing `handledFailures` and a warning when that count is known from the workflow events/journal. Do not derive a total from the UI's truncated child array. If the count is not recorded historically, omit it.

### external_runs list

`data:{runs:PublicRun[],workflows:PublicRun[],nextCursor?,nextWorkflowCursor?}`. Keep the existing independent cursor streams, initial live/durable merge, deduplication, and workflow-child filter. Do not flatten two pagers into a cursor that silently loses one stream. Preserve order; completeness requires exhausting the relevant cursors.

### external_runs inspect

Two discriminated payloads:

- Batch summary: `{mode:"batch",entries:PublicRun[],nextCursor?}`.
- Single-run view: `{mode:"single",runId,view,page:{text,encoding,complete,nextCursor?},finalAvailable?,outputStatus?}`.

Retain single-view UTF-8 paging rather than inventing a second cursor mechanism. `encoding` is `text`, `json`, or `ndjson`, derived from the actual view serializer. A JSON page may be a fragment. Concatenate all pages from the same sequence before parsing; never parse each fragment independently. Workflow `final` preserves its existing JSON document containing the canonical result; an agent final page can be plain text. If final is unavailable, return empty page text plus `finalAvailable:false`, not a fabricated explanation as the result. [S07]

The structured batch payload must never stringify `entries` as human prose. Singleton selection retains its existing normalization to a single-run view; callers discover this exact shape, rather than relying on raw renderer details. Read-only inspection of a failed or cancelled run returns `ok:true`.

### external_runs wait

`data:{mode:"any"|"all",completed:PublicRun[],pending:string[]}`. Preserve selected request order, deduplication, early return for an unsuccessful workflow, shared result byte budget, and all still-pending IDs. A failed target is not an invocation error. Do not cancel pending work on `any`, or retry failed targets.

### external_runs cancel

`data:{runId,status:"requested"|"terminal"}`. `requested` does not claim process termination. A terminal receipt means already terminal as established by the existing registry/records. Unowned/uncertain historical work that cannot be cancelled safely returns `ok:false`; do not claim retrospective cleanup.

### Error codes

Suggested stable first-release set: `INVALID_REQUEST`, `CONFIG_INVALID`, `SELECTION_UNAVAILABLE`, `CAPABILITY_UNSUPPORTED`, `RUN_UNAVAILABLE`, `CURSOR_INVALID`, `PAGE_TOO_SMALL`, `CONTEXT_UNAVAILABLE`, `CONTEXT_TOO_LARGE`, `RUN_FAILED`, `RUN_CANCELLED`, `RUN_TIMED_OUT`, `CANCELLATION_UNCONFIRMED`.

Assign codes where the condition is known; do not parse English error messages into codes. Keep unknown/cross-session/cross-project IDs intentionally indistinguishable as `RUN_UNAVAILABLE`. Do not include sensitive target details in that failure. Configuration problems discovered by a read-only capability query can instead be returned as explicit unavailable capability data; discovery itself need not pretend a launch occurred.

## 6. Pagination and size compatibility

Do not hide new overhead inside old byte-budget promises. The existing APIs have different budgets; document them precisely rather than silently changing them:

- Single-run inspection: `limitBytes` continues to bound the actual `page.text` bytes. Structured metadata adds a small documented envelope, not another unbounded body. Preserve UTF-8 boundaries and content-sensitive stale cursors.
- Batch inspection: account for the FULL new structured response, including wrapper/cursor overhead, when selecting whole entries under `limitBytes`. If even one entry cannot fit, `PAGE_TOO_SMALL`; never emit an empty non-advancing page. Preserve validation of every requested target before returning any page.
- Wait: keep the existing shared result-payload budget, not one allowance per child. Omit oversized inline values in favour of refs; preserve existing human-content truncation flags/routes. Do not silently turn a partial result into a complete value.
- List: keep count pagination and the two cursor streams; do not imply the count limit is a byte limit.

Use one page-selection decision per response for both machine and human views. Do not generate independent cursors/pages for each representation. Preserve current text content semantics where other users may depend on them; adding structured data is not permission to rewrite every human response.

## 7. Three views without three truth stores

Pipeline: existing registry/journal/evidence → shared sanitized public projection → (a) machine envelope, (b) readable status, (c) refs to the existing inspector. Continue passing the richer internal progress `details` to renderers where needed. The shared terminal facts must come from the same settled source, never separate ad hoc inference.

Preserve the existing task/purpose, role/harness, access and context disclosures, background receipt label, phase tree, freshness, hidden-child counts, and inspect route. A stopped parent wait does not imply a stopped child. A historical record does not animate. No raw JSON wall, full launch prompt, or fabricated final answer in the default card. Bro is not changed; main-agent milestone explanations remain useful.

Redaction applies to BOTH `content` and `structuredContent` before return. Pi hooks that replace only content can drop structured content; test that no caller bypasses this by loading raw `details` or private records. Detailed launch inspection stays opt-in and scoped. Public data must not widen access to retained evidence. [S13]

## 8. Concise discovery

Retain existing `external_help` topics. Add:

```ts
external_help({ topic:"contracts" })             // small index
external_help({ topic:"contracts", tool:"Agent" }) // one exact contract
external_help({ topic:"capabilities", harness:"pi-example" })
```

`tool` is an optional new selector restricted to actual public tool names. `harness` retains its legacy semantics for existing topics and filters capabilities in the new topic. Preserve blank/whitespace placeholder handling. Return `structuredContent` for help too; retain readable text.

A contract detail contains the actual input schema, the public output schema, concise semantic notes, a small validated example, and relevant workflow helper signatures. Generate schema content from registered definitions or their shared source modules. Do not copy schemas into a parallel handwritten string. The index lists names and one-line purposes; full schemas are pulled only when needed. Existing model-specific schema conversions must be tested against this export.

A capability record separates configured/enabled status from support and readiness:

- structured output: supported / unsupported / unknown;
- resume: supported / unsupported / unknown;
- budget enforcement: enforced / not_enforced / unknown;
- cost reporting: native / estimated / partial / unavailable / unknown;
- supported permission tiers and actual enforcement mechanism, with platform/UID/preset conditions;
- context modes and limits; CLI resources vs named-Pi resources;
- readiness: `not_probed` unless an existing explicit check supplied evidence.

Build this from shared capability descriptors used by existing launch validation and help. Avoid a second capability table that drifts. Do not refactor adapter execution behaviour. Do not spawn processes, inspect credentials, or invoke a provider merely to show help. No intelligence ranking, automatic harness substitution, or unsupported feature advertised as a fallback. [S08, S11]

Declare `contracts`/`capabilities` details in help schemas, but do not inline all harnesses and full manuals into every parent prompt. Describe one backend at a time when requested; retain only a small index/default summary upfront.

## 9. Compatibility and release

Test against pinned Pi 0.99.2. The repository's current dev pins are 0.79.4, so a schema-only unit test is insufficient. First prove a fake-backed extension registration, direct call, nested codemode call, typed error, hooks, and renderer in the real target host. Then align development dependencies deliberately. Do not opportunistically upgrade unrelated packages. [S02, S03]

Recommended release contract: certify the new machine API for Pi >=0.99.2 and <1, subject to the tested matrix. Preserve older direct-mode support only if deliberately tested; do not claim compatibility from wildcard peers. Update the relevant host peer ranges/support notes according to actual tests. This is host compatibility work, NOT replacement of Flow's runtime.

Keep existing tool names, input selectors, settings, workflow source/header format, run IDs, journals, context modes, and replay behaviour. New output fields are additive for ordinary callers. Error signalling becomes intentionally more accurate; document that change. No automatic conversion of old run records is needed; projections label missing evidence as unknown.

## 10. Context integration boundary

Within one codemode call, intermediate results and `store()` values do not automatically become child context. In a Flow workflow, each child selects from the invocation-time parent snapshot. Current source explicitly excludes pending calls and selects from the current branch. [S09]

The implementation must document and test the existing explicit alternative: inspect/validate a result, assemble a bounded evidence section, pass it in the next task prompt, and choose `none`, `recent`, `full`, or supported resume deliberately. Do not add a new handoff mode here. The separate context note describes a measured follow-up, not scope expansion.

Sources: [06_SOURCE_MAP.md](06_SOURCE_MAP.md). Schemas: [contracts/README.md](contracts/README.md).
