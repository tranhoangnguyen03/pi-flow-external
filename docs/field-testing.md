# Field testing external-agent receipts

Use this checklist to test the installed CLIs and the current checkout end to end. These runs invoke real providers, consume tokens, and use dangerous/no-approval backend modes. Run them only in a trusted repository.

Records may contain prompts, source excerpts, and tool output despite best-effort redaction. Keep the evidence root private and delete it after review.

## Prepare an isolated trial

```bash
cd /path/to/pi-flow-external
export ROOT_MODEL="openai-codex/gpt-5.4-mini" # substitute any authenticated Pi model
export PI_FLOW_TEST_ROOT="$(mktemp -d /tmp/pi-flow-field-test.XXXXXX)"
pi auth check --model "$ROOT_MODEL" --json
claude --version
codex --version
agy --version
```

The Pi root model and the delegated CLIs authenticate separately. `openai-codex/*` uses ChatGPT/Codex OAuth; `openai/*` requires an OpenAI API key.

Create a temporary Agy profile if one is not already available:

```bash
export AGY_PROFILE="agy-field-test-$(date +%s)"
mkdir -p "$HOME/.pi/agent/subagents"
cat > "$HOME/.pi/agent/subagents/$AGY_PROFILE.md" <<'EOF'
---
description: Manual Antigravity field-test profile.
backend: agy
thinking: medium
---

Follow the requested task precisely. Work read-only unless explicitly asked to run a harmless command. Do not modify repository files.
EOF
```

## 1. Direct Claude and Codex receipts

This verifies local extension loading, exact backend routing, real file access, terminal-success validation, and complete evidence.

```bash
export RUNS="$PI_FLOW_TEST_ROOT/direct"
mkdir -p "$RUNS"
PI_FLOW_EXTERNAL_RUNS_DIR="$RUNS" npm run --silent e2e:claude-subagent -- --root-model "$ROOT_MODEL"
PI_FLOW_EXTERNAL_RUNS_DIR="$RUNS" npm run --silent e2e:codex-subagent -- --root-model "$ROOT_MODEL"
npm run --silent field-report -- --json "$RUNS" > "$PI_FLOW_TEST_ROOT/direct.json"
jq -e '.runs == 2 and .byStatus.done == 2 and .byBackend.claude == 1 and .byBackend.codex == 1 and .incompleteRecords == 0' "$PI_FLOW_TEST_ROOT/direct.json"
```

## 2. Agy stdin transport

Run one Agy delegation that executes `sleep 20`, then reads a known file. While it sleeps, inspect the Agy process from another terminal:

```bash
ps -axo command= | grep -E '(^|/)agy( |$)' | grep -- '--input-format stream-json'
```

The command should include both stream-JSON flags and must not contain the delegated prompt:

```text
--input-format stream-json
--output-format stream-json
```

After completion, the run summary should report `backend: "agy"`, `status: "done"`, at least one backend event, and `nestedActivitySeen: false`. An ordinary shell tool is not nested-agent activity.

## 3. Parallel workflow fan-out

Run an ad-hoc workflow with explicit Claude and Codex children:

```js
export const meta = { name: "manual_fanout", description: "Manual Claude and Codex fan-out" };
const results = await parallel([
  () => agent("Read package.json and report its name and version. Do not edit files.", { label: "claude", subagent_type: "claude-explorer" }),
  () => agent("Read package.json and report its name and version. Do not edit files.", { label: "codex", subagent_type: "codex-explorer" })
]);
return results;
```

Set `PI_FLOW_EXTERNAL_RUNS_DIR` to a fresh directory and start Pi with this checkout, `--tools workflow`, and `--max-concurrent-subagents 2`. The field report should contain exactly two complete `done` records, one for each backend.

## 4. Nested-agent timeout extension

Use a 90-second base timeout. Ask Agy to invoke one native subagent, then run `sleep 60`, and finally return a known marker. Include the repository's absolute path in the nested prompt; backend-native helpers may otherwise use their own scratch workspace.

A passing summary has:

```text
status: done
nestedActivitySeen: true
nestedTimeoutExtended: true
configuredTimeoutMs: 90000
effectiveTimeoutMs: greater than 90000
```

The extension starts when the structured nested event is observed. It grants one fresh base timeout from then, capped at twice the original deadline; it does not unconditionally double the run.

## 5. Expected backend failure

Create a temporary Agy profile with an invalid model and call it once. Do not retry. The expected report distinguishes backend failure from recording failure:

```text
byStatus.error: 1
incompleteRecords: 0
recentFailures: contains the backend error
```

Its `summary.json` should still have matching `eventCount` and `attemptedEventCount` with `writeErrorCount: 0`.

## 6. Damaged-record detection

Copy a complete run into a fresh evidence directory and set its top-level `writeErrorCount` to `1`:

```bash
jq '.writeErrorCount = 1' summary.json > summary.json.tmp
mv summary.json.tmp summary.json
```

The field report should keep the backend status but set `incompleteRecords: 1` and include `record write errors` under `recentFailures`. A parseable summary is not automatically trustworthy.

## Interpret and clean up

- `done` with complete evidence: valid backend receipt.
- `error` or `aborted` with complete evidence: backend failed, but diagnostics are trustworthy.
- `incompleteRecords > 0`: evidence integrity failed; do not trust status alone.

Remove temporary profiles and evidence when finished:

```bash
rm -f "$HOME/.pi/agent/subagents/$AGY_PROFILE.md"
rm -rf "$PI_FLOW_TEST_ROOT"
unset AGY_PROFILE PI_FLOW_TEST_ROOT RUNS
```
