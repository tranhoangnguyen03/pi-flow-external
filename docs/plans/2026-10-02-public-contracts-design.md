# Public contracts for workflow, supervision, and discovery (#77, #79, #78)

**Status:** design revision 2. It reconciles one independent review round (Claude and agy: both "approve with changes"; see Appendix A). No code has changed yet.
**Goal:** finish the public-contract programme.
- #77: `workflow` and every `external_runs` action return versioned, typed results.
- #79: `external_help` reports truthful per-harness capabilities.
- #78: contract help is generated from the executable schemas.

All three reuse the boundary #76 shipped for `Agent`.
**Inputs:**
- Issues #77, #78 and #79.
- #76 as shipped: `src/public-contract.ts`, `src/core/errors.ts`, `docs/agent-public-contract.md`.
- Three read-only audits: Claude on #77, agy on #79, pi-astra on #78. Each also cross-checked one other issue. Spot-checks against the source.

## 0. Ground rules

1. **Shipped #76 is the pattern.** The handoff draft in `docs/pi-flow-external-codemode-handoff/` is not: it uses `RUN_FAILED`-style codes, `action:"run"` for Agent, warnings as objects, and `evidence.refs`. Everything here extends the shipped forms:
   - lowercase codes in `FLOW_ERROR_CODES`;
   - `action:"delegate"`;
   - `warnings: string[]`;
   - `run.refs` as callable `external_runs` argument objects.

   The issue texts' `PAGE_TOO_SMALL` becomes `page_too_small`.
2. **The model only ever sees `content`.** Pi's `createToolResultMessage` copies `content`, `details` and `isError`, but never `structuredContent` (`pi-agent-core/dist/agent-loop.js:649-660`). Native codemode resolves a call to `structuredContent` whenever the tool declares `outputSchema`, even when `isError` is set (`codemode/execute.js:172-178`). Three consequences:
   - Every fact a model needs stays in readable `content`.
   - Typed failures must be *returned*, not thrown, or scripts never see their codes.
   - Every public tool declares `outputSchema`.
3. **`isError` colours the TUI row red** (`tool-execution.js:228`). `isError === !ok`, and `ok` describes the *operation*, never the target run. Inspecting or waiting on a failed run is `ok:true`.
4. **Three channels, one source.** A call writes three things:
   - `content`: model-readable text;
   - `details`: the renderer/progress payload. It is unchanged and stays non-public;
   - `structuredContent`: the public contract.

   All three come from the same settled projection and the same page-selection decision. There is no second record format, cursor system, or capability table. Section 2.5 lists exactly where `content` changes.
5. **No runtime replacement.** Execution, the registry, journals, run records, permissions, retries, resume and replay behave as they do today. The audit bugs that the contract would otherwise cement are fixed in place (§5.4).

## 1. Shared foundation

### 1.1 Module layout

| File | Owns |
|---|---|
| `src/contract/envelope.ts` | The `contractEnvelope(...)` schema factory, the `envelope()` builder, `INLINE_RESULT_BYTES`, `deliverValue()` (redact, then measure, then inline or reference), and the `withContract()` executor wrapper (§1.4). |
| `src/contract/run.ts` | `publicRunSchema({kinds, statuses})` builder, `publicRun()` serializers (live/durable agent, live/journal workflow), `runRefs()`. Built on `src/core/run-projection.ts`, which it does not replace. |
| `src/contract/agent.ts` | `agentToolParameters`, moved out of `pi-subagent.ts` (the only schema in the help import cycle), plus `agentOutputSchema` and `agentReceipt()`. |
| `src/contract/workflow.ts` | `workflowOutputSchema`, `workflowReceipt()`, `AGENT_OPTION_KEYS` and `WORKFLOW_HELPERS` (§4.3). |
| `src/contract/runs.ts` | `externalRunsOutputSchema` and the per-action data builders. |
| `src/contract/help.ts` | `externalHelpOutputSchema` and the `PUBLIC_TOOLS` index (§4.1). |
| `src/core/capabilities.ts` | The backend capability descriptor (§3), a core fact source. |

- Input schemas without the cycle problem stay where they are and are exported: `workflowToolParameters` from `workflow/source.ts`, `externalRunsParameters` from `external-runs.ts`, `externalHelpParameters` from `external-help.ts`.
- `src/contract/` owns every **output** contract plus Agent's input schema.
- `src/public-contract.ts` is deleted, and its imports move to `src/contract/agent.ts`.

### 1.2 Envelope (#76, generalised)

```ts
{ contractVersion: 1, tool, action, observedAt, ok, data, warnings: string[], error?: { code, message } }
```

| Tool | `action` | Success `data` | Failure `data` |
|---|---|---|---|
| Agent | `delegate` | `{run}` | `{run: PublicRun \| null}` (unchanged) |
| workflow | `run` | `{run}` | `{run: PublicRun \| null}`, where `null` means before registration |
| external_runs | the requested `action` | the per-action payload (§2.3) | `null` |
| external_help | `help` | the per-topic payload (§3.4, §4.1) | `null` |

Rule: when the operation *is* a run (Agent, workflow), the failure keeps its subject run, because failed runs carry evidence. Read-only tools return `data: null` on failure, so a partial page can never be mistaken for a result.

### 1.3 Error vocabulary: extend `FLOW_ERROR_CODES` once

| Code | Meaning |
|---|---|
| `request_invalid` | The parameters are malformed or contradict each other: bad ID format, both selectors given, a target count out of bounds, batch inspect with a non-summary view, `limitBytes` not finite, more than one workflow source, or `resumeFromRunId` without `scriptPath`. |
| `run_unavailable` | The run is unknown, belongs to another session or project, or was removed by retention. These cases are deliberately indistinguishable. |
| `run_not_live` | The run is in this session but has no live owner, and its evidence is not terminal. A wait cannot complete and a cancel cannot be confirmed. |
| `cursor_invalid` | The cursor is malformed, or belongs to another run, view, list scope or target set. |
| `cursor_stale` | The run or its retained evidence changed while paging, including when the cursor now points past the available evidence. Restart without a cursor. |
| `page_too_small` | One whole batch entry plus its envelope exceeds `limitBytes`. |
| `session_unavailable` | The originating session is not persisted. |
| `script_invalid` | The workflow source failed parsing, `meta` or `apiVersion` validation. Nothing was launched. |
| `storage_unavailable` | Script persistence or journal setup failed before registration. These paths already return today and keep returning. |
| (existing) `selection_invalid` | Also used for an unknown help `harness` or `tool` selector, and an unknown saved workflow. |

- **Where codes are raised:** at their source, as `ExpectedFlowError`. Sources are the assertion helpers and cursor decoders in `external-runs.ts`, `core/run-inspection.ts` and `workflow/journal.ts`. Each `{ok:false}` object returned by `workflow/source.ts` gains a `code` field; those paths are not converted into throws.
- **No message parsing:** the projection decoder's `"stale"` sentinel and re-throw (ER:355-362) become a direct `ExpectedFlowError("cursor_stale")`, with a regression test that a broad `catch` does not collapse it into `cursor_invalid`.
- **One code table:** the implementation PR covers every throw site with one table-driven test, one row per site (§5.2).
- **Still thrown as host errors:**
  - interrupted waits ("Run wait aborted");
  - programming errors;
  - filesystem faults other than the workflow pre-registration paths above;
  - Pi argument validation;
  - `tool_call` blocks.

### 1.4 `withContract`: one wrapper, caller-owned failure data

```ts
withContract({ tool, action, redact }, async () =>
  ({ content, details, data, warnings?, error?: PublicError }))
```

- **Returned `error`:** produces `ok:false` and `isError:true`. `content`, `details` and `data` are kept exactly as the caller built them. Foreground Agent and workflow terminal failures use this path, so `data.run`, the full human text and the renderer `details` all survive.
- **Thrown `ExpectedFlowError`:** produces `ok:false` and `isError:true`. `content` is the message, `data` is the tool's failure default (`{run:null}` or `null`), and `details` is the caller's prelaunch `details` if supplied, otherwise `{error}`.
- **Anything else** is rethrown.
- **`redact` is per tool:**
  - Agent and workflow redact `content` and the delivered canonical value, preserving #76.
  - external_runs and help never redact an already-cut page. Doing so would break `limitBytes` and could miss a secret split across a page boundary.
- **Rule: every served text is redacted at its source, before it is measured or sliced.**
  - Durable evidence is redacted when it is written (`run-record.ts:90,137-205`) and is served byte-exact.
  - Memory-sourced text is redacted in full by one helper (`redactedText()`), then measured and sliced. That covers live output and diagnostics pages (`liveAgentOutput`, `external-runs.ts:375-381`, served at :839-849), the legacy wait `result` from `outcome.result`, and every workflow view. Workflow journals are not redacted at write, so journal-sourced views count as memory-sourced too. None of these is redacted today. Cursor revisions are computed over the redacted text.
  - Every `deliverValue()` call redacts the value it inlines before measuring it. That is where `output_redacted` comes from.

  So whether text comes from disk or memory, no surface serves unredacted text.

Agent's local `receipt()` (`pi-subagent.ts:370-377`) is rewritten as a caller of `withContract`.

### 1.5 `PublicRun`: one builder, per-tool subsets

```ts
{
  runId, kind, live,
  task:     { description?, profile?, backend?, harness?, workflowRunId?, name?, source? },
  state:    { status, outcome?: "succeeded" | "failed" | "cancelled" | "timed_out" },
  timing:   { ...RunTiming },              // workflow: {} until derived
  output:   { available, finalAvailable, delivery: "inline" | "reference" | "none", value? },
  evidence: { integrity: "complete" | "incomplete" | "damaged" | "unknown" },
  children?: { count?: number, failed?: number },   // workflow only (§2.2)
  refs?:    { summary, final, diagnostics }         // callable external_runs args (#76 form)
}
```

- **Per-tool schemas.** `publicRunSchema({kinds, statuses})` builds each tool's schema:
  - Agent stays exactly as shipped: `kind: "agent"`, five statuses, no `children`. Its native declaration therefore does not grow.
  - workflow uses `kind: "workflow"`.
  - Supervision uses both kinds plus `interrupted_or_uncertain`.
- **`deliverValue(value, {inlineBudget, inspectable})`** is the single delivery rule. Values are all-or-nothing, and a truncated value is never returned as `value`.
  - Agent and workflow receipts use a 16 KiB inline budget.
  - list and batch rows use 0, so their delivery is always `reference` or `none`.
  - wait follows §2.3.
- **Workflow integrity** comes from the journal. This fixes B4.
  - `complete`: `run_start` and a terminal line were parsed, with no bad line.
  - `incomplete`: there is no terminal line, or only the final line is torn (an in-flight run or a crash).
  - `damaged`: a malformed line mid-file, or a run-ID mismatch.
  - `unknown`: the journal version is unsupported or unreadable.

  Live workflows report `incomplete` until settled, matching #76. A journal read that fails after settlement reports `unknown` and never discards the settled result.
- **`refs` routing.**
  - `refs.summary` is batch inspect with one ID, which returns `PublicRun` entries.
  - `refs.final` and `refs.diagnostics` are single-ID non-summary inspects, which normalise to single-run pages.

  This is today's behaviour; it is now documented (B6).

## 2. #77: workflow and external_runs contracts

### 2.1 `workflow` declares `outputSchema`

| Path | `ok` | `error.code` | `data.run` |
|---|---|---|---|
| Catalog blocked | false | `configuration_invalid` | null |
| More than one source; resume without `scriptPath` | false | `request_invalid` | null |
| Unknown saved workflow | false | `selection_invalid` | null |
| Parse, `meta` or `apiVersion` failure | false | `script_invalid` | null |
| Resume source missing, unreadable, or in another project | false | `run_unavailable`. Fixes B10: another project's run is no longer revealed. | null |
| Script persistence or journal setup failure | false | `storage_unavailable` | null |
| `registry.start` reports a closed session | false | `session_closed`. Fixes B2: the error is caught and the already-written journal is finished as `run_error`. | null |
| Background run accepted | **true** | — | queued or running run |
| Foreground run succeeded | **true** | — | terminal run; value inline if ≤16 KiB, otherwise `reference` |
| Foreground run failed, cancelled or timed out | false | the outcome | terminal run with evidence |

`content` and `details` stay as they are today. Inner script semantics are unchanged:
- `agent()` return values and `ChildRunError`;
- the un-awaited-call guard;
- the limiter and sibling draining;
- the frozen catalog and context;
- successful-prefix replay.

**New visible behaviour:** failed workflows now set `isError`, which turns the TUI row red (§2.5).

### 2.2 Handled child failures: counted at the single delivery site

A script learns that an `agent()` call failed only through the **non-fatal** `agentResult ok:false` reply (`workflow/runtime.ts:484-490`). That reply covers:
- child failures;
- children that never launched;
- failures that happen before the child has an index, such as `context_invalid`.

The fatal reply (`runtime.ts:476-483`) is **excluded**. A fatal error always fails the root, and that includes the worker's own max-calls rejection, which calls `markFatal` (`script-worker.ts:130-134,175-178`).

On a **successful** root, the worker has already rejected every unobserved failed promise chain (`script-worker.ts:376-378`). The number of non-fatal replies is therefore exactly the number of handled failures.

The count is also exact for **resumed** runs. A result is reused only when all of these hold (`runtime.ts:229-230`):
- it was not a failure;
- its fingerprint matches;
- it is still inside the unchanged prefix, which ends at the first miss.

Every failure in a resumed run is therefore a fresh run of that child in this attempt, delivered through the same non-fatal reply. The count covers only this attempt; earlier attempts' failures are never carried over.

- `runWorkflow` counts those replies and returns `childFailures` with the result.
- `executeWorkflow` carries the count to the registry `outcome()` as `children: {count, failed}`, and to the journal. `run_complete` and `run_error` gain an optional `childFailures` field. This is additive; `JOURNAL_VERSION` stays 1.
- `PublicRun.children.failed` is present **only** when it comes from those two sources. Older journals omit it, which means the count is unknown. It is never derived from snapshot rows, which undercount.
- When `ok:true` and `failed > 0`: add the warning `handled_child_failures` and one sentence in `content`. The model needs the sentence; it cannot see `structuredContent`.
- Both the success and the failure path emit the final snapshot to the registry before returning. Today the registry can lag (WT:554, 570-575).

### 2.3 `external_runs` declares `outputSchema`; payloads are discriminated

**list**: `data: {runs: PublicRun[], workflows: PublicRun[], nextCursor?, nextWorkflowCursor?}`.
- **Preserved:** the two cursor streams, ordering, and the `workflowRunId` filter.
- **`nextCursor` means *scan incomplete*,** not *more rows exist*. `listRunRecords` stops at `MAX_LIST_SCAN`, so an empty next page is possible. This is now documented.
- **B1 (live work misreported), fixed on every page.** Every durable or journal row whose `runId` is in the registry uses the live projection. Live entries with no persisted row yet are paged first, inside the same `limit`, through an unpersisted stage of the same opaque list cursor; after them the cursor starts the persisted listing. Live work is never reported as interrupted, and pages never exceed `limit`. Tests cover a run that sits beyond page 1 while live, and registry-only runs at `limit: 1`.
- **B3 (one bad journal fails the whole list), fixed:** a journal that fails to load becomes one row with `status: interrupted_or_uncertain` and `integrity: damaged` (or `unknown` for an unsupported version). It no longer fails the whole list.

**inspect, batch** (`runIds`, summary view): `data: {mode: "batch", entries: PublicRun[], nextCursor?}`.
- Ownership is validated for every target before any page is returned (unchanged).
- **Each entry is measured twice:** as the legacy `{entries, nextCursor}` text, and as the full structured envelope including the cursor. An entry is served only if **both** fit. This keeps the same entries and one cursor in both channels.
- If the first entry does not fit both, the call returns `page_too_small`.
- Content pages may therefore hold fewer entries than today (§2.5).

**inspect, single**: `data: {mode: "single", runId, view, page: {text, encoding, complete, nextCursor?}, finalAvailable?, outputStatus?}`.
- **`page.text`** is the view's page text, bounded by `limitBytes` in UTF-8 bytes. The envelope adds a small fixed overhead, which is documented.
- **`encoding` is the page serialization:**
  - `json` for agent summary and launch, and for every workflow view;
  - `text` for agent output, diagnostics and final.

  An agent final value is the canonical result string verbatim. A schema-constrained workflow child stores JSON text there; this is documented.
- **`complete`** means there is no `nextCursor`. JSON pages may be fragments, so callers must concatenate one cursor sequence before parsing.
- **B9 (multi-item pages are not lossless), fixed by an explicit change.** Every message after the first is preceded by one `\n` separator, and cursor offsets count over that separated text. agy/muse streaming deltas with the same id continue their message without a separator, so the cursor also records what preceded its position. As a result, the pages of an output or diagnostics stream concatenate losslessly. Tests cover multi-page, multi-item streams and old-offset rejection, where an old cursor fails as `cursor_stale`.
- **Unavailable output.** `final` stays an empty page with `finalAvailable:false`. For output and diagnostics, `content` keeps its "No output is available" sentence, but `page.text` is `""`.

**wait**: `data: {mode, completed: PublicRun[], pending: string[]}`.
- **Preserved:** request order, deduplication, the early return for an unsuccessful workflow, the rule that wait never cancels pending work, and legacy `content` and `details.outcomes`. `renderWaitResult` and `scripts/e2e/external.mjs` read the last two.
- **One budget per channel, both spent in request order.** `completed[i].output.value` is inline only when all three of these hold:
  1. the canonical terminal value is **in memory** (registry `outcome.result`);
  2. that entry's legacy `result` text was **not truncated** by the existing shared budget;
  3. its redacted JSON fits both 16 KiB and what remains of the structured channel's own copy of `limitBytes`, which each inlined value spends.

  Otherwise delivery is `reference`, with `refs.final`. Text and JSON sizes differ (escaping can double a string), so the text decision alone cannot keep #77's "fits the remaining shared budget" promise. This mirrors batch inspect, where each channel stays within `limitBytes`.
- **No new disk reads.** Durable targets are always delivered by reference, and the no-evidence-read rule after the budget is exhausted is unchanged.
- The structured value never contains output-view narration. That resolves B5 for machine callers; the legacy text keeps narration, which is useful for failures.

**cancel**: `data: {runId, status: "requested" | "terminal"}`.
- A run with no live owner and non-terminal evidence fails with `run_not_live`.
- The `"unknown"` result from `RunRegistry.cancel`, which is unreachable, now maps to `run_unavailable` instead of the "already terminal" text.
- `requested` never claims that the run has ended.

### 2.4 `/external runs` consumes the public contract

`external-command.ts` reads `structuredContent`, the same surface a script reads.
- `runAction` returns the envelope.
- `readSummary` and `showPages` use `data.page.text`, `data.page.nextCursor` and `data.finalAvailable`.
- Stale-cursor recovery checks `error.code === "cursor_stale"`. `readSummary` gains the same recovery (fixes B8).
- Any other `ok:false` result shows a notice and keeps the navigator open; today the navigator closes.

Renderers keep reading `details`.

### 2.5 Compatibility: every visible change

| Surface | Change |
|---|---|
| external_runs and workflow expected failures | Previously **thrown, now returned** with `isError:true` and the same message. Direct callers that used `.rejects` must check `ok` or `isError`. |
| workflow failure rows | Now `isError:true`, shown as a red TUI row. Previously never set. |
| Batch `content` pages | May hold fewer entries, because both encodings must fit. The cursor is shared. |
| Output and diagnostics page text | Items are now `\n`-terminated, and offsets shift. Old cursors fail as `cursor_stale`. |
| list | Live overlay on every page (B1); a damaged journal becomes a row instead of a failure (B3). |
| Unknown help harness filter (`roles`/`permissions`) | Previously thrown, now returned `selection_invalid`. |
| Live output and diagnostics pages, legacy wait `result` from memory, live workflow views | Now redacted before slicing; previously served unredacted. |
| Everything else in `content` and `details` on success; inputs, IDs, journals, run records | Unchanged. The journal gains an optional `childFailures` field. |
| README and schema text | A singleton `runIds` summary returns batch entries; the `launch` view is documented (B6). |

The CHANGELOG lists every row above, with a table mapping each old thrown message to its new code.

## 3. #79: truthful capability discovery

### 3.1 One descriptor for facts no helper already provides

```ts
// src/core/capabilities.ts
BACKEND_CAPABILITIES: Record<SubagentBackend, {
  boundary: "external_cli" | "pi_sdk",
  workflowChildSchema: { support: "supported" | "unsupported", mechanism: "cli_flag" | "schema_file" | "injected_tool" | "none" },
  resume:   { support: "supported" | "unsupported", mechanism?: string, conditions: string[] },
  budget:   "enforced" | "not_enforced",
  cost:     { kind: "native" | "estimated" | "partial" | "unknown", conditions: string[] },
  retries:  { extension: "none" | "once_on_infrastructure", native: "none" | "internal" | "unknown" },
  nestedAgentDetection: boolean,
  permissionCaveats: string[],     // only the prose no helper computes
}>
```

| backend | child schema (workflow `agent({schema})`) | resume | budget | cost | extension / native retry | nested detection |
|---|---|---|---|---|---|---|
| claude | `--json-schema` | `--resume` | **enforced** (`--max-budget-usd`, only when >0) | native | none / unknown | yes |
| codex | `--output-schema` file | `exec resume` | not | **estimated** (local price table; unknown if the model is unmapped) | none / unknown | yes |
| agy | `--json-schema` | `--conversation` | not | unknown | **once on infrastructure** / unknown | yes |
| grok | `--json-schema` | `--resume` | not | native | none / unknown | yes |
| muse | `--output-schema` file | `--session-id` | not | unknown | none / internal (≤10) | **no** (deliberately) |
| opencode | **unsupported** (rejected inside the adapter) | `--session`, refused for restricted tiers | not | **partial** (unknown when a message lacks usage, or a subagent ran) | none / internal (≤10) | yes |
| pi | injected `structured_output` tool (workflow tool) | **unsupported** (in-memory session) | not | native, from Pi SDK stats; whether provider-reported or computed is documented as "Pi SDK" | none (SDK retry disabled) | no (delegation tools excluded) |

The descriptor **describes, and changes no behaviour**. The opencode schema rejection and the pi resume failure stay where and how they happen today, per #79's "unchanged" gate. Earlier rejection would be a separate issue.

**Derived, not copied:**
- Per-tier support, `enforced` and `caveat` come from calling `unsupportedPermissionReason` and `resolvePermission` for each tier.
- The pi tool lists come from `PI_TIER_ACTIVE_TOOLS`.
- The context limit comes from a new `PARENT_CONTEXT_MAX_BYTES` constant, extracted from the inline literal at `parent-context.ts:107`.
- The `permissions` help text is generated from the same derived facts plus `permissionCaveats`. This replaces the handwritten `PERMISSION_HELP_BY_BACKEND` (`external-help.ts:45-53`) and fixes its pi line, which today lists the union of tools rather than each tier's tools.

**Single consumer swap:** the three separate `backend === "claude"` budget checks (`spawn.ts:262,433`, `subagent-render.ts:190`) read `budget === "enforced"` instead.

**Conformance tests** (`test/capabilities.test.ts`, one table-driven test per field) check each value against the **adapter-level evidence**, never against code that reads the descriptor:
- arg builders include or omit the schema and budget flags (`claude.ts:68-69`, `codex.ts:129`, …);
- the opencode adapter rejects a schema;
- `resolveResume` fails for pi;
- each usage function's `costKnown` and `costEstimated` combinations;
- the agy-only retry classifier;
- `hasNestedAgentActivity` per backend.

### 3.2 Conditions, evaluated without probing

- Claude under effective UID 0 (`process.geteuid?.()`): `auto` instead of bypass.
- Grok network blocking is Linux-only (`process.platform`).
- agy accepts only danger.
- Muse `--yolo` trusts the workspace.
- OpenCode uses application rules, not an OS sandbox, and plugins/MCP still load.
- pi uses curated tools, not an OS sandbox. Its resources depend on the preset and on `ctx.isProjectTrusted()`.

### 3.3 Capability record

```ts
{
  harness, backend, boundary,
  configuration: { state: "built_in" | "registered" | "invalid", enabled, diagnostics?, model?, thinking?, preset? },
  readiness: "not_probed",   // always; points to /external config harness test and /external doctor
  workflowChildSchema, resume, budget, cost, retries, nestedAgentDetection,
  permissions: { default, tiers: { readonly | edit | danger: { supported, enforced, caveat?, tools? } } },
  context: { modes: ["none", "recent", "full"], maxBytes, resumeConflict: true },
  resources?: { skills: "none" | "user" | "user_and_project", extensions: "none", promptTemplates: "none", themes: "none" }   // pi only
}
```

- `enabled` comes from `catalog.disabledHarnesses`.
- If the catalog is blocked, the index lists the built-in harnesses with `configuration.state: "invalid"` plus one diagnostics entry. Registered pi names may be unreadable, so none are guessed. Backend facts are still reported, because they do not depend on settings.
- Readiness is always `not_probed`. No readiness evidence is persisted, and configuration is not authentication.

### 3.4 `external_help({topic: "capabilities", harness?})`

- **No harness:** a compact index with one line per selectable harness: enabled, tiers, child schema, resume, budget, cost.
- **With a harness:** one full record.
- **Unknown harness:** `selection_invalid`. A blank placeholder counts as omitted.
- `content` is readable text rendered from the same records, and `data` is `{topic, harnesses}`.
- The topic spawns nothing, reads no credentials, calls no providers and writes nothing. A test asserts all four by stubbing `child_process` and the write paths.

Also in #79: running pi rows say `Pi SDK child · host access` instead of "external host access" (`subagent-render.ts:174-176`). This is an AGENTS.md disclosure invariant and a one-line fix in a file this issue already touches.

## 4. #78: generated contract discovery and explicit handoff

### 4.1 `external_help({topic: "contracts", tool?})`

`tool` is a `Type.String` validated at execute time, like `harness`, so a blank placeholder works (#62). An unknown value returns `selection_invalid`.

**Index** (no tool; UTF-8 bytes of `content` and of serialized `data` each ≤ 1.5 KiB, enforced by a test):
- For each tool: name, actions, `contractVersion`, a one-line purpose, and `registered` (false for workflow when it is disabled).
- The rules:
  - check `ok`, not only try/catch;
  - returned typed failures versus thrown host errors;
  - inline versus reference delivery;
  - background `ok` means accepted, not finished;
  - follow cursors to completion;
  - operation success versus target outcome versus task acceptance.
- A pointer to native `describeTool` for TypeScript declarations.

**Detail**: `{tool, contractVersion, input, output, semantics, examples, helpers?}`.
- `input` and `output` are the **same schema objects** the tool registers.
- Tests assert deep equality with the registered definitions, and run `Value.Check` on every example receipt.

**Help's own contract:** `externalHelpOutputSchema` declares `data` as `{topic, harness?, tool?, text}` for the four prose topics, plus `index | contract` or `harnesses` for the structured topics. Existing topics keep their text, selector semantics, blank-placeholder handling, and the disabled-workflow availability text.

### 4.2 Fix the erased Agent input declaration (gated)

Pi renders a root `anyOf` before `properties` (`pi-codemode/dist/declarations.js:242-255`); root `allOf` has the same problem. The fix: each `anyOf` branch repeats the shared property definitions plus its selector constraint. The root `required` list and prohibitions are kept.

Gates:
1. **Accepted/rejected parity,** using Pi's own `validateToolArguments`. The table must cover role+subagent_type, role+harness, and the blank placeholders. Pi drops `not` when rendering, so the declaration may look more permissive than validation actually is.
2. **Rendering:** `describeTool("Agent")` renders the properties.
3. **Size:** the existing declaration bound (`agent-codemode.test.ts:106`, <12,000 bytes) still holds.

If any gate fails, keep the current schema and leave the limitation documented. Validation never moves into `execute`.

### 4.3 Workflow helper reference

- Export one `AGENT_OPTION_KEYS` constant, read by both `normalizeAgentOptions` (`runtime-values.ts:39`) and `WORKFLOW_HELPERS`. Unknown keys stay silently ignored, so behaviour is unchanged.
- `WORKFLOW_HELPERS` lists the signatures of `agent`, `parallel`, `pipeline`, `phase` and `log`, plus the globals `args` and `cwd`. The `workflow` help API line is rendered from it.
- A conformance test asserts that the helper and global names equal what `script-worker.ts` installs.

### 4.4 Explicit context handoff: docs and tests, no new behaviour

**Docs.** `docs/public-contract.md` replaces `docs/agent-public-contract.md`, plus a short section in the `usage` playbook.

The handoff pattern:
1. The parent chooses the intent and the evidence rules.
2. Code inspects the complete, authorized result: it checks `ok` and follows refs or cursors to completion.
3. Code embeds bounded, selected evidence in the next prompt.
4. The code deliberately picks `none`, `recent`, `full` or a supported resume.

Boundaries:
- Evidence is untrusted data, not authority.
- A Flow ref means nothing to a foreign CLI.
- Neither `store()` values nor nested results become parent history.
- Workflow snapshots stay frozen.
- Text explicitly printed into an outer result *does* become ordinary history.
- The docs state source freshness and omissions. Capture time does not prove the current state of the repository.

Copyable examples, each run by a test: batch inspect, typed error, paged final retrieval, explicit handoff.

**Tests** (`test/context-handoff.test.ts`, real Pi codemode with faux children):
1. **Positive:** evidence from child A, including quotes, newlines and multibyte text, reaches child B's prompt byte-for-byte with `context:none`. No root model turn runs in between.
2. **Negative control,** for both `recent` and `full`: A's unprinted result and a `store()` value are absent from B's context, including after a later codemode call.
3. Pending outer-call arguments and host nested IDs are excluded.
4. Independent workflow reviewers see no sibling verdict unless it is passed explicitly.

Assertions run outside hooks. Existing branch, compaction and replay tests are extended rather than duplicated.

## 5. Delivery

### 5.1 PR sequence (each PR leaves `npm run check` green)

| PR | Content | Label |
|---|---|---|
| **0: supervision fixes** | B1 (live overlay plus dedup), B2, B3 and B10, each with its regression test. These fix current behaviour, do not depend on the contract, and change no format. | `release:patch` |
| **1: #77** | `src/contract/` foundation; `withContract`; codes at source; source-side redaction of memory-sourced text; `PublicRun` builder with Agent unchanged; external_runs and workflow `outputSchema`; the wait and batch rules; `childFailures`; journal integrity (B4); `/external runs` migration (B8); README/schema text (B6); the page-format change (B9: `\n`-terminated items, shifted offsets, old cursors rejected, named in the CHANGELOG); `agent-codemode.test.ts` renamed to `contract-codemode.test.ts`. | `release:minor` |
| **2: #79** | Descriptor plus conformance tests, the budget consumer swap, generated `permissions` text, help `outputSchema`, the `capabilities` topic, the pi row label. | `release:minor` |
| **3: #78** | `tool` selector, contract index and detail, `AGENT_OPTION_KEYS` / `WORKFLOW_HELPERS`, the gated Agent input fix, handoff docs and tests. | `release:minor` |

Versions: `3.1.1-external.0`, `3.2.0-external.0`, `3.3.0-external.0`, `3.4.0-external.0`.

### 5.2 Tests (one authoritative test per behaviour)

| Behaviour | Where |
|---|---|
| Serializers: null/false/0/empty values, inline cap, integrity states, refs, per-tool subsets (Agent schema unchanged) | `test/public-contract.test.ts` |
| Every throw site mapped to a returned code (one table); interrupted waits still throw; `cursor_stale` is not collapsed | `test/external-runs.test.ts` (replaces about 22 `.rejects` assertions) |
| B1, B3, B9; batch dual measurement and `page_too_small`; wait inline rule, ordering and no new reads | `test/external-runs.test.ts` |
| Every action's `structuredContent` validates against its schema, only | `test/run-contract.test.ts` |
| Workflow receipts per path; handled-failure count (caught child, never-launched child, pre-index failure, fatal excluded); B2; journal integrity | `test/workflow.test.ts` |
| Real host: workflow and external_runs through native codemode; typed failures resolve rather than throw; `isError`; interrupting a wait does not cancel, interrupting a blocking call does | `test/contract-codemode.test.ts` |
| Nested usage is not counted twice in workflow or Agent receipts (extends the existing usage test) | `test/workflow.test.ts` |
| `/external runs` stale recovery through the error code | `test/external-command.test.ts` |
| Renderers tolerate the new failure `details` (`{error}`) on previously thrown paths: `renderExternalRunsResult` falls back to the message text, and `renderWaitResult` is not used | `test/external-runs-rendering.test.ts` |
| Memory-sourced text is redacted before slicing: a secret split across a page boundary is still redacted, and `limitBytes` holds | `test/external-runs.test.ts` |
| The contracts index stays bounded: UTF-8 bytes of `content` and of serialized `data` are each ≤ 1.5 KiB | `test/external-help.test.ts` |
| Capability conformance; help has no side effects; filters | `test/capabilities.test.ts`, `test/external-help.test.ts` |
| Contract help equals the registered schemas; examples validate; Agent input parity and declaration | `test/external-help.test.ts`, `test/tool-schema-provider.test.ts` |
| Explicit handoff and negative controls | `test/context-handoff.test.ts` |

- **Docs checklist for each PR:** README, AGENTS, CONTEXT, CHANGELOG and field-testing guidance, checked against what was tested.
- **Before each release:** `npm test` stays offline and deterministic. Real-backend checks follow `docs/field-testing.md`: one CLI backend plus one pi harness, both with `--workflow`.

### 5.3 Out of scope

- B7: workflow selection codes, and inspectable IDs for failures that happen before a child has an index.
- doctor's omission of opencode.
- #43, #41 and #35.

### 5.4 Audit bugs and where they are fixed

| ID | Bug | Fixed in |
|---|---|---|
| B1 | List cursor pages report live runs as interrupted; a run can be duplicated across pages | PR 0 |
| B2 | Workflow `session_closed` is uncaught, leaving the journal orphaned | PR 0 |
| B3 | One bad journal fails the whole `list` | PR 0 |
| B4 | A truncated journal is read silently, with no integrity flag | PR 1 |
| B5 | Durable wait `result` is narration, not the canonical result | PR 1, structured channel only |
| B6 | Docs mis-describe the singleton summary; `launch` view undocumented | PR 1 |
| B7 | Workflow selection code lost; failures before a child has an index get `workflow-child-N` IDs | out of scope |
| B8 | `readSummary` has no stale-cursor recovery | PR 1 |
| B9 | Concatenating multi-item pages is lossy | PR 1 (a format change) |
| B10 | Resume reveals runs from another project | PR 0 |

## Appendix A: review reconciliation

| Finding | Source | Resolution |
|---|---|---|
| `withContract` treated every returned result as `ok:true`, which would turn failed foreground receipts into successes | agy (blocker) | §1.4: the callback can return `error`, and failure data stays caller-owned. |
| Failure `details: {error}` would break Agent's renderer | Claude | §1.4: the caller's `details` are kept. |
| Redacting pages after slicing breaks `limitBytes` and misses secrets split across a page boundary | Claude | §1.4: redaction is per tool; pages are served as stored. |
| The dual wait ledger was ambiguous and needed a second read | Claude | §2.3: one budget, inline only from memory, durable targets by reference. |
| Batch dual measurement changes content | Claude | Accepted and listed in §2.5. |
| The B9 fix changes page text and offsets | Claude | Accepted; explicit in §2.3 and §2.5, with tests. |
| #79 moved rejections earlier, against its "unchanged" gate | Claude | §3.1: the descriptor only describes; conformance tests check it. |
| Handled-failure count | Claude | The fatal reply is now excluded. **Rejected** the max-calls counterexample: it is fatal (`script-worker.ts:175-178`), so the root fails. |
| B1 fix could duplicate a run across pages | Claude | §2.3: overlay keyed by `runId` on every page. |
| Workflow `isError` change missing from the compatibility table | Claude | §2.5 |
| Some throw sites had no code; `source.ts` returns objects rather than throwing | Claude | §1.3 |
| Generic `PublicRun` would widen Agent's declaration | Claude | §1.5: per-tool subsets. |
| Journal integrity rules too coarse | Claude | §1.5 |
| Encoding depends on the stored value | Claude, agy | §2.3: page serialization plus a note on JSON text. |
| Wrong citations (geteuid, help prose location, 1 MiB constant) | Claude | Fixed. |
| `structuredOutput` blurred receipts and child schemas | Claude | Renamed `workflowChildSchema`. |
| Native retries unverified for several CLIs | Claude | Marked `unknown`. |
| `permissionSummary` was a second prose source; conformance tests were circular | Claude | §3.1: text generated from the helpers; tests check the adapters. |
| Option keys could not be tested | Claude | §4.3: shared `AGENT_OPTION_KEYS`. |
| Test overlap with `run-contract.test.ts` | Claude | §5.2: schema validation only. |
| Missing test rows (abort, nested usage, docs) | Claude, agy | §5.2 |
| Blocked catalog record set unclear | Claude | §3.3 |
| Move only the Agent schema | Claude | §1.1 |
| Fix the pi row label now | Claude | §3.4, PR 2 |
| Version suffix | Claude | §5.1 |
| `nestedAgentDetection` missing from the table | agy | §3.1 |
| Unknown `tool` code | agy | §4.1: `selection_invalid`. |
| Q1, separate `cancellation_unconfirmed` | agy | **Not adopted.** agy's reason quoted a gate wording (process exit / PID untracked) that is not in #77. Cancel never waits for exit, and the condition and the recovery are identical for wait and cancel. Claude agreed: one code. |
| Q3, bug fixes first versus inside #77 | split | Bugs that do not depend on the contract go first (PR 0); B4 and B8 stay in #77. Rationale: reviewable size, and testable without the contract. |
| Live and memory-sourced pages bypass write-time redaction | maintainer | §1.4: redact memory-sourced text in full before slicing; listed in §2.5. |
| Missing test rows: renderer tolerance for failure `details`; contracts index size | maintainer | §5.2 rows added; §4.1 states the exact bound. |
| B9 changes the format but sat in a patch PR | maintainer | Moved to PR 1 (minor); PR 0 is pure fixes. |
| The handled-failure argument did not cover resume | maintainer | §2.2: replay never reuses failed results, so the count is exact and per attempt. |

## Appendix B: implementation notes (PR 1)

| Design text | As built | Why |
|---|---|---|
| B9: each item terminated by `\n` | A `\n` separator before each new message; same-id agy/muse deltas join without one; inspection cursors carry the preceding stream state and move to version 2 | Terminators split streamed messages mid-sentence |
| Memory-sourced redaction | Also covers journal-sourced workflow views | Journals are not redacted at write |
| §1.1: move the Agent input schema to `src/contract/agent.ts` | Deferred to PR 3, where the help import cycle appears | No PR 1 behaviour depends on it |
| §4.4: `docs/public-contract.md` replaces `docs/agent-public-contract.md` in PR 3 | Done in PR 1 | PR 1 introduces the contracts the doc describes |
| Agent declaration unchanged | Its run schema is unchanged; its error-code enum gains the nine new codes (declaration 3130 bytes, well under the 12,000-byte bound) | One shared error vocabulary |
| Unreadable journals | `WorkflowJournalReadError` is an `ExpectedFlowError` (`run_unavailable`) carrying `integrity` and, when readable, `project`; another project's unreadable journal reads as unknown | Codes at source, no cross-project disclosure |
| Batch cursor from another session | `cursor_invalid`, "Cursor belongs to a different session or project" | It is a cursor fault; the message reveals nothing about runs |
| `/external runs` failures | Coded `RunsActionError`; stale recovery by code; other failures notify and keep the navigator open | §2.4 |
| Wait inline rule (review of #82) | The structured channel spends its own copy of `limitBytes` in request order | #77 requires inline values to fit the remaining shared budget; escaped JSON can exceed the text size |
| Agent final view (review of #82) | A settled successful registry result is served as `final` from memory, redacted before paging | A promised `refs.final` must resolve even when evidence was never persisted |
