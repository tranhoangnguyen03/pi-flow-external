# Migration Guide: Upgrading to Settings Version 5

This guide covers converting older settings (v1–v4) to the version 5 format and cleaning up legacy migration files.

---

## Why Version 5?

Settings version 5 introduces:
- A unified settings catalog (`settings.json`) replacing disparate profile markers.
- Sparse role inheritance (harness defaults apply to all roles unless explicitly overridden).
- Symmetric lifecycle commands under `/external config harness` and `/external config role`.
- Strict execution boundaries without silent fallbacks.

---

## Converting to Version 5

If you have an existing v4 installation, the extension blocks delegation until settings are converted.

### Automatic Conversion Flow

1. Run `/external` in chat or terminal.
2. The window opens to **Settings need attention**.
3. Select **Preview format update…** (or run `/external config convert` from the command line).
4. Review the migration preview. The converter will:
   - Create an immutable backup at `settings.v4.backup.json`.
   - Migrate custom role instructions to `roles/` and `overrides/<harness>/`.
   - Migrate model and reasoning overrides into sparse JSON objects in `settings.json`.
   - Preserve disabled scopes and compatibility selectors.
5. Confirm the conversion. Settings version 5 is activated immediately.

### Upgrading from Pre-v4 Versions
If your installation is v1, v2, or v3:
- The first run of `/external config convert` upgrades your legacy files to v4.
- Running `/external config convert` a second time previews and applies the v5 upgrade.
- Existing legacy files are preserved throughout this process.

---

## Replaced Commands Mapping

The following older command routes have been replaced:

| Deprecated Command | Current Replacement |
|---|---|
| `/external` *(plain text output)* | `/external` opens interactive TUI/RPC; `/external config text` prints overview |
| `/external config` *(plain text)* | `/external config` opens interactive TUI/RPC; `/external config text` prints settings |
| `/external config harnesses` | `/external config harness list` |
| `/external config enable\|disable\|default <name>` | `/external config harness enable\|disable\|default <name>` |
| `/external config harness create` *(interview)* | `/external config harness assist` (interactive) or `/external config harness create` (direct) |
| `/external roles` | `/external config role list` |
| `/external role create <name>` | `/external config role create <name>` or `/external config role assist` |
| `/external role inspect <role> [harness]` | `/external config role inspect <role> [--harness <harness>]` |
| `/external role override <role> <harness>` | `/external config role edit <role> --harness <harness>` (instructions)<br>`/external config role set <role> --harness <harness>` (scalars) |

---

## Optional: Purging Legacy Files

Once version 5 is active and verified, you can optionally remove legacy files that are no longer used:

```bash
/external [danger]purge-old-files
```
*(Note: The brackets and the word `danger` are part of the command syntax).*

### What the Purge Tool Scans:
- **Legacy Seeded Profiles:** The original 30 markdown profiles under `subagents/` (e.g. `claude-explorer.md`, `codex-reviewer.md`).
- **Legacy Custom Profiles:** Markdown files with harness prefixes declaring external backends.
- **Legacy Seed Markers:** `.pi-flow-defaults-seeded-v1`, `v2`, and `v3`.
- **Old Harness Registry:** `pi-flow-external/harnesses.json`.

### Safety Guarantees:
- The purge tool **never** deletes current `settings.json`, `roles/`, `overrides/`, or active run records.
- Nothing is preselected; you toggle each file individually and confirm.
- Downgrading after a purge requires your own backup of the deleted files.

---

## Related Documentation

- **[Configuration Reference](configuration-reference.md):** The settings v5 schema and command interface.
- **[Troubleshooting](troubleshooting.md):** Common errors and conversion diagnostics.
- **[Documentation Index](README.md):** Directory map of all guides and contracts.
