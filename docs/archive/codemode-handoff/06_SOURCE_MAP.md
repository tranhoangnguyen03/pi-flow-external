# Source map and baseline notes

Sources were inspected on 1 October 2026. These references identify the repository state used to design the handoff, not the user's installed package or a tested build. Later HEAD changes must be reconciled. The short symbols below locate implementation seams; this package does not include an entire source checkout.

## S01 — Flow baseline

[Flow commit `ae04c8883470dcc16995f75ea2a39b5b32e729db`](https://github.com/tranhoangnguyen03/pi-flow-external/commit/ae04c8883470dcc16995f75ea2a39b5b32e729db) is the inspected default-branch head. Its commit message records merge of #71, delegation transparency and clearer workflow progress. The baseline manifest reports `2.10.0-external.0`.

## S02 — Flow dependencies and commands

[package.json](https://github.com/tranhoangnguyen03/pi-flow-external/blob/ae04c8883470dcc16995f75ea2a39b5b32e729db/package.json): Node >=22.19.0; `npm run check` runs TypeScript no-emit and Vitest; development Pi packages pinned to 0.79.4; host peers are wildcard in the inspected manifest. This is why the plan requires a real target-host lane rather than assuming new output contracts work on the old development pin.

## S03 — Pi target version

[Pi coding-agent package.json](https://github.com/earendil-works/pi/blob/8ce69e9d2b171d173fe4b6b2b6256f1f4411e69d/packages/coding-agent/package.json) reports 0.99.2. [Pi commit](https://github.com/earendil-works/pi/commit/8ce69e9d2b171d173fe4b6b2b6256f1f4411e69d) is the inspected default-branch head. The handoff pins both project and host evidence rather than relying on a moving `latest` label.

## S04 — Native codemode conversion and result handling

[tool.ts](https://github.com/earendil-works/pi/blob/8ce69e9d2b171d173fe4b6b2b6256f1f4411e69d/packages/coding-agent/src/extensions/codemode/tool.ts): file header, `CodemodeToolDetails`, `DESCRIPTION_INTRO`, and `toCodemodeDeclaration`. A tool with `outputSchema` provides `structuredContent` to the script, including data-bearing error results. Otherwise the script receives joined text. Nested results do not become ordinary transcript results. `store` is branch-path custom state. Script success does not roll back tool side effects.

[Standalone library README](https://github.com/earendil-works/pi/blob/8ce69e9d2b171d173fe4b6b2b6256f1f4411e69d/packages/codemode/README.md): SDK sandbox transport, store limitations, failure kinds, and declaration generation. This source is reference only: **runtime reuse is explicitly excluded from the requested feature**.

## S05 — Outer Flow result boundary

[pi-subagent.ts](https://github.com/tranhoangnguyen03/pi-flow-external/blob/ae04c8883470dcc16995f75ea2a39b5b32e729db/src/pi-subagent.ts): `agentToolParameters`, `createAgentTool`, foreground execution, background return, and renderer methods.

[core/progress.ts](https://github.com/tranhoangnguyen03/pi-flow-external/blob/ae04c8883470dcc16995f75ea2a39b5b32e729db/src/core/progress.ts): `textResult` returns text content plus details.

[workflow/tool.ts](https://github.com/tranhoangnguyen03/pi-flow-external/blob/ae04c8883470dcc16995f75ea2a39b5b32e729db/src/workflow/tool.ts): `workflowResult`, `workflowError`, `createWorkflowTool`, schema-based child setup, and result/renderer paths. The public definition does not declare an output schema in the inspected version. The existing inner structured child result does not automatically become a structured outer tool result.

[workflow/structured-output.ts](https://github.com/tranhoangnguyen03/pi-flow-external/blob/ae04c8883470dcc16995f75ea2a39b5b32e729db/src/workflow/structured-output.ts): `createStructuredOutputTool`, validated final child data, and plain-text output notes. Keep these separate from the operational receipt schema.

## S06 — Existing shared projections

[core/run-projection.ts](https://github.com/tranhoangnguyen03/pi-flow-external/blob/ae04c8883470dcc16995f75ea2a39b5b32e729db/src/core/run-projection.ts): `normalizeRunStatus`, `projectLiveAgent`, `projectDurableAgent`, `projectWorkflowRun`. Important details: workflow internal completed → public done; live status is registry-backed; history can be interrupted/uncertain; final availability uses explicit presence checks. Reuse this layer rather than introducing a second public state machine.

## S07 — Inspection, pages, cancellation, waiting

[external-runs.ts](https://github.com/tranhoangnguyen03/pi-flow-external/blob/ae04c8883470dcc16995f75ea2a39b5b32e729db/src/external-runs.ts): `externalRunsParameters`, `result`, `workflowFinalState`, summary projection helpers, selector normalization, and the action handlers. In particular, the inspected lines 680–910 cover independent list cursors, batch ownership/page sizing, single workflow/agent views, unavailable final output, and cancellation acknowledgement. Single pages can contain fragments of a JSON document. `launch` is a real inspect view even where older prose lists only four views.

[README — supervision/workflows](https://github.com/tranhoangnguyen03/pi-flow-external/blob/ae04c8883470dcc16995f75ea2a39b5b32e729db/README.md): target limits, shared wait budget, interruption differences, session-owned background work, uncertain post-crash history, no live steering, and explicit replay.

## S08 — Discovery gap and current help

[external-help.ts](https://github.com/tranhoangnguyen03/pi-flow-external/blob/ae04c8883470dcc16995f75ea2a39b5b32e729db/src/external-help.ts): `externalHelpParameters`, `workflowHelp`, `PERMISSION_HELP_BY_BACKEND`, `validateHarnessFilter`, and `createExternalHelpTool`. Existing topics are usage/roles/permissions/workflow. Keep compatibility and blank-harness handling. A long string currently carries signatures and many semantic rules; generate a concise reference from tested definitions instead of copying another manual.

[prompts.ts](https://github.com/tranhoangnguyen03/pi-flow-external/blob/ae04c8883470dcc16995f75ea2a39b5b32e729db/src/prompts.ts) is an identified integration target for coordinator/playbook guidance; re-read the exact relevant sections during implementation before changing them. Do not treat this source map as proof every line of that file was audited.

## S09 — Context and workflow invariants

[core/parent-context.ts](https://github.com/tranhoangnguyen03/pi-flow-external/blob/ae04c8883470dcc16995f75ea2a39b5b32e729db/src/core/parent-context.ts): `parentContextSchema`, `captureParentContext`, `prepareParentContext`. Snapshot comes from the current branch, is captured before queueing, excludes pending calls/thinking/system instructions, has a 1 MiB ceiling, and conflicts with non-none context plus resume.

[workflow/runtime.ts](https://github.com/tranhoangnguyen03/pi-flow-external/blob/ae04c8883470dcc16995f75ea2a39b5b32e729db/src/workflow/runtime.ts): `runWorkflow`, `runAgentCall`, frozen parent messages and fingerprint/prefix replay logic.

[workflow/script-worker.ts](https://github.com/tranhoangnguyen03/pi-flow-external/blob/ae04c8883470dcc16995f75ea2a39b5b32e729db/src/workflow/script-worker.ts): `agent`, `trackChain`, `parallel`, `pipeline`, forgotten-await guards, and the existing VM worker. **Read to preserve behaviour, not to replace it.**

[workflow/source.ts](https://github.com/tranhoangnguyen03/pi-flow-external/blob/ae04c8883470dcc16995f75ea2a39b5b32e729db/src/workflow/source.ts): `workflowToolParameters`, `prepareWorkflowToolSource`, source/root restrictions, API-versioned workflow header, and explicit replay eligibility.

## S10 — Previous context experiment: do not repeat the rejected mechanism

[Issue #29 decision comment](https://github.com/tranhoangnguyen03/pi-flow-external/issues/29#issuecomment-5607743408), titled no-go for current prototype (2026-09-10). It rejects fragile selected-transcript refs and the tested read-at-delegation blackboard. A good explicit handoff was the meaningful comparison; smaller transport did not prove a total-cost/quality gain. Active multi-stage publish/consume remains an untested follow-up. The package preserves that boundary.

## S11 — Contributor invariants and backend distinctions

[AGENTS.md](https://github.com/tranhoangnguyen03/pi-flow-external/blob/ae04c8883470dcc16995f75ea2a39b5b32e729db/AGENTS.md): ordinary tool set, role/harness distinction, settings v4, catalog freezing, permissions, named-Pi resources, backend-specific capabilities, context and transparency invariants. The recipient must read the current complete file. The preparation inspected the leading contributor-contract section; it did not execute those invariants.

Important preserved distinctions: no automatic harness substitution; named-Pi tools are not an OS sandbox; native/provider retries are not the same as Flow retries; Antigravity has a documented limited infrastructure-retry exception; budget/cost/resume support varies by adapter; OpenCode structured schemas are unsupported in the inspected implementation.

## S12 — Prior transparency work

[Issue #67](https://github.com/tranhoangnguyen03/pi-flow-external/issues/67) and the baseline commit's merge of [PR #71](https://github.com/tranhoangnguyen03/pi-flow-external/pull/71). Task intent, background receipts, launch inspection, bounded child presentation, and real-versus-historical evidence are existing investments to preserve. Do not reopen this as a new UI or steering project.

[README — transparency](https://github.com/tranhoangnguyen03/pi-flow-external/blob/ae04c8883470dcc16995f75ea2a39b5b32e729db/README.md) and [Pi codemode renderer](https://github.com/earendil-works/pi/blob/8ce69e9d2b171d173fe4b6b2b6256f1f4411e69d/packages/coding-agent/src/extensions/codemode/renderer.ts) support the distinction between Flow's custom cards and codemode's generic nested-call rendering.

## S13 — Current Pi extension API

[Official extension documentation](https://pi.dev/docs/latest/extensions), Tools section: data-bearing errors, structured results, nested execution hooks, bounded nested metadata, usage aggregation, and redaction behaviour. This is a moving reference; use the pinned Pi source to verify implementation details. In particular, nested tool results are not an archive available for future context reconstruction, and replacing only text in a redaction hook can remove structured data.

## S14 — Native codemode SDK setup

[SDK example 14-codemode-mcp.ts](https://github.com/earendil-works/pi/blob/8ce69e9d2b171d173fe4b6b2b6256f1f4411e69d/packages/coding-agent/examples/sdk/14-codemode-mcp.ts) is the setup reference identified in the source search. Read it fully when wiring the real-host test lane. CLI-built-in extension loading and SDK factory setup are not interchangeable assumptions.

## What this source review does not establish

No local repository clone could be obtained in the build container because GitHub DNS resolution failed. No repository test suite or native integration ran here. No installed package was scanned. No provider was invoked. No new feature was implemented or published. Full test-file discovery, capability descriptor extraction across every adapter, and actual host compatibility remain explicit first steps for the recipient.
