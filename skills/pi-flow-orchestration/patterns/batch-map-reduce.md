# Batch map–reduce

**Use when:** a collection contains many similar independent items—transcripts, customer comments, documents, or file inventories—and you need per-item work, possibly followed by a shared analysis. A handful of distinct scopes is [parallel work](parallel-work.md). One giant context is not a substitute for explicit coverage.

**Shape:** source manifest → size-aware batches → bounded concurrent readers → per-item records → optional hierarchical synthesis.

## Prepare once, then run

The parent uses ordinary tools (or a useful discovery assignment) to list sources, assign stable IDs and estimate their text size. Pass absolute paths, accessible references, or captured text. The workflow worker cannot enumerate files itself. Only provide data the selected child can actually access.

Load [batch-map-reduce.js](../recipes/batch-map-reduce.js) and pass:

```json
{
  "task": "Summarize each interview and synthesize customer problems, disagreements, and rare findings; keep source references.",
  "items": [
    { "id": "T001", "source": "/work/interviews/T001.txt", "estimatedChars": 9000 },
    { "id": "T002", "source": "/work/interviews/T002.txt", "estimatedChars": 4500 }
  ],
  "harness": "codex",
  "batchChars": 24000,
  "batchItems": 8,
  "concurrency": 4,
  "reduce": true,
  "reduceFanIn": 8,
  "reduceChars": 32000
}
```

Defaults are examples, not an optimal setting for every model. The map phase needs a **read-only and structured-output-capable** harness; Codex is the example default, not an automatic fallback or a claim of live qualification. Check `external_help({topic:"capabilities", harness:"..."})` when selecting another. Unsupported schemas or permissions may fail; the recipe does not widen access or retry.

The script packs by supplied size, with a per-batch item cap, and maintains a small local worker pool. That pool sits below Flow's shared concurrency limit. It does not launch one permanent worker agent: each batch is a fresh `agent()` assignment. Estimates are character counts, **not token or context-window guarantees**; include room for prompts and outputs. Split an oversized transcript into stable chunk IDs before launch, and regroup chunks when analyzing whole transcripts. The sample limits a run to 500 items; larger corpora use explicit subsets.

## Adapting extraction for theme counts

Codex's strict output schema supports a subset of JSON Schema: **do not add `uniqueItems`** to a theme array. It rejects that keyword before the child reads a source. Keep the schema simple and count each summarized source once per theme in JavaScript; repeated labels in one record must not inflate frequencies. A schema's acceptance still depends on the selected provider; Flow forwards it rather than rewriting it.

For a `themes` property on each per-source record, use this schema and counting function. Keep the recipe's ID/status/evidence validation and missing-source accounting when adapting it. This is an adaptation fragment, not a standalone workflow:

```js
const themeSchema = {
  type: "array",
  items: { type: "string", enum: ["BILLING", "LOGIN", "SUPPORT"] },
};
function countThemes(records) {
  return Object.fromEntries(["BILLING", "LOGIN", "SUPPORT"].map((theme) => [
    theme,
    records.filter((record) => record.status === "summarized" && record.themes.includes(theme)).length,
  ]));
}
```

This counts sources mentioning each theme, not repeated mentions. A source can contribute to multiple themes, so totals may exceed the number of sources. A provider schema rejection is a failed child run: retain the error and obtain authorization before rerunning; do not fan out the same rejected schema again automatically.

## Preserve the deliverable, not just a final paragraph

Each map call must return exactly one record per requested ID: `summarized` with summary/evidence, or `unreadable` with a reason. A failed call or malformed ID set marks that batch as failed instead of silently dropping items. The workflow restores original input order and returns **all per-item records**, plus total/summarized/unreadable/failed counts and a missing-ID list.

`reduce:false` stops there. With reduction enabled, bounded groups combine into increasingly compact reports. Reducers receive missing-source information; group size and evidence-size limits control their inputs. The script never silently clips these evidence packets. If summaries cannot fit together, `reduction.status` is `blocked_by_size` and full remaining units are returned for a parent decision. If a reducer fails, surviving results and failed-group inputs remain available. No automatic repair loop follows.

Overall `status` means processing coverage (`complete`, `partial`, or `failed`), not factual approval. A completed model report does not prove the source was interpreted correctly. Minority observations, citation fidelity, and frequency claims still need judgment. For quantitative claims, count explicit per-source facts; do not treat repeated summaries as independent votes.

## Large-output handling

The return retains individual summaries even after synthesis. Flow may deliver it by `refs.final` rather than inline; retrieve all required pages through `external_runs`. Private run evidence has retention rules and is **not** permanent corpus storage. For lasting deliverables, have the parent write the returned records to authorized files. This read-only recipe itself does not write files, persist checkpoints, resume arbitrary failed branches, or survive session shutdown as a service.

For a 240-transcript trial, use uneven sizes, one unreadable source, one failed batch and a deliberately small reducer budget. Check item IDs and the final report, not merely child count. [Handoffs](../references/handoffs.md) explains source selection; [runtime rules](../references/runtime-rules.md) explains references, failure and replay boundaries.
