# Configuration Reference

This guide covers advanced configuration, the interactive settings window, JSON schema, inheritance rules, and the complete command-line interface for `pi-flow-external`.

---

## Control center and Configuration (`/external`)

`/external` opens the control center in TUI/RPC. `/external config` goes directly to the Configuration navigator. Neither opens a provider or makes a paid request.

```text
External
  Mode…                 → Normal / Orchestrator / Frontline Worker
  Configuration…        → Global / Agents / Roles
    Global…             → Default harness, access, budgets, concurrency, timeouts,
                           retention, diagnostics, settings file
    Agents…             → Select harness → Model, reasoning, role customizations,
                           enablement, readiness, advanced settings
    Roles…              → Shared definitions, per-agent overrides, restore / delete
  Runs…                 → Browse/inspect runs; summary; confirmed receipt pruning
  Workflows…            → Browse saved workflows and their source paths (read-only)
  Help…                 → Quick guidance, full command reference, optional diagnostics
  Close
```

Runs reuses the existing inspection and cancellation navigator. Its Maintenance page requires confirmation before pruning completed receipts. Workflows lists validated global and trusted-project scripts without executing them. Help displays short guidance and opens Doctor only when selected.

The Mode selector changes the same session entry as `/external mode`; it does not alter global defaults. Configuration values still follow existing inheritance and edit permissions. A broken configuration enters its existing repair screen while the control center remains accessible.

### Command discovery

The empty `/external ` argument menu suggests only `mode`, `runs`, `config`, and `workflows`. Typing a prefix finds detailed commands such as `doctor` or `config harness inspect`. `config ` folds suggestions into harness, role, text, edit, and conversion groups. No command is removed; detailed routes still work in headless mode.

### UI Navigation Shortcuts
- **Terminal (TUI):** ↑/↓ to navigate, `Enter` to select, `/` to filter list rows, `Esc` to clear filter, go back, or close. `PgUp`/`PgDn` scroll text previews. In the instructions editor, `Shift+Enter` adds a newline; `Ctrl+G` opens `$VISUAL` or `$EDITOR`.
- **RPC:** Menus map to standard client select, input, editor, and confirmation dialogs.
- **Headless / Non-interactive:** Prints plain-text summaries. Use CLI commands below for non-interactive automation.

---

## Model List Sources

When choosing a model in `/external`:

| Agent | List Source |
|---|---|
| Codex CLI | Local model catalog (`$CODEX_HOME/models_cache.json`, default `~/.codex`). Stale if Codex hasn't run recently. |
| Claude Code | Built-in aliases: `sonnet`, `opus`, `fable`. The CLI resolves the specific version on launch. |
| Antigravity, Grok CLI, OpenCode | Queried from CLI `models` command when opening the picker (10s timeout). |
| Muse Code | Current and previously configured model IDs, plus custom manual entry. |
| Pi agents | Pi's internal model registry, grouped by provider. |

---

## Settings File & Schema

The execution settings file is located at:
```text
$PI_CODING_AGENT_DIR/pi-flow-external/settings.json
# Default: ~/.pi/agent/pi-flow-external/settings.json
```

### Default Settings (Version 5)

```json
{
  "version": 5,
  "defaultHarness": "agy",
  "maxConcurrentSubagents": 12,
  "subagentTimeoutMs": 7200000,
  "defaultPermission": "danger",
  "defaultMaxBudgetUsd": null,
  "maxRunRecords": 200,
  "harnesses": {}
}
```

### Sparse Overrides
Settings support sparse inheritance. Setting a model or reasoning level on a harness applies to all roles on that harness unless explicitly overridden for a specific role:

```json
{
  "version": 5,
  "defaultHarness": "claude",
  "harnesses": {
    "codex": {
      "model": "<model-id>",
      "thinking": "high",
      "roles": {
        "reviewer": {
          "thinking": "xhigh"
        }
      }
    }
  }
}
```

### Project-Specific Default Harness Override
A trusted repository can override `defaultHarness` locally without modifying global settings. Create `<project>/.pi/pi-flow-external/settings.json`:

```json
{
  "defaultHarness": "claude"
}
```

This file is only read if Pi marks the project trusted and only supports the `defaultHarness` key.

---

## File System Layout

```text
$PI_CODING_AGENT_DIR/pi-flow-external/
  settings.json             # Execution configuration
  roles/                    # User-authored shared role instructions (Markdown)
    security-reviewer.md
  overrides/                # Harness-specific instruction overrides (Markdown)
    claude/reviewer.md
  runs/                     # Local run evidence & logs
```

### Resolution Order
1. **Harness:** Explicit call argument > Trusted project default > Global default > Built-in default (`agy`).
2. **Enablement:** Harness, role, and binding must all be enabled.
3. **Instructions:** `overrides/<harness>/<role>.md` > `roles/<role>.md` > Built-in memory instructions.
4. **Model & Effort:** Binding setting (`harnesses.<harness>.roles.<role>`) > Harness default > CLI native defaults.

### CLI Flags vs. Settings JSON Schema Keys

When setting configuration via the CLI, flags map to settings schema attributes as follows:
- `--effort <level>` sets `"thinking": "<level>"` (values: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `parent`).
- `--budget <usd>` sets `"max_budget_usd": <number>` on role bindings.
- `--tools <list>` sets `"tools": ["..."]` (enforced on named Pi harnesses only).

---

## Session work modes

`/external mode` cycles **Normal → Orchestrator → Frontline Worker → Normal**. Each press selects the next mode without asking for extra arguments.

| Mode | Effect | Status |
|---|---|---|
| Normal (default) | No Flow system-prompt injection; use the agent's own judgment. | No mode indicator |
| Orchestrator | Strong nudge to seek useful delegation and integrate results. | `pi-flow: orchestrator` |
| Frontline Worker | Strong nudge to investigate, execute, and verify directly; delegate when useful. | `pi-flow: frontline-worker` |

Only the short mode prompt is injected. The `pi-flow-orchestration` skill and `external_help` contain detailed methods on demand. These are execution preferences, not restrictions: both modes retain all existing tools, permissions, and user approval rules.

The choice is stored in the session tree and restored from the active branch on resume or navigation. Existing two-state session entries remain readable: enabled restores Orchestrator; disabled restores Normal. No settings-file migration is needed. `/external` and `/external config` still open the settings window.

---

## Full Command Reference

### Harness Management

| Command | Purpose |
|---|---|
| `/external config harness list` | List all harnesses with model, reasoning, preset, and enablement. |
| `/external config harness inspect <harness>` | Inspect effective defaults, origins, and role exceptions. |
| `/external config harness default <harness>` | Set the global default harness. |
| `/external config harness edit <harness>` | Edit one harness configuration block in the standard editor. |
| `/external config harness set <harness> [--model M] [--effort E] [--preset P]` | Set harness defaults. |
| `/external config harness reset <harness> [--model] [--effort] [--preset]` | Reset harness customizations to inherit defaults. |
| `/external config harness enable <harness>` | Enable a harness for execution. |
| `/external config harness disable <harness>` | Disable a harness for execution. |
| `/external config harness create pi-<name> --model <provider/model>` | Register a named Pi in-process harness. |
| `/external config harness delete pi-<name>` | Delete a custom named Pi harness. |
| `/external config harness test <harness>` | Run non-prompt status check or confirmed Pi smoke test. |
| `/external config harness assist` | Interactive interview with smoke-test rollback to register a Pi harness. |

### Role Management

| Command | Purpose |
|---|---|
| `/external config role list` | List all available roles and their enablement status across harnesses. |
| `/external config role inspect <role> [--harness H]` | Inspect role instructions, scalar overrides, and effective authority. |
| `/external config role create <role>` | Author a new shared role in your editor. |
| `/external config role edit <role> [--harness H]` | Edit shared instructions, or harness-specific replacement instructions. |
| `/external config role set <role> --harness H [--model M] [--effort E] [--budget B] [--tools T]` | Set binding-specific execution scalars. |
| `/external config role reset <role> [--harness H] [--instructions]` | Reset role overrides to inherit shared definitions. |
| `/external config role enable <role> [--harness H]` | Enable a role globally or for a specific harness. |
| `/external config role disable <role> [--harness H]` | Disable a role globally or for a specific harness. |
| `/external config role delete <role>` | Delete a custom role globally. |
| `/external config role assist` | Model-assisted role authoring interview. |

### System & Maintenance Commands

| Command | Purpose |
|---|---|
| `/external` and `/external config` | Open interactive guided configuration window. |
| `/external mode` | Cycle the active session through Normal, Orchestrator, and Frontline Worker. |
| `/external config text` | Print effective configuration in any environment. |
| `/external config edit` | Open `settings.json` in `$EDITOR` with validation. |
| `/external config convert` | Preview and execute migration to version 5. |
| `/external doctor` | Validate catalog and verify CLI / Pi provider credentials. |
| `/external runs` | Browse session runs, child logs, diagnostics, and cancellation. |
| `/external runs summary` | Summarize durable run records on disk. |
| `/external runs --prune` | Clean up eligible completed run records beyond retention limits. |

---

## Related Documentation

- **[Harness Reference](harness-reference.md):** Deep CLI flags, sandbox enforcement, and backend constraints.
- **[Migration Guide (v4 → v5)](migration-v4-to-v5.md):** Upgrading from settings v4 to v5.
- **[Troubleshooting](troubleshooting.md):** Resolving configuration conflicts and error diagnostics.
