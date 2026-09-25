# Workflow ↔ Agent UX parity — investigation + design

> **Superseded historical proposal.** This document contains outdated observations and is not an implementation specification. See [the approved north star](../delegation-experience-north-star.md) and [visual guidelines](../delegation-visual-guidelines.md).

## Problem (from screenshots)

* `Agent` collapsed→expanded is one clean card: `✓ Backend(role, label) duration usage -> first-line`, `Final output` (≤4k chars), `Run <id>`, `Evidence <path> · N events`, context receipt. Feels polished.
* `workflow` outcome is a JSON wall: `Result:\n{...}` in tool message + expanded view repeats every child's 4k `Final output` + workflow JSON. Hard to scan.
* `external_runs wait` dumps raw `{"outcomes":[{preview:512…}]}` — least polished, leaks JSON to conversation.
* `External Runs` row in tray with no children is `external_runs list/inspect` query tool, not a missed workflow row — but label collision makes it feel like a broken workflow heartbeat.

## Investigation

### Rendering surfaces (user perspective)

| Stage | Agent (`src/pi-subagent.ts:583/636→core/subagent-render.ts:259`) | Workflow (`src/workflow/tool.ts:605/609→744`) | external_runs wait (`src/external-runs.ts:476`, no renderResult) |
|---|---|---|---|
| Intent (`renderCall`) | Rich: `Delegating Label → type · tier`, Task, Why (profile.description), Context, Workspace | One-liner: `Workflow <name> · unsandboxed external agents` | None — raw args badge |
| Live | Rich ≤4 concurrent (activity lines≤4×120ch, Thinking…) else compact 1-line; spinner frame via `activeRuns` heartbeat (`pi-subagent.ts:334`) | Header `Workflow(name) running · done/active/queued/failed/total` + phase tree (`renderPhaseTree:689`) or flat list; 6 agents/phase max (`selectAgentsForRender:633`, priority error>running>queued), each via `renderSubagentNode(..., showAccess:false)`; own 100 ms `snapshot.frame` heartbeat (`tool.ts:344`) | Blocking, no `onUpdate`, no live |
| Collapsed done | `✓ Backend(type,label) duration usage evidence abcd1234 -> first-line` | Header + phase markers + 6 compact children + last 3 logs; **no** Final output | Raw JSON string |
| Expanded done | + `Final output` (≤4k), evidence, context | **Fans out** `expanded:true` to every visible child (≤6×4k each) + workflow `Final output` JSON (≤4k) + Run/Journal paths → wall of text | Raw JSON still; preview only 512ch (`previewOutcome:465`) |
| `background:true` | Returns `queued` card, detached signal, no heartbeat (`pi-subagent.ts:570`) | Text says `queued as wf_…` but snapshot stays `status:running, agents:[]` → frozen `running · 0/0` card (`tool.ts:172/600`) | N/A |
| JSON leaks | None (plain `textResult`) | `Result:\n` + `JSON.stringify(result, null,2)` in tool message (`tool.ts:544`) and `JSON.stringify` in expanded view (`tool.ts:778`) | All actions `JSON.stringify(list/payload)` (`external-runs.ts:511/564/615/730`) |

### Agent perspective (LLM-driving-UX)

* System prompt: `AGENT_PROMPT_SNIPPET` vs `WORKFLOW_PROMPT_SNIPPET` vs `EXTERNAL_RUNS_PROMPT_SNIPPET` (`src/prompts.ts:5/8/14`) + merged `buildCoordinatorPrompt` (roles, `maxConcurrentSubagents` cap, "use parallel([...]) or background Agent calls; sequential awaits stay serial"). So the LLM *is told* they're different tiers: one-shot delegate vs orchestrator script vs query/sync.
* Tool params: `Agent` takes `role|subagent_type + harness + description + prompt + permission + context + resume + max_budget_usd`. `workflow` takes `name|scriptPath|script + args + background` and exposes `agent({subagentType,label,phase,schema,…})` — naming drift `description↔label`, `role+harness↔subagentType`. `external_runs` takes `action/list/inspect/wait/cancel + runId/runIds + view + cursor` (up to 100 wait targets, 20 for batch inspect, cursor paging).
* Orchestration reality: `Agent` = synchronous slot→`spawnSubagent`→stream. `Workflow` = V8 isolated `script-worker.ts` + `runtime.ts` phases/parallel/replay-cache + journal. So dissimilarity is structural, not just cosmetic. User confusion comes from rendering not signaling that tier.
* Output contract: `Agent` result is always a string (assistant text). `Workflow` result is JSON-serializable arbitrary value (`structured_output` or plain), stringified on the wire. `external_runs` outcomes are normalized `RegisteredRunOutcome` + 512ch preview refs.

### Root causes of "looks worse"

1. **Workflow intent card is empty** — hides what it's doing.
2. **Workflow success path stringifies JSON into the conversation** — Agent never does.
3. **Expanded workflow multiplies child outputs** — Agent shows one.
4. **Workflow running starves rich detail when >4 concurrent** (shared `RICH_SUBAGENT_ACTIVE_LIMIT=4`) and hard-caps at 6 rows.
5. **Background workflow snapshot lies about status** (running vs queued).
6. **`external_runs` has no `renderResult`** — pure JSON by design, but reads as unpolished.

## Design — minimal parity (ladder: reuse what exists)

### Principles

* Reuse `core/subagent-render.ts` as the single source of truth for every row. Don't invent new widgets.
* Conversation text (`content[0].text`) stays human-readable prose; structured JSON lives only in `details`.
* Keep `Agent` as the canonical look; teach `workflow` to look like "N Agents grouped".

### Changes

#### 1) `src/workflow/tool.ts` — Intent card
Enrich `renderCall` to mirror Agent's without inventing args rendering: `Workflow <name> · <phase-count> phases · <args preview if present> · Workspace <cwd>`. Pull description from `meta.description` + `params.args` (truncated 120ch like activity). One-line addition, reuses `getBackendAgentLabel` already used elsewhere.

#### 2) `src/workflow/tool.ts` — Result text (conversation)
Replace `Result:\n${JSON.stringify(result,null,2)}` (line 544) with helper:
```
formatWorkflowResultText(result): string {
  if (typeof result === "string") return result.slice(0,4000)
  const keys = Object.keys(result||{}); return `Workflow returned object with keys: ${keys.join(", ")} — see expanded Final output.`
}
```
Keep full JSON only in `details.result`. Mirrors Agent's `-> first-line` + `Final output` split.

#### 3) `src/workflow/tool.ts` — Expanded view dedup
In `renderWorkflowSnapshot`, when `expanded===true` **do not** pass `expanded=true` to children. Keep children compact (first-line only) and show only the workflow's own `Final output` (≤4k) + per-child `evidence <id>` one-liners. Preserves scannability; details still reachable via `external_runs inspect <child> view:output`.

#### 4) `src/workflow/tool.ts` — Live richness budget
Keep `selectAgentsForRender(…,6)` but raise rich threshold per child: pass `runningCount` scoped to *that phase* not global `workflowRunningCount`, so a fan-out of 8 doesn't demote every phase's single runner to compact. One-line change in `renderPhaseTree`/`renderFlatAgents`.

#### 5) `src/workflow/tool.ts` — Background queued card
On `background===true`, snapshot should be `status:"running"` is wrong — set `status:"queued"` or add explicit branch in `renderWorkflowSnapshot` that renders `Workflow(name) queued as wf_… · use external_runs wait` instead of `running · 0/0`. Zero-agent running header disappears.

#### 6) `src/external-runs.ts` — Minimal `renderResult` (no JSON wall)
Add `renderResult` that checks `details.outcomes`:
* Each outcome → `renderSubagentNode`-like line via shared helper `formatOutcomeLine(outcome)` (reuse `formatDuration`/`formatTokens` from `subagent-render`): `✓/✗ run_<8> kind status duration -> preview(120ch)`.
* Keep raw JSON only as fallback when `view !== "wait"`. This makes `wait` look like a collapsed Agent list without changing the wire `content`.

#### 7) `src/external-runs.ts` — Live wait heartbeat (optional, low cost)
Thread `onUpdate` through `registry.wait` loop to emit `Waiting N/M — last outcome …` every 1s so tray doesn't look frozen. Reuses existing `emitActiveRunUpdate` pattern; behind `if (details.mode==="all")`.

### Non-goals (YAGNI)

* Live streaming of `external_runs list/inspect` — keep them as queries.
* Uncapping workflow children to unlimited — keep 6 but surface `… N more (M failed)` clearly.
* Unifying Agent+Workflow into one tool — keep distinct tiers; align *presentation* only.

### Agent-experience alignment (docs, not code)

* In `buildCoordinatorPrompt`, spell out the tiered mental model in one line: "Agent = 1 delegate; workflow = script of many delegates; external_runs = query/wait, not live rows." Already partly there — just tighten sentence.
* Normalize naming in docs/examples: `description` (Agent) vs `label` (workflow agent) — call it "label/description" everywhere so LLM doesn't guess.

### Acceptance

* Screenshots: Agent collapsed/expanded, single-agent workflow collapsed/expanded, and `external_runs wait` collapsed all share the same `✓/✗ label duration usage -> first-line` grammar.
* No `{"outcomes":[` appears in user-facing `content` for success paths; JSON only in `details` / paged `inspect` views.
* `workflow background:true` card says queued, not `running · 0/0`.

### File touch list (≤4 files)

* `src/workflow/tool.ts` (renderCall, result text, expanded branching, background snapshot, per-phase runningCount)
* `src/external-runs.ts` (renderResult for wait, optional wait heartbeat, preview reuse)
* `src/core/subagent-render.ts` — only if extracting `formatOutcomeLine` helper; otherwise no change
* `src/prompts.ts` — one-line coordinator clarification (optional)
