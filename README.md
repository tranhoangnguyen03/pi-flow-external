# pi-flow external

External agent delegation for [pi](https://github.com/earendil-works/pi). A **role** is the work. A **harness** is where and how that role executes. The harnesses are:

- Antigravity (`agy`)
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (`claude`)
- [Codex CLI](https://github.com/openai/codex) (`codex`)
- [Grok Build CLI](https://github.com/xai-org/grok-build) (`grok`)
- Muse Code (`muse`)
- Named Pi harnesses (`pi-<label>`) — in-process, per-model configs you register yourself, not a spawned CLI

Six built-in roles are available in memory on every one of those harnesses. A fresh installation writes no profile files.

The ordinary driver has four tools (`workflow` can be disabled):

- `Agent` resolves and runs one external role.
- `workflow` orchestrates multiple external roles with trusted JavaScript.
- `external_help` returns the usage playbook, role details, permission behavior, or workflow guidance on demand.
- `external_runs` lists, inspects, waits for, and cancels session-owned runs.

`Agent` and `workflow` accept a role with an optional harness — `agy`, `claude`, `codex`, `grok`, `muse`, or a registered `pi-*` name. A registered Pi harness uses that same selection. Legacy exact `subagent_type` remains available and cannot be combined with `role` or `harness`. `pi_flow_role_create` is active only during `/external role create`. `pi_flow_harness_create` is active only during `/external harness create`. Worked calls are `external_help` topic `usage`.

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
grok --version
muse --version
```

Pi's coordinator model and the external CLIs authenticate independently. A working Claude, Codex, Antigravity, Grok, or Muse login does not authenticate the root Pi model. The Grok Build CLI installs and authenticates entirely separately from Pi: install with `curl -fsSL https://x.ai/cli/install.sh | bash`, then authenticate with `grok login` or an `XAI_API_KEY` environment variable. This integration is verified against Grok Build CLI `1.0.40`. Muse Code likewise installs and authenticates separately from Pi; this integration is verified against Muse Code `1.3.0` against its `meta` provider.

External agents use the effective permission tier and each harness's native mechanism:

- Claude: `--permission-mode plan`, `--permission-mode acceptEdits`, or `--dangerously-skip-permissions`
- Codex: `--sandbox read-only`, `workspace-write`, or `danger-full-access`
- Antigravity: only `--dangerously-skip-permissions`. `readonly` and `edit` are rejected.
- Grok: `--sandbox read-only`, `workspace`, or `off`, always alongside `--permission-mode bypassPermissions` — bypass only skips the interactive approval prompt; the kernel sandbox remains the enforced boundary. `readonly`'s network-blocking guarantee is Linux-only (a no-op on macOS), and sandbox startup can fail closed on some macOS hosts (for example when `/var/run/docker.sock` resolves to a symlink) rather than silently running unsandboxed.
- Muse: every tier passes `--disable-approval` (approval and Muse's own sandbox are ON by default, and headless runs must not hang on an interactive prompt); `readonly` additionally passes `--disable-write --disable-shell`; `edit` leaves the sandbox enabled with only approval bypassed; `danger` uses `--yolo`, which disables approval and the sandbox and additionally trusts the workspace for this run (loads its skills/rules) — a broader grant than an unsandboxed run alone.
- Named Pi harnesses: a curated tool list (`read`/`grep`/`find`/`ls` at `readonly`; those plus `edit`/`write` at `edit`), or the SDK's own default active tools (`read`/`bash`/`edit`/`write`) at `danger`. That list is not an OS sandbox. The registration preset is `minimal` (skills stay unloaded; the default when the field is absent) or `skills` (installed skills load; project skills load only when the project is trusted). Extensions, prompt templates, and themes stay unloaded.

The effective tier is the call's `permission`, or settings `defaultPermission` when the call omits it. The default is `danger`. A role does not change the tier. Claude refuses bypass mode when its effective UID is `0`; danger then uses `--permission-mode auto`. Claude `edit` denies Bash headlessly. Pass `danger` on the call when the task needs a shell. Run external agents only in repositories you trust and state whether each task is read-only or may edit files.

The TUI labels a direct run with its effective access, including `unsandboxed external CLI` for danger, `Pi SDK child · host access · curated tools` for a danger-tier named Pi harness, and `external host access` while workflow work is active. These labels disclose actual execution authority. A read-only instruction in a role is intent, not that authority.

## Breaking upgrade

Settings are version 4. This v2 minor release includes breaking configuration and command changes; the product owner chose `2.6.0-external.0` (`release:minor`) rather than a v3 bump. The changelog and GitHub release notes carry this notice. Earlier notes under `docs/plans/` stay historical; this section is the current contract.

`/external profiles`, `/external profile create`, and `/pi-flow-profile create` are removed. They are not aliases, redirects, or hidden handlers. An unknown `/external` command lists the commands below. `Agent` and `workflow` still accept exact `subagent_type`. That API is unchanged.

| Removed command | Replacement |
|---|---|
| `/external profiles` | `/external roles` |
| `/external profile create` | `/external role create` for a shared role; `/external harness create` for a named Pi harness; `/external role override <role> <harness>` for one exact execution file |
| `/pi-flow-profile create` | The same three commands. This spelling is removed. |

### One-time conversion

`/external settings` shows the effective values and, when a pre-v4 installation is present, points at `/external settings convert`. That command previews the conversion and applies it after confirmation. There is no `/external migrate` command. A pre-v4 installation — settings older than version 4, a `pi-flow-external/harnesses.json` file, or a historical seed marker — gets an actionable setup error on delegation until conversion finishes. `/external settings` stays available while delegation is blocked.

Conversion runs once:

1. Combine valid runtime settings and named Pi harness registrations into `settings.json` version 4.
2. Copy customized external profiles into `pi-flow-external/overrides/` as exact overrides, dropping obsolete `permission` and `capabilitySet` fields. A legacy `subagents/pi-<role>.md` template with `harness: "pi-*"` becomes `roles/<role>.md` for every harness. `piCapabilitySets` is not copied. Unchanged generated content is recognized conservatively. Uncertain valid external content is kept as an override.
3. Record seeded identities you deleted in `disabledProfiles`, using the historical seed cohorts. Those identities stay disabled.
4. Leave every original file in place as the recovery copy.
5. Validate before activation. Conflicting destinations or malformed inputs stop with a concrete diagnostic. Copied overrides are installed before version 4 is activated. Until that activation, staged copies are not live catalog inputs. Retrying an interrupted conversion accepts identical copies and rejects a destination whose contents differ.

Once version 4 is active, delegation reads only `settings.json`, `roles/`, and `overrides/`. Old `subagents/` profiles, seed markers, and `harnesses.json` are ignored. This release does not write both layouts, and it does not keep the old layout as a fallback resolver.

A shared role is one file for every harness. `roles/reviewer.md` replaces the built-in reviewer on `agy`, `claude`, `codex`, `grok`, `muse`, and every named Pi harness:

```md
---
description: Review security-sensitive changes and report actionable findings.
---

Review the supplied changes without editing files. Prioritize exploitable
issues, cite locations, and distinguish verified findings from speculation.
```

An exact override replaces one harness binding completely. `overrides/claude-reviewer.md` keeps the existing profile frontmatter and is the whole definition for that identity, not a field merge:

```md
---
description: Claude-specific review instructions.
backend: claude
model: claude-sonnet-5
thinking: high
---

Review the supplied changes without editing files. Apply the Claude-only notes in this body.
```

`tools` in an override is enforced only on a named Pi harness. A CLI harness keeps its own tools. A Pi override's `model` and `thinking` must match the named harness entry; omit them to inherit that entry.

### Optional purge

Delegation after conversion does not require deleting anything. `/external [danger]purge-old-files` is a separate destructive maintenance command. The brackets and the word `danger` are part of the spelling.

It lists the exact candidate paths and whether customized content was copied. Nothing is preselected. You toggle each path, then confirm deletion of that selection. It requires a completed version 4 conversion, so it cannot erase the only harness registry or deletion markers before they are recorded. Customized copies inside the inventory can be deleted too.

| Candidate | Scope |
|---|---|
| Legacy seeded profiles | The exact 30 `<agy\|claude\|codex\|grok\|muse>-<explorer\|planner\|implementer\|reviewer\|qa\|worker>.md` names under the old `subagents/` directory |
| Legacy custom CLI profiles | Harness-prefixed Markdown files declaring the matching external backend |
| Legacy named Pi profiles | `pi-<label>-<role>.md` declaring `backend: pi` and the matching harness, identified from the file |
| Legacy shared Pi templates | `subagents/pi-<role>.md` declaring `harness: "pi-*"`. Conversion already copied these into `roles/<role>.md` |
| Seed markers | `.pi-flow-defaults-seeded-v1`, `.pi-flow-defaults-seeded-v2`, and `.pi-flow-defaults-seeded-v3` |
| Old harness registry | The exact `pi-flow-external/harnesses.json` path |

Nonstandard exact-only legacy names are listed separately for an explicit choice. Symlinks and other non-regular entries are skipped. The command does not recurse. It does not remove the `subagents/` directory, native or unrelated profiles, current settings, roles, overrides, project configuration, or run evidence. It reports deleted, skipped, and failed paths. Running it again is harmless. A file that changes after the preview is skipped and reported.

Downgrade after a purge needs your own backup of the deleted files. Originals remain available only until you purge them.

## Quick start

The six built-in roles — explorer, planner, implementer, reviewer, qa, and worker — are already available on `agy`, `claude`, `codex`, `grok`, `muse`, and any named Pi harness you register. Nothing has to be authored first.

Check the setup:

```text
/external
/external doctor
/external roles
/external harnesses
```

Then delegate by role. The built-in default harness is `agy`:

```text
Use the Agent tool with role "explorer" and harness "claude" to map this repository read-only.
```

`/external doctor` checks the catalog separately from CLI readiness. A configured harness can still be uninstalled or unauthenticated.

Author one additional role for every harness with `/external role create`. That interview only validates and writes the role. Register a named Pi harness with `/external harness create`. The interview asks for a resource preset, `minimal` or `skills`, then smoke-tests the Pi runtime with that preset before saving. A harness smoke test does not judge role quality.

## Commands

All user commands use the `/external` namespace:

| Command | Purpose |
|---|---|
| `/external` | Overview: default harness and its source, roles, harnesses, settings path, and actionable problems |
| `/external doctor` | Validate the catalog, then report CLI and named-Pi readiness separately |
| `/external settings` | Effective values, harness source, and the canonical JSON path. Points at conversion when a pre-v4 installation is present |
| `/external settings edit` | Edit and validate canonical settings in the standard editor |
| `/external settings convert` | Preview and apply the one-time version 4 conversion |
| `/external harnesses` | List the five CLI harnesses and named Pi harnesses. Readiness is separate from registration |
| `/external harness create` | Register one named Pi harness. No role interview |
| `/external roles` | Six built-ins plus user roles, with restrictions and overrides. The list is not the role × harness product |
| `/external role create` | Author one reusable role |
| `/external role inspect <role> [harness]` | Effective instructions, source, model, and the backend's real authority for the default permission |
| `/external role override <role> <harness>` | Materialize one intentional full override |
| `/external [danger]purge-old-files` | List and delete obsolete extension files. Secondary maintenance; the brackets are literal |
| `/external workflows` | List saved workflows |
| `/external runs` | Interactively browse current-session runs, every workflow child, paged output/diagnostics, and cancellation |
| `/external runs summary` | Summarize durable run records |
| `/external runs --prune` | Prune eligible completed run records |
| `/external help` | Show the command reference |

`/external doctor` reports CLI availability separately from provider authentication and catalog validity. Claude and Codex use their non-interactive login-status commands; other CLIs report login as unverified. Credential presence does not prove a request will succeed. Known inherited authentication/routing environment variables are listed by name only, never value. Native status commands may access credential storage or perform network activity; no model prompts or quota requests are sent, and no credentials are changed.

Doctor also reads retained run summaries for this project and shows the latest recorded usage-limit observation per harness, its source run, any reset time, and whether a later run succeeded. These are historical observations, not current account status. New failed Claude runs can preserve structured rate-limit rejections; Antigravity runs can preserve terminal individual-quota errors. Other backends and older records may have no evidence. Missing, malformed, or oversized summaries are skipped and counted; backend event logs and model answers are never searched. Remaining allowance stays unavailable.

A typical overview:

```text
External agents
Default: pi-deepseek (global)
Roles: 6 built-in · 1 custom · 1 harness override
Harnesses: 5 CLI · 1 named Pi
Settings: ~/.pi/agent/pi-flow-external/settings.json
```

The built-in default harness on a fresh installation is `agy`. The overview above is a directory that has already registered `pi-deepseek` and authored one extra role plus one override.

## Configuration

One extension-owned home. Reads do not create directories or write defaults. The extension does not write Pi's root settings or Pi's native `subagents/` directory.

```text
$PI_CODING_AGENT_DIR/pi-flow-external/
  settings.json             # only execution-configuration file; optional
  roles/                    # user-authored shared roles; created when you save one
    security-reviewer.md
  overrides/                # exact execution files; created only when you save one
    claude-reviewer.md
  runs/                     # operational evidence
```

Normally `$PI_CODING_AGENT_DIR` is `~/.pi/agent`. Markdown holds authored instructions. JSON holds scalar execution settings. Project-local roles are not supported; the global catalog is used for both global and project-only package installations. A trusted project may still override `defaultHarness` only, described under Settings.

At each direct call the extension loads one catalog snapshot. A workflow freezes that same snapshot for the whole run. Resolution order:

1. Harness: explicit call, then the trusted project default, then the global default, then the built-in default (`agy`).
2. Unknown harnesses and identities listed in `disabledProfiles` are rejected. The call does not switch to another harness.
3. Role definition: exact override, then a shared role, then the built-in role.
4. That definition is bound to the chosen harness and executed through the existing runners.

An invalid higher-priority override blocks that selection. An unrelated invalid file is reported and does not take a different role offline. Invalid settings JSON, or a settings version this release does not support, blocks delegation. `/external settings`, `/external settings convert`, and `/external role inspect` remain available. The next invocation reads settings, roles, and overrides from disk. A workflow that has already started keeps the snapshot it froze at start. A change to `maxConcurrentSubagents` waits until no subagent is active and none are queued.

Stable identities stay `<harness>-<role>`. Receipts and workflow descriptors use that identity, or the exact legacy `subagent_type` name when that was the selector. Permission is the call, or `defaultPermission`. It is not a role field.

Names may contain lowercase letters, numbers, and hyphens. A role `description` is the user-visible reason for selection, so keep it concise. Instructions become the external agent's system instructions. Shared role files accept `description` only. `permission`, `capabilitySet`, `backend`, `model`, and `thinking` on a shared role are rejected with a diagnostic.

`roles/security-reviewer.md` works with any harness, with no backend prefix:

```md
---
description: Review security-sensitive changes and report actionable findings.
---

Review the supplied changes without editing files. Prioritize exploitable
issues, cite locations, and distinguish verified findings from speculation.
```

Role instructions do not erase harness differences. Antigravity accepts only autonomous danger. A CLI harness does not gain a named Pi harness's curated tool list. That list is not an OS sandbox.

### Exact overrides

`overrides/claude-reviewer.md` is a complete replacement for that one identity. Backend-specific model, thinking, tools, budget, and instruction customizations belong here. New guided overrides use `<harness>-<role>` names. Older nonstandard names remain selectable only through `subagent_type`.

```md
---
description: Repository exploration through Claude Code.
backend: claude
model: claude-sonnet-5
thinking: high
---

Explore the repository read-only. Identify architecture, entry points, tests, configuration, risks, and recommended first-read files.
```

The same frontmatter shape accepts the other CLI backends:

```yaml
backend: codex
model: gpt-5.6-sol
```

```yaml
backend: agy
model: gemini-3.7-flash-high
```

```yaml
backend: grok
model: grok-4.6
```

```yaml
backend: muse
model: muse-spark-1.3-contributor
```

A named Pi override adds `backend: pi` and `harness: <registered pi-* name>`. CLI harnesses use their own tools, so `tools` does not control them. On a named Pi harness, `tools` is intersected with the permission tier's curated tool table.

### Built-in roles

explorer, planner, implementer, reviewer, qa, and worker ship in memory for `agy`, `claude`, `codex`, `grok`, and `muse`, and for every registered named Pi harness. Session start writes no default files and no seed markers. Built-in CLI roles leave `model` and `thinking` unpinned, so they track that CLI's own model and the current Pi thinking level. A named Pi harness's six built-ins use that harness's registered model and thinking. Adding a harness writes no role files. Seven authored roles are seven files under `roles/`, whatever the harness count is.

Disable an execution identity by listing its exact name in `disabledProfiles`, for example `codex-explorer`. That blocks both `role` selection and exact `subagent_type` selection. Deletions captured during conversion are stored the same way. The extension does not recreate a disabled identity.

### Named Pi harness configurations

A named Pi harness runs in-process through Pi's own SDK, for any model Pi can already resolve (built-in, self-hosted, or a custom-registered provider). Register it with `/external harness create`: a `pi-<label>` name, a `provider/model` id, a thinking level (`off`, `minimal`, `low`, `medium`, `high`, or `xhigh`, always stored explicitly), and a resource preset (`minimal` or `skills`). `minimal` is the default and leaves skills unloaded. `skills` loads installed skills, and project skills only when the project is trusted. The smoke test uses the selected preset. Registration is then saved into the `harnesses` object of `settings.json`. A legacy entry that omits `preset` is `minimal`. The five CLI harnesses are built in and do not need entries there.

```json
{
  "version": 4,
  "defaultHarness": "pi-deepseek",
  "maxConcurrentSubagents": 12,
  "subagentTimeoutMs": 7200000,
  "defaultPermission": "danger",
  "defaultMaxBudgetUsd": null,
  "maxRunRecords": 200,
  "harnesses": {
    "pi-deepseek": {
      "model": "deepseek/deepseek-chat",
      "thinking": "high",
      "preset": "minimal"
    }
  }
}
```

The six built-in roles are available on that harness immediately. Delegate the same way as a CLI harness:

```ts
Agent({
  description: "Cheap repository review",
  prompt: "Review this diff read-only.",
  role: "reviewer",
  harness: "pi-deepseek",
});
```

A custom role is the one shared file from `/external role create`. Use `/external role override reviewer pi-deepseek` when only that harness needs a different body, tools, or budget. Permission stays on the call or in `defaultPermission`; an override cannot set it. The override's `model` and `thinking` come from the harness entry. A different pin is rejected.

Settings writes use a private staged file and a same-directory replacement, and they preserve unrelated fields. The extension refuses to overwrite a malformed or newer-version file. Replacement avoids a torn write. Concurrent sessions can still overwrite each other's update: there is no inter-process lock. A harness smoke test finishes before that short commit. The writer then rereads and checks for a duplicate or a conflict.

**v1 scope, by design:** a pi child's tools are the SDK builtins (`read`/`bash`/`edit`/`write`, plus `grep`/`find`/`ls` at `readonly`/`edit`). The registration preset selects `minimal` (skills stay unloaded) or `skills` (installed skills load; project skills require a trusted project). Extensions, prompt templates, and themes stay unloaded. The tool list is not an OS sandbox, and `bash` at `danger` is host access. Retry is disabled per pi child (in-memory, never touching your real Pi settings). Pi children cannot resume a prior conversation and have no enforced budget cap. Trusted extensions, MCP, resumable sessions, and budget controls remain [issue #43](https://github.com/tranhoangnguyen03/pi-flow-external/issues/43).

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

Resolution always targets the exact `<harness>-<role>` identity and does not switch harness. If a role is unavailable, the error lists the harnesses that provide it. Existing calls may instead use `subagent_type` as an exact-identity escape hatch; do not combine it with `role` or `harness`. Nonstandard override names are exact-only.

The parent prompt always includes one compact catalog of role names, restricted harness availability, exact-only names, the default harness, and a short operating guide. It does not repeat role descriptions, the usage playbook, or the workflow manual. Call `external_help` with topic `usage` for worked examples, `roles` for descriptions, `permissions` for harness caveats, or `workflow` for syntax and saved workflow discovery. The optional `harness` filter applies to `roles` and `permissions`. A listed role is a catalog entry. It does not mean the CLI is installed or authenticated.

External agents start fresh in the requested working directory unless `resume` continues a previous child. By default, they receive only the task briefing and the resolved role instructions. The parent can explicitly share conversation context:

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

Completed rows show a short evidence identifier and result preview. Press **Ctrl+O** (the default tool-expansion binding) to reveal bounded canonical output, its full run ID, a `/external runs` navigation hint, and advanced local evidence details:

```text
✓ Claude Code(claude-explorer, Map repository architecture) 42s evidence 8f21a004 -> Architecture mapped.
  Final output
  Architecture mapped.
  Run run_... · /external runs for full paged output and diagnostics
  Evidence ~/.pi/agent/pi-flow-external/runs/run_... · 15 backend events
```

Workflows show access once at the workflow level, retain done/active/queued/failed counts, and expose bounded final output plus the workflow journal when expanded. Hidden child rows remain reachable through `/external runs`. Active rows report last-activity freshness independently of the spinner. Raw backend events remain in local records rather than flooding the default terminal view.

`Agent`, `workflow`, and `external_runs` all register their own `renderCall`/`renderResult` — the same reusable header, status/timing/output presentation, and disclosure rules across all three, so a workflow's card is more hierarchy over the same visual language rather than a different one, and `external_runs` (list/inspect/wait) reads like the tools it observes rather than raw JSON. A text answer's final output — `Agent`'s own expanded result, a workflow's string result, and `external_runs`' `output`/`final` views — renders as Markdown where a host theme is available, falling back to plain text (never a crash) otherwise; a workflow's structured (object/array) result stays formatted data rather than Markdown-interpreted prose.

### Host renderer integration

Stock Pi renders every tool's own `renderCall`/`renderResult` directly, so the cards above work with no configuration.

**Compatibility caveat — pi-cc / ccstyle:** our live progress renderers are not compatible with the default rendering overrides in [`pi-cc-extensions`](https://www.npmjs.com/package/pi-cc-extensions). Manual testing showed workflow and wait progress replaced by a generic `Pending…` display while Agent retained its dedicated renderer. Expanded generic output can also duplicate raw JSON. This is a display limitation, not evidence that the underlying run has stopped.

To preserve this extension's renderers, add its three tool names to pi-cc's `excludeRenderers` setting in `~/.pi/agent/pi-cc-extensions.json`. Merge these entries into your existing configuration; do not replace other settings or exclusions:

```json
{
  "excludeRenderers": ["Agent", "workflow", "external_runs"]
}
```

Restart Pi after changing the configuration. Exclusions use **tool names**, not the extension's package name. All three tools above provide custom renderers. This is pi-cc's supported renderer-preservation mechanism; do not edit its installed package files. End-to-end progress rendering with these exclusions still needs confirmation in your installed pi-cc version. If it continues to show only `Pending…`, disable pi-cc when you need our live progress display. Full compatibility with pi-cc's default overrides is not claimed.

## Background runs and supervision

`Agent` and `workflow` are blocking by default — an ordinary call waits for its child and returns the result, run everything this way unless the parent has other work to do first. Add `background: true` only when the parent can productively proceed before completion; it returns a stable `run_...` or `wf_...` handle after validation and registration while the originating Pi session continues to own the work:

```ts
Agent({
  description: "Long repository audit",
  prompt: "Audit /absolute/repo read-only.",
  role: "reviewer",
  background: true,
});
```

Use `external_runs` with these actions:

- `list`: current session/project runs; use `cursor` for run pages and `workflowCursor` for workflow pages. `workflowRunId` filters children of one workflow. Rows carry a `timing` projection (`queueDelayMs`, `elapsedMs`, `activityAgeMs` when live, `processDurationMs`) plus `outputAvailable`/`finalAvailable`.
- `inspect`: single-entry `runIds` with `view: "summary" | "output" | "diagnostics" | "final"`, and optional opaque `cursor`/`limitBytes` (max 64 KiB, same cap for every view). Follow `nextCursor` to avoid truncation. `summary` includes the same `timing` projection as `list`, plus `output.finalAvailable`. `final` returns only the verified canonical terminal answer — empty with `finalAvailable: false` until a successful terminal boundary exists; it never promotes partial/narration text. `output` stays the combined stream (assistant messages plus canonical result) and is unchanged.
- `inspect` with `runIds` (summary view) (up to 20, deduplicated, order preserved): a single bounded batch of `summary`-only projections — one cheap request to see whether several selected background children are queued, running, or terminal, each with `outputRef`/`diagnosticsRef` for follow-up detail. Ownership of every requested ID is validated before any page is returned. Reuses the same `limitBytes` cap as single-run inspection; pages contain whole target entries and continue through `nextCursor`, without invalidation from ordinary live progress. If one compact entry cannot fit, an actionable error asks you to increase `limitBytes` or inspect that run individually; no target is silently dropped. The legacy `runId` selector remains accepted by programmatic callers but is no longer advertised to models. A singleton list supports other views; multiple targets require `summary`.
- `wait`: selected `runIds` (one or more), with `mode: "any" | "all"`. It returns terminal outcomes plus still-pending IDs; an unsuccessful workflow returns early even in `all` mode. It never chooses a winner or cancels pending work. While waiting, a bounded heartbeat (independent of any single target settling) reports live progress — watched targets, completed/pending counts, and recent activity — through the tool's update channel; it stops automatically on settlement, error, or interruption. Each settled outcome's `result` is spent from one shared byte budget (`limitBytes`, default 32768) across the whole response, in the requested `runId`/`runIds` order — never settlement race order, so the same targets and final states spend the budget identically regardless of which one happened to settle first: a result that fits is returned complete, one that does not is truncated with `resultTruncated: true` and the existing `outputRef`/`diagnosticsRef` to continue reading it — not a fixed-length teaser regardless of size. A target's evidence is never read from disk once the shared budget is already exhausted.
- `cancel`: single-entry `runIds` and optional reason. Whole-workflow cancellation stops active children; targeted child cancellation remains a catchable workflow outcome. Cancellation does not roll back edits or other side effects.

Interrupting a blocking `Agent`/`workflow` call cancels its work. Interrupting `external_runs wait` stops only that wait. Background work survives its launching tool return and ordinary parent turns, but not the owning session: orderly session shutdown requests cancellation and waits for bounded cleanup. This is not a daemon. After a host crash or unconfirmed shutdown, unfinished evidence is `interrupted_or_uncertain`; restart restores evidence access, never live ownership or guaranteed retrospective process termination. No routine activity wakes the parent, and live steering is not supported.

A parent's own `sleep`/wait duration (or its process lifetime) is not a measurement of, and does not bound, how long a delegated command actually takes to run — a background child keeps running under the session's ownership regardless of what the parent does next. A realistic collection shape:

```ts
// Launch two independent background runs.
const one = Agent({ description: "Audit auth module", prompt: "Audit /absolute/repo/auth read-only.", role: "reviewer", background: true }); // -> run_...
const two = Agent({ description: "Audit billing module", prompt: "Audit /absolute/repo/billing read-only.", role: "reviewer", background: true }); // -> run_...

// Optional: give both a head start before doing anything else. This sleep
// bounds nothing about the children's own runtime — it is just the parent
// choosing when to next check in, not a deadline or a proxy for command time.
// sleep(30_000)

// Do unrelated parent work here (read files, answer the user, plan next steps)
// while both children continue running under the session, not the parent turn.

// Check on both at once, without waiting for either to finish:
// external_runs({ action: "inspect", runIds: [one.runId, two.runId] })

// Leave them running and come back later in the conversation (or after
// further parent work) to collect final output once each is actually done:
// external_runs({ action: "inspect", runIds: [one.runId], view: "final" })
```

A task that sounds like a 30-second command can legitimately take substantially longer end-to-end once queueing and backend overhead are included — inspect and wait, do not assume.

## Workflow usage

The `workflow` tool runs trusted JavaScript that calls one or more external roles and returns a JSON-serializable result. Workflows are for explicit fan-out — and for the case this extension was built to make explicit: running several children on the **same** harness at once. Example:

```js
export const meta = { apiVersion: 1, name: "triage", description: "Three parallel agy reviewers" };
const [a, b, c] = await parallel([
  () => agent("Review slice A read-only: /absolute/repo", { label: "rev-a", role: "reviewer", harness: "agy" }),
  () => agent("Review slice B read-only: /absolute/repo", { label: "rev-b", role: "reviewer", harness: "agy" }),
  () => agent("Review slice C read-only: /absolute/repo", { label: "rev-c", role: "reviewer", harness: "agy" }),
]);
return { a, b, c };
```

Sequential `await agent(...)` stays serial by construction; `parallel([...])` is how parallel children share the single `maxConcurrentSubagents` limiter at once. Top-level direct `Agent` calls issued together also run together (`executionMode: "parallel"`, default under one limiter). `external_runs wait` and `external_runs inspect` cover both surfaces. Its first statement must be the current declaration `export const meta = { apiVersion: 1, name, description }`; missing or unsupported versions fail before any child launches. Every `agent()` child uses the same `role`/optional `harness` resolution as direct `Agent` calls, with legacy exact `subagent_type` also supported. `agent()`'s second argument accepts `description` as the common task-name option shared with direct `Agent` calls; `label` remains a compatible alias for existing scripts. Setting both to different values is rejected rather than silently preferring one.

`background: true` belongs to the `workflow` tool call itself (`workflow({ script, background: true })`), never to `meta` — `meta` fields other than `apiVersion`/`name`/`description`/`phases` are ignored, so `export const meta = { ..., background: true }` does not run the workflow in the background.

Saved workflows are discovered on demand through `external_help({ topic: "workflow" })`; project `.pi/workflows` entries are included only when Pi reports the project trusted.

Example request:

```text
Use the workflow tool to ask role "explorer" on harness "claude" for an architecture map and role "reviewer" on harness "codex" for a risk review, then synthesize their findings.
```

Direct `Agent` calls and workflow children share one concurrency limiter (`maxConcurrentSubagents`, default 12) and the same timeout controls. There is no per-harness cap: three `agy` children run together when started together — `parallel([() => agent(..., { harness: "agy" }), ...])` in a workflow, or three `background: true` `Agent` calls in one turn followed by `external_runs wait`. Sequentially `await`ed children stay serial by construction. Direct calls default `executionMode: "parallel"` so top-level `Agent` calls issued together run together. Workflow `agent(prompt, { role, context: { mode: "recent", turns: 5 } })` accepts the same context modes. Every current-version `agent()` returns its value or throws a catchable `ChildRunError` with `runId`, `outcome` (`failed`, `cancelled`, or `timed_out`), `message`, and output/diagnostic references. Catch an optional failure explicitly; an uncaught child error fails the workflow and drains active siblings. `parallel` and `pipeline` preserve this contract and never convert failure to `null`.

Every child selects from one parent snapshot and effective settings frozen at workflow invocation; earlier child results must still be passed explicitly. `resumeFromRunId` is explicit replay for a persisted `scriptPath`: it reuses only the longest unchanged prefix of successful child calls. The API version, transferred context, prompt, selection, and relevant options participate in fingerprints. The first changed, failed, cancelled, or timed-out call and everything after it executes again. Recomposition is cheap, but rerun children may cost money or repeat side effects; the runtime never retries or replays a repaired script automatically.

## Permission tiers, budgets, and resume

Every `Agent` call and workflow `agent()` child also accepts these optional run parameters (`context` is covered under agent usage above):

- `permission`: `readonly` | `edit` | `danger`. Omit it to use settings `defaultPermission` (`danger` unless changed). A role or override `permission` field is obsolete and is rejected. Tiers map onto native harness mechanisms where the backend can enforce them. Antigravity accepts only `danger` (`--dangerously-skip-permissions`) and rejects `readonly` and `edit`. Claude `readonly`/`edit` auto-deny shell commands headlessly; denials are surfaced in the receipt. A named Pi harness restricts tool names. That is not an OS sandbox.
- `max_budget_usd`: a spending cap. Claude Code enforces it mid-run with its native `--max-budget-usd` flag. Codex estimates cost from a price map and agy does not report cost at all; Grok reports its own native cost (`total_cost_usd`) but exposes no enforcement flag; Muse has never been observed to report cost at all. For codex, agy, grok, and muse alike, the cap is recorded and marked `budget unenforceable` instead of pretended.
- `resume`: a prior run id. Continues the same backend conversation (Claude `--resume`, Codex `exec resume`, agy `--conversation`, Grok `--resume`, Muse `exec --session-id`) instead of starting from scratch. The prior run must use the same backend. Claude sessions persist in Claude Code's own local storage (this extension no longer passes `--no-session-persistence`) so recorded session ids stay resumable; remove old conversations from Claude Code itself if that matters to you. Muse's `--session-id` resume was verified directly: two independent `muse exec` processes sharing the same `--session-id` reported the same session, and the second recalled a fact only told to the first. `resume` cannot be combined with `context` sharing — continue an existing child, or start a new one with a snapshot.

Resolution order for the tier is call `permission`, then settings `defaultPermission`. Budget order is call `max_budget_usd`, then an exact override's `max_budget_usd`, then the settings default. Conversion of a pre-v4 install drops `permission` and `capabilitySet` from copied overrides, turns `harness: "pi-*"` templates into ordinary roles, and does not copy `piCapabilitySets`.

## Settings and runtime limits

The only execution-configuration file is:

```text
$PI_CODING_AGENT_DIR/pi-flow-external/settings.json
```

Normally this resolves to `~/.pi/agent/pi-flow-external/settings.json`. A missing file uses these defaults in memory and is not created by a read:

```json
{
  "version": 4,
  "defaultHarness": "agy",
  "maxConcurrentSubagents": 12,
  "subagentTimeoutMs": 7200000,
  "defaultPermission": "danger",
  "defaultMaxBudgetUsd": null,
  "maxRunRecords": 200
}
```

Field names and units are unchanged. Add `harnesses` only for named `pi-*` registrations; the five CLI harnesses need no entries. Add `disabledProfiles` to list exact execution identities to exclude, such as `"codex-explorer"`. Empty objects and lists may be omitted. A file that also registers a harness is shown under Named Pi harness configurations. `maxRunRecords` prunes the oldest completed run records at session start and via `/external runs --prune`; records still running or interrupted are never pruned, and `0` keeps everything.

`/external settings` shows the effective values, the harness source, and the canonical path. When conversion is ready, it tells you to run `/external settings convert`. `/external settings edit` opens that JSON in the standard editor and validates it before saving. The next invocation reads the saved file. A workflow already running keeps the snapshot it froze at start. A new `maxConcurrentSubagents` value waits until active and queued work has drained.

Pre-v4 files are not applied as live settings. Convert them once with `/external settings convert`, as described in Breaking upgrade. After that, version 4 ignores the old files.

### Project default-harness override

A trusted project can override the global `defaultHarness` without editing the global file or copying roles. Create:

```text
<project>/.pi/pi-flow-external/settings.json
```

```json
{ "defaultHarness": "claude" }
```

The override applies only when Pi marks the project trusted, supports `defaultHarness` only, and is never created or written by the extension. The project file cannot inject roles or harness registrations. Precedence: an explicit `harness` in the call wins, then the trusted project default, then the global setting, then the built-in default. `/external settings` reports the effective harness and its source. An untrusted or invalid project file is ignored with a warning. A role that does not resolve on the effective harness fails with an actionable error and does not switch harnesses. The next invocation reads the project file. Startup flags override extension factory options, which override this file, which override built-in defaults.

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

- **Delegation says configuration must be converted:** run `/external settings` for the pointer, then `/external settings convert` to preview and apply. Delegation stays blocked until version 4 is active. Old files are kept and are not a live fallback.
- **Role unavailable on the selected harness:** choose one of the harnesses listed in the error, author the shared role with `/external role create`, or materialize that one binding with `/external role override <role> <harness>`. The extension does not substitute another harness.
- **Disabled identity:** remove that exact name from `disabledProfiles` in `/external settings edit` when you intend to use it again. Conversion records deleted seeded identities there on purpose.
- **CLI available but authentication fails:** authenticate that CLI directly; Pi and every external backend keep separate credentials.
- **Claude rejects `--dangerously-skip-permissions` under root:** reload the current extension version; root runs use Claude's `auto` permission mode.
- **Nested agent cannot find the repository:** include the repository's absolute path and required context in the prompt.
- **Child is missing earlier decisions:** share the smallest sufficient parent context (`context: { mode: "recent", turns: N }` or `{ mode: "full" }`), or restate the missing decisions in the prompt.
- **Workflow rejected before any child launched:** the script is missing or using an unsupported `meta.apiVersion` declaration. Recompose it starting with `export const meta = { apiVersion: 1, name, description }`; nothing ran, so nothing needs cleanup.
- **Run shows `interrupted_or_uncertain`:** the host exited before the run's termination was confirmed. Treat its evidence as interrupted — partial output may be readable via `/external runs` — but never resume live ownership after restart; start a new run or replay explicitly.
- **Inspection cursor fails as stale:** the run's content changed while paging (live updates or registry handoff). Restart the inspection from the first page; cursors are single-sequence continuation tokens.
- **Run failed with complete records:** read its output and diagnostics via `/external runs`, or inspect `summary.json`/`events.ndjson` directly; do not retry automatically unless requested.
- **Sensitive content appears in evidence:** remove the affected run directory. Local redaction is not a secrecy boundary.

## Development

Run the deterministic offline checks:

```bash
npm run check
```

Real-provider checks consume tokens, but the default lane never prompts a root LLM to choose the tool call: it builds an in-process Pi SDK session with a faux, never-streamed root model and calls the `Agent`/`workflow`/`external_runs` tool executors directly, so only the selected external backend's own child (a real spawned CLI process, or, for `--backend pi`, a real in-process nested Pi child) is real:

```bash
npm run e2e -- --backend claude
npm run e2e -- --backend codex
npm run e2e -- --backend agy
npm run e2e -- --backend grok
npm run e2e -- --backend muse
npm run e2e -- --backend claude --workflow
npm run e2e -- --backend codex --workflow
npm run e2e -- --backend agy --workflow
npm run e2e -- --backend grok --workflow
npm run e2e -- --backend muse --workflow
npm run e2e -- --backend pi --harness pi-deepseek
npm run e2e -- --backend pi --harness pi-deepseek --workflow
```

The `pi` backend requires a harness you have already registered under `harnesses` in your real `settings.json`, with real credentials configured. The script never registers, writes, or pays for one on your behalf. `--interrupt` cancels a backgrounded `Agent` through `external_runs` instead of `--workflow`'s two-child check.

A separate, explicit `--routing-smoke` lane spawns a real `pi` CLI process with a real root model and asks it, in plain language, to pick the right tool — useful only when role discovery, tool descriptions, or coordinator guidance changes, and never the default:

```bash
export PI_CODING_AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
npm run e2e -- --routing-smoke --backend codex
```

See [`docs/field-testing.md`](docs/field-testing.md) for provider checks and [`docs/releasing.md`](docs/releasing.md) for the release process.

Run directly from a checkout with:

```bash
pi -e ./index.ts
```
