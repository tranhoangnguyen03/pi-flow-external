# pi-flow external

External Claude Code and Codex delegation for [pi](https://github.com/earendil-works/pi).

This fork intentionally narrows pi-flow's `Agent` and `workflow` subagent lanes to external CLI backends only:

- **Claude Code** via profiles with `backend: claude`
- **Codex CLI** via profiles with `backend: codex`

Use pi's native subagent system for Pi-backed agents such as scout, reviewer, planner, worker, or oracle. Use this extension only when you explicitly want another agent harness.

## Why this fork exists

The upstream pi-flow package can launch Pi, Codex, and Claude subagents through the same `Agent` tool. That is powerful, but it creates routing ambiguity when pi also exposes a native subagent system.

This fork enforces a global split:

```text
Native Pi delegation      -> native subagent tool
External harnesses        -> Agent / workflow from this extension
```

That keeps prompts predictable across projects:

- "Use scout/reviewer/planner" means native Pi subagents.
- "Ask Claude Code" means an `Agent` profile named like `claude-*`.
- "Ask Codex" means an `Agent` profile named like `codex-*`.

## Install

After publishing this fork to npm:

```bash
pi install npm:@davidus-tranus/pi-flow-external
```

For local development, install from this checkout if your pi installation supports local extension paths.

## Define external profiles

Custom profiles live in `~/.pi/agent/subagents/<name>.md`. Only profiles whose frontmatter sets `backend: claude` or `backend: codex` are shown to, and accepted by, `Agent`/`workflow`.

Recommended naming convention:

```text
claude-explorer.md
claude-reviewer.md
codex-explorer.md
codex-reviewer.md
```

Claude example:

```md
---
description: Repository exploration through Claude Code.
backend: claude
model: sonnet
thinking: high
---

Explore the repository read-only. Identify architecture, entry points, tests, configuration, risks, and recommended first-read files.
```

Codex example:

```md
---
description: Broad code search through Codex CLI.
backend: codex
model: gpt-5.4-mini
thinking: high
---

Search broadly and summarize findings with file references. Do not edit files.
```

Profiles with `backend: pi` or missing `backend` are rejected by design. Use the native subagent system for those jobs.

## Use Agent

```ts
Agent({
  description: "Claude repo map",
  subagent_type: "claude-explorer",
  prompt: "Map this repository read-only and summarize important files.",
});
```

Subagents start fresh in the same working directory. Parent messages and tool results are not inherited, so prompts must be self-contained.

External profiles run local CLI commands in no-approval mode (`claude ... --dangerously-skip-permissions`, `codex exec ... --dangerously-bypass-approvals-and-sandbox`). Use them only in trusted repositories.

## Use workflows

The `workflow` tool is still available for trusted JavaScript orchestration, but its `agent()` calls use the same external-only profile roster. It is useful for mixing several Claude/Codex lanes and synthesizing their outputs.

## Runtime guardrails

Direct `Agent` calls and workflow `agent()` calls share one global concurrency cap and one wall-clock timeout guardrail:

```bash
pi --max-concurrent-subagents 4 --subagent-timeout-ms 600000
```

Set `--subagent-timeout-ms` to `0` to disable the timeout. Values are milliseconds.
