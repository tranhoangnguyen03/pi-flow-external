# Orchestration evaluation

Use real parent-agent tasks to judge guidance changes. Offline test fixtures verify
runtime mechanics and recipe control flow, but cannot measure model judgment.

## When to run a live comparison

Run a small comparison only when changing guidance, tool discovery, or behavior
that could alter which work the parent delegates. Ordinary implementation
regressions belong in the existing offline tests. For adapter changes use the
change-triggered real-provider checks in [field testing](field-testing.md).

Compare the pre-change commit with the candidate using the same authenticated
Pi version, parent model, available harness, permissions, task and workspace.
Use fresh sessions. Record the commit SHAs and actual tool traces. Do not give
one condition extra tools, examples, or provider access.

Start with these three tasks:

1. **Direct task:** "Ask one external helper to locate the JSON parser entry point
   and report the key files, then summarize its answer." Look for one suitable
   delegation and a useful answer, without needless workflow setup.
2. **Independent review:** "Have helpers inspect payment retry and idempotency
   logic, without changing files. Combine their results and name gaps." Look for
   distinct scopes, truthful integration and no unnecessary child launches.
3. **Dependent reasoning:** "Compare two implementation choices, then use the
   evidence to recommend one and flag uncertainty." Look for a real evidence
   handoff and a grounded parent decision.

Use a partial-failure variation when recovery matters: one child fails, and the
parent should use completed evidence without inventing coverage or silently
changing providers. Add permission or background misuse only when relevant.

## Record what happened

For each attempted task, keep a short record of:

- Base/candidate commit, Pi/model/harness versions, and permissions.
- The user prompt, actual parent tool calls, children launched, and final result.
- Whether the requested task was done, missing evidence was reported, and
  authorization was honored.
- Unnecessary setup, corrected arguments, and human intervention.
- Elapsed time and provider cost only when measured.

Judge correctness, permissions, result quality and useful progress first.
Compare runs fairly; if a provider is unavailable, record the blocker instead
of counting a pass. Repeat a case when results are ambiguous.

The old fifteen-scenario playbook runner, synthetic verifier, and coverage
matrix were retired because no qualifying controlled behavioral comparison
had been established and the extra testing machinery was costly to maintain.
Historical material remains in Git. The executable recipe regression tests and
the real-provider smoke entry points remain in place.

## Mechanical check

Run `npm run check` for offline correctness. For changed backend behavior
follow [field testing](field-testing.md), including the optional
`npm run e2e -- --routing-smoke --backend <backend>` lane when actual parent
tool selection matters. A prompted routing smoke is narrower than evidence
that the parent autonomously discovered a useful delegation.
