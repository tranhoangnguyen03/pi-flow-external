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
