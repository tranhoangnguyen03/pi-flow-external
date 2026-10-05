# Troubleshooting

Solutions to common issues, authentication questions, and environment quirks when using `pi-flow-external`.

---

## Common Issues & Fixes

### 1. "Settings need attention" or Delegation Blocked
- **Cause:** Settings file is using an older version format (v1–v4) or has JSON syntax errors.
- **Fix:** If older version, run `/external` and choose **Preview format update…**, or run `/external config convert`. If malformed JSON, edit and repair `settings.json` via `/external config edit`.

### 2. Role Unavailable on Selected Harness
- **Cause:** The requested role is disabled or not configured on that specific harness.
- **Fix:** Check availability with `/external config role inspect <role> --harness <harness>`. If disabled, enable with `/external config role enable <role> --harness <harness>`.

### 3. Harness Disabled or Inactive Default
- **Cause:** The default harness was disabled or has no valid configuration.
- **Fix:** Enable it via `/external config harness enable <harness>`, or choose a new default with `/external config harness default <harness>`.

### 4. CLI Available but Authentication Fails
- **Cause:** External CLIs and Pi manage credentials independently.
- **Fix:** Verify host login directly in your terminal:
  - Claude: `claude login`
  - Codex: `codex login`
  - Grok: `grok login` or set `XAI_API_KEY`
  - OpenCode: `opencode auth login`
  Run `/external doctor` to inspect diagnostic status.

### 5. Model Missing from Picker
- **Fix:** In `/external`, select **Enter a custom model ID…** to enter unlisted models. For named Pi harnesses, register the model in Pi's registry first.

### 6. Claude Rejects `--dangerously-skip-permissions` Under Root
- **Cause:** Claude Code refuses bypass flags when running as UID 0.
- **Fix:** Current extension versions automatically map root runs to `--permission-mode auto`. Update to the latest release if you encounter this.

### 7. Child Agent Cannot Find the Repository
- **Cause:** Nested subagents or CLIs may launch in a separate working directory.
- **Fix:** Always include absolute paths in briefings (e.g. `prompt: "Audit /absolute/path/to/repo"`).

### 8. Child Missing Earlier Conversation Context
- **Fix:** Explicitly pass conversation turns using `context`:
  ```ts
  Agent({ role: "reviewer", context: { mode: "recent", turns: 5 }, prompt: "..." })
  ```

### 9. Workflow Rejected Before Launch
- **Cause:** Missing or invalid `meta.apiVersion`.
- **Fix:** Ensure the first statement in your script is `export const meta = { apiVersion: 1, name: "...", description: "..." };`.

### 10. Run Shows `interrupted_or_uncertain`
- **Cause:** Host process exited or was killed before terminal outcome confirmation.
- **Fix:** Evidence is preserved in `~/.pi/agent/pi-flow-external/runs/<run-id>/`. The extension never re-attaches to dead sessions; start a new run or replay the workflow.

### 11. Sensitive Content Appears in Evidence
- **Fix:** Remove the run folder under `~/.pi/agent/pi-flow-external/runs/<run-id>/`. Local redaction is best-effort and does not replace filesystem security.

---

## Third-Party UI Compatibility: `pi-cc` / `ccstyle`

If using [`pi-cc-extensions`](https://www.npmjs.com/package/pi-cc-extensions), its default rendering overrides can cause `workflow` and `wait` progress cards to show a generic `Pending…` message.

### Resolution
Add `pi-flow-external` tool names to `excludeRenderers` in `~/.pi/agent/pi-cc-extensions.json`:

```json
{
  "excludeRenderers": ["Agent", "workflow", "external_runs"]
}
```

Restart Pi after saving. This preserves native live progress cards while retaining `pi-cc` styling for other tools.

---

## Related Documentation

- **[Configuration Reference](configuration-reference.md):** Settings schema and CLI management commands.
- **[Harness Reference](harness-reference.md):** Verifying CLI installations and sandbox prerequisites.
- **[Migration Guide (v4 → v5)](migration-v4-to-v5.md):** Step-by-step recovery and conversion instructions.
