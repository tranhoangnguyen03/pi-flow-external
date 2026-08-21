# pi-flow external

External Claude Code, Codex CLI, and Antigravity delegation for [pi](https://github.com/earendil-works/pi).

This fork intentionally narrows pi-flow's `Agent` and `workflow` subagent lanes to external CLI backends only:

- **Claude Code** via profiles with `backend: claude`
- **Codex CLI** via profiles with `backend: codex`
- **Antigravity** via profiles with `backend: agy`

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
- "Ask Antigravity" means an `Agent` profile named like `agy-*`.

## Install

Global install from npm; the `npm:` prefix is required:

```bash
pi install npm:@tranhoangnguyen0310/pi-flow-external
pi list
```

Project-only install:

```bash
pi install -l npm:@tranhoangnguyen0310/pi-flow-external
```

Project packages load after project trust. In a fresh project, `pi list --approve` can display a project package before trust so you can approve it.

Local development examples:

```bash
cd /path/to/pi-flow-external
pi install "$(pwd)"
```

Run once from a checkout without installing:

```bash
cd /path/to/pi-flow-external
pi -e ./index.ts
```

## Prerequisites and onboarding

This npm package installs the Pi extension only. It does not install or authenticate Claude Code (`claude`), Codex CLI (`codex`), or Antigravity (`agy`). At least one selected CLI must be installed, on `PATH`, and authenticated:

```bash
claude --version
codex --version
agy --version
```

External profiles run those CLIs in no-approval/dangerous modes (`claude ... --dangerously-skip-permissions`, `codex exec ... --dangerously-bypass-approvals-and-sandbox`, `agy --dangerously-skip-permissions`). Use them only in trusted repositories.

No usable external profiles are bundled. Create backend-qualified profiles in `~/.pi/agent/subagents/*.md` before `Agent` or `workflow` can run. Project-only package installation still reads profiles from that global agent directory; project-local profiles are not currently supported.

## Create an external profile

Recommended: start an AI-assisted interview in Pi:

```text
/pi-flow-profile create
```

Pi asks one question at a time, recommends a backend, and compiles the answers into a profile for your review. Generated names must start with the selected backend (`claude-`, `codex-`, or `agy-`). After confirmation, pi-flow stages the profile and smoke-tests the real backend from an empty temporary working directory without applying the proposed profile instructions. A successful test installs it in `~/.pi/agent/subagents/`; a failed test removes the staged profile. If cleanup itself fails, pi-flow reports the residual path for manual removal. The selected CLI still runs in the no-approval mode described above, so use this flow only in a trusted environment.

## Define external profiles manually

Custom profiles live in `~/.pi/agent/subagents/<name>.md`. Valid profile names use lowercase letters, numbers, and hyphens. Only profiles whose frontmatter sets `backend: claude`, `backend: codex`, or `backend: agy` are shown to, and accepted by, `Agent`/`workflow`.

Claude profile, `~/.pi/agent/subagents/claude-explorer.md`:

```md
---
description: Repository exploration through Claude Code.
backend: claude
model: sonnet
thinking: high
---

Explore the repository read-only. Identify architecture, entry points, tests, configuration, risks, and recommended first-read files.
```

Codex profile, `~/.pi/agent/subagents/codex-explorer.md`:

```md
---
description: Broad code search through Codex CLI.
backend: codex
model: gpt-5.4-mini
thinking: high
---

Search broadly and summarize findings with file references. Do not edit files.
```

Antigravity profile, `~/.pi/agent/subagents/agy-reviewer.md`:

```md
---
description: Code review through Antigravity.
backend: agy
thinking: high
---

Review the requested change for correctness, regressions, and missing validation. Do not edit files.
```

Do not add `tools:` expecting it to control external CLI tools; external backends use their own tool surface. Profiles with `backend: pi` or missing `backend` are rejected by design. Use the native subagent system for those jobs.

## Use from Pi

Natural request:

```text
Ask Claude Code to explore this repository read-only and summarize the architecture.
```

Exact/manual profile selection is more deterministic:

```text
Use the Agent tool with subagent_type "claude-explorer" to explore this repository read-only and summarize the architecture.
```

Parallel request using named profiles:

```text
In parallel, use the Agent tool with subagent_type "claude-explorer" to map the architecture and subagent_type "codex-explorer" to search for tests and entry points. Synthesize their findings.
```

Workflow/fan-out request:

```text
Use the workflow tool to fan out repository review with explicit external profiles "claude-explorer" and "codex-explorer", then synthesize the results.
```

Explicit profile naming is the most deterministic form. Every `Agent` call and every workflow `agent()` child requires `subagent_type`.

## Advanced: tool-call shape

```ts
Agent({
  description: "Claude repo map",
  subagent_type: "claude-explorer",
  prompt: "Map this repository read-only and summarize important files.",
});
```

Subagents start fresh in the same working directory. Parent messages and tool results are not inherited, so prompts must be self-contained.

The `workflow` tool is trusted JavaScript orchestration. Its `agent()` calls use the same external-only profile roster, and each child needs an explicit backend-qualified `subagent_type`.

## Runtime guardrails

Direct `Agent` calls and workflow `agent()` calls share one global concurrency cap and one wall-clock timeout guardrail. Defaults are 12 concurrent subagents and 2 hours per subagent.

```bash
pi --max-concurrent-subagents 4 --subagent-timeout-ms 600000
```

Set `--subagent-timeout-ms` to `0` to disable the timeout. Values are milliseconds.
When a structured backend event first reveals nested-agent work, pi-flow gives
the external session one fresh timeout period, capped at twice the original
deadline. It extends the deadline only once.

## Field prototype: trustworthy returns

This implementation is deliberately a field prototype. Its question is simple: can an
unattended external run return a result with enough evidence to trust and debug
it?

For every normal `Agent` or workflow child run:

- Claude Code, Codex CLI, and Antigravity must emit a recognized terminal
  success event, return a non-empty result, and exit successfully.
- Pi-flow does not block native Claude, Codex, or Antigravity subagents. When
  the selected backend and its configuration use them, known nested-agent event
  names are heuristically flagged and detected nested work receives the
  one-time timeout extension described above.
- Parsed backend events and a final summary are kept locally under
  `~/.pi/agent/pi-flow-external/runs/<run-id>/`.

Each run directory contains:

- `events.ndjson`: the structured events received from the backend.
- `summary.json`: status, duration, usage, result, and prototype control labels.

The recorder makes no additional network requests; the delegated CLI still
sends data to its configured AI provider. New run directories and files are
private to the local user, but secret redaction is best-effort and records can
still contain sensitive prompts, source excerpts, or tool output. Records are
not deleted automatically. Override the directory with
`PI_FLOW_EXTERNAL_RUNS_DIR` if needed. If persistence fails, the completed run
is labeled `record unavailable` instead of pretending the evidence was saved.

Antigravity 1.1.15 or newer is required for `--input-format stream-json` and `--output-format stream-json`.

From this checkout, summarize the collected evidence with:

```bash
npm run field-report
npm run field-report -- --json
```

### Known prototype limits

- All three backends still use their dangerous/no-approval modes.
- Nested-agent detection depends on structured events. A helper started through
  a shell command or an unknown event name may remain invisible, and pi-flow
  does not provide operating-system process containment.
- The event log stores parsed structured events, not byte-for-byte stdout and
  stderr.
- Record volume is not yet capped or rotated; clean the run directory during a
  long field trial.
- Automatic retries, session resume, project-local profiles, and permission
  tiers are intentionally postponed until real usage shows which matter.

The useful field test is 20–30 real delegations. Check whether runs finish with
valid receipts, whether nested activity appears, whether the extra time helps,
and where failures cluster. Cost is recorded when readily available, but it is
optional and does not affect success.
