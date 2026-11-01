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
This release converts only settings version 4. If your installation is v1, v2, or v3 (or still has `harnesses.json`, seed markers, or extension profiles under `subagents/`), delegation stays blocked with a message naming the last converting release. This release does not read, convert, or modify those files.

1. Install the last converting release:
   ```bash
   pi install npm:@tranhoangnguyen0310/pi-flow-external@5.5.0-external.2
   ```
2. Start Pi and run `/external config convert`. The first run converts pre-v4 files to v4 and keeps the originals; run it again to preview and apply v4 → v5.
3. Upgrade to the current release:
   ```bash
   pi install npm:@tranhoangnguyen0310/pi-flow-external
   ```

Legacy files left behind after conversion are ignored. Delete them yourself if you want; the extension no longer ships a purge command.

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

## Related Documentation

- **[Configuration Reference](configuration-reference.md):** The settings v5 schema and command interface.
- **[Troubleshooting](troubleshooting.md):** Common errors and conversion diagnostics.
- **[Documentation Index](README.md):** Directory map of all guides and contracts.
