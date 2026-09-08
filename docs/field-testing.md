# Essential external field testing

Real-provider checks consume tokens and normally run external CLIs in dangerous/no-approval modes. Claude uses `auto` permission mode instead when its effective UID is 0. Use them only in a trusted checkout. Receipts can contain prompts and source excerpts despite best-effort redaction.

## Preparation

```bash
cd /path/to/pi-flow-external
export PI_CODING_AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
export ROOT_MODEL="openai-codex/gpt-5.6-sol"
pi auth check --model "$ROOT_MODEL" --json
claude --version
codex --version
agy --version
```

Root Pi authentication is separate from each delegated CLI.

## Direct backend receipt

Run only the backend affected during development:

```bash
npm run e2e -- --backend claude
npm run e2e -- --backend codex
npm run e2e -- --backend agy
```

Each run creates a collision-safe temporary profile and fixture, delegates once, requires the expected token, checks for one complete `done` receipt, verifies that the fixture stayed clean, and removes its temporary files.

Defaults:

| Lane | Model | Thinking |
|---|---|---|
| Root Pi | `openai-codex/gpt-5.6-sol` | `high` |
| Claude | `claude-sonnet-5` | `high` |
| Codex | `gpt-5.6-sol` | `high` |
| Agy | `gemini-3.7-flash-high` | `high` |

Override with `--model`, `--thinking`, `--root-model`, or `--root-thinking`. Use `--keep` only when evidence inspection is necessary; it preserves sensitive output and the temporary profile path printed by the runner.

## Workflow receipt

When workflow runtime, scheduling, or tool integration changes:

```bash
npm run e2e -- --backend codex --workflow
```

This runs two children through one workflow and requires two complete receipts. One backend is enough because direct backend checks validate adapter-specific transport.

## Natural-language routing smoke

When role discovery, tool descriptions, or coordinator guidance changes, run three fresh Pi sessions against the current checkout and a read-only fixture. Ask for two named harnesses to review, two named harnesses to research, and a task split between Pi plus two named harnesses. For each session, verify that each requested external harness produced one complete `done` receipt through `role` plus `harness`, no help/discovery call was needed for the built-in roles, and the fixture stayed unchanged.

This is a qualitative trigger smoke, not a statistical regression comparison or a model-independent guarantee. It does not cover workflow routing or the omitted-`harness` default; use the workflow receipt above and a separate direct role request without `harness` for those paths.

## Change-triggered nested timeout check

Run a real nested-agent timeout scenario only when nested-event detection or timeout-extension code changes. Use an Agy profile that invokes one native subagent, set a short bounded timeout, and verify the latest `summary.json`:

```bash
jq -e '.summary.status == "done" and
  .summary.nestedActivitySeen == true and
  .summary.nestedTimeoutExtended == true and
  .summary.effectiveTimeoutMs > .summary.configuredTimeoutMs' \
  "$PI_FLOW_EXTERNAL_RUNS_DIR"/run_*/summary.json
```

Do not run damaged-record and expected-failure provider scenarios manually. Their behavior is deterministic and belongs in the local fixture tests.

## Release minimum

Before a runtime release:

1. Run `npm run check`.
2. Run all three direct backend receipts.
3. Run one workflow receipt.
4. Run the natural-language routing smoke only if role discovery, tool descriptions, or coordinator guidance changed.
5. Run the nested timeout check only if nested detection or timeout behavior changed.
6. Remove temporary evidence and profiles.
