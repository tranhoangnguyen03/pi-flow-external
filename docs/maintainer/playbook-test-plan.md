# Playbook verification: mechanical evidence and live-agent trials

**Scope:** PR #103. Nine live runs were reported, but runner defects, mixed child harnesses and a model-facing pagination problem prevent release qualification. See [the reported results and narrow correction plan](playbook-live-trial-followup.md). The corrected runner has mechanical regression coverage; no new live result or efficiency improvement is claimed. Keep the draft/release hold.

## Evidence instead of coverage bookkeeping

The [playbook coverage matrix](playbook-coverage.json) records the PR #103 review and is retained as historical evidence. It is no longer an update obligation or test gate. Linking a recommendation to a test name never established that the test proved the recommendation.

Check a changed runnable recipe with its direct mechanical regression tests. Review guidance-only edits for accuracy and practical value. Use a small, matched live-agent comparison before claiming better delegation decisions or task outcomes. Keep the existing behavior-trial runner and its evidence integrity checks for claims that need them.

Read-only concurrency cannot prove worktree isolation: Flow has no built-in worktree isolation or merge arbitration. Parser tests cannot prove a human received a good briefing. These require appropriate behavioral evidence.

## Mechanical regression coverage

| Pattern | Direct executable checks | Still a behavioral question |
| --- | --- | --- |
| Parallel work | Scope collection, partial failure, explicit synthesis handoff and omissions | Useful division of work and truthful integration |
| Batch map–reduce | Uneven 240-item batch, bounded concurrency, stable IDs, failed/unreadable sources, malformed and duplicate/missing records, size blockage and failed reductions | Extraction accuracy, quantitative claims and preservation of important detail |
| Pipeline | Actual prior evidence passed onward; failure and oversized handoff stop the dependent call | Whether the downstream answer correctly uses evidence |
| Routing | Both bug and feature branches; unknown-category rejection | Whether the parent chooses the appropriate treatment |
| Discover and delegate | Structured bounds, empty/invalid/duplicate scopes, exact objective/question/target handoff, concurrency and partial failure | Grounded, useful, nonredundant and genuinely independent work discovery |
| Independent review | Fresh calls, no sibling verdict handoff, no forced drafting, partial/all failure | Actual criticism quality and source fidelity |
| Bounded refinement | Authorization flag, compatible backend, feedback, stop on pass/invalid QA, exhaust all allowed attempts while checks keep failing | Useful revisions and sound assessment criteria |

The tests execute actual recipes and code extracted from guides through Flow's runtime with deterministic child substitutes. Those substitutes are not real model decisions. Run:

```sh
npm run check
npm pack --dry-run --json
node scripts/e2e/playbook-behavior.mjs --selftest
```

Verifier regressions separately exercise retention after cleanup, exclusion of credential copies, missing facts/calls/receipts, altered manifests, stale scenarios, mismatched reviews and false-pass reproductions. Live-response regressions use the reported `structuredContent` field layout, distinguish rejected arguments from admitted runs, check the real harness-selection configuration, and separate eight-page retrieval from a one-space exact-copy mismatch. Synthetic fixtures are labelled as such; they do not attest a provider run.

## Fifteen scenarios, not fifteen qualified results

Task fixtures remain in [scenarios.json](../../test/fixtures/playbook-behavior/scenarios.json). The [large-output fixture](../../test/fixtures/playbook-behavior/large-output.mjs) adds a roughly 30 KB, 160-row source. The runner exports the full scenario list, including briefing/phase review criteria for coordinated work.

`large-output-inspection` asks a helper to return the source and the parent to retrieve its canonical result through final-result pages. The runner now reports three separate observations: **retrieval fidelity** compares a complete linked page sequence with the retained canonical child result; **source fidelity** compares that canonical result with the source bytes; **cursor visibility** checks continuation guidance in tool text rather than assuming structured metadata was visible to the model. No whitespace is normalized. A lost trailing source space fails the exact-copy task but not otherwise complete retrieval. Metadata-only continuation remains unqualified on the reported Pi surface; fixing that integration is outside this correction.

Discovery has natural-choice, explicit discovery-child, and already-known-split cases. Several fixtures contain easy clues and explicit delegation requests. They are execution/reading smoke tests, **not strong evidence of autonomous investigation or better ergonomics**. Start with the small matched comparison and inspect traces, rather than adding another evaluation framework.

## Retained trial evidence

A real trial uses a temporary private agent directory with copies of root-model authentication files. Original user credentials and settings are never edited. The runner enables only the selected child harness in that temporary configuration and records the settings; default selection alone is not a restriction. Before cleanup, it copies only session and child-evidence roots, not the credential-bearing agent directory. Known credential filenames and symlinks are excluded or rejected. Temporary credentials are removed even if retention fails.

| Artifact | Purpose |
| --- | --- |
| `sessions/`, `evidence/` | Parent sessions and child run records, readable after cleanup |
| `artifacts.json` | Retained file inventories/checksums |
| `pi-events.jsonl`, `pi-stderr.log` | Parent tool events, answers and diagnostics |
| `process.json` | Process outcome, selected model/harness, scenario and trial-settings digests |
| `trial-settings.json` | Nonsecret fixed-harness availability configuration; absent in older trials |
| `fixture-manifest.json`, `fixture-after.json` | Source snapshot and fixture-only before/after hashes |
| `result.json` | Cached score, never authority for verification |
| `review.json` | Current case ID, exact questions, reviewer, ratings and evidence |

**Fixture-only checks do not prove no writes elsewhere.** The reported Claude plan-file write under its home directory was outside that check. Do not delete such files as incidental test cleanup or claim a machine-wide write audit. Prefer Codex for the controlled rerun without generalizing its requested sandbox tier into a global no-writes guarantee.

Retained artifacts can contain sensitive material. Keep them private. Credential-file exclusion is not a transcript secret scrubber.

## Running and reviewing real trials

Use an authenticated Pi parent and working compatible child CLI. Calls are opt-in and may incur provider charges. Use model names available in the installation.

```sh
node scripts/e2e/playbook-behavior.mjs --list
node scripts/e2e/playbook-behavior.mjs --real \
  --case discovery-child-decomposition --out /tmp/flow-trials \
  --model openai-codex/gpt-5.6-sol --harness codex
```

Inspect retained source, session and child records. Rate each current question **0 fail / 1 adequate / 2 strong**, cite supporting records, and mark `verdict: "pass"` only if every criterion is adequate. Do not rename, drop or reorder questions.

```sh
node scripts/e2e/playbook-behavior.mjs --verify /tmp/flow-trials
```

`--verify` reloads the current scenario, checks its digest and complete source manifest, validates retained artifacts, and reparses the actual response envelopes and child receipts. It ignores cached pass flags. Task output checks are separate from fixed-harness comparison eligibility and model-visible pagination qualification. It reports attempted calls, rejected invocations, argument rejections, unique admitted run IDs and unresolved responses. A rejected call followed by corrected arguments is not a second admitted run; a new run after an admitted failure is.

Existing bundles with intact retained evidence can be reassessed without model calls or modification. Missing or stale artifacts still fail. A legacy default-only configuration cannot silently become a controlled comparison; entirely local results are unaffected by a child-harness constraint they never used. A directory containing only some cases still does not qualify the whole suite.

This is consistency checking, **not provider attestation or proof of reviewer independence**. Human review must establish that the records came from the intended trials and support their conclusions.

## Small matched comparison and targeted reruns

For baseline versus candidate, keep the same corrected runner, runtime, parent model, restricted child harness, fixtures and approval settings. Record both skill SHAs, use separate output directories and select the skill with `--skill-path`. Verify actual child receipts as well as the configuration.

```sh
for condition in baseline candidate; do
  for task in batch-corpus discovery-unknown; do
    node scripts/e2e/playbook-behavior.mjs --real --case "$task" \
      --harness codex \
      --skill-path "/tmp/flow-$condition/skills/pi-flow-orchestration" \
      --out "/tmp/flow-comparison-$condition"
  done
done
```

First reassess existing missing-source and large-output bundles. New execution is needed for comparisons confounded by harness choices, or to test cursor usability after that integration is corrected. An exact-copy retry is needed only for an exact-source-reproduction claim. Local outcomes need no rerun merely because unused harnesses were available.

Compare task quality, missing evidence, useful versus redundant delegation and human correction. Help-read count is secondary; one trial with differing child harnesses proves no efficiency gain or loss. The missing-source case tests limitation reporting, not a forced backend failure.

## Release status

The reported nine runs provide useful but unqualified evidence. The correction does not resolve model-visible pagination or rerun the controlled comparison. Required provider/routing checks in [field testing](field-testing.md) still apply independently. Keep PR #103 draft until live qualification and release metadata are resolved; no `release:none` bypass for shipped skills.
