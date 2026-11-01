# pi-flow external

Delegate tasks from [pi](https://github.com/earendil-works/pi) to external AI coding harnesses and custom in-process models, with explicit permissions, live progress cards, and durable local receipts.

Supported harnesses:

- **Claude Code** (`claude`)
- **Codex CLI** (`codex`)
- **Grok Build CLI** (`grok`)
- **Muse Code** (`muse`)
- **Antigravity** (`agy`)
- **OpenCode** (`opencode`)
- **Named Pi harnesses** (`pi-<label>`) — in-process, per-model configs you register yourself

---

## How It Works

You ask Pi to delegate work in plain chat. Every delegation combines three elements:

1. **Role:** What the agent should do. Six built-in roles work out of the box on every harness: `explorer`, `planner`, `implementer`, `reviewer`, `qa`, and `worker`.
2. **Harness:** Where and how that role runs (`claude`, `codex`, `agy`, etc.).
3. **Permission:** The enforced access boundary (`readonly`, `edit`, or `danger`).

> ⚠️ **Security &amp; Defaults:**
> Roles describe **intent**; `permission` defines **authority**. Saying "read-only" in prompt text does not restrict an agent.
> Out of the box, the default harness is `agy` and the default permission is `danger` (full host access). Antigravity rejects `readonly` and `edit`. For restricted access, request a supported permission tier explicitly. Claude uses native tool restrictions; Codex uses an OS sandbox. See the permission matrix below.

---

## Requirements &amp; Install

1. **Host:** Pi `~1.3.0`.
2. **External CLIs:** Install and authenticate any external CLI you want to use (`claude`, `codex`, `agy`, `grok`, `muse`, or `opencode`). Pi and external CLIs manage authentication independently.

Install globally:

```bash
pi install npm:@tranhoangnguyen0310/pi-flow-external
```

Or project-only (requires project trust):

```bash
pi install -l npm:@tranhoangnguyen0310/pi-flow-external
```

---

## Quickstart

### 1. Verify your setup

Check installed CLIs, authentication, and harness availability:

```bash
/external doctor
```

### 2. Configure defaults (optional)

Run `/external` to open the interactive settings window. You can set your default harness, choose default models or reasoning levels, and manage roles.

### 3. Run your first delegation

Ask Pi in chat:

> **You:** "Use Claude Code to explore this repository and map key modules read-only."

Pi recognizes the request and delegates:

- **Role:** `explorer`
- **Harness:** `claude`
- **Permission:** `readonly` (native tool restrictions: Claude cannot edit files or run shell commands; not an OS sandbox)

*(Programmatic / Codemode equivalent):*

```ts
const receipt = await tools.external_delegate({
  description: "Map repository architecture",
  role: "explorer",
  harness: "claude",
  permission: "readonly",
  prompt: "Map repository architecture and list core modules.",
});

if (receipt.ok) {
  console.log(receipt.data.run.output.value);
}
```

Or using the default harness (`agy` — runs with full host access):

> **You:** "Explore this codebase and find the authentication entrypoints."

---

## Permission Matrix


| Harness    | `readonly`                          | `edit`                    | `danger` (default)                 | Notes                                        |
| ---------- | ----------------------------------- | ------------------------- | ---------------------------------- | -------------------------------------------- |
| `claude`   | ✅ `--permission-mode plan`          | ✅ `acceptEdits` (no bash) | ✅ `--dangerously-skip-permissions` | Root UID falls back to `auto`                |
| `codex`    | ✅ `--sandbox read-only`             | ✅ `workspace-write`       | ✅ `danger-full-access`             | Native kernel sandbox                        |
| `grok`     | ✅ `--sandbox read-only`             | ✅ `workspace`             | ✅ `off`                            | Readonly network block is Linux-only         |
| `muse`     | ✅ `--disable-write --disable-shell` | ✅ Sandbox ON              | ✅ `--yolo`                         | Danger trusts workspace                      |
| `opencode` | ✅ Deny-by-default rules             | ✅ Edit/write tools        | ✅ `--auto`                         | Standalone server; native tool rules         |
| `agy`      | ❌ Rejected                          | ❌ Rejected                | ✅ Supported                        | Full host CLI; 1 infra retry on auth/network |
| `pi-*`     | ✅ Curated read tools                | ✅ Curated edit tools      | ✅ Full SDK tools                   | Curated tool lists; not an OS sandbox        |


---

## Everyday Usage

You interact with external agents through natural conversation with Pi.

### 1. Context Sharing

When you want the subagent to understand your ongoing conversation:

> **You:** "Ask Codex to review the refactoring plan we just discussed."

Pi automatically packages recent conversation turns into the briefing:

- **Role:** `reviewer`
- **Harness:** `codex`
- **Context:** Shared recent conversation turns (`{ mode: "recent", turns: 5 }`)

*(Codemode):*

```ts
await tools.external_delegate({
  description: "Review refactoring plan",
  role: "reviewer",
  harness: "codex",
  permission: "readonly",
  prompt: "Review the refactoring plan we just discussed.",
  context: { mode: "recent", turns: 5 },
});
```

### 2. Foreground or Background?

**Use foreground when you need the result next.** Use background when independent local work can proceed first, or you want to leave the work running and check back in a later turn (ending a turn does not stop it). A long task alone does not need background mode.

Both `external_delegate` and `external_workflow` support these modes:

| | Foreground (default) | Background (`background: true`) |
|---|---|---|
| Original call returns | When the work finishes or fails | After registration, with a run ID; work may already have finished |
| Progress | Live execution card | A static launch receipt plus a live status bar count (`pi-flow N bg`); inspect with `/external runs` |
| Next step | Pi checks the returned outcome | Pi keeps the run ID and does independent work before collecting, or reports the ID and switches tasks/ends its turn if left running across turns |

> **You:** "Have Claude audit the API in the background while we review the release checklist. Then bring me the findings."

- **Status bar & completion wake-up:** UI sessions show active background runs in the footer status bar, notify on completion, and automatically queue a follow-up wake message when an uncollected background run finishes across turns. If Pi already collected the run in the same turn, no duplicate message is sent.
- **Keep Pi open:** background work belongs to its originating session, not a persistent service. Orderly shutdown requests cancellation with bounded cleanup; restart does not adopt unfinished work.
- **Stopping is different from waiting:** interrupting the original foreground call cancels it. Interrupting `external_runs wait` only stops waiting; use `/external runs` or `external_runs cancel` to stop background work.

Both modes allow parallel workflow children under the same concurrency limit. Background does not change permissions, enforce new budget limits, or make work inherently faster or cheaper. Prompt instructions such as “do not edit” express intent; the supported `permission` tier defines enforced restrictions.

See [launch → independent work → collect](docs/supervision-and-runtime.md#background-example-launch--independent-work--collect) for the operational example, result handling, and cancellation details.

### 3. Multi-Agent Workflows (Parallel Delegation)

**Choosing a good plan:** This package also installs the on-demand [pi-flow-orchestration skill](skills/pi-flow-orchestration/SKILL.md). It teaches Pi when to delegate once, parallelize independent scopes, pass evidence between stages, challenge claims independently, or run a user-authorized bounded repair loop. See the [Orchestration Playbook](docs/orchestration-playbook.md) for sample prompts and [runnable recipes](skills/pi-flow-orchestration/recipes). This is guidance, not a new workflow runtime or mandatory agent count.

For tasks that benefit from multiple perspectives at once:

> **You:** "Run a parallel review: have Claude check for architectural issues while Codex audits test coverage."

Pi first explains who will do what, what runs in parallel, what may change, and the expected result. It then uses `external_workflow` to run both subagents under a shared concurrency limiter. The live card shows the roadmap and actual child activity; `/external runs` provides inspection and cancellation.

*(Workflow script):*

```js
export const meta = {
  apiVersion: 1, name: "code-review", description: "Parallel review",
  phases: [{ title: "Review", detail: "Claude checks architecture while Codex checks test coverage; both use readonly access." }],
};

phase("Review");
const [arch, coverage] = await parallel([
  () => agent("Review architectural integrity read-only", { role: "reviewer", harness: "claude", permission: "readonly" }),
  () => agent("Audit test coverage read-only", { role: "qa", harness: "codex", permission: "readonly" }),
]);

return { arch, coverage };
```

---

## Configuration &amp; Commands

- `/external`: Interactive settings window (TUI &amp; RPC) to set defaults, manage models, and edit roles.
- `/external doctor`: Validates catalog and checks CLI / provider authentication.
- `/external runs`: Interactive viewer for active and completed runs, outputs, and diagnostics.

**Common CLI commands:**

```bash
# Config UI and Menu
/external config

```

---

## Upgrading from v4

Settings use version 5. If upgrading from version 4:

1. Run `/external` and choose **Preview format update…**, or run `/external config convert`.
2. Existing configurations, overrides, and disabled states are preserved.
3. See [Migration Guide](docs/migration-v4-to-v5.md) for full details.

Installations older than settings version 4 are blocked without changes. Convert them with `@tranhoangnguyen0310/pi-flow-external@5.5.0-external.2` first, then upgrade (steps in the [Migration Guide](docs/migration-v4-to-v5.md#upgrading-from-pre-v4-versions)).

### Upgrading from the `Agent` tool

The direct delegation tool `Agent` is now `external_delegate`, with no alias. Update codemode calls, hooks, and renderer exclusions. See [Tool Rename Migration](docs/migration-agent-to-external-delegate.md).

---

## Documentation

- **[Harness Reference](docs/harness-reference.md):** Deep CLI flags, OpenCode 2 standalone server details, Muse session resume, Grok sandbox notes, and Pi in-process presets.
- **[Configuration Reference](docs/configuration-reference.md):** Settings v5 JSON schema, sparse inheritance, role overrides, and full command reference.
- **[Supervision &amp; Runtime](docs/supervision-and-runtime.md):** `external_runs` actions, cursor pagination, batch inspect, and byte budgets.
- **[Workflows](docs/workflows.md):** `external_workflow`, plain-language plans, live phases, error handling (`ChildRunError`), and replay cache.
- **[Orchestration Playbook](docs/orchestration-playbook.md):** When to choose patterns, how to invoke the bundled skill, and tested example recipes.
- **[Workflow Tool Rename](docs/migration-workflow-to-external-workflow.md):** `workflow` → `external_workflow`, with no alias.
- **[Public Contract](docs/public-contract.md):** Contract envelope definitions (`external_delegate`, `external_workflow`, `external_runs`, `external_help`), `external_help({ topic: "contracts" | "capabilities" })` discovery, and explicit context-handoff guidance for Pi codemode consumers.
- **[Troubleshooting](docs/troubleshooting.md):** Common errors, authentication checks, and `pi-cc-extensions` renderer compatibility.
