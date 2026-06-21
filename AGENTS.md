# Agent Notes

## pi-flow external contract

This fork changes the original pi-flow contract: `Agent` is no longer a generic Pi subagent launcher. It is an external delegation tool only.

- Registered tools: `Agent` and optional `workflow`.
- `Agent` accepts `description`, `prompt`, and optional `subagent_type`.
- Valid `Agent` profiles must come from `~/.pi/agent/subagents/*.md` and set `backend: claude`, `backend: codex`, or `backend: agy`.
- Profiles with `backend: pi` or missing `backend` are filtered out and rejected.
- Use the native Pi subagent system for Pi-backed scout/reviewer/planner/worker/oracle style delegation.
- Prefer backend-qualified profile names: `claude-*`, `codex-*`, and `agy-*`.
- External CLI backends use their own tool surface and no-approval command modes; use them only in trusted repositories.
- Subagent prompts must be self-contained because children do not inherit parent conversation or tool results.

## Workflow contract

`workflow` remains a trusted JavaScript orchestration tool. Its `agent()` calls use the same external-only profile roster as `Agent`.

Use workflows when the user asks for explicit fan-out or multi-agent orchestration across Claude/Codex/Antigravity lanes. Do not use workflow for native Pi subagents; use the native subagent system instead.
