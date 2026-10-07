# Flow × codemode: context handoff is a promising seam

**Recommendation:** first use codemode to prepare and forward explicit task evidence through Flow's existing interfaces. Do not add shared memory or another context mode as part of this feature.

This document has two statuses: the compatibility/documentation tests are part of the main plan; the research experiment and any new context mechanism are follow-up proposals only.

## 1. Preserve the previous decision

Issue #29's recorded no-go rejected fragile selected-transcript references and a read-at-delegation blackboard. A compact handoff performed comparably to that blackboard, and the parent still had to do the curation. The experiment did not establish a total-cost or quality advantage. It explicitly left an active multi-stage publish/consume workflow as a separate untested hypothesis. Do not resurrect the rejected API or claim reduced bytes prove benefit. [S10]

The shipped baseline remains `context: none|recent|full`, plus explicit task text, and supported backend resume. Workflow children use a frozen parent snapshot. These are valuable simple boundaries. [S09]

## 2. Three kinds of context are being confused

| Kind | What it contains | How to handle it |
|---|---|---|
| Intent and decisions | Goal, scope, constraints, agreed trade-offs | Main agent supplies authoritative task instructions and necessary decisions. |
| Working evidence | Exact records, diffs, findings, IDs, checks, source revisions | Codemode can collect, join, validate, select, and transport it. |
| Conversation history | User/assistant exchanges and completed tool exchanges | Flow's existing none/recent/full selection, or backend resume when appropriate. |

Codemode is particularly useful for the second kind. Its role is not to infer which old user decision still wins. That remains a judgment by the main agent or an explicitly tasked reviewer.

Example: the main agent can decide, "Compare current adapters with the agreed compatibility requirements." Code can carry the exact discrepancies to a reviewer without the main model reading and rewriting each intermediate record. The reviewer still reasons. This saves a potential translation/rewrite step; it does not guarantee lower total model cost.

## 3. What does NOT happen automatically

A native codemode script's intermediate nested results do not become ordinary main-session tool exchanges. Its `store()` values are not conversation messages. Flow captures the current branch's completed exchanges, excludes pending tool calls, and uses an invocation-time snapshot for workflow children. Therefore `context:full` cannot recover evidence that was never emitted to the parent transcript. [S04, S09]

A child result can be present in JavaScript memory but absent from the next child's prompt. Code sequencing is not context sequencing. Pass relevant earlier results explicitly.

An external CLI also does not automatically possess the parent's `tools.external_runs` interface, codemode store, or absolute evidence path. A run reference is useful to the parent but is not a universal child-readable document locator. Resolve it to authorized content before handoff, or use a separately verified child-accessible artifact.

## 4. The immediate pattern: parent-selected intent, code-carried evidence

1. Main agent defines the objective, authority, evidence-selection rule, and stopping conditions.
2. Codemode gathers or retrieves evidence, checks completeness/status, and applies that rule.
3. Code places the selected data in an explicit evidence section of Flow's existing task `prompt`.
4. Flow supplies the role, requested permissions, chosen history mode/resume, and lifecycle management.
5. The child investigates/reasons and returns a result. Use the existing inner workflow schema feature when programmatic branching needs a business-data schema.
6. Main agent interprets the result and accepts/revises the approach. It leaves a brief ordinary assistant explanation for the user/Bro at a meaningful decision.

The public operational receipt and the child's task-specific finding schema are different contracts. A schema-valid receipt proves correct transport shape, not that a child's finding is true or complete. A prose child answer remains prose; do not pretend the new receipt schema validates its semantics.

### Small evidence packet convention — NOT a new API

Use this as JSON embedded in a task prompt when helpful; do not add these fields to Flow's `context` schema:

```json
{
  "sourceRunId": "run_example",
  "sourceRevision": "an actually observed commit or content identity",
  "selection": "failed compatibility checks plus exact supporting excerpts",
  "facts": [],
  "openQuestions": [],
  "omissions": []
}
```

Only include observed values; omit an unavailable revision instead of fabricating it. Put the current assignment and permission restrictions outside this data packet. Mark quoted tool/child output as untrusted evidence, not instructions. A minimal handoff can simply forward a bounded canonical result and its source ID; the packet is a convention, not mandatory boilerplate.

Useful immediate cases: reuse candidates grouped by objective criteria; failed tests with exact error excerpts; cross-adapter compatibility checks; collecting multiple reviews while preserving disagreements; replaying a continuing implementation with a precise change-only brief.

## 5. Boundaries that keep the integration useful

- **Selection versus judgment.** Filtering explicit fields is a code task. Choosing which uncertain requirement to sacrifice is not. Return to main reasoning for new interpretations.
- **Completeness.** Follow every relevant cursor or state what is omitted. A successful first page is not a complete evidence set.
- **Large data.** Forward the necessary content or a verified accessible artifact; do not blindly expand every retained transcript. A parent-held ref alone does not help a child that cannot resolve it.
- **Freshness.** `observedAt` is capture time. Verify source revision/current state before applying old findings; neither session branching nor a stored packet rolls back the repository.
- **Supersession.** A newer explicit user decision outranks an older transferred conclusion. In a later experiment, preserve explicit correction identities instead of silently merging incompatible claims.
- **Independent review.** Give reviewers the same requirements and primary evidence; do not leak other reviewers' verdicts by default. Keep disagreement visible for the main agent.
- **Authority.** No handoff may increase permissions. No new agents or paid calls inside codemode bypass the agreed orchestration approval.
- **Privacy.** Avoid secret-bearing launch views unless explicitly necessary and authorized. Redaction is not proof that content is safe for any destination/provider.
- **Observability.** Explain the consequential handoff in ordinary assistant text. Printing `text()` inside codemode is tool output, not a substitute for Bro's conversation-only seed.

## 6. Follow-up experiment, not a production feature commitment

Only after the public contract works, evaluate a genuinely active multi-stage task. Use one repeatable repository fixture and isolated arms with the same worker models/permissions:

**A — Strong existing baseline:** parent-mediated focused task handoffs; not gratuitous full-history copying.

**B — Explicit codemode handoff:** parent defines selection once; code forwards the validated records/results through existing Flow prompts. No new context mode or persistent shared store.

**C — Active publish/consume hypothesis:** an experimental, isolated artifact protocol lets A publish a finding, B consume/correct it, and C consume the current state. This arm requires a separate implementation decision/authorization. Do not reuse a read-at-delegation blackboard and call it this experiment.

Include at least: an earlier finding corrected later; a conflicting pair of reviews; a large paged result; stale source state; interrupted/failed execution; an irrelevant secret-bearing record that must not be forwarded. Use source-grounded binary acceptance checks and blind review where feasible.

Measure end-to-end correctness, missed/superseded requirements, evidence completeness, main-agent rewrite effort, extra inference turns, retries/repairs, root+child input/output/cache usage, known costs and unknown components, elapsed time, and user effort. Payload size is a diagnostic, not the verdict.

Adopt only a mechanism that preserves quality and improves total effort/cost or delivers a clear quality gain worth its complexity. Set numeric gates against the measured baseline before paid runs; do not invent a universal percentage target. If B already provides the value, stop there. If C needs substantial state machinery without a measurable advantage, reject it.

## 7. Architectural conclusion

The near-term opportunity is a clean boundary between **parent intent**, **programmatically carried evidence**, and **child reasoning**. Flow remains the execution owner. Codemode reduces avoidable transport/formatting work. The main agent remains responsible for judgment. Bro remains the user's sideline interface.

Sources: [06_SOURCE_MAP.md](06_SOURCE_MAP.md). Post-implementation pattern: [examples/02_explicit_handoff.js](examples/02_explicit_handoff.js).
