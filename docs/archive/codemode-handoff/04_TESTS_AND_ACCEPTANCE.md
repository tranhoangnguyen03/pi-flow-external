# Verification and acceptance

## What has and has not been tested

The bundled fixture validator tests the proposed contract and its invariants. It does not execute Flow, Pi, a worker, or a provider. The actual implementation must pass the checks below. Record observed commands/results, not historical test counts copied from the repository.

## Deterministic contract/regression matrix

| ID | Scenario | Required observation |
|---|---|---|
| T01 | Foreground Agent succeeds | `ok:true`; real run ID; terminal outcome; exact canonical result. |
| T02 | Foreground Agent fails | `ok:false`; `isError:true`; typed code; run/evidence retained. |
| T03 | Pre-launch error | No worker spawned, no invented run ID; `run:null` or null data. |
| T04 | Background launch | Queued/running receipt, not completion; stable ID registered before return. |
| T05 | False-like values | `null`, `false`, `0`, and empty string preserved without truthiness fallback. |
| T06 | Promise resolves with typed failure | Caller checks `ok`; does not label success merely because await returned. |
| T07 | Workflow handles child failure | Root may succeed; handled failure remains visible and inspectable. |
| T08 | Unhandled workflow child failure | Existing ChildRunError/cancellation/draining semantics preserved. |
| T09 | Inspect failed target | Inspection `ok:true`, target failed; failure not erased or turned into tool error. |
| T10 | Final not available | Empty final page, `finalAvailable:false`; no partial narration as final. |
| T11 | Large final result | Inline value omitted intact in favour of ref; paged retrieval recovers exact data. |
| T12 | Single JSON page boundary | Concatenate complete UTF-8 pages before JSON parse; invalid/stale cursor fails. |
| T13 | Batch summary | Whole typed entries; order/deduplication; all ownership checked before any page. |
| T14 | Too-small batch budget | Error, not oversize page, silently dropped target, or non-advancing empty page. |
| T15 | Wait any/all | Failed targets are data; pending IDs retained; unsuccessful workflow early return unchanged. |
| T16 | Wait byte budget | One shared budget, request-order allocation, no per-child multiplication. |
| T17 | Cancel | Requested vs already terminal vs cannot confirm; no implied rollback. |
| T18 | Live vs historical | Stale records never animate or claim live ownership; unknown integrity stays unknown. |
| T19 | Three-view consistency | Same run ID, state/outcome, result availability, and known evidence gaps. |
| T20 | UI preservation | Direct Agent/workflow/run cards, phase hierarchy, access/context labels, and drill-down remain readable. |
| T21 | Sensitive data | No launch prompt/env/credential leakage in default machine or text output; explicit launch inspection stays scoped/redacted. |
| T22 | Usage | Preserve known/estimated/partial/unknown distinctions; avoid nested host double counting. |
| T23 | Contract discovery | Output equals actual registered input/output schemas; index remains small. |
| T24 | Capability discovery | Claims match current adapter paths; unsupported/unknown distinct; no probes or paid calls. |
| T25 | Legacy help/selectors | Existing topics and blank optional placeholders behave correctly; no removed aliases resurrected. |
| T26 | Invalid/unknown version | Clear incompatibility, not parsing prose or guessing field meanings. |
| T27 | Coordinator prompt | Does not acquire the entire contract/capability manual; details remain on demand. |

Use fresh isolated temporary run directories/configs for tests. Fixtures must not touch the user's real settings, sessions, or CLI credentials. Verify partial-failure cleanup in addition to text snapshots.

## Real Pi host / fake-child integration

Use pinned Pi 0.99.2 with the real Flow extension and real native codemode. Inject fake child execution at the existing seam or through the repository's test harness. No paid inference is needed. A standalone sandbox calling a hand-built imitation tool is not sufficient.

| ID | Host check | Required observation |
|---|---|---|
| H01 | Direct registered Agent | Existing model text/render details retained; structured output present. |
| H02 | Same Agent through native codemode | Script receives the public object, not renderer details or human prose. |
| H03 | Typed error + predispatch rejection | Data-bearing `isError:true` reaches script; blocked/invalid calls also covered as host failures. |
| H04 | Workflow through codemode | Same registered lifecycle, limiter, child result, and evidence IDs as direct call. |
| H05 | Forgotten await | Existing Flow guard still fails; do not substitute generic codemode cancellation semantics. |
| H06 | Abort paths | Blocking work cancels; interrupted wait only ends wait; background remains session-owned. |
| H07 | Resume/replay/history | Same backend constraints; longest unchanged successful prefix; no automatic rerun; no crash adoption. |
| H08 | Hooks/discovery | Validation and permission hooks run; content-only redaction does not leak structured payload; contract/capability tools callable. |
| H09 | Nested context negative control | B cannot rely on A's nested output being in parent `recent/full`; store is not shared conversation. |
| H10 | Explicit handoff | Selected validated evidence in B's task arrives intact without changing context modes. |
| H11 | Branch + world freshness | Current-branch snapshot only; capture time is not proof file/repo state remains current. |
| H12 | Reviewer independence | Independent arms do not receive each other's conclusions unless explicitly requested. |

Use SDK resource factories to load native codemode as documented in Pi's SDK example; the CLI and SDK do not necessarily activate the same built-ins automatically. Test through the host tool pipeline so the test exercises hooks and structured-result conversion. [S14]

## Compatibility matrix to record

At minimum: target Pi 0.99.2 direct mode and codemode `on`, Node satisfying Flow's `>=22.19.0` requirement, and the existing deterministic repository suite. A codemode `only` run is a useful additional contract test, not a required user default. Test older direct-mode hosts only if retaining that support claim. Test current supported macOS/Linux execution paths where environment access permits; clearly mark any unrun lane.

## Manual user experience check

Run one small fake or explicitly authorized real delegation foreground and background. Observe queued state, worker activity, a handled failure, a failed final, large-output inspection, cancellation, and historical reload. Check the existing `/external runs` route while the main agent is active. Do not declare Bro integration tested: Bro is unchanged and not part of this feature.

## Quality/cost evaluation after correctness

Compare the same approved task and worker configuration with (A) direct Flow and (B) codemode calling the new public contract. Hold briefing, model, permissions, repository starting state, and acceptance tests constant. Record root and child input/output/cache usage, known dollars with unknown components separate, elapsed time, orchestration repairs, evidence omissions, and user interventions. Do not use visible tool-call count or payload bytes as a quality/cost score. Do not run paid comparisons without authorization.

## Release gate

All executor-owned envelopes schema-valid; no false-success regression; no permission/ownership/redaction regression; all evidence recoverable within documented retention/availability limits; no runtime swap; no new context-sharing API; direct UX retained; real target-host integration demonstrated. Remaining unrun lanes and observed baseline failures must be stated in the final report.

Sources: [06_SOURCE_MAP.md](06_SOURCE_MAP.md).
