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
