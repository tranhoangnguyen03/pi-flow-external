# Antigravity latency diagnosis (maintainers)

This runbook compares Flow's Antigravity route against direct `agy` CLI runs. It makes **no claim that Flow is slower until matched runs show it**.

## Stable behavior

- Production still runs `agy --dangerously-skip-permissions --output-format stream-json --input-format stream-json`, with the same model, effort, timeout and optional `--conversation` / `--json-schema`.
- Never remove `--dangerously-skip-permissions` to make a benchmark pass. It bypasses prompts and grants broad tool access; execute only in a trusted workspace with prompts you control.
- Flow sends the task as a JSON user event over stdin. This avoids exposing private prompts in process arguments. `agy --print` uses a command-line prompt, so the comparison tool sends **only its built-in harmless prompt**.
- No server/ACP/daemon change is part of this PR.

## Step 1: identify the route and version

Record `agy --version`, OS/architecture, selected model, effective thinking level, workspace, whether this is a cold or warm launch, and whether a Flow parent shares its concurrency slot. In Flow, the default model is unpinned and thinking maps `off` to backend default and `high` / `xhigh` to `high`. Compare *actual* model and effort, not only role names.

Antigravity upstream 1.5.2 reported improvements to headless requests (including removing background title generation and fixing a roughly one-minute permission stall). A later upstream 1.5.5 fix concerns shutdown after `-p`. Neither establishes that the Flow stdin mode is slow or fixed. See:
- https://github.com/google-antigravity/antigravity-cli/releases
- https://antigravity.google/docs/cli/headless/

## Step 2: inspect an existing Flow receipt

`external_runs({ action: "inspect", runIds: ["<runId>"], view: "summary" })` already reports queue delay, activity age and process duration. In the private run directory, `events.ndjson` now includes one `agy_attempt_timing` event **per actual spawn attempt**, including a retry after an infrastructure failure.

| Field | Meaning |
|---|---|
| `adapterToSpawnMs` | Initial adapter work before the OS process spawn event |
| `spawnToFirstEventMs` | CLI startup until first non-empty stdout line |
| `spawnToInitMs` | Time to structured `init` event, if emitted |
| `spawnToFirstActivityMs` | Time to first tool or text activity, if emitted |
| `spawnToTerminalMs` | Time from spawn to terminal `result` event |
| `terminalToExitMs` | Time after terminal result before OS process exit |
| `adapterToExitMs` | Overall adapter-to-exit wall-clock time |
| `adapterElapsedMs` | Entire adapter attempt, including post-exit checks |
| `attempt`, `eventCount`, `exitCode` | Retry identity, volume and process result |

All times are rounded elapsed milliseconds measured with a monotonic clock. Missing stages are omitted instead of invented. The existing per-event receipt path still redacts and writes each event; **this PR does not change recording strategy before measuring it**.

To assess Flow's finalization cost, compare the final `agy_attempt_timing` event timestamp and `run_finished` timestamp with the tool's observed completion. The gap is not a pure disk-cost measurement: parsing, result handling, on-disk event queue draining and root-agent tool consumption can all contribute. If this gap is notable, add a targeted experiment to time record finalization before changing the recorder.

## Step 3: compare the two direct CLI modes (real model calls)

Dry help (zero model calls):

```sh
node scripts/e2e/agy-latency.mjs --help
```

After ensuring you are signed in to `agy` and have consent to incur real requests:

```sh
node scripts/e2e/agy-latency.mjs --execute --rounds 3 --model <same-model> --effort high
```

The script deliberately alternates two modes and uses only the built-in prompt, “Reply with exactly AGY_LATENCY_CHECK. Do not use tools.” It does **not** print model output, environment, credentials or conversation IDs. Both modes use `--dangerously-skip-permissions --output-format stream-json` and the same `--print-timeout`. No live invocation is made without `--execute`. The `--print` mode includes that harmless prompt in argv; **do not change it to private task material**.

A changed prompt, model, effort, permission or repo workload invalidates a matched comparison. Run one child before measuring parallel work. Measure medians, outliers, first activity, terminal-to-exit time and retry counts; avoid claiming an absolute speedup based on synthetic fixtures.

## Step 4: compare against Flow and Claude

Use `npm run e2e -- --backend agy --keep` for a real Flow run and inspect the retained receipt. Its default fixture and harness options may differ from the direct benchmark, so align model, effort, prompt, workspace and CLI account before drawing conclusions. Record parent-agent decision time separately. If Claude invokes `agy` directly, capture its effective argv, session reuse and model choice without logging credentials or prompts.

Compare cold and warm runs, then runs with several concurrent children. Distinguish:
1. `agy` startup before `init`;
2. model/tool execution between `init` and terminal result;
3. native CLI shutdown after terminal result;
4. Flow's terminal-result processing and durable recording;
5. parent-agent delay before dispatch and after receiving the result.

Only optimize the dominant demonstrated cause. Run-record batching must preserve ordered events, redaction, terminal receipts and cancellation; persistent ACP adds a separate ownership and lifecycle contract and is out of scope.

## Verification and evidence limits

Run `npm run check`, `npm pack --dry-run --json` and the normal CI gates. The offline fake-cli test includes an intentional post-terminal delay and verifies its `terminalToExitMs` timing plus a separate event for each retry. It does **not** measure real `agy` startup, speed, account selection or provider latency. Real live experiments are opt-in and may incur usage fees. Do not attach raw event logs or task prompts to public issues/PRs without review.
