# Prep: grok-cli as a fourth external backend

> Investigation notes for adding xAI's Grok Build CLI (`grok`) alongside claude/codex/agy.
> Original investigation reports installed `grok 1.0.40` (help text + live headless run) and
> https://github.com/xai-org/grok-build docs (user-guide 14/16/18/22).
> Follow-up independently checked local code, CLI help/version, and sandbox startup only;
> original live-event/auth/cost claims below have not been independently reproduced.

## Follow-up corrections (take precedence over proposals below)

- **Seeding:** do not simply bump v1 to v2 and seed all missing profiles. That resurrects
  deliberately deleted profiles. On an existing v1 installation, seed only the six new
  grok profiles; on a fresh installation seed the full roster. Test migration preservation.
- **Profile parsing is not generic:** `src/profiles.ts:parseBackend` has a hardcoded
  backend allowlist in addition to `EXTERNAL_HARNESSES`; update both.
- **Read-only sandbox currently fails on this Mac:** `grok --sandbox read-only version`
  exits 1 because `/var/run/docker.sock` resolves to a symlink. Workspace startup succeeds.
  Preserve fail-closed behavior; do not silently downgrade to advisory/tool-only restrictions.
  Any alternative tier mapping needs separate verification and accurate disclosure.
- **Danger must explicitly select `--sandbox off`:** help documents `GROK_SANDBOX`;
  omitting the sandbox flag does not reliably override inherited configuration.
- **Final output:** concatenating every `text` delta risks promoting intermediate narration
  to canonical final. Verify multi-turn message boundaries before choosing the wire format.
  Help also exposes `streaming-messages-json` with whole messages and optional partials;
  investigate that before inventing text-reset heuristics.
- **Durable output:** `run-inspection.ts:outputFromEvent` is stateless. Delta aggregation
  belongs in its existing paging/assembly path, not in a per-event extractor. Final view
  must continue to consume the verified canonical receipt, not reconstruct success.
- **Structured output remains unresolved:** help says `--json-schema` implies JSON output;
  determine actual flag precedence and payload shape before committing to NDJSON parsing.
- **Terminal semantics remain unresolved:** do not accept max-token/max-turn stops as success
  merely because text exists. Verify the CLI's completion semantics first.
- No adapter line-count target, new dependency, generic runner refactor, or release bump is
  required for preparation. Adapter scope should follow verified protocol requirements.

## Ground truth: the `grok` CLI headless contract

- Binary `grok` (official xAI "Grok Build", Rust; `curl -fsSL https://x.ai/cli/install.sh | bash`). Auth: `grok login` (browser/device) or `XAI_API_KEY`. Sessions in `~/.grok/sessions`.
- Headless: `-p <PROMPT>` or `--prompt-file <PATH>` (**no stdin**; use a temp prompt file like codex's schema file). Working dir: spawn `cwd` (also `--cwd`).
- Output: `--output-format streaming-json` (xAI-native NDJSON). `--json-schema '<json>'` (inline schema, implies `--output-format json`) for structured output; result object carries `structured_output` (verify field live at impl time).
- Models: `-m grok-4.6` (default) / `grok-4.5`; `grok models` lists. Thinking: `--reasoning-effort none|minimal|low|medium|high|xhigh|max` (map Pi `off`→`none`; pass the rest through).
- System prompt: `--system-prompt-override <TEXT>` (argv, same pattern as codex `-c developer_instructions`). `--rules <TEXT>` appends instead.
- Resume: `--resume <sessionId>`; sessionId comes from the `end` event (`--session-id` is new-session-UUID only). `--fork-session` exists.
- Exit codes: 0 ok, 1 error, 130 SIGINT, 143 SIGTERM. Update checks auto-suppressed on non-TTY stderr; `--no-auto-update` also works.

### streaming-json events (observed live)

```
{"type":"available_commands","tools":[...],"commands":[...]}   # chatty, repeats; skip
{"type":"thought","data":"..."}                                # optional activity
{"type":"tool_call","toolCallId":"...","title":"Read","kind":"read","status":"in_progress","toolName":"read_file","rawInput":{...}}
{"type":"tool_call_update","toolCallId":"...","status":"completed","rawOutput":{...}}
{"type":"text","data":"OK"}                                    # accumulate -> final result
{"type":"usage","usage":{"input_tokens":18478,"cache_read_input_tokens":192,"cache_creation_input_tokens":0,"output_tokens":117,"reasoning_tokens":116}}
{"type":"end","stopReason":"end_turn","sessionId":"<uuid>","requestId":"...","usage":{...,"total_tokens":18787},"num_turns":1,"total_cost_usd":0.0128,"total_cost_usd_ticks":128363600,"modelUsage":{...}}
{"type":"error","message":"..."}                               # non-zero exit
```

- `end` is always last. Terminal success = `end` observed + exit 0 + non-empty accumulated `text`. `end.stopReason` ∈ end_turn, max_tokens, max_turn_requests, refusal, cancelled — treat refusal/cancelled as failure, accept end_turn (and max_* with non-empty text) after live check.
- Token buckets are disjoint; `input_tokens` is **uncached only**. `total_cost_usd` present only when the server reported complete cost (present in our OAuth-pool test run) — else `costKnown: false`. No budget feature at all → `budgetEnforceable: false` (codex pattern).
- Nested agents: tool name `spawn_subagent` (docs 16). **Not** in spawn.ts `isNestedToolName` list — add it.

### Permissions + sandbox (docs 18/22, verified flags)

- `--permission-mode default|acceptEdits|auto|dontAsk|bypassPermissions|plan`; `--always-approve`/`--yolo` = bypassPermissions. Headless default-mode prompts are unanswerable → automation always pairs bypass with a sandbox for lower tiers.
- `--sandbox off|workspace|devbox|read-only|strict` — kernel-enforced (Seatbelt macOS / Landlock Linux). Sandbox bounds even approved tool calls.
  - `read-only`: read everywhere; writes only `~/.grok` + tmp; child network blocked (Linux only — macOS no-op).
  - `workspace`: writes CWD + `~/.grok` + tmp; network allowed.
- `--allow/--deny <RULE>` (Bash(git *)/Read(src/**)/WebFetch(domain:...)/MCPTool(...)); deny always wins.
- Project AGENTS.md/permission rules need folder trust (`--trust` or prior grant); untrusted ⇒ sources skipped, not an error. `--trust` is absent from 1.0.40 `--help` — test before relying on it.
- Tool ids (for `--tools` allowlists): `read_file, list_dir, grep, search_replace, write, run_terminal_command, web_search, web_fetch, spawn_subagent, ...`

### Proposed tier mapping (all enforced; no execution-lane danger floor needed)

| tier | argv | note |
|---|---|---|
| readonly | `--sandbox read-only --permission-mode bypassPermissions` | kernel write-block; disclose macOS network no-op |
| edit | `--sandbox workspace --permission-mode bypassPermissions` | codex workspace-write analogue |
| danger | `--permission-mode bypassPermissions` | sandbox off (default) |

Unlike claude/pi, grok's edit tier keeps shell access (sandboxed), so `resolveEffectivePermissionTier` needs **no** grok branch. `permissionLabel` generic path works; caveats: readonly → "kernel sandbox; writes blocked (network block Linux-only)", edit → "kernel sandbox; writes limited to workspace".

## Repo touchpoints

Central choke point: `EXTERNAL_HARNESSES = ["agy","claude","codex"]` (src/types.ts:5). Insert `"grok"` (alphabetical). Most surfaces iterate it generically.

Backend-specific work:
1. **src/core/grok.ts** (NEW, ~450 lines) — mirror codex.ts: `buildGrokArgs`, `parseGrokJsonLine`, `extractGrokUsage`/`extractGrokSessionId`/`extractGrokFinalText`(accumulate text events)/`extractGrokError`, `grokActivityFromEvent` (tool_call/tool_call_update previews; skip available_commands/thought), `spawnGrokSubagent`. Prompt via temp `--prompt-file` (mkdtemp pattern already in codex.ts for schemas). Oversize/abort/process-tree/BoundedBuffer scaffolding identical to codex.ts. No retry (agy-only contract). Cost: `end.total_cost_usd` → `costKnown` native (not estimated).
2. **src/core/permissions.ts** — `resolvePermission` grok case (enforced: true + sandbox caveats); `buildPermissionArgs` grok case per table above.
3. **src/core/spawn.ts** — dispatch branch (codex-like; no maxBudgetUsd pass-through); `hasNestedAgentActivity` grok case (`type==="tool_call" && isNestedToolName(toolName)`); add `"spawn_subagent"` to `isNestedToolName`.
4. **src/core/display.ts** — `getBackendAgentLabel` grok → label (pick: "Grok CLI" vs official "Grok Build").
5. **src/core/run-inspection.ts** — `outputFromEvent` (accumulate `text`, `end`) + activity grok cases. Do **not** repeat the known pi gap (failed durable paging returning empty output).
6. **src/defaults.ts** — `DEFAULT_BACKENDS += "grok"`, `BACKEND_LABELS.grok`, bump `SEED_MARKER` v1→v2 so upgrades seed 6 new `grok-*` profiles (18→24 files).
7. Copy mentions: `src/prompts.ts` (lines 6, 95), `src/pi-subagent.ts` (lines 77, 86, 158 SUBAGENT_BACKENDS, 355 tool description), `src/external-help.ts` (line 26 harness filter, HARNESS_PERMISSIONS note), `src/profile-creator.ts` (interview line 46 "claude, codex, or agy"). Smoke test is generic (routes through spawnSubagent) — auto works.

Generic (free via EXTERNAL_HARNESSES): settings/defaultHarness validation, profile legitimacy + role resolution, workflow roster freeze + replay fingerprints, `/external doctor` (`grok --version`), external-runs surfaces, subagent-render budget note (already `!== "claude"`).

Scripts/tests/docs:
8. `scripts/e2e/external.mjs` — `defaults.grok = { model: "grok-4.6", thinking: "high" }`; error/help text.
9. `package.json` — description + keywords (+ CHANGELOG section, release label per repo rules).
10. NEW `test/grok-backend.test.ts` — mirror codex-backend.test.ts coverage: args build, cost from end, final-text accumulation, terminal-event requirement (no success without `end`), abort kills child, oversize stdout line, unknown-model cost absent, session-id capture for resume.
11. Existing tests asserting exact triples/counts: `test/defaults.test.ts` (18→24), permissions, profiles, settings, run-inspection, agent-rendering, resume-retention, external-command, external-help, spawn-observation, field-report, profile-creator, workflow.
12. Docs: README (backend mentions + permission table), AGENTS.md, CONTEXT.md, ARCHITECTURE_SNAPSHOT.md.

## Verification plan

- `npm run check` (tsc + vitest offline, mocked `grok` binary).
- Real: `npm run e2e -- --backend grok` (+ `--workflow`), then `--backend grok --model grok-4.5` sanity; follow docs/field-testing.md.
- Live spot-checks at impl time: `--json-schema` + structured_output field on the `json` object; `--trust` presence/need; `end.stopReason` on a max-turns run; readonly sandbox on this machine (Seatbelt).

## Open choices (defaults picked, confirm if you care)

- Harness key: `grok` (matches binary, like claude/codex/agy). Display label: **Grok CLI** (README already says "Grok CLI" style for others; official product name is "Grok Build").
- e2e default model `grok-4.6`, thinking `high` (maps to `--reasoning-effort high`).
