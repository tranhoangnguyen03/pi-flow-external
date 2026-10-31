# Agent-first development principles

**Status:** Product and development direction. Apply to future design and review decisions; this document is **not** a description of new runtime features.

## North star

> **The agent sees useful work, hands it to the right helpers, uses their results, and keeps moving.**

Build `pi-flow-external` as an extension of an agent's capabilities, not as a procedure the agent must learn to operate. The principal user of the tool contracts, help, skills and recipes is a **parent agent already engaged in work**. It should spend its judgment on the actual task. Flow should remove orchestration effort, not replace it with planning paperwork.

The human still owns the objective and consequential authority. The parent owns task decomposition and integration. Children own the methods used to complete their bounded assignments. Each level should be equipped without micromanaging the next.

## The parent-agent journey is the product

| Moment | What the parent needs | What good development enables |
| --- | --- | --- |
| **Notice work** | Recognize where independent help is useful | Discover `external_delegate` and `external_workflow` without a skill-loading ritual |
| **Choose** | Decide whether tasks require coordination | One meaningful fork: independent assignments or a coordinated workflow, not a mandatory pattern taxonomy |
| **Brief** | Express objective, useful context, expected result and allowed action | Good defaults and flexible roles; no duplicated forms or boilerplate contracts |
| **Run** | Give work to capable child agents | Simple direct calls or composable JavaScript; use the runtime's existing facilities |
| **Observe** | Know whether work is underway and where to inspect | Truthful run/child state; no need to ask the model to excavate logs |
| **Use results** | Get the actual deliverable and relevant gaps | Easy canonical output, sensible evidence links and visible partial failures |
| **Continue** | Make the next useful decision | Adapt, reuse, investigate, integrate or stop without a forced loop |

Assess proposed changes against this whole journey. A feature that optimizes one isolated step while creating extra work at the next may be a net loss.

## Design principles

### 1. Work first, orchestration second

Let the agent describe **what needs doing** before choosing **how Flow should run it**. A single external assignment uses `external_delegate`; several independent assignments can use multiple direct calls; tasks requiring shared coordination, dependencies or a grouped result use `external_workflow`. Do not mistake the number of tasks for the need for a workflow.

Pattern names are useful examples, not a required classification step. The parent may invent and compose a better plan when the work calls for one.

### 2. Empower intelligent agents

Provide the child with a meaningful objective, sufficient context, intended output and relevant authority. Let it choose its investigative and implementation method. Treat built-in roles as helpful default instruction sets, not artificial qualifications for performing a task. A general `worker` is legitimate for broadly specified work; specialist roles are valuable when they improve outcomes.

Do not introduce fixed agent counts, approval ceremonies, mandatory subagents, question quotas or "one right workflow" instructions without a demonstrated need. Leave enough latitude for the parent to adjust to evidence as it arrives.

### 3. Progressive discovery beats duplicated instruction

Use three layers with distinct jobs:

1. **Tool descriptions and optional mode prompt:** concise tool descriptions are always available. A short orchestration nudge is injected only when `/external mode` is enabled. Keep routine context cost low.
2. **On-demand skill and examples:** help with nontrivial composition and real-world work shapes; easy to find, adapt and run. Never a compulsory prerequisite.
3. **Technical help and contracts:** exact schemas, capability-specific behavior, advanced failure/replay details and version-specific boundaries, retrieved when needed.

Avoid copying the same large manual into all three layers. The executable contract is authoritative for syntax and permitted behavior. Repo-only maintainer documents describe product direction; the skill and published user docs describe current usage.

### 4. Make composition feel like ordinary programming

Retain the expressive `agent()`, `parallel()`, sequential `await`, `pipeline()` and `phase()` helpers. Recipes demonstrate *useful techniques* and serve as starting points. They are not a second runtime or a mandatory workflow engine.

An agent should be able to author a small ad-hoc workflow without installing another package, creating a long-lived team or navigating multiple management screens. Improve the reachability of existing examples before increasing their number.

### 5. Context is material, not baggage

Send what the child needs to perform the assignment. Choose fresh context for an independent perspective; deliberately pass selected prior work for dependent steps. Do not conflate the parent's entire conversation, sibling transcripts, and relevant task evidence. Make necessary handoffs simple and explicit, while avoiding repeated reconstruction of already-known facts.

### 6. Continue from results, not run mechanics

A completed call is an opportunity to make progress on the task, not the end of a workflow ceremony. Help the parent find the actual answer, what remains unverified, and the next useful action. Large outputs, background execution, and partial failures should be understandable with existing inspection tools.

A successful tool operation is not proof that the assignment met its objective. Preserve this distinction, but do not force the parent to study the entire receipt schema when a normal result is available.

### 7. Trustworthy behavior should be built in, not endlessly narrated

Authority, sandbox constraints, tool-level validation, run outcomes and evidence integrity are runtime concerns and precise technical-reference concerns. Keep them correct and discoverable without filling every parent turn with repeated warnings.

"Agent-first" does **not** mean covert edits, silent permission escalation, unsupported assumptions of completion or hidden failures. It means sensible defaults, truthful interfaces and fewer redundant steps. Follow the user's existing authorization, not a new fixed approval gate.

### 8. Evaluate friction on real agent journeys

A test proving a recipe parses is useful but does not prove an agent discovers or uses it. Compare actual parent-agent task attempts with the **same** tools, harnesses and goal before and after guidance changes. Observe:

- Whether the agent chose an appropriate direct call or coordinated workflow.
- Time/calls until useful work was delegated and results were used.
- Extra skill/help reads, corrected arguments, boilerplate or unnecessary child launches.
- Completion quality, missing evidence, user steering, recovery from imperfect outputs, cost and latency where measurable.

Treat synthetic child runs as contract evidence, not empirical proof of a better parent experience. If live providers are unavailable, report that limitation; do not fabricate a quality result. Prefer a small matched trial to a large speculative evaluation framework.

## How to review a change

Ask: **Which step in the parent-agent journey becomes easier?** Then ask what new choices or work it imposes on the parent, child and human. Test the most direct task path, a coordinated multi-task path and continuation after an incomplete result when relevant.

Prefer edits that remove repeated guidance, clarify confusing choices, reuse existing tools and keep the work moving. Add runtime features only when simpler guidance and examples cannot solve observed friction.

## Scope and adjacent contracts

This principle applies across delegation tool descriptions, system-prompt injection, roles, skills, workflow examples, help and results.

- [Delegation experience north star](rfcs/delegation-experience-north-star.md) covers the **human supervisor's** visibility and inspection. This document covers the **agent operator's** work journey. Both should reinforce each other.
- [Orchestration evaluation](orchestration-evaluation.md) is the home for comparison scenarios and measurements.
- [Architecture](architecture.md), the [public tool contract](../public-contract.md) and actual implementation remain authoritative for mechanics and current behavior.
- The installed [orchestration skill](../../skills/pi-flow-orchestration/SKILL.md) and [user playbook](../orchestration-playbook.md) provide user/agent-facing guidance; do not promote this maintainer document into a mandatory user workflow.

No additional agent runtime, review system, persistent team, approval flow or compatibility-breaking API is implied by these principles.
