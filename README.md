# pi-flow external

External agent delegation for [pi](https://github.com/earendil-works/pi) through:

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) profiles with `backend: claude`
- [Codex CLI](https://github.com/openai/codex) profiles with `backend: codex`
- Antigravity profiles with `backend: agy`

The ordinary driver has three tools (`workflow` can be disabled):

- `Agent` resolves and runs one external role.
- `workflow` orchestrates multiple external roles with trusted JavaScript.
- `external_help` returns role details, permission behavior, or workflow guidance on demand.

`Agent` and `workflow` accept external roles with an optional harness override. Use pi's native subagent system for Pi-backed agents. The `pi_flow_profile_create` finalizer is active only during `/external profile create`.

## Install

Global installation:

```bash
pi install npm:@tranhoangnguyen0310/pi-flow-external
pi list
```

Project-only installation:

```bash
pi install -l npm:@tranhoangnguyen0310/pi-flow-external
```

Project packages load after project trust. Use `pi list --approve` to inspect and approve packages in a new project.

Update installed extensions with:

```bash
pi update --extensions
pi list
```

## Requirements and security

Install and authenticate each external CLI you intend to use:

```bash
claude --version
codex --version
agy --version
```

Pi's coordinator model and the external CLIs authenticate independently. A working Claude, Codex, or Antigravity login does not authenticate the root Pi model.

External agents use the effective permission tier and each harness's native mechanism:

- Claude: `--permission-mode plan`, `--permission-mode acceptEdits`, or `--dangerously-skip-permissions`
- Codex: `--sandbox read-only`, `workspace-write`, or `danger-full-access`
- Antigravity: always `--dangerously-skip-permissions`

Claude refuses bypass mode when its effective UID is `0`; in that case the extension uses `--permission-mode auto`. External execution lanes (like `implementer`, `debugger`, `qa`, and `worker`) require shell execution to inspect repositories, run tests, and verify code. On Claude Code, headless `edit` mode (`acceptEdits`) auto-denies all shell commands; therefore, execution lanes maintain a `danger` floor so the model is not artificially handcuffed by permission blocks. Run external agents only in repositories you trust and state whether each task is read-only or may edit files.

The TUI labels a direct run with its effective access, including `unsandboxed external CLI` for danger and all Agy runs, and shows `external host access` while workflow work is active. These labels disclose actual execution authority; they do not turn a read-only prompt into an enforced permission boundary.

## Quick start

Create a profile from Pi:

```text
/external profile create
```

The guided flow selects a backend, creates a backend-qualified profile, smoke-tests the real CLI, and installs the profile only after a successful test.

Check the resulting setup:

```text
/external doctor
/external profiles
```

Then delegate by role (the global default harness is initially `agy`):

```text
Use the Agent tool with role "explorer" and harness "claude" to map this repository read-only.
```

## Commands

All user commands use the `/external` namespace:

| Command | Purpose |
|---|---|
| `/external` | Show profile, workflow, and runtime-setting status |
| `/external doctor` | Check settings, profiles, and configured CLI versions |
| `/external settings` | Show the default harness and effective runtime settings |
| `/external profiles` | List configured external profiles |
| `/external profile create` | Create and smoke-test a profile |
| `/external profile clean-up` | Archive retired pi-flow default profiles |
| `/external workflows` | List saved workflows |
| `/external runs` | Summarize recorded external runs |
| `/external help` | Show the command reference |

`/external doctor` verifies CLI availability, not provider authentication.

## Profiles

Profiles live in:

```text
~/.pi/agent/subagents/<name>.md
```

Names may contain lowercase letters, numbers, and hyphens. A profile must declare `backend: claude`, `backend: codex`, or `backend: agy`, and its name should start with the matching backend name.

Example Claude profile, `~/.pi/agent/subagents/claude-explorer.md`:

```md
---
description: Repository exploration through Claude Code.
backend: claude
model: claude-sonnet-5
thinking: high
---

Explore the repository read-only. Identify architecture, entry points, tests, configuration, risks, and recommended first-read files.
```

Codex and Antigravity use the same format:

```yaml
backend: codex
model: gpt-5.6-sol
```

```yaml
backend: agy
model: gemini-3.7-flash-high
```

Profile instructions become the external agent's system instructions. A profile's `description` is also shown as the user-visible reason for its selection, so keep it concise and concrete. External CLIs use their own tools, so a profile's `tools:` field does not control them. Profiles with `backend: pi` or no backend are not available to this extension; they belong to Pi's native subagent system and are never modified by it. `/external profile clean-up` archives only profiles this extension itself shipped and later retired (currently the former `debugger` role) to `~/.pi/agent/subagents/archive/` after confirmation — moved, never deleted.

Profiles created through `/external profile create` are stamped `owner: user`, and clean-up never archives `owner: user` profiles. When writing a profile by hand, add `owner: user` to its frontmatter to protect it from clean-up.

### Default profiles

On first session start the extension seeds a default roster — five code-oriented roles (explorer, planner, implementer, reviewer, qa) plus the generalist worker — as one storage profile per backend (18 files). The compact agent catalog advertises each role once rather than presenting 18 choices. Seeding happens once: it never overwrites existing files, and profiles you delete or customize afterwards stay that way. Default profiles leave `model` and `thinking` unpinned so they track the CLI's own model and the current Pi thinking level. Roles not in the default roster, such as debugger, can be added with `/external profile create`.

Project-local profiles are not supported; global profiles are used for both global and project-only package installations.

## Agent usage

A direct tool call requires `description`, `prompt`, and either `role` or legacy exact-profile `subagent_type`. With `role`, `harness` is optional and defaults to the global `defaultHarness` setting:

```ts
Agent({
  description: "Claude repository map",
  prompt: "Map this repository read-only and summarize important files.",
  role: "explorer",
  harness: "claude",
});
```

Profiles named with their matching backend prefix expose the suffix as a built-in or custom role (`claude-security-reviewer` -> `security-reviewer`). Resolution always targets the exact `<harness>-<role>` profile and never falls back to another harness. If a role is unavailable, the error lists its supported harnesses. Existing calls may instead use `subagent_type` as a legacy exact-profile escape hatch; do not combine it with `role` or `harness`. Nonstandard profile names are exact-only.

The parent prompt always includes one compact catalog of role names, restricted harness availability, exact-only profile names, and the default harness; it does not repeat profile descriptions or the workflow manual. Call `external_help` with topic `roles` for profile descriptions, `permissions` for harness caveats, or `workflow` for syntax, examples, and saved workflow discovery. The optional `harness` filter applies to `roles` and `permissions`. Catalog availability means a matching profile is configured, not that its CLI is installed or authenticated.

External agents start fresh in the requested working directory unless `resume` continues a previous child. By default, they receive only the task briefing and profile instructions. The parent can explicitly share conversation context:

```ts
Agent({
  description: "Review agreed design",
  role: "reviewer",
  prompt: "Review the agreed design read-only. Repository: /absolute/repo.",
  context: { mode: "recent", turns: 5 },
});
```

| `context` | Shares |
|---|---|
| Omitted or `{ mode: "none" }` | No parent history; write a self-contained prompt |
| `{ mode: "recent", turns: N }` | Last N available user turns, including the current turn |
| `{ mode: "full" }` | Available current-branch conversation after compaction, including summaries |

A **user turn** starts with a user message and includes subsequent assistant messages and tool exchanges until the next user message. This is not Pi's per-model-response turn count. `turns` must be a positive integer. If fewer turns remain, all available user turns are shared and the receipt shows the actual/requested count. Recent mode does not automatically include older compaction summaries. Associated tool calls are retained when a result crosses the selected turn boundary.

Choose the smallest sufficient context: `recent` for focused follow-ups, `full` when older discussion matters, and `none` for independent tasks. Supply missing older decisions explicitly. Use `resume` to follow up with an existing child; it cannot be combined with context sharing.

Snapshots are frozen before queueing. They contain labeled background text and completed tool exchanges, never parent system instructions, thinking blocks, tool-result metadata, or pending tool calls. Images/unsupported content and snapshots over **1 MiB** fail explicitly rather than being silently truncated. Full means available post-compaction context, not recovery of old transcripts or a byte-for-byte model request. External agents retain their own instructions and permissions.

This is text transfer into a new external conversation, not a native session clone or guaranteed prompt-cache reuse. Shared content goes to the selected external harness and may persist in its conversation storage and private local run evidence; do not share sensitive history unnecessarily. Receipts report mode, actual turns, message count, byte size, and compaction status.

Backend-native nested agents may start in another workspace. Include the repository's absolute path when asking an external agent to delegate further.

## Delegation transparency

Direct calls keep their intent card visible during execution:

```text
Delegating Claude Code → claude-explorer · unsandboxed external CLI
Task Map repository architecture
Why Repository exploration through Claude Code.
Context recent · up to 5 user turns
Workspace /path/to/project
⠋ Claude Code(claude-explorer, Map repository architecture) external host access · 12s
```

The `Context` line appears only when the parent shares conversation content, so extra data leaving for the external harness is visible before the run. Completed rows summarize what was actually shared (`context recent 4/5 turns`).

Completed rows show a short evidence identifier and result preview. Press **Ctrl+O** (the default tool-expansion binding) to reveal the local record path plus structured backend-event count:

```text
✓ Claude Code(claude-explorer, Map repository architecture) 42s evidence 8f21a004 -> Architecture mapped.
  Evidence ~/.pi/agent/pi-flow-external/runs/run_... · 15 backend events
```

Workflows show access once at the workflow level, retain done/active/queued/failed counts, and expose child evidence plus the workflow journal when expanded. Raw backend events remain in local records rather than flooding the default terminal view.

## Workflow usage

The `workflow` tool runs trusted JavaScript that calls one or more external roles and returns a JSON-serializable result. Every `agent()` child uses the same `role`/optional `harness` resolution as direct `Agent` calls, with legacy exact `subagent_type` also supported.

Saved workflows are discovered on demand through `external_help({ topic: "workflow" })`; project `.pi/workflows` entries are included only when Pi reports the project trusted.

Example request:

```text
Use the workflow tool to ask role "explorer" on harness "claude" for an architecture map and role "reviewer" on harness "codex" for a risk review, then synthesize their findings.
```

Direct `Agent` calls and workflow children share the same concurrency and timeout controls. Workflow `agent(prompt, { role, context: { mode: "recent", turns: 5 } })` accepts the same context modes. Every child selects from one parent snapshot frozen at workflow invocation; earlier child results must still be passed explicitly. Replay fingerprints include the transferred context, so changes invalidate cached results.

## Permission tiers, budgets, and resume

Every `Agent` call and workflow `agent()` child also accepts these optional run parameters (`context` is covered under agent usage above):

- `permission`: `readonly` | `edit` | `danger` (default `danger`). Tiers map onto native harness mechanisms — Claude permission modes and Codex's single-axis `--sandbox`. Antigravity (`agy`) is different: its headless sandbox denies even read-only tools like `read_url_content`, and its only unsandboxed mode is `--dangerously-skip-permissions`, so **every agy run is unsandboxed** and `readonly`/`edit` on agy are advisory profile-body instructions, not a boundary. Getting out of the model's way is deliberate; every agy run discloses as `unsandboxed external CLI` rather than claiming a read-only boundary it cannot keep. Claude `readonly`/`edit` runs auto-deny shell commands headlessly; denials are surfaced in the receipt.
- `max_budget_usd`: a spending cap. Claude Code enforces it mid-run with its native `--max-budget-usd` flag; codex and agy do not report cost, so the cap is recorded and marked `budget unenforceable` instead of pretended.
- `resume`: a prior run id. Continues the same backend conversation (Claude `--resume`, Codex `exec resume`, agy `--conversation`) instead of starting from scratch. The prior run must use the same backend. Claude sessions persist in Claude Code's own local storage (this extension no longer passes `--no-session-persistence`) so recorded session ids stay resumable; remove old conversations from Claude Code itself if that matters to you. `resume` cannot be combined with `context` sharing — continue an existing child, or start a new one with a snapshot.

Resolution order for tiers and budgets: call > profile frontmatter (`permission:`, `max_budget_usd:`) > settings defaults.

## Settings and runtime limits

The extension creates:

```text
$PI_CODING_AGENT_DIR/pi-flow-external/settings.json
```

Normally this resolves to `~/.pi/agent/pi-flow-external/settings.json`:

```json
{
  "version": 3,
  "defaultHarness": "agy",
  "maxConcurrentSubagents": 12,
  "subagentTimeoutMs": 7200000,
  "defaultPermission": "danger",
  "defaultMaxBudgetUsd": null,
  "maxRunRecords": 200
}
```

Version 1 and 2 files migrate on read: recognized keys carry over, missing `defaultHarness` becomes `agy`, unknown keys warn, and invalid values fall back per-key. `maxRunRecords` prunes the oldest completed run records at session start and via `/external runs --prune`; records still running or interrupted are never pruned, and `0` keeps everything.

### Project default-harness override

A trusted project can override the global `defaultHarness` without touching global settings or duplicating profiles. Create:

```text
<project>/.pi/pi-flow-external/settings.json
```

```json
{ "defaultHarness": "claude" }
```

The override applies only when Pi marks the project trusted, supports `defaultHarness` only, and is never created or written by the extension. Precedence: an explicit `harness` in the call wins, then the trusted project default, then the global setting. `/external settings` reports the effective harness and its source; an untrusted or invalid project file is ignored with a warning, and a role that has no profile on the effective harness fails with an actionable error instead of silently switching harnesses. Edit the file and run `/reload`.

Edit the file and run `/reload`. Startup flags override extension factory options, which override this file, which overrides built-in defaults.

Equivalent startup flags:

```bash
pi --max-concurrent-subagents 4 --subagent-timeout-ms 600000
```

Set `--subagent-timeout-ms 0` to disable the timeout.

When a structured backend event reveals nested-agent work, the extension grants one fresh timeout period from that observation, capped at twice the original deadline. The extension does not otherwise retry failed or aborted runs.

## Run records

Each normal external run writes best-effort local evidence under:

```text
~/.pi/agent/pi-flow-external/runs/<run-id>/
```

Set `PI_FLOW_EXTERNAL_RUNS_DIR` to override the location. Each run contains:

- `events.ndjson`: parsed structured backend events
- `summary.json`: status, duration, usage, result, and record-integrity metadata

Records are private to the local user but may still contain sensitive prompts, source excerpts, and tool output. Redaction is best-effort. The retention sweep automatically prunes eligible completed records beyond `maxRunRecords`; active, interrupted, incomplete, or damaged records are retained.

Summarize records from this checkout with:

```bash
npm run field-report
npm run field-report -- --json
```

A failed backend can still have complete diagnostic evidence. Treat `incompleteRecords > 0` as an evidence-integrity problem independent of backend status.

## Troubleshooting

- **No external profiles:** run `/external profile create`, or verify that the profile is in `~/.pi/agent/subagents/` with a matching backend-qualified name.
- **Role unavailable on the selected harness:** choose one of the supported harnesses listed in the error, or create the exact `<harness>-<role>` profile. The extension never substitutes another harness.
- **CLI available but authentication fails:** authenticate that CLI directly; Pi and every external backend keep separate credentials.
- **Claude rejects `--dangerously-skip-permissions` under root:** reload the current extension version; root runs use Claude's `auto` permission mode.
- **Nested agent cannot find the repository:** include the repository's absolute path and required context in the prompt.
- **Child is missing earlier decisions:** share the smallest sufficient parent context (`context: { mode: "recent", turns: N }` or `{ mode: "full" }`), or restate the missing decisions in the prompt.
- **Run failed with complete records:** inspect the run's `summary.json` and `events.ndjson`; do not retry automatically unless requested.
- **Sensitive content appears in evidence:** remove the affected run directory. Local redaction is not a secrecy boundary.

## Development

Run the deterministic offline checks:

```bash
npm run check
```

Real-provider checks consume tokens. Point the runner at the authenticated Pi agent directory:

```bash
export PI_CODING_AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
npm run e2e -- --backend claude
npm run e2e -- --backend codex
npm run e2e -- --backend agy
npm run e2e -- --backend codex --workflow
```

See [`docs/field-testing.md`](docs/field-testing.md) for provider checks and [`docs/releasing.md`](docs/releasing.md) for the release process.

Run directly from a checkout with:

```bash
pi -e ./index.ts
```
