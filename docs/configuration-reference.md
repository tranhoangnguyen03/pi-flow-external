# Configuration Reference

This guide covers advanced configuration, the interactive settings window, JSON schema, inheritance rules, and the complete command-line interface for `pi-flow-external`.

---

## Interactive Settings Window (`/external`)

Running `/external` or `/external config` in terminal (TUI) or RPC mode opens the guided settings modal.

### Menu Navigation

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
| `/external` | Open interactive guided configuration window. |
| `/external config text` | Print effective configuration in any environment. |
| `/external config edit` | Open `settings.json` in `$EDITOR` with validation. |
| `/external config convert` | Preview and execute migration to version 5. |
| `/external doctor` | Validate catalog and verify CLI / Pi provider credentials. |
| `/external runs` | Browse session runs, child logs, diagnostics, and cancellation. |
| `/external runs summary` | Summarize durable run records on disk. |
| `/external runs --prune` | Clean up eligible completed run records beyond retention limits. |
| `/external [danger]purge-old-files` | Preview and delete legacy v1–v4 migration remnants. |

---

## Related Documentation

- **[Harness Reference](harness-reference.md):** Deep CLI flags, sandbox enforcement, and backend constraints.
- **[Migration Guide (v4 → v5)](migration-v4-to-v5.md):** Upgrading from settings v4 to v5 and running safe file purges.
- **[Troubleshooting](troubleshooting.md):** Resolving configuration conflicts and error diagnostics.
