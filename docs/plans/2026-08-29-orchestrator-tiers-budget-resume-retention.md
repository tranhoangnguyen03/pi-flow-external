# Orchestrator-Decided Tiers, Budget, Resume, and Retention

**Date:** 2026-08-29
**Status:** Phases 1–3 implemented on `feature/orchestrator-tiers`; Phase 4 (live e2e) pending
**Inputs:** Council review (claude-reviewer, codex-reviewer, agy-reviewer runs of 2026-08-29) plus patterns verified in `yorch/pi-harness-delegate` (claude.ts, codex.ts, opencode.ts, config.ts), local CLI checks (`claude --help`, `codex exec --help`), and the official Antigravity headless/sandbox docs (antigravity.google/docs/cli/headless, /docs/cli/sandbox).

**Rule (supersedes the council's error-out recommendation):** never block a launch on tier support. When the orchestrator asks for a tier a harness cannot enforce, run at the closest native approximation and label the truth (`advisory, not enforced`). Trust + disclose; the orchestrator decides.

## Goal

Let the orchestrator (the model driving pi) choose a permission tier and a budget per external call, continue a backend conversation across calls, and keep run records bounded — while keeping the extension's trust-and-disclosure philosophy: the orchestrator is trusted, tiers are enforced by native harness mechanisms (not promises), and every limitation is disclosed in the receipt instead of papered over.

## Non-goals

- No local mid-run budget kills, token-price tables, or token-based budget fallbacks (council: usage arrives only at terminal events on all three backends; price tables drift from billing and fire too late).
- No `--allowedTools` allowlists for Claude tiers (YAGNI; denials are surfaced instead).
- No sandboxing changes, no new record formats, no automatic retries.
- No project-local profiles or templates.

## Feature x harness matrix

Full = native enforcement. Partial = enforced with a real limitation, disclosed. Advisory = instruction only, labeled as such. None = feature unsupported at that layer.

| Feature | claude | codex | agy |
| --- | --- | --- | --- |
| `readonly` tier | **Partial** — `--permission-mode plan`; Bash is auto-denied headlessly, so shell-based exploration degrades; `permission_denials` surfaced in receipt | **Full** — `--sandbox read-only`; governs model-generated shell commands only, not MCP/plugins/hooks (not a confidentiality boundary) | **Advisory** — official docs confirm workspace writes are always auto-allowed in headless; labeled, never blocked |
| `edit` tier | **Partial** — `--permission-mode acceptEdits`; file writes auto-approved, Bash (tests, linters) auto-denied headlessly | **Full** — `--sandbox workspace-write` | **Full** — omit the bypass flag: agy's default headless policy allows workspace writes and soft-denies shell commands (official docs) |
| `danger` tier (default) | **Full** — current `--dangerously-skip-permissions`, root fallback `--permission-mode auto` unchanged | **Full** — switch to single-axis `--sandbox danger-full-access`; drop `--dangerously-bypass-approvals-and-sandbox` so sandbox and bypass flags can never combine | **Full** — current behavior unchanged |
| Budget enforcement (mid-run) | **Full** — native `--max-budget-usd` passthrough (Claude enforces itself; only works with `-p`, which is how we run it) | **None** — no cost field in stream (ChatGPT-plan auth); documented as unenforceable | **None** — usage only in terminal result, never USD |
| Post-run accounting | **Full** — `total_cost_usd` in result event | **Partial** — tokens reported at `turn.completed`; no backend cost on ChatGPT-plan auth, but locally *estimated* from token usage for known models (labeled as an estimate, never as backend-reported) | **Partial** — tokens in terminal result; cost unknown |
| Session resume | **Full** — `--resume <id>`; `--no-session-persistence` becomes conditional (open item A2) | **Full** — `exec resume <id> <prompt> --json`; latch `thread_id` from `thread.started` | **Full** — `--conversation <id>`; `conversation_id` already captured |
| Permission-denial visibility | **Full** — `permission_denials` array in result event, shown as "N permission denials" in receipt | **Partial** — no equivalent field observed; absent, not faked | **Partial** — same |
| Usage stream granularity | Terminal `result` event only | Terminal `turn.completed` only | Terminal `result` event only |

Harness-agnostic features (settings-level, identical on all backends): record retention, settings v2 migration, tier/budget parameter surface on `Agent` + workflow `agent()`.

## Design

### 1. Permission tiers

- New optional `permission: "readonly" | "edit" | "danger"` on the `Agent` tool and workflow `agent()` calls.
- Resolution: **call > profile frontmatter > settings default > `danger`** (today's behavior).
- Tool description nudges the narrowest workable tier; nothing blocks `danger`.
- Backends map tiers onto whatever native mechanism expresses them (the opencode precedent: mechanisms, not flags):
  - claude: permission-mode (`plan` / `acceptEdits` / bypass as today).
  - codex: single-axis `--sandbox` (`read-only` / `workspace-write` / `danger-full-access`).
  - agy: `readonly` → advisory with explicit label `readonly (advisory, not enforced)` (workspace writes are always auto-allowed per official docs). `edit` → omit the bypass flag; agy's default headless policy is a native edit tier (writes allowed, shell soft-denied). `danger` → unchanged.
- Disclosure labels update from a blanket `unsandboxed external CLI` to `external CLI · <tier>` plus, where applicable, the enforcement caveat (Bash-denied on claude plan/acceptEdits; shell-commands-only on codex; advisory on agy).
- Profiles may declare `permission:` in frontmatter as their default tier.

### 2. Budget

- New optional `maxBudgetUsd: number` on calls and workflow children. Default: unlimited.
- Resolution: call > profile > settings `defaultMaxBudgetUsd` (default null).
- claude: pass through as `--max-budget-usd` (native, mid-run, enforced by Claude itself).
- codex/agy: never kill anything; record `maxBudgetUsd` vs reported spend in `summary.json`; receipts say `budget unenforceable (no cost reported)` when the backend reports no cost. Unknown cost is rendered as unknown, never `$0`.

### 3. Session resume

- `summary.json` records the backend session id (claude `session_id` from result event; codex `thread_id` latched from `thread.started`; agy `conversation_id`, already captured).
- New optional `resume` parameter on `Agent`/`agent()` referencing a prior run id; resolves to the stored session id and must match the same backend.
- claude: `--resume <id>`; `--no-session-persistence` becomes conditional — only passed when not resuming. Persistence surface change is documented in README (AGENTS.md already treats persisted transcripts carefully).
- codex: `exec resume <id> <prompt> --json`.
- agy: `--conversation <id>`.
- Resume is orthogonal to workflow replay-cache (which resumes the orchestration script, not a backend conversation).

### 4. Record retention

- Settings `maxRunRecords` (default 200, `0` = keep forever). Sweep at startup and via `/external runs --prune`.
- Prune only **completed** records (`summary.json` present and not marked active); never touch runs still executing; oldest first.

### 5. Settings v2

```json
{
  "version": 2,
  "maxConcurrentSubagents": 12,
  "subagentTimeoutMs": 7200000,
  "defaultPermission": "danger",
  "defaultMaxBudgetUsd": null,
  "maxRunRecords": 200
}
```

- Migrate-on-read, never reject: defaults first, recognized v1 keys override, unknown keys tolerated, invalid JSON falls back to defaults with a warning. Existing precedence unchanged (startup flags > factory > file > defaults).

## Testing (essential-test mandate)

One contract test per behavior at the lowest useful layer:

1. Argv construction per tier/backend (including codex single-axis danger and `-p` budget passthrough).
2. Budget: native passthrough on claude; `budget unenforceable` marking on codex/agy post-run records.
3. Resume: session-id capture per backend from events; resume argv; claude conditional persistence flag; backend-mismatch rejection.
4. Retention: completed-only pruning, active-run preservation, `0` disables.
5. Settings: v1→v2 migrate-on-read (partial, unknown keys, invalid JSON).
6. Receipt labels: tier + advisory + denials-count rendering.

E2E (opt-in, change-triggered): one real run per backend covering tier enforcement (claude readonly denial visible, codex read-only completes, agy sandbox decision), claude budget flag accepted, and a full run→capture-id→resume→assert cycle.

## Open items

- **A1 (resolved, live-verified 2026-08-29):** agy without the bypass flag completes headless runs with `SUCCESS` (shell behavior follows agy's own headless policy; no hang). `edit` is that native policy; `readonly` stays advisory-labeled. `--conversation` resume verified working.
- **A2 (resolved, live-verified 2026-08-29):** Claude `--resume` **fails** after `--no-session-persistence` ("No conversation found with session ID"), so claude runs now always persist sessions in Claude Code's own storage and the flag is removed. Full run → capture id → resume → assert cycle verified; `--max-budget-usd` accepted.
- **A3 (resolved, live-verified 2026-08-29):** Codex `--sandbox danger-full-access` permits out-of-workspace writes (equivalent to the old bypass for our purposes); resume with `--sandbox` before the `resume` subcommand works; `--sandbox read-only` runs complete without hanging.

## Known limitations

- Workflow replay fingerprints hash the script's explicit `permission`/`max_budget_usd`/`resume` values, not the resolved profile/settings defaults. Changing a profile's frontmatter tier (without changing the script) may reuse a cached result. Same class of limitation as profile `model` changes; revisit if it bites.
- Claude `permission_denials` semantics across multi-result background-agent runs are unverified (per-turn vs cumulative); the implementation treats the latest result as authoritative, consistent with text/usage/session handling.
