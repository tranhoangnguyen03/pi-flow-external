# Changelog

All notable changes to pi-flow external are documented here.

## Unreleased

## [2.5.0-external.0] - 2026-09-22

Partially addresses issue #43 (named Pi harness follow-up capability expansion): shared custom Pi roles and reusable capability sets. Trusted extensions/MCP, resumable sessions, and real per-child budget controls remain out of scope and stay tracked on issue #43 for a later slice.

### Added

- **Shared custom Pi roles**: a custom (non-canonical) role can now be authored once as `~/.pi/agent/subagents/pi-<role>.md`, declaring `backend: pi` and the literal marker `harness: "pi-*"` instead of one concrete harness name. `mergeSynthesizedPiProfiles` materializes it into a concrete `<harness>-<role>` profile for every currently-registered `pi-*` harness that lacks its own on-disk override for that role, pinned to that harness's registered model/thinking. Precedence: harness-specific on-disk file > shared template > synthesized canonical body. The marker deliberately fails `isValidHarnessName`, so a shared template can never itself become externally selectable or admitted as a native profile. A malformed shared template (wrong `pi-<role>.md` filename, or one that pins `model`/`thinking`) is dropped with a diagnostic surfaced by `/external doctor` rather than failing the whole roster. `/external profile create` supports authoring one directly, smoke-tested against one representative already-registered harness.
- **Reusable capability sets** (`piCapabilitySets`): a named `{ skills: string[]; promptTemplates: string[] }` entry in the existing global `pi-flow-external/settings.json`, and, for a trusted project, in `.pi/pi-flow-external/settings.json` (a project entry replaces the same-named global entry wholesale, never merging arrays). A profile opts in via frontmatter `capabilitySet: <name>`, on any harness including a shared `pi-*` role template. Selected resources are discovered through the installed Pi SDK's own `DefaultResourceLoader` (extensions/MCP/themes never load), post-filtered to exactly the named skills/prompt templates, with project-scope resources visible only when the caller's project is genuinely trusted. An unknown set name or an undiscoverable resource fails before any prompt/session exists, naming exactly what's missing. A skill is a lazy file read, so both a direct `Agent` call and a workflow run content-hash the selected skill/prompt-template bytes at resolution time and again immediately before each child spawn, refusing to launch a child whose selection drifted since it was resolved/frozen; a workflow's replay fingerprint is widened by that same hash. Selected names are disclosed on the intent card before launch and recorded as `capabilities` in both the `Agent` tool's and workflow child receipts. `/external doctor`, `/external settings`, and `/external profiles` all surface configured sets, unknown-set references, and malformed `capabilitySet` declarations.
- A workflow child that fails before `spawnSubagent` ever runs (unknown `capabilitySet`, or any other pre-spawn resolution error) now still finishes its already-queued durable run record as a recognizable failure, instead of leaving it stuck "incomplete" forever.
- Offline coverage in `test/capabilities.test.ts`, extended `test/pi-runtime.test.ts` (including real-SDK tests of the installed SDK's own explicit `/name args` prompt-template expansion and `/skill:name` skill invocation semantics, unaffected by `capabilitySet` filtering), `test/profiles.test.ts`, `test/settings.test.ts`, `test/workflow.test.ts`, `test/replay-cache.test.ts`, and `test/external-command.test.ts`. Verified against a real registered `pi-*` harness with real credentials: a real child resolved a project-scope `capabilitySet`, read and followed the selected skill's content (not guessable — an unpredictable nonce), and both the returned result and the persisted receipt disclosed matching `capabilities` (set, skills, content hash).

## [2.4.0-external.0] - 2026-09-21

Adds `muse` as a fifth external CLI backend, delegating to Muse Code alongside Claude Code, Codex CLI, Antigravity, and Grok Build CLI. Investigation notes: `docs/plans/muse-backend-prep.md`; ex-ante design issue: none filed — additive backend addition following the same shape as the Grok backend.

### Added

- `muse` backend (`src/core/muse.ts`), verified against Muse Code `1.3.0` running its `meta` provider, installed and authenticated independently of Pi. Runs `exec --json`, parsing schema-versioned MSP JSONL envelopes (`payload_type`/`payload`) — a different event shape from claude/codex/grok's flat events. Root-run ownership is established once from the process's own `runtime.command.accepted`/`session.run.linked` bootstrap pair (`command_id` tied to `run_stream.id`) and checked explicitly on every subsequent envelope: only a `run.terminal.completed`/`run.terminal.failed`/`run.output.delta` whose own `payload.run_stream.id` matches can finalize, fail, or contribute partial output to the result, so a nested or foreign-run envelope with an identical shape can never masquerade as the root's own answer, and `sessionId` is captured once from that bootstrap rather than from every envelope. Structured output uses `--output-schema <FILE>` (a temp file path, unlike Grok's inline `--json-schema`); the terminal event's `text` is already the pre-serialized JSON document. Muse has no native system-prompt flag, so a profile's `systemPrompt` is folded into the prompt file content, the same pattern Antigravity uses.
- Native approval/sandbox permission tiers: `readonly` (`--disable-approval --disable-write --disable-shell`), `edit` (`--disable-approval` only, sandbox left enabled), and `danger` (`--yolo`, which disables approval and the sandbox and additionally trusts the workspace for this run — a broader grant than an unsandboxed run alone, disclosed in full permission-help text). Approval and sandbox are ON by default, so every tier bypasses approval to avoid hanging headlessly. `edit` already permits shell execution within the sandbox, so Muse execution-lane roles need no `edit`→`danger` floor.
- `resume` support via Muse's own `exec --session-id <uuid>` flag, verified against the real CLI: two independent `muse exec` processes sharing the same session id shared context, confirmed by the second recalling a fact only told to the first (distinct from the separate, interactive-only `muse resume` command, which is not used here). Muse has never been observed to report token usage or cost on any run, so usage is reported as unknown (`costKnown: false`) rather than a fabricated zero or a locally estimated cost, and — like codex and grok — failed or aborted runs are never automatically retried by this extension; Muse's own `meta` provider integration performs its own internal retries (observed up to 10 attempts with growing backoff on transient errors) entirely inside the `muse` process, surfaced only as activity narration.
- Default roster migration: a pre-existing installation gains only the six new `muse-*` profiles on its next seed pass (30 default profiles total across five backends), without resurrecting any profile the user previously deleted or customized; a fresh installation seeds all 30 directly.
- Offline coverage in `test/muse-backend.test.ts` (including authoritative negative tests for a nested run's own terminal.completed/terminal.failed being ignored, and a terminal event whose run_stream never matches the established root failing closed) plus extended permission/defaults/profiles/resume/spawn-observation/run-inspection regression tests; opt-in real-provider coverage via `npm run e2e -- --backend muse` and `--backend muse --workflow`/`--interrupt`.

### Known limitation

- Nested-agent (sub-delegation) detection for Muse always reports false and never grants the one-time nested-timeout extension: every real probe run observed only internal `reminder.agent.*` skill-reminder tasks, never a genuine agent delegation (the CLI reported "Agent delegation: auto unavailable: workspace is untrusted" in every probe), so there is no confirmed real event shape to key off — a speculative `task_kind` match was deliberately rejected as unsafe (it would let ordinary internal task activity spuriously extend the deadline) and removed after review.

## [2.3.1-external.0] - 2026-09-21

### Fixed
- Resolve permission requests against the profile's minimum authority (`readonly < edit < danger`) across all harnesses. Parent requests can increase permissions but cannot reduce a worker's calibrated permission floor. Agent, workflow, and disclosures share the same resolver; backend-specific floors remain in effect.

## [2.3.0-external.0] - 2026-09-21

Unifies the run experience across direct `Agent`, `workflow`, and `external_runs` per issue #52: a shared projection, shared rendering, and a corrected model/human contract, rather than isolated renderer patches.

### Added

- `Agent`, `workflow`, and `external_runs` now share one normalized run projection (`src/core/run-projection.ts`) for identity/state/timing/output, covering both agents (`projectLiveAgent`/`projectDurableAgent`) and workflows (`projectWorkflowRun`). Every `external_runs` surface — `list`, single `inspect`, batch `inspect`, and `wait` — routes through it instead of independently hand-rolling its own shape; a durable `list`/`inspect` row now also carries the same nested `task`/`state`/`output` shape a live one already had, alongside its existing flat fields for compatibility.
- Run identity now includes the resolved profile and harness end-to-end: `Agent`, workflow children, and every backend (`claude`/`codex`/`agy`/pi) persist an explicit `harness` (registered pi-* config, or equal to backend for external CLIs) on `SubagentProgressNode`/`SubagentToolDetails`/`WorkflowAgentSnapshot` and in run-record metadata — never reparsed or guessed from a profile/subagentType name. `RunTaskProjection.profile`/`.harness` are populated from this real persisted data (`src/profiles.ts`'s `selectorHarness` is the one shared resolution).
- `external_runs` registers its own `renderCall`/`renderResult` for the first time, covering `list`, single/batch `inspect`, `wait`, and `cancel` with the same reusable header/row presentation `Agent`/`workflow` already use (`src/core/run-render.ts`, shared with `/external runs`' own text formatting).
- `external_runs wait` reports bounded live progress through its update channel while waiting — watched targets, completed/pending counts, and recent activity — on a fixed heartbeat independent of any single target settling; it stops on settlement, error, or interruption without ever cancelling watched work.
- Text answers now render as Markdown where a host theme is available (`renderOutputText` in `src/core/subagent-render.ts`, shared by `Agent`'s expanded output, `workflow`'s final text-answer output, and `external_runs`'s `output`/`final` views), falling back to plain text — never throwing — when no theme has been initialized (headless/RPC callers, tests). A workflow's structured (non-string) result stays formatted data, never Markdown-interpreted, per this issue's "no invented prose answer" contract.
- Workflow `agent()` accepts `description` as a compatible alias for `label`, matching direct `Agent`'s common task-name option; setting both to different values is rejected.
- `WorkflowToolDetails` gained an additive `lifecycleStatus` field normalizing the legacy internal `"completed"` state word to the same vocabulary `Agent`'s `details.status` already uses (`"done"`), for a coordinating model reading either tool's details. The internal `status` field and its literal `"completed"` value are unchanged for existing readers (journal replay, rendering internals).
- Documented ccstyle (`pi-cc-extensions`) host-renderer integration: the `excludeRenderers` setting is the supported way to preserve `Agent`/`workflow`/`external_runs`'s own rendering under that host (README "Host renderer integration").
- Added an authoritative cross-surface contract test (`test/run-contract.test.ts`) asserting the same run reports the same identity/status/output facts across `list`, single `inspect`, batch `inspect`, and `wait`, and that a workflow child's identity matches what `external_runs` independently reports for that same child runId.

### Changed

- `external_runs wait` no longer clips every settled outcome to a fixed 512-character `preview`. Each response now spends one shared byte budget (`limitBytes`, default 32768) across all settled outcomes in the caller's REQUESTED order (never settlement race order — two calls with the same targets and final states now spend the budget identically regardless of which target happened to settle first): a result that fits is returned complete under the new `result` field; one that does not is truncated to what remains with `resultTruncated: true`, alongside the existing `outputRef`/`diagnosticsRef` to read the rest. A disk read of a target's evidence is now skipped entirely once the shared budget is already exhausted, rather than reading and then discarding it. The old `preview` field is removed.
- `liveSummary`/`journalSummary`/batch `resolveRunSummaryEntry`'s workflow branch now build their `task`/`state`/`output` through the single shared `projectWorkflowRun`, fixing a real drift: batch inspect previously omitted `output.status` entirely (present on the other two), and `liveSummary` never stated a top-level `live` flag.
- `WorkflowAgentSnapshot` field copying (`workflow/tool.ts`) now goes through shared helpers (`src/core/agent-snapshot.ts`) instead of an inline per-field copy. Fixes a real disclosure/evidence gap: a workflow child's `retries`, `retryOf`, and `permissionRequested` were never copied onto its snapshot at all (silently dropped the moment a retried/elevated child ran inside a workflow instead of as a direct `Agent` call), and `thinkingClamped` was dropped on the running-progress copy.
- Corrected the workflow help's background example: `background` is a `workflow` tool call parameter, never a `meta` field. The previous example's `meta.background: true` was silently ignored and did not run the workflow in the background.

### Fixed

- `preview`'s hidden double-truncation: a full in-memory `outcome.result` under 512 characters was fine, but the exact bug reported in issue #52 (`external_runs wait` returning `kind: "agent"` with a clipped result) is now gone for any result that fits the shared budget.
Adds `grok` as a fourth external CLI backend, delegating to the official Grok Build CLI alongside Claude Code, Codex CLI, and Antigravity. Investigation notes: `docs/plans/grok-backend-prep.md`; implementation plan: `docs/plans/2026-05-21-grok-cli-implementation.md`; ex-ante design issue: [#51](https://github.com/tranhoangnguyen03/pi-flow-external/issues/51).

### Added

- `grok` backend (`src/core/grok.ts`), verified against Grok Build CLI `1.0.40`, installed and authenticated independently of Pi. Normal runs use `--output-format streaming-messages-json` (a Claude-compatible `assistant`/`result` event envelope); structured output uses `--json-schema` and parses the single terminal document's `structuredOutput` field. Prompts are passed through a temporary `--prompt-file` since Grok does not read stdin. Terminal success requires an observed `result` event affirming `subtype: "success"`, `is_error: false`, and `stop_reason: "end_turn"` — never inferred from exit code or accumulated text alone.
- Native kernel-sandbox permission tiers: `readonly` (`--sandbox read-only`), `edit` (`--sandbox workspace`), and `danger` (`--sandbox off`), always paired with `--permission-mode bypassPermissions` — bypass only skips the interactive approval prompt; the sandbox remains the real enforced boundary at every tier. `edit` already permits shell execution, so Grok execution-lane roles need no `edit`→`danger` floor. `readonly`'s network-blocking guarantee is Linux-only, and sandbox startup can fail closed on macOS hosts (for example, a symlinked `/var/run/docker.sock`) rather than silently running unsandboxed.
- `resume` support via Grok's own `--resume <sessionId>` and native cost reporting (`total_cost_usd`); Grok has no budget-enforcement mechanism, so `max_budget_usd` is recorded but unenforceable, and — like codex — failed or aborted runs are never automatically retried (agy's one infra-failure retry exception does not apply to Grok).
- Default roster migration: a pre-existing installation gains only the six new `grok-*` profiles on its next seed pass (24 default profiles total across four backends), without resurrecting any profile the user previously deleted or customized; a fresh installation seeds all 24 directly.
- Offline coverage in `test/grok-backend.test.ts` plus extended permission/defaults/spawn/profile/run-inspection regression tests; opt-in real-provider coverage via `npm run e2e -- --backend grok` and `--backend grok --workflow`.

### Fixed

- Overhauled `scripts/e2e/external.mjs`: the default `npm run e2e -- --backend <...> [--workflow|--interrupt]` lane no longer routes tool selection through a real, paid, nondeterministic root Pi LLM. It now builds an in-process Pi SDK session with a faux, never-prompted root model (via the same public SDK/faux-provider patterns `test/helpers/pi-subagent-harness.ts` already uses) and calls the `Agent`/`workflow`/`external_runs` tool executors directly — only the selected external backend's own child (a real spawned CLI process, or, for `--backend pi`, a real in-process nested Pi child) is real. This also fixes two related failures the old design could hit: concurrent direct/workflow runs colliding on a `Date.now()`-only temporary role name (now `randomUUID()`), and an isolated agent directory hiding a real custom root model/auth and surfacing as an unrelated coordinator startup failure (the new default lane never needs a real root model at all). The prior natural-language, real-root-LLM routing check survives unchanged as an explicit, opt-in `--routing-smoke` flag for when role discovery, tool descriptions, or coordinator guidance changes.

## [2.2.0-external.0] - 2026-09-20

### Added

- `external_runs` `inspect` now accepts a bounded `runIds` batch (up to 20, deduplicated, order preserved) returning one consistent normalized summary entry per target — live, durable, agent, or workflow — without waiting for completion.
- Added a verified `view: "final"` projection that returns only a backend's own canonical terminal answer, separate from combined narration/output; unavailable is a bounded, narration-free empty page (`finalAvailable: false`), never a synthesized sentence.
- Derived explicit queue/elapsed/activity timing (`queueDelayMs`, `elapsedMs`, `activityAgeMs`, `processDurationMs`) from existing evidence, computed only where the underlying timestamps genuinely exist; a registry-confirmed-live run is required before now-relative durations are computed, so an orphaned/crashed durable record is never misreported as actively running.
- `/external runs` list rows now show status, queue/elapsed duration, live activity age, and output/final availability, plus a manual `Refresh` choice that re-reads the current page and resets stale cursors.

### Fixed

- Recorded an explicit `execution_started` evidence boundary (direct `Agent` calls and workflow `agent()` calls) so durable status classification and timing no longer depend solely on `processStartedAt`, which never exists for in-process Pi children.
- A workflow child's own registry entry now transitions `queued` → `running` explicitly at limiter-acquisition time, instead of only incidentally once its backend's first progress event fires.
- Settled `outcome.status` now wins over a possibly-stale ambient `observation.status` once a run has terminated.
- An unresolvable `wf_...` ID now rejects consistently as unknown/unavailable across `inspect`, `cancel`, `wait`, and batch `inspect`, instead of falling through to the agent-only durable reader.

## [2.1.0-external.3] - 2026-09-18

### Fixed

- Prevented Claude `is_error: true` result diagnostic from being mislabeled as assistant output on terminal error.
- Supported Pi `responseId` in `inspectRun` event-stream projection and added regression coverage for live Pi event inspection.
- Handled surrogate-pair boundaries when slicing the interrupted output tail and shared the `OUTPUT_PREVIEW_CHARS` constant across spawn and workflow receipts.
- Pinned spawn-level timeout rewrite behavior and workflow script `assistantOutput` error propagation in automated tests.

## [2.1.0-external.2] - 2026-09-18

### Fixed

- Preserved and exposed available partial assistant output on failure, cancellation, and timeout across all backend adapters (`codex`, `claude`, `agy`, and in-process `pi`). Unsuccessful terminal receipts retain the failure status and error diagnostic while appending a bounded `Interrupted output:` preview.
- Recovered interrupted assistant output in run evidence inspection (`external_runs(action: "inspect", view: "output")`) from completed non-done summary documents, including Pi SDK child runs.
- `ChildRunError` preserves `partialOutput` and `assistantOutput` for workflow scripts to inspect, and uncaught child errors surface the interrupted output preview in workflow failure receipts.
- Hardened CI release workflow polling loop against npm registry replication latency (increased timeout to 150s).

## [2.1.0-external.1] - 2026-09-16

### Fixed

- Coordinator guidance now names all four harnesses (`Agent` description, `buildCoordinatorPrompt` body): registered Pi harnesses are first-class alongside Claude Code/Codex CLI/Antigravity, not "external CLIs only" leftovers of the pre-2.1.0 copy. `test/agent-contract`/`agent-rendering` pin the copy.
- Parent guidance states the blocking default explicitly (`background:true` is opt-in, use `external_runs` on the returned handle) and how same-harness parallel work actually shares the one `maxConcurrentSubagents` limiter: workflow `parallel([() => agent(...), ...])` or separate background `Agent` calls in one turn; sequential awaits stay serial. Includes a three-`agy` workflow example plus fore/background meta examples in `external_help`. Pinned by a new `test/external-help` regression.

## [2.1.0-external.0] - 2026-09-15

Named Pi harness configurations (`pi-*`): a fourth delegation surface running in-process through Pi's own SDK, selectable exactly like `agy`/`claude`/`codex`. Design: `docs/plans/pi-named-configurations-design.md`; plan: `docs/plans/pi-named-configurations-implementation-plan.md`.

### Added

- Named `pi-*` harness configurations: arbitrary labels pinning any `provider/model` resolvable through Pi's model registry (built-in, self-hosted, or OpenAI-compatible) plus an explicit thinking level, registered in `~/.pi/agent/pi-flow-external/harnesses.json`.
- `Agent({ role, harness: "pi-<label>" })` and workflow `agent()` treat `pi-*` names as first-class harnesses; the six canonical roles (`explorer`/`planner`/`implementer`/`reviewer`/`qa`/`worker`) are synthesized automatically for every registered pi harness with no per-harness files.
- A `backend: pi` profile is delegation-eligible only when it declares a registered `harness`; the registry stays authoritative for model/thinking (conflicting on-disk overrides fail rather than silently win).
- Profile creator gains a harness-declaration branch (`pi_flow_harness_create`) and role profiles targeting an existing pi harness, both smoke-tested through the real runtime with atomic staged writes.
- Pi runtime contract: curated built-in-only child tools (no extensions/skills/themes), synchronous model/auth/thinking preflights, tier→tool allow-lists, execution-role `edit`→`danger` floor, per-child in-memory retry disable (never touching user settings), observed non-retrying terminal-event + non-whitespace completion, thinking-clamp disclosure, and backend-aware permission labels that never call an in-process child an "external CLI".
- `/external settings`, `/external doctor`, and `external_help` disclose pi harnesses and their model/thinking; stale or deleted `defaultHarness` fails the delegation explicitly rather than silently rerouting to `agy`.
- Workflow replay fingerprints include the resolved backend/harness/model/thinking/profile body/tools/effective permission plus an SDK-version policy tag; each workflow freezes one complete profile snapshot (synthesized profiles included) for its run.

### Limitations (v1)

- Pi children are built-in tools only; they do not load project/user extensions, skills, prompt templates, themes, or MCP tools. Expansion tracked in issue #43.
- Custom (non-canonical) pi roles are authored per harness in v1.
- Pi children cannot be resumed and enforce no hard budget cap; both are disclosed, not approximated.

## [2.0.0-external.0] - 2026-09-14

Child observation and workflow-aware supervision. Full design: `docs/plans/2026-09-14-child-observation-and-supervision-design.md`.

### Breaking

- Workflows must declare `meta.apiVersion: 1`. Unversioned or unsupported scripts are rejected before any child launches, with recomposition guidance; one current contract, no legacy failure mode.
- `agent()` throws a structured, catchable `ChildRunError` (outcome, run ID, reason, output/diagnostic references) for failed, cancelled, or timed-out children instead of returning `null`. Composition helpers no longer swallow child failures; unhandled errors terminate the workflow and cancel remaining children. Errors escaping user `catch` blocks propagate.
- Replay is a new explicit attempt with longest unchanged successful-prefix reuse; historical cancellations do not carry forward, and replay evidence from another project or an incompatible API contract is rejected.

### Added

- Background (session-owned) `Agent` and `workflow` execution: runs survive tool-call returns and parent turns; interrupting a wait stops waiting only; closing the session cancels its work. Blocking calls keep interruption-cancels semantics.
- `external_runs` tool: `list` (session/project scoped), `inspect` (summary/output/diagnostics with bounded pages and opaque cursors), `wait` (one/any/all selected runs; outcome-only, no routine wake-ups; `all` escalates on unhandled workflow failure), `cancel` (scoped child/workflow, requested vs confirmed distinguished).
- Stable run IDs from queueing through evidence retrieval, including cancelled-while-queued runs.
- Readable partial and final child output recovered from run evidence across failure, cancellation, and timeout for all three backends, with preliminary/final/interrupted labels.
- Interactive `/external runs` navigation: run list, every workflow child, paged output/diagnostics, and selected-run cancellation; expanded receipts show bounded canonical output and freshness.
- Run listings show process-started vs first-activity, activity freshness, and interrupted/uncertain state for crashed or restarted sessions — never falsely `running`.
- POSIX process-tree termination on cancellation (group SIGTERM→SIGKILL regardless of leader exit) and bounded shutdown draining with honest uncertainty reporting.

### Fixed

- Failed executable launches no longer recorded as `process started`; preallocated run records settle on resume-validation failure; discarded workflow chain rejections (including `undefined`) cannot yield successful completion; agy streamed deltas no longer duplicate the canonical result; live vs durable evidence states are reconciled for inspection; cancelled cleanup siblings remain discoverable in workflow journals.

### Notes

- Windows process-tree termination is covered by mocked `taskkill` tests only. Real-provider field checks are opt-in per `docs/field-testing.md`.

## [1.10.0-external.1] - 2026-09-12

Automated releases, adapted from [pi-bro](https://github.com/tranhoangnguyen03/pi-bro)'s pipeline.

### Added

- Automated releases: PR CI validates release metadata (version bump, matching `release:` label, lockfile, CHANGELOG section), and merging a bump PR tags the commit, publishes to npm via OIDC trusted publishing, and creates the GitHub release. `release:none` skips. A daily sync-check watches for npm/GitHub drift.

## [1.10.0-external.0] - 2026-09-12

Lets a trusted project pin its own default external harness, closing [#26](https://github.com/tranhoangnguyen03/pi-flow-external/issues/26).

### Added

- Project default-harness override: `<project>/.pi/pi-flow-external/settings.json` with `defaultHarness` sets the default external harness for trusted projects only. Precedence is unchanged elsewhere: an explicit call `harness` wins, then the trusted project default, then the global setting. The file is read-only to the extension, accepts `defaultHarness` only, and invalid or untrusted overrides are ignored with disclosed warnings — a role without a profile on the effective harness still fails with an actionable error instead of silently switching harnesses.
- `/external settings` reports the effective `defaultHarness` and its source (`(project: <path>)` or `(global)`), plus the project-override location and any project-file warnings.

### Fixed

- Delegating to agy on an older Antigravity CLI now fails with an actionable hint instead of Go's raw `flag provided but not defined: -input-format` usage dump: the error names the unsupported flag, the agy 1.1.15+ requirement for `--input-format stream-json`, and the `agy update` remedy, closing [#36](https://github.com/tranhoangnguyen03/pi-flow-external/issues/36).

## [1.9.0-external.0] - 2026-09-08

Lets the parent decide how much of its own conversation an external child starts with, closing [#30](https://github.com/tranhoangnguyen03/pi-flow-external/issues/30).

### Added

- Opt-in parent-context sharing for `Agent` and workflow `agent()`: `context: { mode: "recent", turns: N }` shares the last N available user turns (including the current one), `{ mode: "full" }` shares available current-branch conversation after compaction, and the default remains no shared history. A user turn starts at a user message and carries its assistant messages and tool exchanges; a linked tool call is retained when its result crosses the selected boundary.
- Context receipts on every surface: the delegation card names the requested mode before launch, compact and expanded rows report mode plus shared/requested turns, messages, bytes, and compaction state, and `summary.json` plus the workflow journal record the same block.
- `docs/field-testing.md` change-triggered context transfer check.

### Changed

- Coordinator guidance and `external_help` workflow help document the context modes, exclusions, and the `resume` exclusion.

### Notes

- Snapshots are frozen before queueing, exclude parent system instructions, thinking blocks, tool-result metadata, and pending tool calls, and fail explicitly on images/unsupported content or snapshots over 1 MiB instead of truncating. Sharing cannot be combined with `resume`. Workflow children select from one snapshot frozen at invocation, and replay fingerprints include the transferred context.
- This is text transfer into a new external conversation, not a native session clone, system-prompt inheritance, or guaranteed prompt-cache reuse.

## [1.8.0-external.1] - 2026-09-08

### Fixed

- agy `--print-timeout` is now derived from the configured `subagentTimeoutMs` instead of a hardcoded 15-minute ceiling that let agy's internal wait timeout preempt the extension's outer subagent deadline. A disabled deadline (`0`) maps to a ~1-year ceiling because agy has no no-timeout flag, and `timeout waiting for response` is pinned as non-retryable.

## [1.8.0-external.0] - 2026-09-08

### Added

- Role-first external delegation with optional harness overrides, a compact configured-role catalog, on-demand `external_help` for roles/permissions/workflows, and settings v3 with the global `defaultHarness` (initially `agy`). Legacy `subagent_type` remains available for exact-profile selection.

## [1.7.0-external.1] - 2026-09-07

### Fixed

- `/external profile clean-up` inverted ownership: it archived native Pi profiles (`backend: pi` or no backend), which belong to Pi's native subagent system, not this extension. It now archives only retired pi-flow default profiles (the former `debugger` role) after confirmation, and never lists or moves native Pi profiles.
- Profile ownership tag: profiles created through `/external profile create` are stamped `owner: user` in frontmatter, and clean-up refuses to archive any `owner: user` profile even when named directly (enforced at the archive mutation point). Hand-written profiles opt in with the same tag.

## [1.7.0-external.0] - 2026-09-07

### Added

- Shipped default profile roster: on first session start the extension seeds five code-oriented roles (explorer, planner, implementer, reviewer, qa) plus the generalist worker for each backend (18 profiles). Seeding is one-time (marker file), never overwrites existing profiles, and leaves `model`/`thinking` unpinned so defaults track the CLI's model and the current Pi thinking level. The `debugger` role is no longer shipped; create it with `/external profile create` if needed.
- `/external profile clean-up`: archives only profiles this extension itself shipped and later retired (currently the former `debugger` role) to `~/.pi/agent/subagents/archive/` after confirmation. Files are moved, never deleted; existing archive files are never overwritten. Native Pi profiles (`backend: pi` or no backend) and `owner: user` profiles are never touched. Non-interactive sessions get a read-only listing.
- Profile ownership tag: profiles created through `/external profile create` are stamped `owner: user` in frontmatter, and clean-up refuses to archive any `owner: user` profile even when named directly. Hand-written profiles can opt in with the same tag.

## [1.6.0-external.0] - 2026-09-07

### Changed

- Antigravity (`agy`) runs unsandboxed in every mode: its default headless sandbox (`proceed-in-sandbox`) hard-denies read-only tools like `read_url_content`, so `buildPermissionArgs` now always passes `--dangerously-skip-permissions` and `resolveEffectivePermissionTier` elevates every agy tier to `danger`. `readonly`/`edit` on agy are advisory profile-body instructions, not a harness boundary.
- Agent-facing surfaces stop promising a boundary agy cannot keep: the delegation roster and the `permission` parameter description now state the backend-honest rules, and the coordinator guidelines note that agy tiers are advisory only.

## [1.5.0-external.0] - 2026-09-06

Keeps Claude execution lanes from starting as guaranteed no-ops under an `edit` override, closing [#19](https://github.com/tranhoangnguyen03/pi-flow-external/issues/19).

### Added

- Claude execution profiles (`implementer`, `debugger`, `qa`, `worker`, or any profile declaring `permission: danger`) maintain a `danger` floor: an explicit `permission: "edit"` override is elevated to `danger` because headless Claude auto-denies all Bash commands at `acceptEdits`.
- Elevated runs are disclosed to the caller, not just the operator: the parent-facing result banner reads `[run run_xxx · permission elevated edit→danger]`, tool details and `summary.json` carry `permissionRequested`, and the pre-launch delegation line shows `(edit→danger floor)`.

### Changed

- Permission tiers now resolve once in the shared spawn primitive (`Agent` and `workflow` pass the requested tier plus the settings default), removing per-caller resolution drift.
- Agent guidelines and the `permission` parameter description now warn about the real remaining hazard: `edit` on non-execution Claude lanes still auto-denies shell commands headlessly.

## [1.4.0-external.0] - 2026-09-06

Routes the receipt's truth into the agent-facing surfaces a delegating parent actually reads, closing the disclosure gaps from [#16](https://github.com/tranhoangnguyen03/pi-flow-external/issues/16).

### Added

- Delegation and workflow rosters now show each profile's backend and default permission tier (e.g. `claude-implementer (claude · danger)`).
- Agent tool result text ends with the run id, plus the permission-denial count when any occurred (`[run run_xxx · N permission denials — commands may have been blocked]`), so a blocked lane is visible without parsing child prose or reading `summary.json`.

### Changed

- The `permission` parameter advice no longer steers callers toward `edit` for implementation tasks; it now states that omitting uses the profile's calibrated default (recommended) and that explicit tiers mean different things per backend (claude headless denies all shell at `edit`).

## [1.3.0-external.0] - 2026-09-06

Adds a bounded retry for the Antigravity backend and documents the standardized external profile role matrix.

### Added

- Single automatic retry for agy infrastructure failures (authentication, eligibility, network timeouts), disclosed in receipt details as `retries` and `retryOf`. Agent-level failures, aborts, and timeouts are never retried.

### Changed

- AGENTS.md records the agy retry exception to the no-auto-retry policy; CONTEXT.md documents the profile role-matrix design stance (guardrails define lanes, not methods) and the known one-file-per-backend format inelegance.

## [1.2.0-external.0] - 2026-08-29

Implements the orchestrator-decided tiers design ([#11](https://github.com/tranhoangnguyen03/pi-flow-external/issues/11)), live-verified against Claude Code 2.1.239, codex-cli 0.150.1, and agy 1.1.22.

### Added

- Orchestrator-decided permission tiers: `permission` (`readonly`/`edit`/`danger`, default `danger`) on `Agent` calls and workflow `agent()` children, enforced via native harness mechanisms (Claude permission modes, Codex single-axis `--sandbox`, agy bypass-flag omission). Unsupported tiers are labeled `advisory, not enforced` instead of blocking the launch; Claude permission denials are surfaced in receipts.
- Per-call and per-profile USD budgets (`max_budget_usd`, settings `defaultMaxBudgetUsd`): passed natively to Claude (`--max-budget-usd`) and recorded elsewhere with an honest `budget unenforceable` label when the backend reports no cost.
- Session resume: `resume` on `Agent`/`agent()` continues a prior run's backend conversation (Claude `--resume`, Codex `exec resume`, agy `--conversation`); session ids are recorded in `summary.json`. Claude sessions now persist in Claude Code's own local storage (live-verified: `--resume` fails after `--no-session-persistence`, so that flag is gone).
- Run-record retention: settings `maxRunRecords` (default 200, `0` keeps everything) prunes oldest completed records at session start and via `/external runs --prune`; incomplete or active records are never pruned.
- Settings v2 with migrate-on-read from v1 files.

### Changed

- Codex `danger` runs now use `--sandbox danger-full-access` (single axis) instead of `--dangerously-bypass-approvals-and-sandbox`, so sandbox and bypass flags can never combine.
- Run summaries replace the `permissionControl` prototype field with the resolved `permission` tier, enforcement flag, budget, session id, and resume provenance.

## [1.1.0-external.3] - 2026-08-28

### Fixed

- Claude runs that spawn background agents no longer fail when a later task-notification result follows the parent turn result; the latest result is used and process exit remains the stream boundary.
- Agy children now run with `--print-timeout 15m`, so Agy's own five-minute print-mode default can no longer end a run early. Runs longer than 15 minutes are cut by Agy itself; the extension timeout still governs below that.
- Agy failures now surface the backend's terminal error (for example "The stream was interrupted") instead of only `agy exited with code 1`.

## [1.1.0-external.2] - 2026-08-24

### Added

- Persistent direct-delegation cards showing the backend, selected profile, task, profile purpose, working directory, and unsandboxed execution boundary.
- Live external-host-access cues for direct agents and workflows.
- Expanded evidence receipts with local record paths and structured backend-event counts.
- Expanded workflow receipts with workflow evidence IDs and journal paths.

### Changed

- Completed external-run identifiers are labeled as `evidence` instead of `run`.
- Recording failures are labeled `evidence incomplete` independently of backend status.
- Backend labels use the recognizable product names Claude Code, Codex CLI, and Antigravity.
- Workflow progress retains explicit done, active, queued, and failed counts while access disclosure is shown once at the workflow level.

### Security

- The new access labels are disclosure only; this release does not add sandboxing or change external CLI permission modes.
- Read-only remains an instruction to an external agent, not an enforced permission boundary.
- Backend execution, timeout behavior, evidence formats, and automatic-retry policy are unchanged.
