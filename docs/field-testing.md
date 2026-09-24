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
muse --version
opencode --version
```

The default lane needs no root Pi authentication at all (its root model is a faux, never-prompted placeholder). Only `--routing-smoke` needs a working root model:

```bash
export PI_CODING_AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
export ROOT_MODEL="openai-codex/gpt-5.6-sol"
pi auth check --model "$ROOT_MODEL" --json
```

Root Pi authentication is separate from each delegated CLI.

## Direct backend receipt

A runtime release runs all six direct receipts: `agy`, `claude`, `codex`, `grok`, `muse`, and `opencode`. During development, also run the backend you changed:

```bash
npm run e2e -- --backend claude
npm run e2e -- --backend codex
npm run e2e -- --backend agy
npm run e2e -- --backend grok
npm run e2e -- --backend muse
npm run e2e -- --backend opencode --model <provider/model>
```

Each run creates a collision-safe (`randomUUID`-named) temporary fixture in an isolated agent directory, calls the `Agent` tool executor directly with an explicit `role`/`harness`, requires the exact expected result in the child's real result, checks for one complete `done` receipt, verifies that the fixture stayed clean, and removes its temporary files. Isolation is unconditional: for every backend above, an inherited `PI_CODING_AGENT_DIR` (such as the one exported in [Preparation](#preparation)) is ignored unless you pass `--agent-dir` explicitly — only `--backend pi` and `--routing-smoke` ever default to your real agent directory, since they only read it and never write into it. These isolated runner files are not the product catalog. A normal session start still writes zero role files under the user's `subagents/` directory.

Defaults:

| Lane | Model | Thinking |
|---|---|---|
| Claude | `claude-sonnet-5` | `high` |
| Codex | `gpt-5.6-sol` | `high` |
| Agy | `gemini-3.7-flash-high` | `high` |
| Grok | `grok-4.6` | `high` |
| Muse | `muse-spark-1.3-contributor` | `high` |
| OpenCode | Its configured default; use `--model provider/model` to pin | Not forwarded; explicit pins rejected |

Override with `--model`/`--thinking`. Use `--keep` only when evidence inspection is necessary; it preserves sensitive output and the temporary path printed by the runner.

Grok's `readonly`/`edit` tiers run under its own kernel sandbox (`--sandbox read-only`/`workspace`). Grok 1.0.40 on macOS can refuse startup with `sandbox could not be applied: socket deny resolution failed: could not resolve runtime-socket deny path /var/run/docker.sock: endpoint is a symlink`. This is an upstream CLI/environment incompatibility, not proof that the adapter's sandbox flags are wrong. The failed receipt retains the diagnostic and requested permission metadata; the adapter never retries with sandbox off. Do **not** remove or alter the Docker socket as a runner workaround. Verify sandbox enforcement on a compatible host or check a newer Grok version with an actual sandboxed invocation, not just `--help`. An explicitly requested `danger` run has no OS isolation and does not validate readonly delegation. Track compatibility and any confirmed upstream fix in [#61](https://github.com/tranhoangnguyen03/pi-flow-external/issues/61); no fixed upstream version has been verified.

Muse Code 1.3.0 accepts `none` in help text but its `meta` provider rejects `--reasoning-effort none`. Effective `thinking: off` (including the parent session's inherited default, and an exact override that pins `off`) therefore fails before launch with remediation; it is never silently mapped to minimal. Built-in Muse roles do not pin thinking. Pin an exact override to `minimal`, `low`, `medium`, `high`, or `xhigh`, or select a supported parent thinking level. Clearing an override pin does not help when the parent still inherits `off`. Compatibility probes must invoke provider validation, not merely inspect `--help`.

Muse's `meta` provider performs its own internal retries (observed up to 10 attempts with growing backoff on transient 503/504 errors) entirely inside the `muse` process; this is unrelated to and invisible from this extension's own no-auto-retry contract, and shows up only as activity narration (e.g. "retrying meta model stream in 60000ms (attempt 3/10)"). A run that never reports usage/cost is expected — Muse has never been observed to report either.

OpenCode targets CLI 1.18.32. Check direct, workflow, interruption, and a two-process resume with a codeword known only to the first process. Permission checks must exercise native readonly/edit rules with an authenticated provider: free `opencode/*-free` models may reject restricted tool lists with 403. That is not a passing restricted-tier check. Verify an intermediate `tool-calls` step cannot finalize the receipt. Native task-child cost is not streamed; total cost must become unknown. Structured output schemas and explicit thinking pins must fail clearly before launch. Offline source/debug probes do not replace authenticated restricted-tier validation.

### Named Pi harness receipt

Run only when the pi runtime contract, harness registration, or the in-memory role catalog changes, and only if you have already registered a real `pi-*` harness under `harnesses` in your own `settings.json` with real credentials configured:

```bash
npm run e2e -- --backend pi --harness pi-deepseek
```

This lane reads your real agent directory and does not write a role file for the built-in `worker` role. It does not register or pay for the harness. The faux root model is registered only in-process, and the harness's own real model/auth resolve normally through your real `models.json`/`auth.json`. It delegates to the harness you name and requires the same one complete `done` receipt. A missing credential is not a pass.

## Supervised workflow receipt

When workflow runtime, scheduling, supervision, or tool integration changes, run the affected backend. Before a runtime release, run all six CLI workflow receipts and one named Pi harness workflow receipt:

```bash
npm run e2e -- --backend claude --workflow
npm run e2e -- --backend codex --workflow
npm run e2e -- --backend agy --workflow
npm run e2e -- --backend grok --workflow
npm run e2e -- --backend muse --workflow
npm run e2e -- --backend opencode --model <provider/model> --workflow
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
npm run e2e -- --backend muse --interrupt
npm run e2e -- --backend opencode --model <provider/model> --interrupt
```

The runner calls the `Agent` tool executor directly with `background: true`, polls `external_runs` until the run is observed `running`, cancels its stable ID with an explicit reason, waits for its `cancelled` outcome, and asks `external_runs` for every available output and diagnostic page. A very early cancellation may legitimately have diagnostics but no assistant text; the durable receipt must still be `aborted` with the exact reason. Do not retry a failure automatically. Use `--keep` for one deliberate evidence inspection, then remove the printed run root and temporary files.

## Natural-language routing smoke

There are two levels of routing check:

- `npm run e2e -- --routing-smoke --backend <claude|codex|agy|grok|muse|opencode>` (optionally `--workflow`/`--interrupt`) spawns a real `pi` CLI process with a real root model and gives it a single plain-language instruction naming the exact tool, role, and harness to call. It is a mechanical, automated check that the natural-language call-and-relay path (real root LLM → real tool call → real backend child) still works end to end. It requires real root Pi authentication (see Preparation) and is opt-in only — never the default backend gate — because the root model's tool-call decision is a live, provider-billed, non-deterministic step. `--root-model`/`--root-thinking` only apply here.
- The broader, still-manual qualitative check below covers *discovery*, not just one named call: when role discovery, tool descriptions, or coordinator guidance changes, run three fresh Pi sessions against the current checkout and a read-only fixture. Ask for two named harnesses to review, two named harnesses to research, and a task split between Pi plus two named harnesses. Cover `agy`, `claude`, `codex`, `grok`, `muse`, and `opencode` across those sessions, plus a registered named Pi harness when one is configured. For each session, verify that each requested external harness produced one complete `done` receipt through `role` plus `harness`, no help/discovery call was needed for the built-in roles, and the fixture stayed unchanged. An auth-blocked harness is not a pass.

Neither is a statistical regression comparison or a model-independent guarantee. Neither covers workflow routing or the omitted-`harness` default; use the workflow receipt above and a separate direct role request without `harness` for those paths.

## Change-triggered nested timeout check

Run a real nested-agent timeout scenario only when nested-event detection or timeout-extension code changes. Use an agy role whose prompt invokes one native subagent, set a short bounded timeout, and verify the latest `summary.json`:

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
3. After both children are confirmed terminal (`external_runs wait` or a later `inspect`), call `external_runs({ action: "inspect", runId: <runId>, view: "final" })` for a completed run and confirm it returns only the verified canonical answer. Also call `external_runs({ action: "inspect", runIds: [<that settled id>], view: "final" })` and confirm the one-element `runIds` list returns the same verified answer. For a run cancelled mid-flight (or inspected before it settles), confirm the tool response reports `finalAvailable: false` with a deliberately empty, bounded projection (`items: []`, `integrity: "incomplete"`) rather than a fabricated success — this empty shape is correct at the tool layer, not a bug. The human-readable explanation ("No verified final answer is available yet for `<runId>`.") is a separate, UI-only notice that `/external runs` shows when Final is selected on an unsettled run; the tool response itself stays narration-free by design.
4. Run `/external runs`, open the list, and manually select `Refresh`: confirm it re-reads the first page and resets any list cursor without navigating into a run or waiting/polling. Select a still-running row and confirm its queue/elapsed timing and final-availability marker are present and update only when you refresh again (never on a timer).

Local fixture tests already cover batch pagination/cursor/byte-limit edge cases, the `final` view's success/unavailable/legitimate-null shapes, and `Refresh`'s cursor-reset behavior deterministically; this check only proves the real backend/registry timing (queued→running, activity age, terminal settlement) matches what those fixtures assume.

## Change-triggered project default-harness check

Run only when project default-harness resolution changes. In a fresh Pi session against a trusted read-only fixture containing `.pi/pi-flow-external/settings.json` with `"defaultHarness": "claude"`, verify `/external config` reports `defaultHarness: claude (project: ...)`, delegate one read-only task with `role` only (no `harness`) and verify the receipt names a `claude-*` identity, then confirm an explicit `harness: "codex"` call still routes to codex. Repeat once in the same fixture with trust removed and confirm the override is ignored with a warning. Confirm the project file is still `defaultHarness` only.

## Change-triggered configuration surface check

Run when settings ownership, the role catalog, slash commands, upgrade, or purge behavior changes. Use a disposable `PI_CODING_AGENT_DIR`. This check uses the product commands. It does not add an E2E flag.

1. Fresh directory: start Pi against this checkout. `/external` shows the default harness, six built-in roles, six CLI harnesses (`agy`, `claude`, `codex`, `grok`, `muse`, `opencode`), and the settings path. The directory gains no extension role files under `subagents/` and no `.pi-flow-defaults-seeded-v1`, `-v2`, or `-v3` markers. Reading settings does not create `settings.json`.
2. `/reload`, then start another session. Still no generated role files. `/external role create` writes one file under `pi-flow-external/roles/` and no per-harness copies.
3. `/external config harness create` for one named Pi harness writes that entry into `settings.json` only. `/external roles` and a following `Agent` or `workflow` call on that harness use the same model binding. No role file appears for the six built-ins.
4. Upgrade: place a pre-v4 `settings.json`, a `pi-flow-external/harnesses.json` registry, one customized external profile, and `subagents/pi-reviewer.md` with `harness: "pi-*"` plus a `piCapabilitySets` entry in the disposable directory. `/external config` points at `/external config convert`. Run convert, confirm the preview, and check that originals remain. Conversion writes `roles/reviewer.md` for every harness and does not copy `piCapabilitySets`. A following delegation reads the version 4 catalog. Old paths are ignored after activation. Confirm a deleted seeded identity from a historical cohort is present in `disabledProfiles` and is not recreated. An auth-blocked backend is not a passing receipt.
5. Frozen workflow: start a workflow, edit the role file or settings while it runs, and confirm that run keeps the snapshot from its start. The next invocation outside that workflow sees the edit. Lower `maxConcurrentSubagents` while work is active or queued and confirm the cap stays until that work drains.
6. Optional purge: `/external [danger]purge-old-files` lists candidates, including customized legacy copies. Select individual paths, then confirm. Skipping the purge still leaves delegation working. Confirm current `settings.json`, `roles/`, `overrides/`, project settings, native profiles, and `runs/` stay. Repeat the command and confirm it reports nothing further to delete.
7. Because catalog and command guidance changed, also run `--routing-smoke` for a backend you can authenticate. Unknown `/external profile create` must list the current commands and must not start the old interview.
8. Presets: register two named Pi harnesses, one with `"preset": "minimal"` and one with `"preset": "skills"`, plus one entry that omits `preset`. Confirm the omitted entry is treated as `minimal`. Confirm neither preset loads extensions, prompt templates, or themes. `skills` loads installed skills, and project skills only when the project is trusted. `minimal` leaves skills unloaded.
9. Permission default and call override: set `defaultPermission` to `readonly`. A Claude or Codex call that omits `permission` records readonly. The next call with `permission: "danger"` records danger. A role or override file that still contains `permission` is rejected and does not change the tier.
10. Antigravity rejection: `permission: "readonly"` and `permission: "edit"` on `agy` fail before launch. The receipt is a rejection. It is not an unsandboxed run described as advisory.

### Harness toggles and config routing

In the disposable agent directory, use `/external config default claude`, then `/external config disable muse`. Verify config lists Muse as disabled, doctor skips its readiness probe, and executable discovery omits it. Both `role: "worker", harness: "muse"` and `subagent_type: "muse-worker"` must reject without spawning. Repeat with a named Pi harness and a nonstandard exact override. Re-enable and confirm the saved registration and override are unchanged; individual `disabledProfiles` exclusions must remain in effect.

Try disabling the effective default and selecting a disabled default: guided commands must refuse. Manually make the default disabled and verify delegation fails without choosing another harness. Confirm a running workflow retains its snapshot, while a new invocation (including replay) observes the toggle. `/external role create` must still author a role; `/external config harness create` must start the harness interview. Superseded settings/harness commands must not launch old routes.

## Release minimum

Before a runtime release:

1. Run `npm run check`.
2. Run all six direct backend receipts (`agy`, `claude`, `codex`, `grok`, `muse`, `opencode`). All six are mandatory.
3. Run all six supervised workflow receipts, plus one named Pi harness direct receipt and its workflow receipt when a real harness is registered.
4. Run interruption checks for adapters whose cancellation/output path changed.
5. Run `--routing-smoke` (mechanical) and the manual qualitative routing smoke when role discovery, tool descriptions, coordinator guidance, or slash commands changed. This configuration release requires that smoke. An auth-blocked lane is not a pass.
6. Run the configuration surface check when settings, the role catalog, upgrade, or purge behavior changed.
7. Run the nested timeout check only if nested detection or timeout behavior changed.
8. Run the background-run observability check only if batch inspection, the `final` view, timing projection, or `/external runs` browsing changed.
9. Remove temporary runner evidence. Ordinary use does not require `/external [danger]purge-old-files`.
10. When presets, permission defaults, Antigravity tier rejection, wildcard conversion, or `runIds` selection changed, run the matching configuration-surface and background-run checks. Coordinator-guidance changes also require the routing smoke.
