# Tool-schema compatibility investigation (#62)

## Reproduction and scope

In the reported `9-router/gpt-6-astra` session, the model-facing tool declarations
require both `external_runs.runId` and `runIds`, and require `external_help.harness`.
This was reproduced during this PR's investigation: inspect calls supplying both
selectors fail, as does workflow help with a harness. Empty placeholders are not
valid omission. This is not evidence that the source forgot `Type.Optional`.

## Verified client boundary

With the pinned Pi SDK 0.79.4, run:

```sh
npx vitest run test/tool-schema-provider.test.ts
```

The test uses the **real tool factories** and Pi's `streamSimple` /
`openai-completions` provider, capturing the JSON-serialized `onPayload` output
before deliberately throwing to prevent HTTP. It uses a fake key and loopback
URL, not real credentials. The provider/model identifiers and session-affinity
compatibility setting match the affected configuration.

| Tool | Outbound `required` | Outbound `strict` |
| --- | --- | --- |
| `external_runs` | `["action"]` | `false` |
| `external_help` | `["topic"]` | `false` |

`pi-ai/dist/providers/openai-completions.js` passes `tool.parameters` through in
`convertTools`; it does not promote optional fields to required. An independent
Grok reviewer also captured a loopback HTTP POST with equivalent schemas and
observed the same arrays. Existing `external-runs` and `external-help` tests own
executor validation, including omission and conflicting selectors; this new test
covers the provider boundary rather than duplicating those contracts.

## What remains unresolved

This proves the stock client provider emits correct optionality. It does **not**
capture the affected live router's outgoing model request, nor rule out additional
session-specific payload hooks. The precise layer responsible for the changed
model-facing declaration remains unverified. Do not dismiss it as a model choosing
to fill optional arguments, and do not claim the routing failure is fixed here.

The next investigation needs sanitized captures on both sides of the affected
router (and after any session payload hooks), comparing `properties`, `required`,
and `strict`. Preserve `required` verbatim when translating non-strict tools. If a
backend requires strict schemas, its adapter must represent absence correctly
rather than making mutually exclusive selectors mandatory. That fix belongs at
the identified conversion boundary; it is not safe to guess intent in this
extension by ignoring conflicting arguments.

Until then, use a provider route that preserves optionality or the human
`/external runs` browser. Keep [#62](https://github.com/tranhoangnguyen03/pi-flow-external/issues/62)
open for the downstream trace and end-to-end confirmation. The PR supplies a
reproducer and client-boundary regression, not a claimed downstream repair.

## Executor-level placeholder tolerance (2.4.2-external.0)

The paragraph above says it is "not safe to guess intent in this extension by
ignoring conflicting arguments" — that guidance is about two *genuinely
populated, disagreeing* selectors (e.g. `runId: "run_a"` alongside
`runIds: ["run_b"]`); this extension still rejects that outright, unchanged.
It does not cover the narrower, empirically reported case: a model coerced by
a broken downstream conversion into treating an optional, mutually exclusive
field as required typically fills the one it means to omit with a blank
string or an empty array — neither of which can ever name an actual run or
harness. `external_runs`' `inspect` action and `external_help`'s `harness`
now treat that specific placeholder shape as omitted rather than a conflict
or an invalid filter. Two genuinely non-empty values, even naming the same
run, are still rejected exactly as before (`inspect` has always refused
`runId` and `runIds` together, by design).

This is deliberately narrow and has a real cost: a caller with its own
unrelated bug that happens to resolve a selector to `""` (or `[]`) is now
silently tolerated instead of failing loudly with "Invalid run ID" or
"Unknown harness". We accepted that trade for the one reported, reproduced
failure mode ("an empty runId did not help") rather than leaving inspect
newly hard-required on a broken router. It is scoped to exactly the fields
named in the #62 reproduction (`external_runs.runId`/`runIds` on `inspect`,
`external_help.harness`) — not a general empty-string/empty-array tolerance
across every optional field, and not extended to `wait`/`cancel`/`list`,
which never exhibited this failure mode.

This is still executor-level input tolerance, not a schema-boundary fix: the
tool declarations themselves are unchanged (`required` stays `["action"]`
and `["topic"]` — see the table above), and the downstream conversion layer
responsible for the reported required-field promotion remains unidentified.
Do not read this section as resolving or closing #62.
