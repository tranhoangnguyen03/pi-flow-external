# pi-flow external context

This package is a fork of pi-flow whose `Agent` and `workflow` tools are reserved for external agent harness delegation.

## Domain language

External profile: A markdown file under `~/.pi/agent/subagents/*.md` whose frontmatter sets `backend: claude`, `backend: codex`, or `backend: agy`.

Native Pi subagent: A subagent exposed by pi's native subagent system. This fork intentionally does not route those through `Agent`.

Agent call: A direct external delegation to Claude Code, Codex CLI, or Antigravity.

Workflow call: A trusted JavaScript orchestration that may fan out several external `agent()` calls.

## Routing rule

- Native Pi work -> native subagent tool.
- Claude Code / Codex CLI / Antigravity work -> this extension's `Agent` or `workflow`.

The split is global and intentional to avoid tool ambiguity across projects.
