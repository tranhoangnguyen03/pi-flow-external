# Field testing external-agent receipts

Use this checklist to test the current checkout end to end. These scenarios invoke real providers, consume tokens, and use dangerous/no-approval backend modes. Run them only in a trusted repository.

Records may contain prompts, source excerpts, and tool output despite best-effort redaction. Keep the evidence root private and delete it after review.

## Prepare an isolated trial

```bash
cd /path/to/pi-flow-external
export ROOT_MODEL="openai-codex/gpt-5.6-sol"
export PI_FLOW_TEST_ROOT="$(mktemp -d /tmp/pi-flow-field-test.XXXXXX)"
export FIELD_STAMP="$(date +%s)"
export CLAUDE_PROFILE="claude-field-test-$FIELD_STAMP"
export CODEX_PROFILE="codex-field-test-$FIELD_STAMP"
export AGY_PROFILE="agy-field-test-$FIELD_STAMP"
export AGY_BAD_PROFILE="$AGY_PROFILE-bad"
mkdir -p "$HOME/.pi/agent/subagents"
pi auth check --model "$ROOT_MODEL" --json
claude --version
codex --version
agy --version
```

The Pi root model and delegated CLIs authenticate separately. `openai-codex/*` uses ChatGPT/Codex OAuth; `openai/*` requires an OpenAI API key. The recommended field baseline is root Pi `gpt-5.6-sol`, Claude `claude-sonnet-5`, Codex `gpt-5.6-sol`, Agy `gemini-3.7-flash-high`, with `high` thinking throughout.

Create temporary profiles:

```bash
cat > "$HOME/.pi/agent/subagents/$CLAUDE_PROFILE.md" <<'EOF'
---
description: Manual Claude field-test profile.
backend: claude
model: claude-sonnet-5
thinking: high
---

Follow the requested task precisely. Work read-only and do not modify repository files.
EOF

cat > "$HOME/.pi/agent/subagents/$CODEX_PROFILE.md" <<'EOF'
---
description: Manual Codex field-test profile.
backend: codex
model: gpt-5.6-sol
thinking: high
---

Follow the requested task precisely. Work read-only and do not modify repository files.
EOF

cat > "$HOME/.pi/agent/subagents/$AGY_PROFILE.md" <<'EOF'
---
description: Manual Antigravity field-test profile.
backend: agy
model: gemini-3.7-flash-high
thinking: high
---

Follow the requested task precisely. Work read-only unless explicitly asked to run a harmless command. Do not modify repository files.
EOF

cat > "$HOME/.pi/agent/subagents/$AGY_BAD_PROFILE.md" <<'EOF'
---
description: Deliberately invalid Antigravity profile for failure testing.
backend: agy
model: definitely-not-a-real-model
thinking: high
---

This profile deliberately selects an invalid model.
EOF
```

## 1. Direct Claude and Codex receipts

This verifies local extension loading, exact backend routing, real file access, terminal-success validation, and complete evidence. The scripts create and remove their own temporary profiles.

```bash
export S1="$PI_FLOW_TEST_ROOT/01-direct"
mkdir -p "$S1"
PI_FLOW_EXTERNAL_RUNS_DIR="$S1" npm run --silent e2e:claude-subagent -- --root-model "$ROOT_MODEL" --root-thinking high
PI_FLOW_EXTERNAL_RUNS_DIR="$S1" npm run --silent e2e:codex-subagent -- --root-model "$ROOT_MODEL" --root-thinking high
npm run --silent field-report -- --json "$S1" > "$PI_FLOW_TEST_ROOT/01-report.json"
jq -e '.runs == 2 and .byStatus.done == 2 and .byBackend.claude == 1 and .byBackend.codex == 1 and .incompleteRecords == 0' "$PI_FLOW_TEST_ROOT/01-report.json"
```

## 2. Agy stdin transport

This verifies that Agy receives its prompt through stdin and that an ordinary shell tool is not misclassified as nested activity.

```bash
export S2="$PI_FLOW_TEST_ROOT/02-agy-stdin"
mkdir -p "$S2"
cat > "$PI_FLOW_TEST_ROOT/02-prompt.md" <<EOF
Call Agent exactly once with subagent_type "$AGY_PROFILE" and description "Agy stdin test". Ask it to run the harmless command sleep 20, read the absolute file $PWD/package.json, and return AGY_STDIN_OK followed by the package name and version. The opaque marker AGY_STDIN_MARKER_9472 must not be repeated. Report the Agent result.
EOF
PI_FLOW_EXTERNAL_RUNS_DIR="$S2" pi -p --model "$ROOT_MODEL" --thinking high --no-extensions --extension "$PWD/index.ts" --no-skills --no-prompt-templates --no-themes --no-context-files --tools Agent --subagent-timeout-ms 120000 --approve @"$PI_FLOW_TEST_ROOT/02-prompt.md"
```

While it sleeps, inspect the Agy process from another terminal:

```bash
ps -axo command= | grep -E '(^|/)agy( |$)' | grep -- '--input-format stream-json'
```

The command must contain `--input-format stream-json` and `--output-format stream-json`, but not `AGY_STDIN_MARKER_9472`.

```bash
RUN2=$(ls -td "$S2"/run_* | head -1)
jq -e '.writeErrorCount == 0 and .eventCount == .attemptedEventCount and .summary.backend == "agy" and .summary.status == "done" and .summary.backendEventCount > 0 and .summary.nestedActivitySeen == false and (.summary.result | contains("AGY_STDIN_OK"))' "$RUN2/summary.json"
```

## 3. Parallel workflow fan-out

This verifies explicit external profiles, concurrent execution, and one complete record per child.

```bash
export S3="$PI_FLOW_TEST_ROOT/03-workflow"
mkdir -p "$S3"
cat > "$PI_FLOW_TEST_ROOT/03-prompt.md" <<EOF
Call workflow exactly once with this script:

export const meta = { name: "manual_fanout", description: "Manual Claude and Codex fan-out" };
const results = await parallel([
  () => agent("Read the absolute file $PWD/package.json and report its name and version. Do not edit files.", { label: "claude", subagent_type: "$CLAUDE_PROFILE" }),
  () => agent("Read the absolute file $PWD/package.json and report its name and version. Do not edit files.", { label: "codex", subagent_type: "$CODEX_PROFILE" })
]);
return results;

Report whether both children returned results. Do not call Agent directly.
EOF
PI_FLOW_EXTERNAL_RUNS_DIR="$S3" pi -p --model "$ROOT_MODEL" --thinking high --no-extensions --extension "$PWD/index.ts" --no-skills --no-prompt-templates --no-themes --no-context-files --tools workflow --max-concurrent-subagents 2 --subagent-timeout-ms 600000 --approve @"$PI_FLOW_TEST_ROOT/03-prompt.md"
npm run --silent field-report -- --json "$S3" > "$PI_FLOW_TEST_ROOT/03-report.json"
jq -e '.runs == 2 and .byStatus.done == 2 and .byBackend.claude == 1 and .byBackend.codex == 1 and .incompleteRecords == 0' "$PI_FLOW_TEST_ROOT/03-report.json"
```

## 4. Nested-agent timeout extension

This verifies structured Agy `subagent` events and the one-time extension. The task should finish near or just after the original 90-second deadline.

```bash
export S4="$PI_FLOW_TEST_ROOT/04-nested-timeout"
mkdir -p "$S4"
PI_FLOW_EXTERNAL_RUNS_DIR="$S4" pi -p --model "$ROOT_MODEL" --thinking high --no-extensions --extension "$PWD/index.ts" --no-skills --no-prompt-templates --no-themes --no-context-files --tools Agent --subagent-timeout-ms 90000 --approve "Call Agent exactly once with subagent_type \"$AGY_PROFILE\" and description \"Nested timeout test\". Ask it to use invoke_subagent exactly once to read the absolute file $PWD/package.json and return the package name. After the nested helper returns, run sleep 60, then return NESTED_TIMEOUT_OK and the package name. Do not modify files. Report the Agent result."
RUN4=$(ls -td "$S4"/run_* | head -1)
jq -e '.summary.status == "done" and .summary.nestedActivitySeen == true and .summary.nestedTimeoutExtended == true and .summary.configuredTimeoutMs == 90000 and .summary.effectiveTimeoutMs > 90000 and (.summary.result | contains("NESTED_TIMEOUT_OK"))' "$RUN4/summary.json"
```

The extension starts when nested activity is observed. It grants one fresh base timeout from then, capped at twice the original deadline; it does not unconditionally double the run.

## 5. Expected backend failure

This verifies that backend failure remains distinct from recording failure and is not retried.

```bash
export S5="$PI_FLOW_TEST_ROOT/05-backend-failure"
mkdir -p "$S5"
PI_FLOW_EXTERNAL_RUNS_DIR="$S5" pi -p --model "$ROOT_MODEL" --thinking high --no-extensions --extension "$PWD/index.ts" --no-skills --no-prompt-templates --no-themes --no-context-files --tools Agent --subagent-timeout-ms 60000 --approve "Call Agent exactly once with subagent_type \"$AGY_BAD_PROFILE\" and description \"Expected backend failure\". Ask it to reply OK. Report the expected failure and do not retry."
RUN5=$(ls -td "$S5"/run_* | head -1)
npm run --silent field-report -- --json "$S5" > "$PI_FLOW_TEST_ROOT/05-report.json"
jq -e '.runs == 1 and .byStatus.error == 1 and .incompleteRecords == 0 and (.recentFailures | length) == 1' "$PI_FLOW_TEST_ROOT/05-report.json"
jq -e '.writeErrorCount == 0 and .eventCount == .attemptedEventCount and .summary.backend == "agy" and .summary.status == "error"' "$RUN5/summary.json"
```

## 6. Damaged-record detection

This verifies that a parseable but unreliable summary is not counted as complete.

```bash
export S6="$PI_FLOW_TEST_ROOT/06-damaged-record"
mkdir -p "$S6"
SOURCE_RUN=$(ls -td "$S2"/run_* | head -1)
cp -R "$SOURCE_RUN" "$S6/"
RUN6="$S6/$(basename "$SOURCE_RUN")"
jq '.writeErrorCount = 1' "$RUN6/summary.json" > "$RUN6/summary.json.tmp"
mv "$RUN6/summary.json.tmp" "$RUN6/summary.json"
npm run --silent field-report -- --json "$S6" > "$PI_FLOW_TEST_ROOT/06-report.json"
jq -e '.runs == 1 and .incompleteRecords == 1 and any(.recentFailures[]; (.error // "") | contains("record write errors"))' "$PI_FLOW_TEST_ROOT/06-report.json"
```

## Interpret and clean up

- `done` with complete evidence: valid backend receipt.
- `error` or `aborted` with complete evidence: backend failed, but diagnostics are trustworthy.
- `incompleteRecords > 0`: evidence integrity failed; do not trust status alone.

```bash
rm -f "$HOME/.pi/agent/subagents/$CLAUDE_PROFILE.md" "$HOME/.pi/agent/subagents/$CODEX_PROFILE.md" "$HOME/.pi/agent/subagents/$AGY_PROFILE.md" "$HOME/.pi/agent/subagents/$AGY_BAD_PROFILE.md"
rm -rf "$PI_FLOW_TEST_ROOT"
unset ROOT_MODEL PI_FLOW_TEST_ROOT FIELD_STAMP CLAUDE_PROFILE CODEX_PROFILE AGY_PROFILE AGY_BAD_PROFILE S1 S2 S3 S4 S5 S6
```
