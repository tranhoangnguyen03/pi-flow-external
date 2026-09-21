# Unified run experience — investigation and proposed design

Status: proposed for review; no runtime changes made.

## Product contract

A delegated task has one identity, lifecycle, result, and inspection experience. Launching it directly, inside a workflow, in the background, or inspecting it later must not change those facts or make its answer harder to retrieve. A workflow adds composition, phases, and children. An observation operation describes existing work; it is not another execution.

Humans and coordinating models receive the same facts through appropriate presentations. Human cards need readable hierarchy. Model-facing responses need complete, explicit machine-readable state and retrieval instructions. Neither presentation becomes a separate source of truth.

## Evidence and corrections

The user's JSON screenshot is `external_runs(action: wait)` returning `kind: agent`, not evidence of a workflow result. Foreground/background collection already diverges for an ordinary Agent. The earlier explanation that this could be an idle tray placeholder was unsupported.

### Ownership includes the installed renderer

The installed `pi-cc-extensions` package owns the “Multiple Tools” group and “Tool Output” modal:

- `extensions/renderer/default-mode.ts:46` defines `DEDICATED_RENDERER_TOOLS = new Set(["Agent"])`.
- `shouldGloballyStyleTool` preserves Agent but wraps other tools unless configured renderer exclusions apply.
- Its partial result path renders generic `Pending…`; its expanded path consumes raw tool content.
- `extensions/renderer/tool/result.ts:44` concatenates text content and inspected details, causing the duplicate JSON visible in the screenshot.
- `extensions/renderer/mouse/interaction.ts:133` opens that text in the “Tool Output” modal.

Our extension owns run semantics and its registered renderers. The host extension owns interception, grouping, and the generic raw modal. Adding our own `external_runs` renderer alone is insufficient in this installation. Existing `excludeRenderers` configuration can preserve workflow/external_runs once they have custom renderers; a supported integration must be verified, not assumed. Do not edit installed node_modules as the shipped fix.

### Current divergence

| Surface | Current behavior | Consequence |
| --- | --- | --- |
| Direct Agent | Intent card, streaming activity, compact receipt, one expanded answer | Best existing baseline, but still plain Text for output rather than rendered Markdown |
| Workflow launch | Sparse intent; parsed description is not retained in its snapshot | Task identity is less clear |
| Workflow completion | `completed` versus Agent `done`; expanded parent expands all visible children and parent output | Different vocabulary and multiplied output |
| Background launch | Agent queued snapshot; workflow running snapshot paired with “queued” text | Receipt can disagree with observed lifecycle; neither launch receipt is a continuing subscription |
| Wait | `_onUpdate` unused; 512-character result preview, IDs and refs, no render hooks | Silent observation, missing task identity, clipped answer |
| Inspection/list | Live/durable agent and workflow paths build different shapes; batch summary partially normalizes them | Consumers branch on kind, liveness, and operation |
| Final retrieval | Agent canonical text; workflow JSON envelope with result | Same operation needs different decoding |
| Workflow diagnostics | Status/error object rather than a comparable activity history | Same view name has substantially different depth |
| `/external runs` | Independent formatting, shape fallbacks, raw summary JSON and editor pages | Yet another presentation grammar |
| Workflow child options | Public `label` vs direct `description`; `description` silently ignored | Same task naming intent behaves differently |
| Workflow child state | Manual copies into `WorkflowAgentSnapshot` | Fields such as requested permissions, retry disclosure, and thinking clamp can be lost |
| Help | Workflow help's background example puts background in meta; execution reads tool params.background | Example does not perform the behavior it advertises |

Source anchors: `src/pi-subagent.ts`, `src/workflow/tool.ts`, `src/types.ts`, `src/workflow/runtime-values.ts`, `src/external-runs.ts`, `src/external-command.ts`, `src/external-help.ts`.

The existing untracked `2026-09-21-workflow-agent-ux-parity.md` is preserved as prior input, not an approved implementation specification. Its proposal to replace workflow result content with object keys and put the answer only in details is unsafe: the OpenAI Responses adapter sends tool `content` to the model, not `details`. It also incorrectly treats public workflow selection as only subagentType; public role/harness selection already exists.

## Alternatives

1. Add missing renderers and adjust host exclusions only. Fast visual improvement, but keeps shape drift, clipped collection, duplicated child state, and divergent navigation. Does not satisfy this request.
2. **Recommended: unify the observation/receipt contract and presentation over existing execution and evidence.** Reuse RunRegistry, durable readers, final verification, and the existing subagent renderer; make all surfaces consume the same projection.
3. Merge Agent and workflow into a new execution framework/tool. Larger migration with little benefit: script orchestration and single-task delegation legitimately differ. Not needed.

## Shared contract

Promote the existing normalized batch-summary concept into one typed, bounded run projection used by direct receipts, workflow roots/children, list, inspect, wait, and the command browser. Do not add another persisted record format or another lifecycle owner.

Common fields:

- Identity: run ID, kind, parent workflow ID if present, human task description, resolved harness/profile, workspace.
- State: queued/running/done/error/aborted, outcome succeeded/failed/cancelled/timed_out, cancellation requested where applicable, independent liveness and evidence integrity.
- Timing: registration/queue/execution/process/activity/settlement facts through existing timing derivation; unknown stays unknown.
- Access/context: actual execution boundary, requested/effective permissions and enforcement, context receipt, retries, thinking adjustment when present.
- Output: preliminary/final/interrupted classification, explicit final availability, format, bounded preview, completeness/truncation and continuation references.
- Usage/evidence: available usage and cost certainty; full IDs and evidence references in expanded/advanced views.
- Workflow extension: phase, child counts, cached-call count, bounded child references and continuation. Cached reuse is identified and does not manufacture a new execution duration.

Normalize legacy workflow `completed` at the projection boundary; retain old record readers. Do not infer workflow success from child counts: caught child failure may coexist with a successfully returned workflow result. Missing or damaged evidence must not become a normal backend failure. Intentional JSON null remains a valid final result.

Workflow composition metadata wraps the shared child snapshot rather than manually copying a second set of agent fields. Reuse existing projection code and replace competing builders; no generic plugin/projection framework.

## Human experience

Every run card answers the same questions in the same order:

1. What task is this, and who is performing it?
2. Is it queued, running, completed, failed, cancelled, or uncertain?
3. What was the latest observed activity and how fresh is it?
4. What is the answer, and is it final or interrupted?
5. Where can I inspect the full output, evidence, or children?

Illustrative foreground and collected-background receipt:

```text
✓ Review Grok adapter quality · Claude Code / reviewer · 4m33s
  3 findings · final answer available

  Final output
  Review complete …

  Run run_… · Full output · Diagnostics
```

Illustrative workflow:

```text
✓ Review Grok integration · Workflow · 6m12s
  2 done · 0 active · 0 queued · 0 failed
  ✓ Implementation review · Claude Code / reviewer
  ✓ Contract checks · Pi / qa

  Final output
  …the workflow's returned answer…

  Run wf_… · Children · Full output · Diagnostics
```

Illustrative observer:

```text
Waiting for 2 tasks · 1 complete · 1 running
  ✓ Contract checks · final answer available
  ⠋ Review Grok adapter quality · 4m12s · activity 3s ago
    Reading src/core/grok.ts
```

Use the same reusable header, status/timing/output sections, and disclosure rules across tool cards and `/external runs`. Workflow adds hierarchy, not a different visual language. Expanded parent output appears once; child outputs require opening the child. A single global row/output budget bounds the whole card, rather than a separate rich budget for every phase. Hidden failures and child counts remain visible; every hidden child has a navigation path.

Lists and inspections are timestamped snapshots. Wait is a live observer with initial state, activity updates, elapsed time, and terminal receipts. Background launch is explicitly a launch receipt; it must not pose as an indefinitely live card. If execution has already started when the launch response is constructed, say running/background at that instant rather than forcing queued. Rendering and persisted transcript replay must not retain live tool callbacks after completion.

A wait-scoped timer reading existing registry observations is sufficient initially; stop it on completion, error, and abort. It must not mutate run state, restart children, or cancel them when observation stops. No new daemon, unsolicited notification stream, or always-on dashboard is necessary.

Use Markdown rendering for text answers where supported; render structured workflow results as formatted data without inventing a prose answer or guessing a privileged `summary` key. Raw payload/evidence remains an explicit advanced view.

Host acceptance includes stock Pi and installed ccstyle with supported preservation of all three run tools. A raw “Tool Output” inspector may stay raw when explicitly requested, but must not be the ordinary result experience. Group summaries must distinguish a finished launch/observation call from a completed underlying task.

## Coordinating-agent experience

Use the same lifecycle, identity, output classification, and continuation rules independent of origin. Distinct tools remain appropriate:

- Agent starts one task.
- workflow composes tasks and returns its script's value.
- external_runs observes or cancels those tasks.

Make `description` the common task-name option; accept `label` as a compatible workflow alias and reject conflicting values. Preserve role/harness, permission, context, resume, and budget semantics. Keep workflow-only phase/schema and script orchestration semantics explicit. Fix the background example and derive help/examples from the actual contract where practical.

Do not change successful workflow `agent()` into a receipt-returning API: scripts depend on returned values and catchable ChildRunError. That is an appropriate language-level adapter over the same run state. Public receipts and retrieval should expose consistent structured state while retaining result data in model-visible content.

Collection should return a useful bounded answer, not just a 512-character teaser and IDs. Apply a total response budget across selected runs, retain per-run outcome metadata, and attach explicit completeness plus final/output continuation for omitted content. Full content that fits should be delivered immediately. Long results remain paged; no unbounded 100-run concatenation. Final retrieval must use the existing verified canonical result reader for both kinds; text/JSON difference is explicit format metadata, not a different state contract.

A change to public response shapes must be versioned and documented. Prefer additive typed projections and compatibility adapters initially, then remove legacy duplicate builders under the declared release contract. Do not silently change cursor meaning. Preserve verified-only final, ownership validation, bounded pages, cancellation semantics, prefix replay, and existing no-auto-retry rules.

## Delivery sequence

1. Define the common projection and field/state/result mapping against existing records and runtime observations. Capture backward compatibility decisions for model-visible response shapes.
2. Route direct Agent, workflow children/root, list, single/batch inspect, wait, and command browser through it; remove duplicate field-copy/shape fallback paths.
3. Share presentation components; implement wait observation and collection completeness; align naming and help.
4. Verify stock Pi and ccstyle integration using the actual grouping and expanded-output paths. Use supported config for exclusions or a maintained upstream change; no local package mutation as a product solution.
5. Run behavioral checks and capture representative screenshots before claiming consistency.

These are implementation steps toward one acceptance contract, not independently finished cosmetic fixes.

## Acceptance and verification

- The same completed agent, viewed directly, through wait, within a workflow, and from `/external runs`, has the same task identity, outcome, access disclosure, output classification, and canonical answer.
- Every public read path uses the same normalized fields for live and durable sources; missing historical fields remain absent.
- Test success, caught/uncaught child failure, cancellation request vs settlement, timeout, queueing, interrupted evidence, explicit null, replayed children, and large output at the lowest useful layer. Extend existing authoritative tests instead of duplicating them by UI surface.
- Model-visible content contains the answer or an explicit complete retrieval route. Output clipping cannot masquerade as a complete final result.
- Wait updates are bounded, stop after settlement/abort, and never change child cancellation behavior.
- One human result expansion shows one selected answer. Hidden rows/results have usable navigation.
- Host compatibility check: Agent/workflow/wait grouped, active, collapsed, expanded, and browsed in stock Pi and ccstyle. A renderer test alone is insufficient.
- Existing tests should continue to prove ownership, verified finals, cursor bounds, and lifecycle cleanup. No screenshot pixel assertions or prose-fragment tests.

Fresh investigation baseline: `npx vitest run test/agent-rendering.test.ts test/external-runs.test.ts test/agent-contract.test.ts` passed 30 tests across 3 files. This establishes current behavior only; no redesigned behavior has been implemented or visually verified.
