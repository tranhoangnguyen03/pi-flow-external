# Essential external field testing

Real-provider checks consume tokens and normally run external CLIs in dangerous/no-approval modes. Claude uses `auto` permission mode instead when its effective UID is 0. Use them only in a trusted checkout. Receipts can contain prompts and source excerpts despite best-effort redaction.

`npm run e2e` has two lanes. The default lane is deterministic and root-model-free: it builds an in-process Pi SDK session with a faux, never-prompted root model and calls the `Agent`/`workflow`/`external_runs` tool executors directly, so tool selection is never left to a live LLM decision — only the selected external backend's own child call (a real spawned CLI process, or, for `--backend pi`, a real in-process nested Pi child) is real. `--routing-smoke` is a separate, explicit lane that spawns a real `pi` CLI process with a real root model and asks it, in plain language, to pick the right tool; see [Natural-language routing smoke](#natural-language-routing-smoke) below. Only `--routing-smoke` needs root Pi authentication or `--root-model`/`--root-thinking`.

## Preparation

```bash
cd /path/to/pi-flow-external
claude --version
codex --version
agy --version
grok --version
```

The default lane needs no root Pi authentication at all (its root model is a faux, never-prompted placeholder). Only `--routing-smoke` needs a working root model:

```bash
export PI_CODING_AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
export ROOT_MODEL="openai-codex/gpt-5.6-sol"
pi auth check --model "$ROOT_MODEL" --json
```

Root Pi authentication is separate from each delegated CLI.

## Direct backend receipt

Run only the backend affected during development:

```bash
npm run e2e -- --backend claude
npm run e2e -- --backend codex
npm run e2e -- --backend agy
npm run e2e -- --backend grok
```

Each run creates a collision-safe (`randomUUID`-named) temporary profile and fixture in an isolated agent directory, calls the `Agent` tool executor directly with an explicit `role`/`harness`, requires the exact expected result in the child's real result, checks for one complete `done` receipt, verifies that the fixture stayed clean, and removes its temporary files. Isolation is unconditional: for every backend above, an inherited `PI_CODING_AGENT_DIR` (such as the one exported in [Preparation](#preparation)) is ignored unless you pass `--agent-dir` explicitly — only `--backend pi` and `--routing-smoke` ever default to your real agent directory, since they only read it and never write into it.

Defaults:

| Lane | Model | Thinking |
|---|---|---|
| Claude | `claude-sonnet-5` | `high` |
| Codex | `gpt-5.6-sol` | `high` |
| Agy | `gemini-3.7-flash-high` | `high` |
| Grok | `grok-4.6` | `high` |

Override with `--model`/`--thinking`. Use `--keep` only when evidence inspection is necessary; it preserves sensitive output and the temporary profile path printed by the runner.

Grok's `readonly`/`edit` tiers run under its own kernel sandbox (`--sandbox read-only`/`workspace`). On a macOS host where `/var/run/docker.sock` resolves to a symlink, sandbox startup can fail closed before the child even runs the prompt — that is expected fail-closed behavior, not a bug; verify enforcement on Linux, or adjust the host's Docker socket if you need to reproduce it locally on macOS.

### Named Pi harness receipt

Run only when the pi runtime contract (§7 of the design), harness registry, or canonical role synthesis changes, and only if you have already registered a real `pi-*` harness in your own `harnesses.json` with real credentials configured:

```bash
npm run e2e -- --backend pi --harness pi-deepseek
```

This lane reads your real agent directory (harnesses.json, subagents) but never writes a temporary profile there — canonical synthesis already provides the `worker` role for any registered harness — and never mutates it: the faux root model is registered only in-process, and the harness's own real model/auth resolve normally through your real `models.json`/`auth.json`. It delegates to the harness you name and requires the same one complete `done` receipt.

## Supervised workflow receipt

When workflow runtime, scheduling, supervision, or tool integration changes, run the affected backend; run all three before release:

```bash
npm run e2e -- --backend claude --workflow
npm run e2e -- --backend codex --workflow
npm run e2e -- --backend agy --workflow
npm run e2e -- --backend grok --workflow
npm run e2e -- --backend pi --harness pi-deepseek --workflow
```

Each command calls the `workflow` tool executor directly with a script declaring `meta.apiVersion: 1` and running two parallel `agent()` calls, blocking (`background: false`) rather than supervised through `external_runs` — workflow execution itself is what's under test here, not run-observability ceremony (the change-triggered background-run observability check below covers that separately). It requires the workflow to complete with two `done` child receipts, both results containing the expected token, and the read-only fixture staying clean.

## Change-triggered interruption and output check

When adapter cancellation, process-tree termination, partial output, or supervision changes, run the affected backend:

```bash
npm run e2e -- --backend claude --interrupt
npm run e2e -- --backend codex --interrupt
npm run e2e -- --backend agy --interrupt
npm run e2e -- --backend grok --interrupt
```

The runner calls the `Agent` tool executor directly with `background: true`, polls `external_runs` until the run is observed `running`, cancels its stable ID with an explicit reason, waits for its `cancelled` outcome, and asks `external_runs` for every available output and diagnostic page. A very early cancellation may legitimately have diagnostics but no assistant text; the durable receipt must still be `aborted` with the exact reason. Do not retry a failure automatically. Use `--keep` for one deliberate evidence inspection, then remove the printed run root and temporary profile.

## Natural-language routing smoke

There are two levels of routing check:

- `npm run e2e -- --routing-smoke --backend <claude|codex|agy|grok>` (optionally `--workflow`/`--interrupt`) spawns a real `pi` CLI process with a real root model and gives it a single plain-language instruction naming the exact tool, role, and harness to call. It is a mechanical, automated check that the natural-language call-and-relay path (real root LLM → real tool call → real backend child) still works end to end. It requires real root Pi authentication (see Preparation) and is opt-in only — never the default backend gate — because the root model's tool-call decision is a live, provider-billed, non-deterministic step. `--root-model`/`--root-thinking` only apply here.
- The broader, still-manual qualitative check below covers *discovery*, not just one named call: when role discovery, tool descriptions, or coordinator guidance changes, run three fresh Pi sessions against the current checkout and a read-only fixture. Ask for two named harnesses to review, two named harnesses to research, and a task split between Pi plus two named harnesses. For each session, verify that each requested external harness produced one complete `done` receipt through `role` plus `harness`, no help/discovery call was needed for the built-in roles, and the fixture stayed unchanged.

Neither is a statistical regression comparison or a model-independent guarantee. Neither covers workflow routing or the omitted-`harness` default; use the workflow receipt above and a separate direct role request without `harness` for those paths.

## Change-triggered nested timeout check

Run a real nested-agent timeout scenario only when nested-event detection or timeout-extension code changes. Use an Agy profile that invokes one native subagent, set a short bounded timeout, and verify the latest `summary.json`:

```bash
jq -e '.summary.status == "done" and
  .summary.nestedActivitySeen == true and
  .summary.nestedTimeoutExtended == true and
  .summary.effectiveTimeoutMs > .summary.configuredTimeoutMs' \
  "$PI_FLOW_EXTERNAL_RUNS_DIR"/run_*/summary.json
```

## Change-triggered context transfer check

Run only when parent-context selection or serialization changes. In one fresh Pi session against a read-only fixture, delegate once with `context: { mode: "recent", turns: 1 }` and verify the child still returns the expected marker, the run has one complete `done` receipt, and that `summary.json` reports the matching `context` block:

```bash
jq -e '.summary.context.mode == "recent" and .summary.context.requestedTurns == 1 and .summary.context.sharedTurns >= 1' \
  "$PI_FLOW_EXTERNAL_RUNS_DIR"/run_*/summary.json
```

Local fixture tests own selection, boundary, and failure behavior; this check only proves a real backend tolerates the transferred block.

Do not run damaged-record and expected-failure provider scenarios manually. Their behavior is deterministic and belongs in the local fixture tests.

## Change-triggered background-run observability check

Run only when batch inspection, the `final` view, timing projection, or `/external runs` browsing changes. In one fresh Pi session against a read-only fixture:

1. Launch two independent `Agent({ ..., background: true })` calls back to back (do not wait on either), then do one unrelated piece of parent work (e.g. read a file) before checking on them — this exercises the actually-recommended usage shape (separate launches, other work in between), not a tight launch-then-immediately-inspect loop.
2. Call `external_runs({ action: "inspect", runIds: [<first>, <second>] })` once and confirm both come back as one bounded batch of `summary` projections (queued/running/terminal, `outputRef`/`diagnosticsRef` per entry) without waiting for either to finish.
3. After both children are confirmed terminal (`external_runs wait` or a later `inspect`), call `external_runs({ action: "inspect", runId: <runId>, view: "final" })` for a completed run and confirm it returns only the verified canonical answer; for a run cancelled mid-flight (or inspected before it settles), confirm the tool response reports `finalAvailable: false` with a deliberately empty, bounded projection (`items: []`, `integrity: "incomplete"`) rather than a fabricated success — this empty shape is correct at the tool layer, not a bug. The human-readable explanation ("No verified final answer is available yet for `<runId>`.") is a separate, UI-only notice that `/external runs` shows when Final is selected on an unsettled run; the tool response itself stays narration-free by design.
4. Run `/external runs`, open the list, and manually select `Refresh`: confirm it re-reads the first page and resets any list cursor without navigating into a run or waiting/polling. Select a still-running row and confirm its queue/elapsed timing and final-availability marker are present and update only when you refresh again (never on a timer).

Local fixture tests already cover batch pagination/cursor/byte-limit edge cases, the `final` view's success/unavailable/legitimate-null shapes, and `Refresh`'s cursor-reset behavior deterministically; this check only proves the real backend/registry timing (queued→running, activity age, terminal settlement) matches what those fixtures assume.

## Change-triggered project default-harness check

Run only when project default-harness resolution changes. In a fresh Pi session against a trusted read-only fixture containing `.pi/pi-flow-external/settings.json` with `"defaultHarness": "claude"`, verify `/external settings` reports `defaultHarness: claude (project: ...)`, delegate one read-only task with `role` only (no `harness`) and verify the receipt names a `claude-*` profile, then confirm an explicit `harness: "codex"` call still routes to codex. Repeat once in the same fixture with trust removed and confirm the override is ignored with a warning.

## Release minimum

Before a runtime release:

1. Run `npm run check`.
2. Run all four direct backend receipts.
3. Run all four supervised workflow receipts.
4. Run interruption checks for adapters whose cancellation/output path changed.
5. Run `--routing-smoke` (mechanical) and the manual qualitative routing smoke only if role discovery, tool descriptions, or coordinator guidance changed.
6. Run the nested timeout check only if nested detection or timeout behavior changed.
7. Run the background-run observability check only if batch inspection, the `final` view, timing projection, or `/external runs` browsing changed.
8. Remove temporary evidence and profiles.
