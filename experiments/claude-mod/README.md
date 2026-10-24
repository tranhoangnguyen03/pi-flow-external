# [experimental] Claude Code Mod → Codex

Tracks [issue #96](https://github.com/tranhoangnguyen03/pi-flow-external/issues/96).

One **read-only** Codex exploration job launched from Claude Code, with a stable run ID, local receipt, inspection, cancellation, collection and a completion toast. Does not change any existing Pi extension code.

## Local run

Requires Node.js 22+, Claude Code with Mods (2.1.287+), authenticated `claude` and `codex` CLIs. From this repository root:

```sh
node --test experiments/claude-mod/tests/*.test.mjs
claude plugin validate ./experiments/claude-mod
claude --plugin-dir ./experiments/claude-mod
```

Inside Claude:

```text
/external start Map the README and main entry points. Return file paths and a short summary.
/external runs
/external inspect run_<id>
/external collect run_<id>
/external cancel run_<id>
```

Claude may also call the Mod's `delegate` and `runs` tools. Tell it to delegate to Codex, continue independent work, then collect the result. It must not treat a launch receipt as a finished task.

## Design and restrictions

- `hooks/register.js` is the Claude session/UI adapter; `runner/cli.mjs` is a standalone Node process supervisor. Hook code uses only Mods APIs.
- Every launch fixes `--sandbox read-only`, `--json` and `--skip-git-repo-check`, mirroring the permission/CLI pattern used in `src/core/codex.ts` and `src/core/permissions.ts`. The shell sandbox governs Codex tool commands, not arbitrary external plugins/MCP/hooks; don't assert OS-wide read-only.
- Task prompt goes over stdin. No conversation is inherited. Role explorer; workspace is Claude's current directory. No shell interpolation.
- Runner records live beneath `~/.pi/agent/pi-flow-external/claude-mod/runs/` by default (`FLOW_CLAUDE_RUNS_DIR` overrides). It stores the task prompt, event previews, final answer and diagnostics; protect as sensitive data.
- `session.end` attempts to cancel active workers. A crashed Claude process does **not** guarantee cleanup. Detached workers and receipt files may survive; this prototype does not adopt jobs across restarts.
- Completion delivery is a UI toast once the Mod observed an active run and then a terminal transition. No automatic model wake/prompt injection yet. Inspect or collect to bring results to the agent.
- The protocol uses short `$.process.run` calls for launch/inspect/cancel; the Node helper runs Codex independently.
- **Not live-validated in Claude Code or Codex here.** Check plugin validation, CLI compatibility, process cancellation and `import.meta.url` resolution on the installed host. No full Flow workflow parity is claimed.
- The runner is a **bounded spike**, not a copy of Flow's production process supervisor. Production reuse/refactor is a decision for after successful trial.

## Tests

The offline Node tests use a fake `codex` binary through `FLOW_CLAUDE_CODEX_BIN`, assert a canonical result and session ownership, and check bad input. They do not incur model calls. Live trials must separately cover inspection, cancellation and session end.

Do not merge until reviewed and live tested.
