# Public contract v1: Agent, workflow and external_runs

`Agent`, `workflow` and `external_runs` declare `outputSchema` and return matching `structuredContent`. Human `content` and renderer `details` stay separate. Native Pi codemode receives the structured result, including failures. **Check `ok`**, not just whether the call threw.

```js
const receipt = await tools.Agent({ role: "worker", description: "Check build", prompt: "Run the build and report." });
if (!receipt.ok) return receipt.error;
return receipt.data.run;
```

## Envelope

Every result carries:
- `contractVersion: 1`;
- `tool` and `action`;
- an ISO `observedAt` timestamp;
- `ok`;
- `data`;
- `warnings` (strings).

`error: {code, message}` exists only when `ok` is false, and `isError === !ok`. A red tool row therefore means the *operation* failed, not that some target run failed. V1 consumers must ignore unknown fields. Removing fields or changing their meaning requires a new contract version. The host uses the schema for declarations, not to validate output at run time; tests validate actual results.

| Tool | `action` | Success `data` | Failure `data` |
|---|---|---|---|
| `Agent` | `delegate` | `{run}` | `{run}`, or `{run: null}` before registration |
| `workflow` | `run` | `{run}` | `{run}`, or `{run: null}` before registration |
| `external_runs` | the requested action | the action's payload (below) | `null` |

A failure that has a run keeps that run's evidence. Read-only supervision never returns partial data on failure.

## Runs

A run reports:
- task identity;
- registry-confirmed liveness;
- lifecycle state and outcome;
- timing;
- evidence integrity;
- output availability and delivery;
- inspect references, where they resolve.

`kind` is `agent` or `workflow`. Supervision adds the status `interrupted_or_uncertain` for unfinished evidence with no live owner. Private evidence paths and launch/configuration details are not included.

**Integrity** is one of:
- `complete`;
- `incomplete`: live, or not yet finalized;
- `damaged`;
- `unknown`: evidence was not read, or could not be read.

Missing or unreadable evidence never discards a settled result. For a workflow journal:
- **`complete`:** a start line and a terminal line, with no bad line.
- **`incomplete`:** there is no terminal line, or only the last line is torn (an unfinished write).
- **`damaged`:** there is a bad line with records after it, or the run ID does not match.
- **`unknown`:** the journal version is unsupported or the file is unreadable.

**Delivery.** A complete canonical result is inline (`output.delivery: "inline"`, `output.value`) only within **16 KiB of UTF-8 JSON after secret redaction**. Otherwise it is delivered by reference: `refs.final` points to a pageable `external_runs` inspection. A value is never truncated. False, null, zero and empty strings are valid results. Partial narration is never the canonical value. `warnings` includes `output_redacted` when redaction changed an inlined value. This is best-effort pattern redaction, not a guarantee that arbitrary sensitive prose is caught.

`refs` are ready-to-call `external_runs` arguments:
- `refs.summary` is a batch inspection with one ID, and returns `{mode: "batch", entries}`.
- `refs.final` and `refs.diagnostics` are single-run page inspections.

## Workflow receipts

`ok` describes the workflow root:
- A foreground root that succeeded is `ok: true`.
- A foreground root that failed, was cancelled or timed out is `ok: false`, with that outcome as `error.code` and its run evidence kept.
- A background launch is `ok: true` once it is **accepted**. That does not mean it has finished; use `external_runs wait`.

`run.children.count` is the number of indexed `agent()` children. `run.children.failed` counts every failed `agent()` call delivered to the script, including calls that failed before a child was indexed. Failures that are always fatal (an unknown role, the call limit) are excluded, because they fail the root. A root that succeeded after catching child failures stays `ok: true` with the warning `handled_child_failures`, and its `content` says so too. `failed` is absent, meaning unknown, for journals written before it was recorded.

## external_runs payloads

| Action | `data` |
|---|---|
| `list` | `{runs, workflows, nextCursor?, nextWorkflowCursor?}`. The two cursor streams are independent. `nextCursor` means the scan stopped early, not that more rows exist; a next page may be empty. A live run appears once, on the page where its record falls, with live state; the first page also lists live runs that have no record yet. |
| `inspect` (`runIds`, summary) | `{mode: "batch", entries, nextCursor?}`. An entry is served only if it fits `limitBytes` in **both** the legacy text and the full structured envelope, so both channels carry the same entries and one cursor. If even one entry cannot fit, the error is `page_too_small`; targets are never silently dropped. A one-element `runIds` with the summary view also returns batch entries. |
| `inspect` (one run) | `{mode: "single", runId, view, page: {text, encoding, complete, nextCursor?}, finalAvailable?, outputStatus?}`. `page.text` is bounded by `limitBytes` in UTF-8 bytes; the envelope adds a small fixed overhead. `encoding` is `json` for agent `summary`/`launch` and for every workflow view, and `text` for agent `output`/`diagnostics`/`final`. JSON pages may be fragments: concatenate one cursor sequence before parsing. Output and diagnostics pages concatenate losslessly, because each new message carries a leading `\n` separator. Unavailable output leaves `page.text` empty, with the human fallback only in `content`. An unavailable `final` is empty with `finalAvailable: false`, never partial narration. A schema-constrained child stores JSON text as its agent final value. |
| `wait` | `{mode, completed, pending}`, in request order. Pending work is never cancelled, and an unsuccessful workflow returns early. One shared byte budget (`limitBytes`) applies to the legacy `content`. A completed run's value is inline only when it is held in memory, its legacy text was delivered whole, and it fits 16 KiB. Everything else, including every durable target, is delivered by reference. No evidence is read once the budget is spent. |
| `cancel` | `{runId, status: "requested" \| "terminal"}`. `requested` does not mean the run has stopped. |

Supervision text is redacted at its source before it is measured or sliced. Durable run records are redacted when written. Memory-sourced text (live output, in-memory wait results, workflow views and journal values) is redacted in full before paging, so `limitBytes` holds and a secret split across a page boundary is still caught.

## Error codes

| Code | Meaning |
|---|---|
| `configuration_invalid`, `harness_unavailable`, `selection_invalid`, `model_unavailable`, `context_invalid` | Configuration or selection problems found before launch. `selection_invalid` also covers an unknown saved workflow. |
| `session_closed` | The owning session closed before the run registered. |
| `failed`, `cancelled`, `timed_out` | Terminal outcome of the run this receipt is about. |
| `request_invalid` | Malformed or contradictory parameters (bad ID, both selectors, target count, view, source count). |
| `run_unavailable` | Unknown, belonging to another session or project, or pruned by retention. These cases are deliberately indistinguishable. Also covers an unreadable journal in this project. |
| `run_not_live` | The run is in this session but has no live owner and its evidence is not terminal, so a wait cannot complete and a cancel cannot be confirmed. |
| `cursor_invalid` | A malformed cursor, or one from a different run, view, scope or target set. |
| `cursor_stale` | The evidence changed while paging, or the cursor predates the current page format. Restart without a cursor. |
| `page_too_small` | One whole batch entry does not fit `limitBytes`. |
| `session_unavailable` | Supervision needs a persisted originating session. |
| `script_invalid` | Workflow parse, `meta` or `apiVersion` failure. Nothing was launched. |
| `storage_unavailable` | Workflow script or journal persistence failed before registration. |

Still thrown, not returned:
- an interrupted wait ("Run wait aborted");
- unexpected exceptions;
- predispatch schema or permission failures;
- `tool_call` blocks.

A host redaction hook that replaces content drops structured content unless it explicitly supplies a replacement.

## Discovery

Pi 0.99.2 generates discriminated return types from these schemas through native `describeTool`. The `Agent` input declaration currently loses its input properties, because Pi renders the root `anyOf` constraints before the properties; input validation itself remains intact. This is a known input-discovery limitation, not a runtime validation bypass.
