# pi-flow-external — Architecture Snapshot

> **Verified:** 2026-09-16 · HEAD `efef9e3` on `chore/ci-test-timeout` (1 ahead of `origin/main`, clean tree) · `npm run check` green (tsc + 321/321 offline) · pinned SDK `@earendil-works/pi-coding-agent@0.79.4` (global CLI `0.85.1` differs, pinned is ground truth) · branch `chore/ci-test-timeout` only raises `vitest.testTimeout` 5s→15s.

Read `CONTEXT.md` + `AGENTS.md` first for invariants, then this file for implementation map.

## 1. Intent & routing

Fork of pi-flow. Ordinary driver: `Agent`, optional `workflow`, read-only `external_help`, `external_runs`; finalizers `pi_flow_profile_create`/`pi_flow_harness_create` only inside `/external profile create`. Native Pi work → Pi subagent tool. Everything else → this extension.

4 harnesses: `claude` (CLI) · `codex` (CLI) · `agy` (CLI, always `--dangerously-skip-permissions`) · `pi-*` (registered in-process configs, not a CLI). `pi-*` runs via `createAgentSession` with parent's live `modelRegistry` instance.

## 2. System map

- `index.ts` → `src/pi-subagent.ts` — lifecycle, flags `--max-concurrent-subagents`/`--subagent-timeout-ms`, `Agent` tool, `buildCoordinatorPrompt` injection, status line.
- `src/profiles.ts` — parse `~/.pi/agent/subagents/*.md`, legitimacy filter (`backend:pi` needs `harness:registeredName`), `mergeSynthesizedPiProfiles` (non-throwing roster merge), `resolveExternalProfile` (throwing at selection), `resolveEffectivePermissionTier`/`isExecutionProfile`.
- `src/default-roles.ts` — 6 roles `explorer/planner/implementer/reviewer/qa/worker` (dependency-free leaf).
- `src/defaults.ts` — one-time seed 18 CLI files (6×3), never overwrite.
- `src/harnesses.ts` — `~/.pi/agent/pi-flow-external/harnesses.json` (`pi-<label>` → `provider/model` + `thinking off|minimal|low|medium|high|xhigh`), migrate-on-read, atomic `write+rename`, last-writer-wins accepted v1.
- `src/settings.ts` — v3 settings `defaultHarness/maxConcurrentSubagents/subagentTimeoutMs/defaultPermission/defaultMaxBudgetUsd/maxRunRecords`, trusted project `.pi/pi-flow-external/settings.json` may override only `defaultHarness`; precedence `call harness > project > global`; stale default at delegation fails, never silently falls back to `agy`.
- `src/core/spawn.ts:846` — shared primitive: `resolveEffectivePermissionTier` → `resolvePermission`, optional `resumeRunId` resolve, `createTimeoutSignal`, `recordRun`, dispatch to `claude/codex/agy/pi`. Outer `spawnSubagent` handles timeout rewrite, abort mapping, receipt banner, durable finish.
- `src/core/permissions.ts` — single source `PI_TIER_ACTIVE_TOOLS`; execution lanes (`implementer/qa/worker` + `permission:danger`) floor `edit→danger` on `claude`/`pi`; `agy` elevates every tier to `danger`; `permissionLabel` — CLRIs `unsandboxed external CLI` vs Pi `Pi SDK child · host access · curated tools`.
- `src/core/claude|codex|agy.ts` — CLI adapters, stream-json parsing, session-id threading (`--resume`/`resume`/`--conversation`), cost mapping, oversize/BoundedBuffer, process-tree kill.
- `src/core/concurrency|timeout|process-tree|model|retention|progress|stream|parent-context|...` — shared primitives.
- `src/workflow/*` — `script-validation` (require `export const meta={apiVersion:1,name,description}`, reject `Date`/`Math.random` determinism lint), `script-worker` (`worker_threads`+`vm`, trusted JS — not a security sandbox), `runtime` (limits `maxAgentCalls 1000`/`maxLogs 500`/`maxLogLength 4000`), `tool→runtime→spawn` path with frozen roster snapshot, `journal` (`run-wf_*.jsonl`), `replay-cache` (`WORKFLOW_FINGERPRINT_POLICY_VERSION = tier-tools-v1+pi-coding-agent@<version>` over `subagentType`+descriptor+effective permission+context+phase+schema), `source`/`registry`/`structured-output`.
- `src/profile-creator.ts` — interview → staged `0o600` temp → real smoke `PI_FLOW_PROFILE_OK` → hard-link/or rename install or rollback.
- `src/external-runs.ts` / `src/core/run-registry.ts` / `src/core/run-record.ts` / `src/core/run-inspection.ts` — supervision.

## 3. Execution contracts (the parts that bite)

- Concurrency: global `maxConcurrentSubagents` default 12, one `ConcurrencyLimiter` shared `Agent`+workflow, `acquire(signal)` queues, not per-harness. `Agent` is `executionMode:"parallel"`. Workflow parallelism requires `parallel([()=>agent(...)])`. 3× same harness (e.g. 3× `agy`) works when queued concurrently, not when sequentially `await`ed.
- Timeout: queue excluded, one `nestedActivitySeen` extension by fresh base capped 2× original. Pi abort cooperative (`session.abort()`), CLRIs SIGTERM→SIGKILL group kill (Windows `taskkill` mocked).
- Cost: Claude native `--max-budget-usd`; else recorded `budgetEnforceable:false`. Codex cost estimated from 3-model price map, `costEstimated:true`.
- Pi child: `noExtensions/noSkills/noPromptTemplates/noThemes:true`, `noContextFiles:false` (project `AGENTS.md` text still loads, inert). Tiers `readonly:read/grep/find/ls`, `edit:+edit/write`, `danger:read/bash/edit/write`; explicit `tools:` intersected. Retry disabled in-memory **after** `resourceLoader.reload()` via `SettingsManager.applyOverrides`, never persisted. Cooperative abort only. No resume (in-memory session disposed, `resolveResume` errors clean). No hard budget.
- Auth preflights before session: closed thinking `off…xhigh`, `hasConfiguredAuth` sync, model resolve discriminated errors. Success = observed `agent_end.willRetry===false` + no terminal `stopReason:error/aborted` + non-whitespace final text + thinking-clamp disclosed.

## 4. Parent context & supervision

Context default none; `recent N`/`full` frozen before queue, one snapshot per workflow, excludes system/thinking/pending, >1MiB/images throw, `resume`+context mutually exclusive, disclosed on intent card + receipt. Supervision: blocking default, `background:true` returns `run_*`/`wf_*` after validation/registration, session-owned (not daemon), `external_runs` `list/inspect/wait/cancel` session/project scoped, wait outcome-only never cancels work, `all` returns early on unsuccessful selected workflow, cancel preserves reason, crash→`interrupted_or_uncertain` never retro-adopted.

Evidence: `runs/<run-id>/{events.ndjson,summary.json}` best-effort redacted, not secrecy boundary; retention prunes oldest completed >`maxRunRecords`, never active/interrupted/incomplete/damaged; `list` keyset, `inspect` byte-paged opaque base64url cursors (`MAX 64KiB`, stale fails), integrity `complete/incomplete/damaged`. Known gap proved: `run-inspection.outputFromEvent` has no `pi` case — failed Pi durable paging returns empty on `output` view (live result still present, `diagnostics` has raw events); live/terminal path unaffected.

## 5. Coordinator guidance (current stale copy)

`src/prompts.ts:AGENT_PROMPT_SNIPPET` and `buildCoordinatorPrompt` still read "Claude Code, Codex CLI, or Antigravity" / "External delegation tools use external CLIs only". Since 2.1.0, `pi-*` are first-class harnesses — copy must read "…or registered Pi harness" / "…use external CLIs and registered Pi harnesses". Fixed in this patch.

## 6. Operational

- `npm test` deterministic offline; real-provider E2E `npm run e2e -- --backend <claude|codex|agy>[ --workflow]` and `pi --harness pi-*` opt-in, change-triggered (`docs/field-testing.md`).
- Release automated on version-bumped PR (`release:patch|minor|major|prerelease`, `release:none` for non-shipped), CI `release-utils.mjs` enforces `X.Y.Z-external.N`, `package-lock` sync, `CHANGELOG` section; merge tags `v*`, OIDC trusted publish to `latest`, GitHub release; watchdog `sync-check.yml`. Current drift: npm `latest 2.1.0-external.0` vs GitHub latest `v2.0.0-external.0` — re-run release workflow.
- Open issues: #35 steering (scoped cancel now done, progress/steer/pause deferred), #39 drift, #40 partial output, #41 decision node, #43 Pi capabilities; PR #46 `release:none` CI timeout only, green.

## 7. Quick map for next agent

Start: `src/pi-subagent.ts:createAgentTool` → `src/core/spawn.ts:spawnSubagent` → `src/core/{claude,codex,agy}.ts` or Pi branch. Workflow: `src/workflow/{source,script-validation,tool,runtime,script-worker,journal,replay-cache}`. Config: `src/{profiles,harnesses,settings,defaults,default-roles}.ts`. Evidence: `src/core/{run-record,run-inspection,run-registry}.ts` + `src/external-runs.ts`.
