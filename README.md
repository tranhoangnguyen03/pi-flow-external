# pi-flow external

External agent delegation for [pi](https://github.com/earendil-works/pi). A **role** is the work. A **harness** is where and how that role executes. The harnesses are:

- Antigravity (`agy`)
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (`claude`)
- [Codex CLI](https://github.com/openai/codex) (`codex`)
- [Grok Build CLI](https://github.com/xai-org/grok-build) (`grok`)
- Muse Code (`muse`)
- [OpenCode](https://opencode.ai/docs/cli/) (`opencode`)
- Named Pi harnesses (`pi-<label>`) — in-process, per-model configs you register yourself, not a spawned CLI

Six built-in roles are available in memory on every one of those harnesses. A fresh installation writes no profile files.

The ordinary driver has four tools (`workflow` can be disabled):

- `Agent` resolves and runs one external role.
- `workflow` orchestrates multiple external roles with trusted JavaScript.
- `external_help` returns the usage playbook, role details, permission behavior, or workflow guidance on demand.
- `external_runs` lists, inspects, waits for, and cancels session-owned runs.

`Agent` and `workflow` accept a role with an optional harness — `agy`, `claude`, `codex`, `grok`, `muse`, `opencode`, or a registered `pi-*` name. A registered Pi harness uses that same selection. Legacy exact `subagent_type` remains available and cannot be combined with `role` or `harness`. `pi_flow_role_create` is active only during `/external config role assist`. `pi_flow_harness_create` is active only during `/external config harness assist`. Worked calls are `external_help` topic `usage`.

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
opencode --version
```

Pi's coordinator model and the external CLIs authenticate independently. A working Claude, Codex, Antigravity, Grok, Muse, or OpenCode login does not authenticate the root Pi model. The Grok Build CLI installs and authenticates entirely separately from Pi: install with `curl -fsSL https://x.ai/cli/install.sh | bash`, then authenticate with `grok login` or an `XAI_API_KEY` environment variable. This integration is verified against Grok Build CLI `1.0.40`. Muse Code likewise installs and authenticates separately from Pi; this integration is verified against Muse Code `1.3.0` against its `meta` provider.

External agents use the effective permission tier and each harness's native mechanism:

- Claude: `--permission-mode plan`, `--permission-mode acceptEdits`, or `--dangerously-skip-permissions`
- Codex: `--sandbox read-only`, `workspace-write`, or `danger-full-access`
- Antigravity: only `--dangerously-skip-permissions`. `readonly` and `edit` are rejected.
- Grok: `--sandbox read-only`, `workspace`, or `off`, always alongside `--permission-mode bypassPermissions` — bypass only skips the interactive approval prompt; the kernel sandbox remains the enforced boundary. `readonly`'s network-blocking guarantee is Linux-only (a no-op on macOS), and sandbox startup can fail closed on some macOS hosts (for example when `/var/run/docker.sock` resolves to a symlink) rather than silently running unsandboxed.
- Muse: every tier passes `--disable-approval` (approval and Muse's own sandbox are ON by default, and headless runs must not hang on an interactive prompt); `readonly` additionally passes `--disable-write --disable-shell`; `edit` leaves the sandbox enabled with only approval bypassed; `danger` uses `--yolo`, which disables approval and the sandbox and additionally trusts the workspace for this run (loads its skills/rules) — a broader grant than an unsandboxed run alone.
- OpenCode: `danger` uses `--auto`; restricted tiers inject deny-by-default native tool rules. These are not an OS sandbox; plugins and MCP still load. See the OpenCode section for restrictions.
- Named Pi harnesses: a curated tool list (`read`/`grep`/`find`/`ls` at `readonly`; those plus `edit`/`write` at `edit`), or the SDK's own default active tools (`read`/`bash`/`edit`/`write`) at `danger`. That list is not an OS sandbox. The registration preset is `minimal` (skills stay unloaded; the default when the field is absent) or `skills` (installed skills load; project skills load only when the project is trusted). Extensions, prompt templates, and themes stay unloaded.

The effective tier is the call's `permission`, or settings `defaultPermission` when the call omits it. The default is `danger`. A role does not change the tier. Claude refuses bypass mode when its effective UID is `0`; danger then uses `--permission-mode auto`. Claude `edit` denies Bash headlessly. Pass `danger` on the call when the task needs a shell. Run external agents only in repositories you trust and state whether each task is read-only or may edit files.

The TUI labels a direct run with its effective access, including `unsandboxed external CLI` for danger, `Pi SDK child · host access · curated tools` for a danger-tier named Pi harness, and `external host access` while workflow work is active. These labels disclose actual execution authority. A read-only instruction in a role is intent, not that authority.

## Quick start

The six built-in roles — explorer, planner, implementer, reviewer, qa, and worker — are already available on `agy`, `claude`, `codex`, `grok`, `muse`, `opencode`, and any enabled named Pi harness you register. Nothing has to be authored first.

1. Run `/external` to open the guided settings window. Check the default agent, pick a model or reasoning level if you want, and close it.
2. Run `/external doctor` to check CLI installation and reported sign-in separately from configuration. A configured agent can still be uninstalled or unauthenticated.
3. Delegate by role. The built-in default harness is `agy`:

```text
Use the Agent tool with role "explorer" and harness "claude" to map this repository read-only.
```

Existing v4 installations must convert first; `/external` opens a **Settings need attention** screen (see [Breaking upgrade](#breaking-upgrade)).

## Configure agents

`/external` and `/external config` open the same guided window. Agents are listed by name (Antigravity, Claude Code, Codex CLI, Grok CLI, Muse Code, OpenCode, and `Pi · <label>` for registered Pi agents), with the default and any **Off** state marked.

```text
External agents
Default: <agent>
  <agent> · Default · <model>      → Model · Reasoning · Make default · Role customizations…
                                     Check installation and sign-in… (CLI) | Check model and credentials… (Pi)
                                     Send a test message… (may incur cost) (Pi only) · Turn on | Turn off · Advanced…
  Add a Pi agent…                  → provider → model → name → Review new agent → Create agent
  Roles…                           → <role> → Edit shared instructions… · Customize for an agent… ·
                                     Turn off everywhere · Details · Restore original instructions… | Remove role…
                                     Create a role…
  Recent runs…                     → the same navigator as /external runs
  Advanced…                        → Global default… · Default access · Default spending cap (USD) · Concurrent runs ·
                                     Run timeout · Retained completed runs · Configuration details · Edit settings file… ·
                                     Diagnostics (checks installation/sign-in)… · Legacy selectors… · Purge old files…
  Close
```

Pickers mark the current choice with `· Current`; settings screens show current values in their rows. Choices save immediately ("Saved · applies to future calls."). Cancelling an input or editor saves nothing from that step, and closing the window does not undo earlier saves. There is no undo history: remove a customization with the **Same as …**, **Use shared instructions**, or **Restore …** choices described below. Removal and restore keep their impact previews. In the terminal window, confirmations start on **Cancel**.

Access is global, not per agent. The agent screen shows the global default (for example `Access: Full access via agent permissions`); change it under **Advanced → Default access**, and a call's `permission` still overrides it. Antigravity shows **Full access only**, and the window will not make it the default unless default access is Full access.

### Walkthrough: change an agent's model

1. `/external` → select **Codex CLI** → **Model · …**.
2. Select a row such as `<name> · <id>`. Type `/` and part of a name to filter. **Enter a custom model ID…** accepts an unlisted ID; **About this model list** says where the list came from.
3. The window confirms `Saved model for Codex CLI. Used by roles without their own setting`. **Use Codex CLI settings** removes the pin again so the CLI's own default applies.

**Reasoning · …** works the same way. **Match my Pi session** stores a snapshot policy: each new call copies your current Pi session level. It is not available for OpenCode, whose reasoning is a model variant (**Enter model variant…**) that requires a pinned model. For Antigravity and Grok, the window offers only the levels those adapters forward unchanged; the explicit commands accept the full validated set.

### Walkthrough: customize one role, then return to inheritance

1. `/external` → **Roles…** → **reviewer** → **Customize for an agent…** → **Codex CLI**. The screen says `Changes here affect this agent only`.
2. **Reasoning · …** → **High**. The window confirms `Saved reasoning for reviewer on Codex CLI only.` In settings this is a sparse `harnesses.codex.roles.reviewer` entry; no instructions are copied.
3. To undo it, open **Reasoning · …** again and choose **Same as Codex CLI · …**. That removes the role's own value, so it follows the agent again.

Two choices look similar but differ:

| Choice on a role's model/reasoning | Result |
|---|---|
| **Same as Codex CLI · …** | Removes this role's setting; the role inherits whatever the agent uses now or later |
| **Use Codex CLI settings** | Stores an explicit `native` value for this role; the CLI's own default applies even if the agent has a pinned model |

**Instructions · …** offers **Customize for this agent…** (a replacement for this agent only), **Use shared instructions** (removes that replacement after a preview and confirmation), and **View effective instructions**. Role-level **Advanced…** holds the spending cap, **Allowed tools** (Pi agents only), Details, and **Restore these role customizations…**. If a role is unavailable, **Reasons and fixes…** lists every blocking gate and offers only the fixes that apply, such as **Turn on reviewer for Codex CLI only**.

### Walkthrough: add a Pi agent

1. `/external` → **Add a Pi agent…** → **Choose a model provider**. Providers with configured credentials are listed, or every provider when none are configured. **Show all providers…** appears when others exist.
2. Pick a model under `Models › <provider>`. Rows read `<name> · <id> · Account configured` or `· Account not configured`.
3. **Name this Pi agent**: lowercase letters, numbers, and hyphens. `fast` becomes `pi-fast`, shown as `Pi · fast`.
4. **Review new agent** shows **Model**, **Reasoning · Off**, and **Skills · Not loaded**; change any of them, then choose **Create agent**. Nothing is saved before that.

Creating sends no prompt. **Check model and credentials…** is also offline: it looks the model up in Pi's registry and reports whether credentials are configured. **Send a test message… (may incur cost)** is the only request the window sends. It asks for confirmation, then sends one readonly-tool prompt from an empty temporary directory. It may wait for a free run slot, stops after 60 seconds, and writes no run record. Esc cancels it in the terminal window. A pass shows that this one request worked; it does not judge role quality.

### Where model lists come from

| Agent | List source |
|---|---|
| Codex CLI | Codex's local model catalog (`$CODEX_HOME/models_cache.json`, default `~/.codex`); may be stale; no request. Open Codex once if it is missing |
| Claude Code | The `sonnet`, `opus`, and `fable` aliases; the CLI resolves the version when it runs |
| Antigravity, Grok CLI, OpenCode | The CLI's own `models` command, run only when you open the picker (10-second limit). Grok and OpenCode names are derived from IDs |
| Muse Code | No listing; current and previously configured IDs plus a custom ID |
| Pi agents | Pi's model registry, grouped by provider |

Listing never sends a prompt, but a CLI may contact its own service. A listed model, **Account configured**, or a successful sign-in check does not prove that your account can use that model. Access is checked by an actual request. If a CLI listing fails, the window says so and you can still enter an ID. Pi choices must resolve through Pi's registry; add missing models to Pi first.

### Terminal, RPC, and headless behavior

- **Terminal (TUI):** one overlay. ↑/↓ navigate, Enter selects, `/` filters list rows, Esc clears the filter, then goes back, then closes. PgUp/PgDn scroll previews. In the instructions editor, Shift+Enter adds a line and Ctrl+G opens `$VISUAL`/`$EDITOR` (a failed editor keeps the draft). Esc cancels model listing and the Pi test.
- **RPC:** the same menus use the client's standard select, input, editor, and confirm dialogs. Text screens appear as a dialog with **Back**. Filtering depends on the client, and model listing or a confirmed Pi test cannot be cancelled from the dialog; they end at their time limits.
- **Without UI:** `/external` prints a short overview and `/external config` prints the configuration text. Use the commands under [Command reference](#command-reference) instead.

Opening the window runs no probes and sends no model requests. Invalid, outdated, or future-version settings open **Settings need attention** with **Preview format update…** (only when a conversion is ready), **Edit settings file…**, and **Show problem and file location**. If settings become invalid while the window is open, it reports **Settings changed** and returns to that screen. It never runs on fallback settings.

## Breaking upgrade

Settings are now **version 5**. Existing v4 installations need an explicit conversion; reads never migrate. Open `/external` and choose **Preview format update…**, or run `/external config convert`. The preview preserves all instructions (including empty full overrides), model/effort pins, and independent disabled scopes. It writes an immutable `settings.v4.backup.json` and nested instruction copies before activating v5. Originals remain untouched. Conflicting destinations or changed sources block activation; identical interrupted copies can be reused.

Conversion notes disclose retained exclusions and exact Pi selectors whose effective model/effort become explicit pins. Legacy CLI `tools` metadata is omitted with a source-specific note because CLI backends never enforced it; Pi tool restrictions are preserved. Unsupported effort blocks conversion with the source file and repair guidance—values are never silently remapped. Editing `version` in the settings editor cannot bypass conversion or perform a downgrade.

Pre-v4 installations use the existing conservative first conversion to v4, then run the command again to preview v5. No old layout remains a live fallback. Ordinary delegation does not require purging originals. Repeated model pins are **not** automatically promoted to harness defaults: that changes future-role behavior and requires a separate reviewed consolidation.

Command changes. Removed routes are not aliases and do not run; `/external help` lists them too:

| Old | Current |
|---|---|
| `/external` (printed an overview) | Opens the guided window in the terminal and RPC; prints the overview only without UI |
| `/external config` (printed configuration) | Opens the guided window in the terminal and RPC; `/external config text` prints the configuration in any mode |
| `/external config harnesses` | `/external config harness list` |
| `/external config enable\|disable\|default NAME` | `/external config harness enable\|disable\|default NAME` |
| `/external config harness create` (interview) | `/external config harness create pi-NAME --model provider/model` (no request), or `/external config harness assist` for the interview |
| `/external roles` | `/external config role list` |
| `/external role create` | `/external config role create NAME`, or `/external config role assist` |
| `/external role inspect ROLE [HARNESS]` | `/external config role inspect ROLE [--harness HARNESS]` |
| `/external role override ROLE HARNESS` | `/external config role edit ROLE --harness HARNESS` for instructions; `/external config role set ROLE --harness HARNESS` for model, effort, budget, or tools |

The older `/external settings`, `/external profiles`, `/external profile create`, `/pi-flow-profile create`, and `/external harnesses` routes remain removed. Agent/workflow selection APIs are unchanged. Canonical pair identities are now `harness/role`; unambiguous legacy exact pair names remain supported.

### Optional purge

Delegation after conversion does not require deleting anything. `/external [danger]purge-old-files` is a separate destructive maintenance command. The brackets and the word `danger` are part of the spelling.

It lists the exact candidate paths and whether customized content was copied. Nothing is preselected. You toggle each path, then confirm deletion of that selection. It requires converted settings (v4 or v5), so it cannot erase the only harness registry or deletion markers before they are recorded. Delegation still requires v5. Customized copies inside the inventory can be deleted too.

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

## Command reference

The guided window covers everyday configuration. These commands are for automation, sessions without UI, diagnostics, and fields the window does not edit. Creation, editing, and lifecycle changes are deterministic and do not need a model. Commands that need an editor or confirmation require UI; `assist` and explicit Pi tests are separate model-request paths.

```text
/external config harness set codex --model <model-id> --effort high
/external config harness reset codex --effort
/external config harness default claude
/external config harness disable muse
/external config role set reviewer --harness codex --effort xhigh
/external config role edit reviewer --harness codex
/external config role reset reviewer --harness codex --instructions
```

| Command | Purpose |
|---|---|
| `/external` | Guided settings window (short text overview without UI) |
| `/external config` | The same guided window (configuration text without UI) |
| `/external config text` | Print effective configuration, its sources, and the settings path in any mode |
| `/external config edit` | Edit and validate canonical settings in the standard editor |
| `/external config convert` | Preview and apply explicit configuration conversion |
| `/external doctor` | Validate the catalog, then report CLI and named-Pi readiness separately |
| `/external config harness list` | Harnesses with model, effort, preset, enabled, and default state. Readiness is separate |
| `/external config harness inspect NAME` | Effective defaults with their origin, role exceptions, instruction overrides, and remaining gates |
| `/external config harness create pi-NAME --model provider/model` | Register a named Pi harness (`--effort`, `--preset minimal\|skills`). Sends no request |
| `/external config harness edit NAME` | Edit one harness entry in the standard editor; validated before saving |
| `/external config harness enable\|disable NAME` | Toggle a harness for new calls; configuration is preserved |
| `/external config harness set NAME` | Set `--model`, `--effort`, and on Pi `--preset` |
| `/external config harness reset NAME` | Reset `--model`/`--effort`/`--preset`, or everything after a confirmed preview; gates stay |
| `/external config harness delete pi-NAME` | Delete a named Pi harness and its overrides after a confirmed preview |
| `/external config harness default NAME` | Choose an enabled global default; trusted project overrides still take precedence |
| `/external config harness test NAME` | Explicit readiness check; see below |
| `/external config harness assist` | Assisted named Pi harness interview; smoke-tests before saving |
| `/external config role list` | One row per role with source, enabled state, and harnesses with exceptions |
| `/external config role inspect NAME [--harness H]` | Per-harness availability, or one binding's instructions, values with origins, gates, and real authority |
| `/external config role create NAME` | Author one reusable role in the editor |
| `/external config role edit NAME [--harness H]` | Edit shared instructions, or one harness's replacement instructions |
| `/external config role enable\|disable NAME [--harness H]` | Toggle a role everywhere, or one binding |
| `/external config role set NAME --harness H` | Binding `--model`, `--effort`, `--budget`, and Pi `--tools a,b` |
| `/external config role reset NAME [--harness H]` | Reset selected fields or `--instructions`, or everything after a confirmed preview; gates stay |
| `/external config role delete NAME` | Delete a custom role everywhere after a confirmed preview |
| `/external config role assist` | Optional assisted role-authoring interview |
| `/external [danger]purge-old-files` | List and delete obsolete extension files. Secondary maintenance; the brackets are literal |
| `/external workflows` | List saved workflows |
| `/external runs` | Interactively browse current-session runs, every workflow child, paged output/diagnostics, and cancellation |
| `/external runs summary` | Summarize durable run records |
| `/external runs --prune` | Prune eligible completed run records |
| `/external help` | Show the command reference and the replaced commands ([mapping](#breaking-upgrade)) |

One harness setting covers every current and future role on that harness. A role exception on one harness (`role set NAME --harness H`) stores only the changed fields and copies no instructions. `role edit NAME` changes the shared instructions; `role edit NAME --harness H` writes a replacement for that one harness only. Model, effort, budget, and tools always need `--harness`; `--tools` applies to named Pi harnesses only. `model native` on a binding selects the CLI's own model, even over a harness pin. This is the window's **Use … settings** choice; resetting the field is **Same as …**.

Three gates apply together: the harness, the role (every harness), and one binding (`--harness`). Enabling one gate reports any gate that still blocks the selection. Disabling preserves definitions, removes the selection from executable discovery, and never switches a call to another harness. Choose another default before disabling the current default; a disabled harness cannot become the default. Existing children and already-running workflows keep their invocation-time configuration.

`reset` with field flags deletes only those properties so they inherit again; without field flags it previews every customization it will remove and asks for confirmation. Reset never enables anything. A role reset removes instruction files before scalar settings; failed file removal keeps scalars intact. Partial removals or a later settings-write failure are reported, and a new preview can finish the reset. Built-in roles and the six CLI harnesses cannot be deleted: reset or disable them instead. Deleting a custom role or a named Pi harness previews every owned file and settings field, refuses while the harness is a global or trusted-project default, disables the entity before removing its files, and leaves it disabled if a file cannot be removed. Run receipts and native CLI configuration are never touched. Every change applies from the next invocation.

Pi agent creation paths differ in what they send:

| Path | Requests |
|---|---|
| **Add a Pi agent…** or `config harness create` | None. Saving is structural |
| **Check model and credentials…** | None. Registry lookup and configured-credential state only |
| **Send a test message…** or `config harness test pi-NAME` | One confirmed, potentially paid readonly request. Needs a UI for the confirmation; without one it reports `Test cancelled`. The command form cannot be cancelled with Esc and ends at the 60-second limit |
| `config harness assist` | An interview with your root Pi model, then a smoke test against the chosen model before saving; a failed test is rolled back |

For a CLI, `config harness test` and **Check installation and sign-in…** run the CLI's version and login-status checks and send no model request. A harness smoke test does not judge role quality. `/external doctor` reports disabled harnesses without probing their readiness.

`/external doctor` reports CLI availability separately from provider authentication and catalog validity. Claude and Codex use their non-interactive login-status commands; other CLIs report login as unverified. Credential presence does not prove a request will succeed. Known inherited authentication/routing environment variables are listed by name only, never value. Native status commands may access credential storage or perform network activity; no model prompts or quota requests are sent, and no credentials are changed.

Doctor also reads retained run summaries for this project and shows the latest recorded usage-limit observation per harness, its source run, any reset time, and whether a later run succeeded. These are historical observations, not current account status. New failed Claude runs can preserve structured rate-limit rejections; Antigravity runs can preserve terminal individual-quota errors. Other backends and older records may have no evidence. Missing, malformed, or oversized summaries are skipped and counted; backend event logs and model answers are never searched. Remaining allowance stays unavailable.

Without UI, `/external` prints an overview like this:

```text
External agents
Default: pi-deepseek (global)
Roles: 7 known
Harnesses: 6 CLI · 1 named Pi (see /external config)
Settings: ~/.pi/agent/pi-flow-external/settings.json
```

The built-in default harness on a fresh installation is `agy`. The overview above is a directory that has already registered `pi-deepseek` and authored one extra role.

## Configuration

One extension-owned home. Reads do not create directories or write defaults. The extension does not write Pi's root settings or Pi's native `subagents/` directory.

```text
$PI_CODING_AGENT_DIR/pi-flow-external/
  settings.json             # only execution-configuration file; optional
  roles/                    # user-authored shared roles; created when you save one
    security-reviewer.md
  overrides/                # instruction replacements only
    claude/reviewer.md
  runs/                     # operational evidence
```

Normally `$PI_CODING_AGENT_DIR` is `~/.pi/agent`. Markdown holds authored instructions. JSON holds scalar execution settings. Project-local roles are not supported; the global catalog is used for both global and project-only package installations. A trusted project may still override `defaultHarness` only, described under Settings.

At each direct call the extension loads one catalog snapshot. A workflow freezes that same snapshot for the whole run. Resolution order:

1. Harness: explicit call, then the trusted project default, then the global default, then the built-in default (`agy`).
2. Harness, role, and binding enabled gates must all permit execution. Invalid configuration blocks the selection; no harness substitution.
3. Instructions: `overrides/<harness>/<role>.md`, then `roles/<role>.md`, then built-in instructions.
4. Model/effort: sparse `harnesses.<harness>.roles.<role>` setting, then harness default, then native CLI defaults (Pi requires a model). Permission remains call then global default.

An omitted scalar inherits. `thinking: parent` snapshots the parent effort; `native` omits the CLI override. `off` requests a level, not reset. Reset removes only the chosen customization. Explicit unsupported effort fails; OpenCode variants require a pinned model. With `parent`, the root level must be supported by the selected backend (for example Claude/Codex reject `off`); change the root level, pin a supported effort, or use CLI-native effort. Inspection reports origins and adapter constraints. A native unresolved default cannot establish replay equivalence.

Linked/non-directory configuration roots block the catalog instead of loading instructions through an unsafe ancestor. An invalid higher-priority override blocks that selection. An unrelated invalid file is reported and does not take a different role offline. Invalid settings JSON, or a settings version this release does not support, blocks delegation. `/external config`, `/external config convert`, and `/external config role inspect` remain available. The next invocation reads settings, roles, and overrides from disk. A workflow that has already started keeps the snapshot it froze at start. A change to `maxConcurrentSubagents` waits until no subagent is active and none are queued.

Canonical binding identities are `<harness>/<role>`, with separate role/harness fields. Legacy `<harness>-<role>` selectors remain accepted when unambiguous; ambiguous names fail and request explicit role/harness selection. Converted nonstandard exact selectors remain explicit compatibility records. Stored exact selectors take precedence over inferred legacy aliases, without replacing structured bindings. They are listed and inspectable under `config role`; edit/remove their preserved JSON `exact` entry through `config edit`. They retain legacy instructions there and deliberately do not participate in ordinary role deletion/reset. Permission is the call, or `defaultPermission`. It is not a role field.

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

### Sparse execution settings and instruction replacements

Set all Codex roles once, including future shared roles:

```text
/external config harness set codex --model gpt-6.1-sol --effort high
/external config role set reviewer --harness codex --effort xhigh
```

These write JSON, never copy role instructions:

```json
{
  "version": 5,
  "harnesses": {
    "codex": {
      "model": "gpt-6.1-sol",
      "thinking": "high",
      "roles": { "reviewer": { "thinking": "xhigh" } }
    }
  }
}
```

Model names are installation/account-specific examples, not availability promises. Role-specific model/effort settings also work on named Pi harnesses. `preset` remains harness-owned. `tools` is accepted only on Pi and intersected with the permission tier.

To replace instructions, use `/external config role edit reviewer --harness claude`. Its `overrides/claude/reviewer.md` has only description frontmatter and the replacement body. A missing file inherits instructions; an empty body explicitly clears them. Removing an instruction replacement restores the shared/built-in body. This never changes scalar settings or enablement.

### Built-in roles

explorer, planner, implementer, reviewer, qa, and worker ship in memory for `agy`, `claude`, `codex`, `grok`, `muse`, and `opencode`, and for every registered named Pi harness. Session start writes no default files and no seed markers. Fresh CLI roles use native model/effort defaults unless configured. Converted installations preserve legacy parent-effort inheritance explicitly. A named Pi harness's roles inherit its model/effort defaults unless a binding overrides them. Adding a harness writes no role files. Seven authored roles are seven files under `roles/`, whatever the harness count is.

Disable a role everywhere with `/external config role disable reviewer`, or add `--harness codex` for one binding. Enable clears only the named gate and reports remaining blockers. Reset does not enable. Built-in roles cannot be deleted; custom definitions can be deleted after an impact preview.

### Named Pi harness configurations

A named Pi harness runs in-process through Pi's own SDK, for any model Pi can already resolve (built-in, self-hosted, or a custom-registered provider). Register it with **Add a Pi agent…** in `/external`, or with `/external config harness create pi-NAME --model provider/model`: a `pi-<label>` name, a `provider/model` id, a reasoning policy (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `parent`, stored explicitly on creation), and a resource preset (`minimal` or `skills`). `minimal` is the default and leaves skills unloaded. `skills` loads installed skills, and project skills only when the project is trusted. Registration is saved into the `harnesses` object of `settings.json` without sending a request. `/external config harness assist` is the model-assisted alternative; its smoke test uses the selected preset and runs before saving. A legacy entry that omits `preset` is `minimal`. The six CLI harnesses are built in and do not need entries there.

```json
{
  "version": 5,
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

A custom role is the one shared file from `/external config role create`. Use `/external config role edit reviewer --harness pi-deepseek` when only that harness needs a different body, and `/external config role set reviewer --harness pi-deepseek --tools read,grep --budget 2` for tools or budget. Permission stays on the call or in `defaultPermission`; an override cannot set it. Model and effort inherit from the harness, with validated role-specific exceptions allowed.

Settings writes use a private staged file and a same-directory replacement, and they preserve unrelated fields. The extension refuses to overwrite a malformed or newer-version file. Replacement avoids a torn write. Concurrent sessions can still overwrite each other's update: there is no inter-process lock. In `assist`, the smoke test finishes before that short commit, and the writer then rereads and checks for a duplicate or a conflict.

**v1 scope, by design:** a pi child's tools are the SDK builtins (`read`/`bash`/`edit`/`write`, plus `grep`/`find`/`ls` at `readonly`/`edit`). The registration preset selects `minimal` (skills stay unloaded) or `skills` (installed skills load; project skills require a trusted project). Extensions, prompt templates, and themes stay unloaded. The tool list is not an OS sandbox, and `bash` at `danger` is host access. Retry is disabled per pi child (in-memory, never touching your real Pi settings). Pi children cannot resume a prior conversation and have no enforced budget cap. Trusted extensions, MCP, resumable sessions, and budget controls remain [issue #43](https://github.com/tranhoangnguyen03/pi-flow-external/issues/43).

### OpenCode

Install and authenticate OpenCode separately (`opencode auth login`); use `opencode models` for available `provider/model` IDs. The adapter targets **OpenCode 2** (`@opencode/cli`, verified against **2.0.16**) only; OpenCode 1.x is not supported. Every run is `opencode run --standalone --format json`, which starts a private server that the run owns. It never uses or stops your shared background service (`opencode service`). The prompt goes over stdin. OpenCode 2 has no `--dir`; the run takes its project from `PWD` and the working directory, which the adapter sets to the Pi workspace. An omitted model uses OpenCode's configured default. For a role-specific setting:

```text
/external config role set reviewer --harness opencode --model anthropic/claude-sonnet-4-5 --effort high
```

Choose an ID available in your own installation. `thinking` is optional and is passed as the model variant (`--model provider/model#high`), so it needs a pinned `model` and must name a variant that model offers. OpenCode 2 rejects an unknown variant before the prompt runs. Inherited Pi thinking is never forwarded. Structured workflow `schema` is unsupported and rejected; plain text results remain available.

`danger` uses `--auto`; explicit OpenCode deny rules still apply. `readonly` and `edit` inject a private, deny-by-default agent through `OPENCODE_CONFIG_CONTENT` and select it with `--agent` on every run, resumes included. A resumed session otherwise keeps the agent it was saved with; OpenCode's `default_agent` applies only to new sessions. The agent allows read/grep/glob, plus edit/write/patch at `edit`. Shell, subagent delegation, web, and every other tool are hidden, and edits outside the workspace are denied. That config reaches only the private standalone server. These are **native tool permission rules, not an OS sandbox**; plugins and MCP servers still load. Restricted tiers refuse an existing `OPENCODE_CONFIG_CONTENT` rather than overwrite it. A restricted resume of a session that carries its own permission rules is refused, because OpenCode applies those after the agent's. A `danger` resume of a session last run by one of these per-run agents is refused too, because that agent no longer exists and the session would run with no tools. Resume it at `readonly` or `edit`, or start a new run.

The streamed JSON is progress only. OpenCode 2 stops forwarding events once the session is idle, and it exits 0 even after an interruption or a cancelled MCP form. So after a zero exit, the adapter reads the persisted session with `opencode session export --standalone <id>`. The export's output is bounded, and it honors the run's cancellation and timeout. A resume also exports the session once before running. Success requires all of the following:
- the session ID the run reported;
- a new user turn carrying exactly this prompt: the only one in a new session, or one absent from the pre-run export on a resume;
- after that turn, a session outcome and a terminal idle outcome of `succeeded`;
- a last assistant message that completed with `stop` and no error, with nonempty text;
- on restricted tiers, every assistant message of the turn run by the injected agent.

The result is that last assistant message's text, never streamed narration, which can include late or stale text. A malformed, oversized, or unknown export fails the run. Usage is this turn's assistant messages only. Cost is unknown if one lacks usage or ran a native `subagent`, whose child usage is not included. No budget cap is enforced. OpenCode retries transient provider errors internally (up to 10 retries); this extension does not retry it. Cancelling a run ends the CLI; its private server exits when the CLI's lease pipe closes.

## Agent usage

A direct tool call requires `description`, `prompt`, and either `role` or legacy exact-profile `subagent_type`. With `role`, `harness` is optional and uses the trusted project default when present, otherwise the global `defaultHarness` setting:

```ts
Agent({
  description: "Claude repository map",
  prompt: "Map this repository read-only and summarize important files.",
  role: "explorer",
  harness: "claude",
});
```

Resolution always targets the structured `<harness>/<role>` identity and does not switch harness. If a role is unavailable, the error lists the harnesses that provide it. Existing calls may instead use `subagent_type` as an exact-identity escape hatch; do not combine it with `role` or `harness`. Nonstandard override names are exact-only.

The parent prompt always includes one compact catalog of role names, restricted harness availability, exact-only names, the default harness, and a short operating guide. It does not repeat role descriptions, the usage playbook, or the workflow manual. Call `external_help` with topic `usage` for worked examples, `roles` for descriptions, `permissions` for harness caveats, or `workflow` for syntax and saved workflow discovery. The optional `harness` filter applies to `roles` and `permissions`; workflow help also accepts it while explaining cross-harness syntax. A listed role is a catalog entry. It does not mean the CLI is installed or authenticated.

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
Delegating Claude Code → claude/explorer · unsandboxed external CLI
Task Map repository architecture
Why Repository exploration through Claude Code.
Context recent · up to 5 user turns
Workspace /path/to/project
⠋ Claude Code(claude/explorer, Map repository architecture) external host access · 12s
```

The `Context` line appears only when the parent shares conversation content, so extra data leaving for the external harness is visible before the run. Completed rows summarize what was actually shared (`context recent 4/5 turns`).

Completed rows show a short evidence identifier and result preview. Press **Ctrl+O** (the default tool-expansion binding) to reveal bounded canonical output, its full run ID, a `/external runs` navigation hint, and advanced local evidence details:

```text
✓ Claude Code(claude/explorer, Map repository architecture) 42s evidence 8f21a004 -> Architecture mapped.
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
- `max_budget_usd`: a spending cap. Claude Code enforces it mid-run with its native `--max-budget-usd` flag. Codex estimates cost from a price map and agy does not report cost at all; Grok reports its own native cost (`total_cost_usd`) but exposes no enforcement flag; Muse has never been observed to report cost at all. OpenCode reports root-step cost but cannot account for nested subagent sessions. For codex, agy, grok, muse, and opencode alike, the cap is recorded and marked `budget unenforceable` instead of pretended.
- `resume`: a prior run id. Continues the same backend conversation (Claude `--resume`, Codex `exec resume`, agy `--conversation`, Grok `--resume`, Muse `exec --session-id`, OpenCode `run --session`) instead of starting from scratch. The prior run must use the same backend. Claude sessions persist in Claude Code's own local storage (this extension no longer passes `--no-session-persistence`) so recorded session ids stay resumable; remove old conversations from Claude Code itself if that matters to you. Muse's `--session-id` resume was verified directly: two independent `muse exec` processes sharing the same `--session-id` reported the same session, and the second recalled a fact only told to the first. `resume` cannot be combined with `context` sharing — continue an existing child, or start a new one with a snapshot.

Resolution order for the tier is call `permission`, then settings `defaultPermission`. Budget order is call `max_budget_usd`, then a role-on-harness setting's `max_budget_usd`, then the settings default. Conversion of a pre-v4 install drops `permission` and `capabilitySet` from copied overrides, turns `harness: "pi-*"` templates into ordinary roles, and does not copy `piCapabilitySets`.

## Settings and runtime limits

The only execution-configuration file is:

```text
$PI_CODING_AGENT_DIR/pi-flow-external/settings.json
```

Normally this resolves to `~/.pi/agent/pi-flow-external/settings.json`. A missing file uses these defaults in memory and is not created by a read:

```json
{
  "version": 5,
  "defaultHarness": "agy",
  "maxConcurrentSubagents": 12,
  "subagentTimeoutMs": 7200000,
  "defaultPermission": "danger",
  "defaultMaxBudgetUsd": null,
  "maxRunRecords": 200
}
```

Runtime field names and units are unchanged. `harnesses` contains optional CLI defaults and required named Pi registrations. Set `enabled: false` on a harness, root role, or harness-role patch to block that scope. Empty objects may be omitted. Legacy unresolved exclusions remain compatibility state; use the lifecycle commands instead of adding flattened names manually. `maxRunRecords` prunes the oldest completed run records at session start and via `/external runs --prune`; records still running or interrupted are never pruned, and `0` keeps everything.

`/external config` opens guided settings. **Advanced → Configuration details**, or `/external config text` in any mode, shows effective values, their sources and the canonical path. When conversion is ready, use **Preview format update…** in the window or `/external config convert`. `/external config edit` opens that JSON in the standard editor and validates it before saving. The next invocation reads the saved file. A workflow already running keeps the snapshot it froze at start. A new `maxConcurrentSubagents` value waits until active and queued work has drained.

Pre-v4 files are not applied as live settings. Convert them once with `/external config convert`, as described in Breaking upgrade. After v5 activation, old files are ignored.

### Project default-harness override

A trusted project can override the global `defaultHarness` without editing the global file or copying roles. Create:

```text
<project>/.pi/pi-flow-external/settings.json
```

```json
{ "defaultHarness": "claude" }
```

The override applies only when Pi marks the project trusted, supports `defaultHarness` only, and is never created or written by the extension. The project file cannot inject roles or harness registrations. Precedence: an explicit `harness` in the call wins, then the trusted project default, then the global setting, then the built-in default. `/external config` reports the effective harness and its source. An untrusted or invalid project file is ignored with a warning. A role that does not resolve on the effective harness fails with an actionable error and does not switch harnesses. The next invocation reads the project file. Startup flags override extension factory options, which override this file, which override built-in defaults.

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

- **Delegation says configuration must be converted, or `/external` shows Settings need attention:** choose **Preview format update…** (or run `/external config convert`) to preview and apply. **Show problem and file location** explains a malformed or future-version file, which is never converted or downgraded there. Delegation stays blocked until version 5 is active. Old files are kept and are not a live fallback.
- **Role unavailable on the selected harness:** choose one of the harnesses listed in the error, author the shared role with `/external config role create NAME`, or check its gates with `/external config role inspect <role> --harness NAME`. The extension does not substitute another harness.
- **Disabled harness:** open it in `/external` and choose **Turn on**, or run `/external config harness enable <harness>`. If a default points at a disabled harness, enable it or choose an enabled default; no fallback is performed.
- **Role off for one agent:** in `/external`, open the agent → **Role customizations…** → the role → **Reasons and fixes…**. It lists every blocking gate and offers only the applicable fixes, such as **Turn on reviewer for Codex CLI only**, including retained legacy exclusions. Conversion preserves deleted seeded identities as binding gates where resolvable, or retained exclusions otherwise.
- **CLI available but authentication fails:** authenticate that CLI directly; Pi and every external backend keep separate credentials. A model shown in a picker or a passing sign-in check does not prove account access.
- **Model missing from a CLI picker:** choose **Enter a custom model ID…**; the CLI checks it on the next request. **About this model list** explains the source, and a failed listing sends no prompt. For Pi, register the model in Pi's registry first.
- **Pi test cannot be cancelled:** Esc cancels it only in the terminal window. In RPC, and with `/external config harness test`, it ends at the 60-second limit.
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
npm run e2e -- --backend opencode --model <provider/model>
npm run e2e -- --backend claude --workflow
npm run e2e -- --backend codex --workflow
npm run e2e -- --backend agy --workflow
npm run e2e -- --backend grok --workflow
npm run e2e -- --backend muse --workflow
npm run e2e -- --backend opencode --model <provider/model> --workflow
npm run e2e -- --backend pi --harness pi-deepseek
npm run e2e -- --backend pi --harness pi-deepseek --workflow
```

The `pi` backend requires a harness you have already registered under `harnesses` in your real `settings.json`, with real credentials configured. The script does not register the harness or rewrite its configuration, but it sends real requests to the selected model and can incur usage charges. `--interrupt` cancels a backgrounded `Agent` through `external_runs` instead of `--workflow`'s two-child check.

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
