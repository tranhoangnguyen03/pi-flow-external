# Agent Notes

## pi-flow external contract

This fork changes the original pi-flow contract: `Agent` is not a generic Pi subagent launcher. It delegates only to external Claude Code, Codex CLI, and Antigravity harnesses.

- Ordinary driver tools: `Agent`, read-only `external_help`, and optional `workflow`. `pi_flow_profile_create` is active only inside `/external profile create`.
- User operations use `/external`; `/pi-flow-profile create` is a temporary deprecated alias.
- Extension-owned concurrency, timeout, and global default-harness settings live in `$PI_CODING_AGENT_DIR/pi-flow-external/settings.json`. Profile backend/model/thinking metadata remains in `subagents/*.md`. A trusted project may override `defaultHarness` via `.pi/pi-flow-external/settings.json` (that key only, read-only to the extension); explicit call harness > project default > global default.
- Every `Agent` call requires `description`, `prompt`, and either `role` with optional `harness` (`agy`, `claude`, or `codex`) or the legacy exact-profile `subagent_type`. The selectors cannot be combined. Without `harness`, use the global `defaultHarness` setting (initially `agy`).
- Valid profiles come from `~/.pi/agent/subagents/*.md` and set `backend: claude`, `backend: codex`, or `backend: agy`. Use matching names such as `claude-*`, `codex-*`, or `agy-*`; the assisted creator enforces that convention.
- A default roster ships with the extension and seeds once on session start: five code-oriented roles (explorer, planner, implementer, reviewer, qa) plus the generalist worker, one storage profile per backend (18 files, but six advertised roles). Seeding never overwrites existing files and respects later deletions. Roles outside the default roster (such as debugger) are user-created via `/external profile create`.
- Profiles with `backend: pi` or a missing backend are filtered out and rejected; they belong to Pi's native subagent system and this extension never modifies them.
- `/external profile clean-up` archives only this extension's own retired default profiles (currently the former `debugger` role) to `subagents/archive/` after user confirmation. Profiles tagged `owner: user` (stamped automatically by `/external profile create`) are the user's property and are never archived, nor are native Pi profiles.
- Use Pi's native subagent system for Pi-backed scout/reviewer/planner/worker/oracle work.
- External backends use their own tools and permission mechanisms. Codex tiers map to its `--sandbox` axis. Claude falls back to `--permission-mode auto` when its effective UID is 0 because Claude refuses bypass mode under root. Execution lanes (implementer, debugger, qa, worker) require shell command authority to inspect repositories and run tests; on Claude (where headless edit auto-denies all Bash commands), execution lanes maintain a danger floor so agents are not artificially handcuffed. Antigravity (`agy`) has no granular headless permission mode — its default sandbox denies even read-only tools — so every agy run is unsandboxed (`--dangerously-skip-permissions`) and `readonly`/`edit` on agy are advisory profile-body instructions, not a boundary. Run them only in trusted repositories and state whether the task is read-only or may edit files.
- Children receive no parent history by default. `Agent` and workflow `agent()` can opt into `context: {mode: "recent", turns: N}` (last N user turns, including the current one), `{mode: "full"}` (available post-compaction conversation), or `{mode: "blackboard", threads: [ids]}` (durable project threads from `.pi/pi-flow-external/blackboard/*.md`, read per agent call so earlier children can publish for later ones). Snapshots exclude system instructions, thinking, tool-result metadata, and pending calls; unsupported content/images and more than 1 MiB fail explicitly. Use the smallest sufficient snapshot plus a clear task, absolute paths, and read-only/edit intent. Shared context goes to the external harness and private local evidence; avoid unnecessary sensitive history. `resume` continues an existing child and cannot be combined with sharing. Recent/full workflow children select from one frozen parent snapshot; blackboard children read thread files per agent call. Replay fingerprints include the transferred context (blackboard receipts carry a content digest so thread edits invalidate cached results).
- Backend-native nested agents may use a different workspace. Include explicit absolute paths and required context when asking an external backend to delegate further.

## Delegation transparency invariants

- Treat each `description` as a concise user-facing task label. Profile descriptions are also user-visible as the declared reason for profile selection.
- `unsandboxed external CLI` and `external host access` disclose the real execution boundary. Never present a read-only prompt as permission enforcement: on agy every run is unsandboxed regardless of tier, so the profile body — not the tier — is what asks the agent to stay read-only.
- Keep direct intent visible during execution. Workflow access belongs once at the workflow level, not on every child row.
- Parent-context sharing is a disclosure, not a silent optimization: the intent card names the mode before launch, and receipts name the mode and shared/requested turns. Shared conversation content leaves for the external harness and lands in local evidence, so never describe sharing as internal or free.
- Keep default progress bounded and human-readable. Expanded output may reveal existing record paths, backend-event counts, workflow IDs, and journal paths.
- Progress snapshots drive live presentation; persisted summaries and event logs remain the durable evidence source. Do not create a second UI-only record format.

## Receipt and evidence invariants

- Success requires a recognized backend terminal-success event, a zero process exit, and a non-empty result.
- A backend failure with a complete local record is different from an incomplete or damaged record; preserve that distinction in reports.
- Normal runs write private best-effort evidence under `~/.pi/agent/pi-flow-external/runs/` or `PI_FLOW_EXTERNAL_RUNS_DIR`. Records may still contain sensitive prompts, excerpts, and tool output despite redaction.
- Settings retention automatically prunes eligible completed records beyond `maxRunRecords`; active, interrupted, incomplete, and damaged records are not eligible.
- Structured nested-agent activity may extend the wall-clock deadline once, by one fresh base timeout, capped at twice the original deadline.
- Do not automatically retry failed or aborted external runs. Preserve the receipt and retry only when the user asks. Exception: the agy backend retries once on infrastructure-classified failures (auth, eligibility, network); the retry is disclosed in the receipt details (`retries`, `retryOf`) and never applies to agent-level failures, aborts, or timeouts.

## Workflow contract

`workflow` remains trusted JavaScript orchestration over the same external-only role roster. Every workflow `agent()` child uses the same `role`/optional `harness` resolution as `Agent`, with legacy exact-profile `subagent_type` available as an escape hatch.

Use workflows for requested fan-out or multi-agent orchestration across Claude/Codex/Antigravity lanes. Do not route native Pi subagents through `workflow`.

## Essential test mandate

- Keep one authoritative automated test per behavior at the lowest useful layer.
- Test public contracts, trust/security boundaries, process lifecycle, cancellation/timeouts, profile rollback, workflow execution/resume, and receipt integrity.
- Do not test cosmetic rendering variations, prompt prose fragments, trivial accessors, or a model's interpretation of instructions.
- Do not repeat the same behavior at unit, integration, and E2E levels. A regression test must replace or extend overlapping coverage.
- `npm test` must remain deterministic and offline. Real-provider E2E is opt-in and change-triggered through `npm run e2e -- --backend <claude|codex|agy> [--workflow]`.

## Verification and release

- Run `npm run check`, `npm pack --dry-run --json`, and `npm audit --omit=dev --audit-level=high` before release.
- Follow `docs/field-testing.md` for real-backend checks and `docs/releasing.md` for versioning, npm authentication, prerelease tags, 2FA, and registry verification.
- Never republish an existing npm version or force-push release history.
