# Background-run observability — live-provider execution report

**Scope of this pass:** actually executed real-provider checks against the
live Anthropic API through the `claude` CLI backend (2026-09-20). No
implementation files were changed and no commits were made during this
pass. No nested agents performed any live-provider check; a read-only
research subagent was used once, separately, to confirm the `/external
runs` TUI's real keybindings from source before scripting the PTY check.

**Not run in this pass:** `--backend codex`, `--backend agy`, `--backend pi
--harness <name>`, the non-workflow single-`Agent` claude lane, and the
`--interrupt` lane (already covered by existing scenarios per
`docs/field-testing.md` and unaffected by this change). These remain
pending release gates — see the PR checklist.

## Environment

- `pi`, `claude` CLI both current on PATH; `codex`/`agy` present but not
  exercised this pass.
- Root Pi model `openai-codex/gpt-5.6-sol` (oauth), confirmed ready via
  `pi auth check --model "openai-codex/gpt-5.6-sol" --json`.
- Claude child model `claude-sonnet-5`, thinking `high` (the runner and
  `docs/field-testing.md` default). Live auth confirmed with a direct
  `claude -p "reply with OK" --model claude-sonnet-5` sanity call before
  spending anything on the real checks.
- `PI_CODING_AGENT_DIR` must be exported into the same shell invocation as
  `npm run e2e` — it does not persist across separate Bash tool calls in
  this environment. The isolated per-lane agent directory `external.mjs`
  creates by default has no root-Pi credentials of its own; pass
  `--agent-dir "$HOME/.pi/agent"` in the same command when the real,
  non-isolated agent directory's OAuth is required. This was a local
  harness-usage mistake, not a provider failure, and nothing was retried
  after catching it.

## 1. `npm run e2e -- --backend claude --workflow`

```
npm run e2e -- --backend claude --workflow --keep --agent-dir "$HOME/.pi/agent"
```

Result: **PASS.** Two real `workflow-child` receipts, both `status: "done"`,
both returning the expected `CLAUDE_EXTERNAL_OK:...` marker under
`permission.tier: "danger"` / `permission.enforced: true`. The root
transcript contained `WORKFLOW_SUPERVISION_OK` and real `external_runs`
calls. The fixture repo was verified clean (`git status --short` empty)
after the run.

## 2. Background-run observability check (`docs/field-testing.md` steps 1–3)

`scripts/e2e/external.mjs` has no built-in mode for this four-step
sequence (only single-Agent, two-child-workflow, or interrupt), so a small
throwaway script reused the runner's fixture/profile-creation pattern and
drove a fresh real `pi -p --mode json` session (`--tools
Agent,external_runs`) through the exact sequence with real
`claude-sonnet-5` children. Real tool-call results were read from the raw
JSON event stream, not the model's paraphrase.

Result: **PASS**, all steps confirmed against real receipts:

- Two independent `background:true` Agent launches queued immediately with
  no blocking wait between them.
- Unrelated parent work (a direct file read) happened before either child
  was inspected.
- One bounded `external_runs({action:"inspect", runIds:[...]})` batch call
  returned both entries in a single `entries` array while one was still
  genuinely `running` (`live:true`, `output.finalAvailable:false`) and the
  other had already settled (`output.finalAvailable:true`) — the batch did
  not wait for either.
- `view:"final"` on the already-completed run returned only the verified
  canonical answer (`finalAvailable:true`, `integrity:"complete"`).
- `view:"final"` requested immediately on a third, still-running run
  returned an empty, bounded projection (`finalAvailable:false`,
  `integrity:"incomplete"`, empty `content`). **This is correct, not a
  defect:** the tool's `final` view is deliberately narration-free —
  unavailable is a bounded empty page, not a synthesized sentence in the
  response text (see `src/external-command.ts`). The human-readable
  explanation belongs one layer up, in the `/external runs` UI (check 4
  below), not in this raw tool response. `docs/field-testing.md` step 3's
  wording was corrected in this pass to state that distinction explicitly.
  After the run settled, re-requesting `final` on the same ID returned the
  full accumulated final answer text.
- **Canonical-answer integrity, verified by diff, not assumed:** the raw
  `final`-view tool text was byte-compared against the same run's durable
  `summary.json` result field and matched exactly — the returned text is
  the backend's own final canonical answer, not transcript narration or
  inspection-layer contamination.

## 3. `/external runs` terminal/PTY smoke

Tooling check first: a real PTY driver (`expect`) was available, so this
exercised genuine terminal rendering, not a mock. Source lookup (via the
read-only research subagent, no live-API call) confirmed the real
keybindings before scripting: `/external runs` is the command; the list is
a `SelectList` where arrow keys move the cursor and Enter selects;
`Refresh`/`Back` rows are appended after any real run rows; and — confirmed
by actually running it — an empty run list returns early with just an info
notification and never renders a `SelectList` at all (correct: a fresh
session has no runs of its own yet, and `external_runs` is
session/project-scoped per `AGENTS.md`).

A second, successful attempt drove one real interactive `pi` session
end-to-end via `expect`, using `--tools Agent,external_runs`:

1. Asked the root (via a plain chat message) to launch one
   `background:true` Agent against the real default `claude-worker`
   profile with a short, fixed-marker prompt.
2. Sent `/external runs` — the real `SelectList` rendered with the launched
   run's row plus `Refresh` and `Back`, confirmed via raw terminal capture.
3. Sent Down-arrow then Enter. Frame-diff of the raw terminal output
   confirmed Enter was pressed while `Refresh` was highlighted (not the run
   row), exercising `docs/field-testing.md`'s exact Refresh requirement:
   the list re-rendered showing the same run row, `Refresh`, and `Back`,
   proving it looped back to the list rather than opening the run's own
   detail submenu.
4. Sent Escape, then Ctrl-C; the process exited cleanly.

Result: **PASS.** The launched child completed with the expected marker
result. This pass's run finished faster than the interaction sequence
around it, so it did not happen to exercise a still-running row inside the
TUI — check 4 below closes that gap with a deliberately slow run.

## 4. Deliberately slow background run — live/presettle/postsettle Final UI

Closes the gap check 3 left open: this check launches one deliberately
slow, read-only Claude background run and drives the same real interactive
`pi` session through the full lifecycle, so it can catch a run genuinely
still running inside `/external runs`. Driven via `expect` against a real
PTY capture, replayed through a real terminal emulator (`pyte`, in a
scratch venv, not added to the repo) so quoted screen content below is a
faithful reconstructed frame, not a guess from raw escape-code fragments.

Result: **PASS.**

1. Launched one `background:true` Agent (real default `claude-worker`
   profile) with a deliberately slow, read-only, "think at length before
   emitting a fixed sentinel" prompt.
2. `/external runs`, opened immediately: the reconstructed frame showed the
   run row with a live `running · elapsed <N>s` marker while the child was
   genuinely still running.
3. Opened the run row → `Final`: reconstructed frame showed the exact
   `ctx.ui.notify` "No verified final answer is available yet for
   `<runId>`." string, while the tool-level projection for the same run at
   the same moment was the same empty/bounded shape verified in check 2 —
   confirming the intended split between an empty tool projection
   (correct) and an explanatory UI notice (this screen), not the same
   thing shown twice.
4. Backed out to the list and polled by repeatedly selecting `Refresh`
   (list-level UI action only, no new provider call) until the row read
   `done · elapsed <N>s · final ready`, matching the real receipt's
   duration.
5. Reopened the run row → `Final` again: the editor pane that opened this
   time showed real, multi-line scrollable content (confirmed by a genuine
   scroll indicator, not a stub) ending in the expected sentinel, which was
   character-for-character the tail of the real receipt's result.
6. Sent Ctrl-C; the process exited cleanly.

**Not exercised, correctly out of scope:** cancelling this run mid-flight —
the interruption path (`--interrupt` lane) is a separate, already-covered
scenario and was not re-tested here; this check is specifically about the
settled/unsettled `Final` distinction on a run that succeeds.

## Cleanup performed

- All temporary profiles written into the real `~/.pi/agent` directory
  during this pass were removed after evidence extraction.
- Temporary run roots and evidence under the OS temp directory were left
  in place as private local evidence only; none touch real `~/.pi/agent`
  state.
- No changes to `src/`, `test/`, or any shipped file; no commits and no
  release steps were made during this pass. One small, authorized doc-only
  wording correction was made to `docs/field-testing.md`'s background-run
  observability check step 3 (see check 2 above).

## Pass 2 — Agy and named Pi harness direct + workflow (2026-09-20)

**Scope of this pass:** the two remaining release-gate lanes explicitly
authorized for this session — `--backend agy` (direct + workflow) and one
registered named Pi harness (direct + workflow). **Codex was explicitly
waived by the user for this pass and not exercised at all**: no `codex`
binary invocation (not even `--version`), no `--backend codex` run, and no
Codex-branded root model. No nested agents performed any live-provider
check in this pass. No commits, merges, tags, or release steps were made.

### Root-model and harness discovery (sanitized — no credentials shown)

`docs/field-testing.md`'s documented root-model default
(`openai-codex/gpt-5.6-sol`) is a Codex model and was excluded per the
user's instruction. Discovery was done with `pi auth check --model/--provider
... --json` (readiness only, no `--credentials` flag, so no secret material
was ever printed) plus minimal, low-cost `pi --model ... -p "reply with OK"`
sanity calls:

| Provider | Auth status | Notes |
|---|---|---|
| `anthropic` (direct) | `not_ready` / `credentials_not_configured` | not usable |
| `google` (direct) | `not_ready` / `credentials_not_configured` | not usable |
| `radius` | `ready` (oauth) | model catalog resolves, but the account returned `402 Payment Required: $0.00 available` on an actual call — authenticated but unfunded, not usable |
| `deepseek` (direct) | `ready` (api_key) | `402 Insufficient Balance` on an actual call — authenticated but unfunded, not usable |
| `cerebras` | `ready` (api_key) | real `OK` reply on sanity call — funded and used |
| `zai` | `ready` (api_key) | real `OK` reply on sanity call — funded and used, but later hit a real `429 Usage limit reached for 5 hour` mid-run (see below) |
| `9-router` (backs the registered `pi-*` harnesses) | `ready` (api_key) | see per-harness results below — not uniformly usable |

Named Pi harness registry (`~/.pi/agent/pi-flow-external/harnesses.json`,
read-only, model/thinking pins only, no credentials in this file):
`pi-astra` → `9-router/big-brain` (thinking `off`), `pi-deepseek` →
`9-router/deepseek-flash-latest` (thinking `xhigh`), `pi-glm` →
`9-router/glm-5.3` (thinking `high`). No new harness or profile was created;
only the runner's own temporary `claude-*`/`agy-*` profiles were written and
removed, exactly as `scripts/e2e/external.mjs` already does for non-pi
backends.

**`pi-deepseek` (the harness suggested as a first choice) was not usable
this pass**, for a real provider-side reason unrelated to this repo's code:
a direct sanity call against `9-router/deepseek-flash-latest` failed with
`503 ... SUBSCRIPTION_PENDING_CONFIRMATION` — the account's pricing for that
specific model changed and requires manual confirmation in the 9-router
dashboard before further use. This was not retried and no workaround was
applied. **`pi-glm`** was attempted next and reached the harness in the real
runner (`--backend pi --harness pi-glm`), but the direct check's receipt
came back `status: "error"` with `429 Usage limit reached for 5 hour. Your
limit will reset at 2026-09-21 02:55:25` — the same reset timestamp `zai`'s
own 429 reported a few commands earlier, consistent with `9-router`'s
`glm-5.3` route and the direct `zai` account sharing underlying provider
capacity. Per the essential-test-mandate no-auto-retry rule, this was not
retried; the pass switched to the third registered harness, **`pi-astra`**
(`9-router/big-brain`), which passed a sanity call and both real checks
below.

**Root model used:** `agy` direct check ran with `--root-model
zai/glm-5.3-flash` (passed). The `agy --workflow` check under the same root
model then hit `zai`'s real `429` mid-run (visible in the raw event stream:
`willRetry:true` twice, then `auto_retry_end success:false` — Pi's own SDK
retry, not an additional retry by this pass); that run's failure was
recorded and not retried. The remaining three checks (`agy --workflow`
retry, both `pi --harness pi-astra` checks) instead used **`--root-model
cerebras/gpt-oss-120b`** (funded, non-Codex, confirmed via sanity call).
`--agent-dir "$HOME/.pi/agent"` was passed explicitly in the same shell
invocation as every `npm run e2e` command, per the isolated-agent-dir
caveat already recorded in Pass 1's environment notes above.

### Results

1. **`npm run e2e -- --backend agy --root-model zai/glm-5.3-flash`: PASS.**
   Receipt `status: "done"`, result
   `AGY_EXTERNAL_OK:gemini-3.7-flash-high-high:...` matched the fixture
   marker exactly, `permission: {tier: "danger", enforced: true}`, fixture
   verified clean (`git status --short` empty) after the run.
2. **`npm run e2e -- --backend agy --root-model zai/glm-5.3-flash --workflow`:
   FAIL (not retried).** Root `pi` process exited 1; the real event stream
   showed `zai`'s `429 Usage limit reached for 5 hour` on the root model
   itself, exhausted after Pi's own internal retry attempts. Zero receipts
   were written (the workflow never reached a child dispatch). Artifacts
   were captured, then removed.
3. **`npm run e2e -- --backend agy --root-model cerebras/gpt-oss-120b
   --workflow`: PASS.** Both `workflow-child` receipts `status: "done"`,
   both returning the exact `AGY_EXTERNAL_OK:...` marker under
   `permission: {tier: "danger", enforced: true}`; root transcript contained
   `WORKFLOW_SUPERVISION_OK`; fixture verified clean after the run.
4. **`npm run e2e -- --backend pi --harness pi-glm --root-model
   cerebras/gpt-oss-120b`: FAIL (not retried; harness switched, see above).**
5. **`npm run e2e -- --backend pi --harness pi-astra --root-model
   cerebras/gpt-oss-120b`: PASS.** Receipt `status: "done"`, result
   `PI_EXTERNAL_OK:pi-astra:pi-astra`, `profile: "pi-astra-worker"`, `model:
   "9-router/big-brain"`, `permission: {tier: "danger", enforced: true}`,
   fixture verified clean.
6. **`npm run e2e -- --backend pi --harness pi-astra --root-model
   cerebras/gpt-oss-120b --workflow`: PASS.** Both child receipts
   `status: "done"` with the exact `PI_EXTERNAL_OK:pi-astra:...` marker and
   the same enforced `danger` permission tier; fixture verified clean.

This satisfies the release-gate intent of "Agy direct + workflow" and "one
registered named Pi harness direct + workflow", using `pi-astra` in place of
the originally-suggested `pi-deepseek`, which was blocked by a real,
unrelated provider-account billing state, not a code defect.

### Cleanup performed (Pass 2)

- Every temporary `agy-zz-e2e-*.md` profile written into the real
  `~/.pi/agent/subagents/` directory was removed after evidence extraction
  from each `--keep` run (confirmed empty via a final directory listing).
- Every `--keep`ed temporary run root under the OS temp directory
  (`pi-flow-external-e2e-<timestamp>`) was removed after its receipt(s) were
  read; none were left behind from this pass.
- `git status --short` on the repo confirmed no source, test, or shipped
  file changed during this pass — only this doc and the PR body were
  touched, after all live checks completed.
- No `codex` binary was ever invoked in this pass, and no automatic retry
  was performed on any failed or aborted provider/root-model run; each
  failure above was diagnosed from its real receipt or event stream, then
  routed to a different, already-funded model/harness rather than repeating
  the same call.
