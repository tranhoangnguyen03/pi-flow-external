# Make Flow's public tools programmable without changing its runtime

**Status:** ready to implement as a scoped local feature. This Markdown is the proposed issue body; no GitHub issue has been created.

## Problem

Flow already offers useful orchestration: direct agents, JavaScript workflows, concurrency control, child errors, session-owned background runs, inspection, cancellation, and replay. Its inner workflow `agent()` can return structured results. The outer tool boundary is less consistent: public tools return human text plus renderer-oriented `details`, while native Pi codemode expects `outputSchema` plus `structuredContent` for data access. Returning an error description in `details` alone does not give the host a standard failed-tool result. [S04–S09]

The user should not have to choose between a compact agent context and useful visibility. A machine caller should not parse status prose, infer success from a resolved promise, or know internal renderer fields. A human should retain the current task cards and evidence drill-down.

## Outcome

Provide one versioned public data contract, with tool-specific payloads, for `Agent`, `workflow`, and `external_runs`. Extend `external_help` so both models and scripts can discover those contracts and actual harness capability limits on demand. Derive machine data, status presentation, and evidence routes from existing authoritative state. Keep the current Flow runtime and run ownership unchanged.

## In scope

- `outputSchema`, matching `structuredContent`, explicit `isError`, and consistent expected-error codes.
- Separate invocation success from target-run success and task acceptance.
- Stable public run receipts/projections, bounded inline results, and existing inspect references.
- Both foreground and background tools; live and historical inspection; all existing inspect views; batch pagination; wait/cancel semantics.
- Readable direct-tool cards and status, without dumping the machine envelope into the UI.
- `external_help` contract and capability discovery generated from executable definitions, not a parallel handwritten API specification.
- A short, discoverable workflow API reference; retain existing workflow syntax and helpers.
- Real Pi 0.99.2 codemode integration using fake child execution, plus ordinary direct-tool regression coverage.
- Explicit documentation/tests for context handoff: nested results are not automatic shared parent history; use existing task prompts and `context: none|recent|full` deliberately.

## Not in scope

No runtime swap, QuickJS migration, new executor, generic tool access inside Flow workflows, new retry policy, new sandbox/permission architecture, automatic acceptance, automatic agent routing, second run registry, new persistence database, background daemon, live steering protocol, or child codemode inheritance. No changes to Bro. No new blackboard, transcript-reference selector, or `context: handoff` mode. No automatic full-history fallback. The historical #29 no-go remains in force. [S10]

## Public behaviour

- A successful background launch means registered/queued, not finished.
- A failed foreground child returns `ok:false` and `isError:true`, retaining a run reference when one exists.
- Inspecting a failed run is normally `ok:true`: the inspection succeeded. Its run outcome remains failed.
- A wait response can validly contain failed/cancelled/timed-out targets and still be `ok:true`; do not erase pending targets.
- Cancellation acknowledgement is not proof of termination or rollback.
- A completed workflow can contain handled child failures. Keep those failures visible.
- `null`, `false`, `0`, and `""` are legitimate values; use presence, not truthiness.
- A ref identifies a route to inspect retained evidence. It is not a permission grant and does not imply that a foreign child CLI can resolve it.
- External host validation or permission hooks may reject before Flow's executor runs. Such failures can still throw; do not promise that every failure arrives as a Flow envelope.

## Deliverables

A shared public-contract module; adapters at the four existing public tools; reusable projections/presentation; generated contract/capability discovery; regression and integration tests; short usage docs and release/compatibility notes. Keep internal journals, states, and user settings compatible unless a specific pre-existing defect makes that impossible and the deviation is documented.

## Acceptance checklist

- [ ] Every executor-owned result from the three operational tools validates against its declared schema, including expected failures and background receipts.
- [ ] Codemode can branch on typed status and inspect refs without parsing human prose or reading `details`.
- [ ] Typed failure data is preserved with `isError:true`; a resolved promise is never the success criterion.
- [ ] Direct tools keep readable intent/progress/result cards, context/access disclosures, and drill-down.
- [ ] Machine/status/evidence views agree on run identity, state, result availability, and known recording gaps.
- [ ] `external_runs` preserves ownership checks, failed-target inspection, null values, ordering, opaque cursors, byte budgets, and wait/cancel boundaries.
- [ ] Human-readable text and `structuredContent` are redacted consistently; default responses do not disclose full launch prompts/configuration.
- [ ] Discovery is concise, read-only, and consistent with actual schemas and adapter support. Configured is not authenticated; unknown is not supported.
- [ ] Existing workflow child error, forgotten-await, cancellation, resume, replay-prefix, and context-freezing behaviour remains intact.
- [ ] Both direct mode and codemode-on mode pass real-host/fake-child checks. No paid provider call is necessary to validate the public boundary.
- [ ] Compatibility with Pi 0.99.2 is demonstrated and older-host support is stated honestly.
- [ ] Context tests show an explicit handoff works without a new context mode or automatic transcript expansion.

## Related decisions

#67/#71 already addressed delegation transparency; reuse that work rather than replacing its UI. #29 rejected a read-at-delegation blackboard without a demonstrated quality/cost advantage over a good task handoff. #43 covers separate Pi-child capabilities. See the source map and separate context note. [S10–S12]

Detailed design: [02_DESIGN.md](02_DESIGN.md). Delivery order: [03_IMPLEMENTATION_PLAN.md](03_IMPLEMENTATION_PLAN.md). Sources: [06_SOURCE_MAP.md](06_SOURCE_MAP.md).
