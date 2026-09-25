# Delegation minimum-standard implementation checkpoint

Tracking: [#67](https://github.com/tranhoangnguyen03/pi-flow-external/issues/67). Contract: [north star](../delegation-experience-north-star.md).

## Implemented locally

- A shared, paged `external_runs inspect` view named `launch`, reachable through `/external runs` → run → Launch.
- Queued intent records include authored prompt, transferred prompt/context receipt, and known planned configuration. Intent is flushed before registration makes a run discoverable.
- Shared execution records `launch_resolved` before backend startup, including role instructions, appended instructions, output schema, known configuration and enforcement disclosures. Existing evidence redaction applies.
- Workflow root source/arguments/metadata are redacted and retained in its existing journal and snapshot; new journal files are private. Historical records without launch data report Not recorded.
- Launch inspection uses revision-checked UTF-8 pagination and terminates at the current snapshot instead of endlessly offering empty pages while execution continues.
- Background Agent and workflow results are explicitly historical launch receipts with run IDs and follow-up routes.
- Active assignment rows and workflow roots expose the run inspection route. Workflow prepared snapshots show purpose/workspace/mode, including saved and path sources; ad-hoc call cards show parsed metadata without evaluating scripts.
- Run navigation includes Refresh; Summary reports the observation timestamp.

## Verification

- TypeScript checking passed.
- Full deterministic suite passed: 460 tests across 42 files with `npx vitest run --maxWorkers=2`.
- Default-concurrency `npm run check` passed earlier, but a later run encountered three backend-fixture startup timeouts. Both affected files passed in isolation (43 tests); the full bounded-concurrency suite passed. Do not describe the last default-concurrency run as passing.
- Added/extended checks cover launch pagination/redaction/immutable recorded values/legacy absence, actual shared launch recording through fake Muse and Pi workflow execution, queued workflow-child inspection, ad-hoc disclosure, and background receipt rendering.
- `git diff --check` passed.

## Claude review remediation

- Stale Launch pagination now reopens page 1 with an explicit notice rather than exiting run navigation; command coverage exercises Launch, recovery, Refresh, and subsequent Final navigation.
- Recorded thinking distinguishes requested levels from normalized CLI effort arguments. Pi records actual SDK thinking and active tool names after initialization, together with loaded context files and the composed system prompt. Injected structured-output schema is retained.
- Budget enforcement excludes a zero cap, matching Claude argument construction.
- Saved/path background receipts include resolved purpose/workspace and explicit host-access disclosure.
- Queued workflow evidence includes requested permissions, budget and output contract. Live pending, never-started, historical missing, and orphaned/uncertain launch states are distinguished.
- Workflow journal directories created by this path use private permissions. Existing directories are not chmodded; workflow evidence still follows session-journal retention, not maxRunRecords.
- Duplicate execution prompt storage was removed. Role descriptions are labeled Role, and workflow script metadata parsing is cached per call.
- Fresh default-concurrency `npm run check` passed: 460 tests / 42 files plus TypeScript. Subsequent small lifecycle-label/role-label/cache edits passed TypeScript and all 26 targeted inspection, command, and rendering tests. `git diff --check` passed.

## Final local and manual verification

- Maintainer completed the manual behavioral walkthrough successfully and subsequently approved the revised card legibility.
- Integrated origin/main through f6e177d (configuration redesign and doctor diagnostics); preserved the new permission/resource-loading contracts and updated launch disclosure for minimal/skills presets.
- Final PR preparation: `npm run check` passed (490 tests / 44 files plus TypeScript), `npm pack --dry-run --json` passed (2.9.0-external.0, no test files shipped), production dependency audit passed, and diff checks passed.
- Unrelated pi-web-access dependency changes are preserved in a separate local stash, excluded from this PR.
- The earlier verification notes below describe the pre-manual-testing checkpoint, not the current maintainer validation. Comprehensive real-provider release lanes have not been rerun after main integration and remain a pre-merge requirement.

## Earlier gate status and remaining verification

This is not yet a full interactive UX sign-off. Renderer and command behavior are exercised deterministically; a live Pi terminal walkthrough has not been completed. In particular, verify that `/external runs` is usable during foreground execution, that Launch pages and Refresh are discoverable at narrow widths, and that saved/path launch purpose arrives visibly with the initial prepared snapshot.

No real providers were called for verification. No commit, push, release, or deployment was made. Existing unrelated working-tree changes remain present.
