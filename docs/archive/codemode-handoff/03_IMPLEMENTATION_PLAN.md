# Implementation plan

## Working rule

Implement the agreed public boundary; preserve Flow's runtime and lifecycle. The path names below are existing source touchpoints unless explicitly marked **new**. New-module names are suggested, not a demand for a framework. Start with one shared contract module and reuse existing projections.

## P0 — Establish the real baseline and target host

1. Read current `AGENTS.md`, `README.md`, `CONTEXT.md`, `package.json`, and existing test conventions. Run the handoff's read-only preflight. Record HEAD and working-tree state; preserve unrelated changes.
2. Compare HEAD with inspected Flow commit `ae04c8883470dcc16995f75ea2a39b5b32e729db`. Review intervening changes in the files listed in the source map. Do not reset, revert, or overwrite later work.
3. Install repository dependencies in the authorized checkout using its lockfile, then run `npm run check`. Record the baseline's actual test results; historical counts in issues are not current results.
4. Set up an isolated Pi 0.99.2 integration lane. The existing 0.79.4 development pins cannot certify the new host contract. Read Pi's pinned SDK codemode example and extension contracts. Verify outgoing structured data, `isError:true`, hook redaction, and nested-call execution before broad edits.
5. Decide the supported host range based on this lane. The intended first target is 0.99.2; update dev/peer compatibility deliberately. Do not update global Pi, user configs, authentication, or unrelated dependencies.

**Exit:** reproducible baseline record and a minimal real-host structured-result/error demonstration. A baseline failure is investigated and documented, not silently attributed to this feature. A broad compatibility refactor must be surfaced as a scope issue, not hidden in the contracts patch.

## P1 — First vertical slice: Agent receipt through native codemode

**Touch:** `src/pi-subagent.ts`, `src/core/progress.ts`; **new:** `src/public-contract.ts` and a focused test file following repository conventions.

- Create the version-1 envelope and public-run schema/serializer. Use the bundled JSON Schema/fixtures as the normative draft; implement with the repository's TypeBox conventions. Keep schemas and TypeScript types in one source.
- Add `outputSchema`, matching `structuredContent`, and explicit error signalling to the final/background/expected-error `Agent` result paths. Leave the current internal `details` and renderers intact.
- Pass known error codes from the condition/branch where they are identified. Do not use status-text regexes. Retain `run:null` before registration and a real run/evidence reference after registration.
- Build fake-child integration cases through real Pi's nested tool pipeline: success, failure with data, queued receipt, and pre-launch selection failure. The test must call Flow's registered tool through native codemode, not a look-alike wrapper.
- Confirm that a failed structured result reaches script code as `ok:false` in the target host, and that a framework-level rejection is handled separately.

**Exit:** T01–T06 and H01–H03 pass for `Agent`; its direct intent/progress/result cards remain usable. This is the first useful implementation checkpoint, not a large up-front rewrite.

## P2 — Apply the same boundary to workflow and inspection

**Touch:** `src/workflow/tool.ts`, `src/external-runs.ts`, `src/core/run-projection.ts`, `src/core/run-inspection.ts` only as needed for existing projections/pages.

- Add the same versioned output contract to `workflow`. Preserve inner `agent()` behaviour, `ChildRunError`, frozen invocation settings/context, forgotten-await checks, abort handling, journal identity, and replay fingerprints.
- Expose handled failures from authoritative events/counts where known; do not infer from visible child rows.
- Normalize `external_runs` into the documented list/single-page/batch/wait/cancel payloads. Populate `structuredContent` directly from source objects; never round-trip through a human-readable status string.
- Preserve legacy content and rich renderer details. At a single-run paged view, construct the machine page alongside the existing page result. Supply explicit encoding and completeness without changing the source sequence or independently generating a second cursor.
- Keep budget/ordering rules from the design. Test the new wrapper overhead for batch pages. Do not change single-view page-byte budgets or wait's shared result budget without documented migration.
- Preserve missing final output, JSON null, failed-target inspections, ownership checks, uncertain history, and cancellation receipt semantics.

**Exit:** T07–T17 and H04–H07 pass. Successful inspection of a failed run is not marked as failed. No old record migration or new registry exists.

## P3 — Coordinate machine, human, and evidence views

**Touch:** `src/core/run-projection.ts`, `src/core/run-render.ts`, `src/core/subagent-render.ts`, `src/workflow/tool.ts`, `src/external-command.ts` only for necessary shared rendering/integration.

- Ensure public receipts and the existing renderer read the same authoritative terminal outcome and availability facts. Preserve richer progress details; do not force all UI data through a tiny summary.
- Retain task/purpose, harness, access/context disclosure, phase/child hierarchy, background-receipt wording, freshness, hidden failures, and inspector routes.
- Bound machine payloads; route large complete values to existing evidence. Do not use an LLM to generate summaries or mutate a canonical result into an interpretation.
- Apply redaction to the two model-visible channels consistently. Keep launch content behind explicit inspection. Do not promote private paths or launch metadata into every receipt.
- Keep usage/accounting consistent with existing adapters. When real Pi aggregates nested usage, do not add the same usage twice. Unknown cost stays unknown; do not extend budget enforcement claims.

**Exit:** T18–T22 and a manual foreground/background TUI check pass. Record the actual checks; a screenshot/snapshot alone cannot establish cancellation correctness.

## P4 — Discover contracts and capabilities precisely

**Touch:** `src/external-help.ts`, `src/prompts.ts`, existing permission/selection/adaptor capability code; **new if useful:** `src/capabilities.ts`.

- Extend help with `contracts` and `capabilities`, and the optional contract `tool` selector. Preserve existing topics, harness-filter semantics, and blank-placeholder handling.
- Generate contract output from real input/output schemas. Serve a compact index by default and one detailed interface on demand. Include a small validated example and the important success/error semantics.
- Render concise workflow helper signatures from a shared definition or tested metadata next to their actual implementation. Do not rewrite `parallel`, `pipeline`, the meta header, or the agent lifecycle just to resemble generic JavaScript APIs.
- Build capability descriptors from actual adapter support and shared validators. Audit each harness at the current checkout: structured schema support, resume, budget enforcement, reporting, permissions and platform caveats, child resources.
- Do not equate configured/enabled with installed/authenticated, and do not run CLI/provider probes in help. Return `not_probed`/`unknown` where appropriate.
- Keep the coordinator prompt short. Full schemas, all harness caveats, and examples belong in on-demand help/docs, not the always-on system prompt.

**Exit:** T23–T27 and H08 pass. Contract examples are validated against actual registered schemas; capability claims match execution rejection/acceptance paths without changing those paths.

## P5 — Context-handoff compatibility and integration proof

**Touch:** tests/documentation around `src/core/parent-context.ts`, `src/workflow/runtime.ts`, and the public tools. No new context API.

- Test that a child launched inside a codemode call does not automatically inherit an earlier nested result or `store()` value.
- Test that explicit evidence included in the task prompt reaches the intended child intact, with `context:none`, without a parent-model rewrite turn.
- Test workflow chaining: an earlier child result is passed explicitly; the later child still uses the frozen parent snapshot. `recent`/`full` do not mutate into an implicit rolling workflow transcript.
- Test branch/time-travel, stale world state, resume versus context conflicts, large/unsupported content, and an independent reviewer that does not receive an earlier reviewer's verdict by default.
- Treat evidence as data; preserve source identities and authorization. A Flow run ref is resolved by the parent/Flow surface before transmitting relevant content to a foreign CLI, unless that child explicitly has a verified retrieval capability.

**Exit:** H09–H12 pass. The pattern is documented and demonstrated using the improved public boundary. The separate research-only experiment is not implemented or run by default.

## P6 — Finish and report

- Run `npm run check`, target-host integration, direct-mode regression, schema/golden fixtures, and explicit manual TUI tests.
- Update `README.md`, `AGENTS.md`, `CONTEXT.md`, `CHANGELOG.md`, and relevant field-test guidance. Keep historical design documents historical.
- Include concise copyable examples: inspect multiple runs, distinguish failed invocation from failed target, handle large evidence by refs, and perform an explicit handoff.
- Review every return/error branch for `Agent`, `workflow`, `external_runs`, and `external_help`. Review hook redaction, unsupported schemas, blank optional placeholders, cancellation, and byte-budget edges.
- Report exactly what changed, compatibility, measured checks, remaining limitations, and excluded work. Do not claim provider quality/cost improvements from fake-child tests. Do not publish without authorization.

## Dependency map

P0 → P1 → P2 → P3 → P4 → P5 → P6. Work can be grouped into fewer commits, but do not bypass the first real-host slice. P3 and P4 share P2's contract source; neither gets a separate state model. Context research does not block core delivery.

| Requirement | Design component | Delivery/check |
|---|---|---|
| Stable typed results/errors | Shared envelope + run serializer | P1/P2; T01–T17 |
| Consistent machine/status/evidence | Existing projections + thin adapters | P3; T18–T22 |
| Concise discovery | Registered schemas + capability descriptors | P4; T23–T27 |
| No runtime/lifecycle regression | Preserve existing executor and journals | P2/P6; H04–H07 |
| Explicit context compatibility | Existing prompt/context/resume path | P5; H09–H12 |

## Required regression boundaries

Do not add or remove existing backend-specific retry behaviour; source currently documents an Antigravity infrastructure-retry exception and separately describes native provider retries. Preserve those distinctions rather than introducing a blanket retry rewrite. Keep one global child limiter, no automatic harness substitution, the current permission authority, no unrequested live steering, and no global config writes. [S08, S11]

Sources: [06_SOURCE_MAP.md](06_SOURCE_MAP.md).
