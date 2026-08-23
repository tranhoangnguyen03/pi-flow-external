# Agent Notes

## pi-flow external contract

This fork changes the original pi-flow contract: `Agent` is not a generic Pi subagent launcher. It delegates only to external Claude Code, Codex CLI, and Antigravity harnesses.

- Ordinary driver tools: `Agent` and optional `workflow`. `pi_flow_profile_create` is active only inside `/external profile create`.
- User operations use `/external`; `/pi-flow-profile create` is a temporary deprecated alias.
- Extension-owned concurrency and timeout defaults live in `$PI_CODING_AGENT_DIR/pi-flow-external/settings.json`. Profile backend/model/thinking metadata remains in `subagents/*.md`.
- Every `Agent` call requires `description`, `prompt`, and an explicit backend-qualified `subagent_type`.
- Valid profiles come from `~/.pi/agent/subagents/*.md` and set `backend: claude`, `backend: codex`, or `backend: agy`. Use matching names such as `claude-*`, `codex-*`, or `agy-*`; the assisted creator enforces that convention.
- Profiles with `backend: pi` or a missing backend are filtered out and rejected.
- Use Pi's native subagent system for Pi-backed scout/reviewer/planner/worker/oracle work.
- External backends use their own tools and dangerous/no-approval modes. Claude falls back to `--permission-mode auto` when its effective UID is 0 because Claude refuses bypass mode under root. Run them only in trusted repositories and state whether the task is read-only or may edit files.
- Prompts must be self-contained because children do not inherit parent conversation, tool results, or reasoning.
- Backend-native nested agents may use a different workspace. Include explicit absolute paths and required context when asking an external backend to delegate further.

## Receipt and evidence invariants

- Success requires a recognized backend terminal-success event, a zero process exit, and a non-empty result.
- A backend failure with a complete local record is different from an incomplete or damaged record; preserve that distinction in reports.
- Normal runs write private best-effort evidence under `~/.pi/agent/pi-flow-external/runs/` or `PI_FLOW_EXTERNAL_RUNS_DIR`. Records may still contain sensitive prompts, excerpts, and tool output despite redaction.
- Structured nested-agent activity may extend the wall-clock deadline once, by one fresh base timeout, capped at twice the original deadline.
- Do not automatically retry failed or aborted external runs. Preserve the receipt and retry only when the user asks.

## Workflow contract

`workflow` remains trusted JavaScript orchestration over the same external-only profile roster. Every workflow `agent()` child needs an explicit backend-qualified `subagent_type`.

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
