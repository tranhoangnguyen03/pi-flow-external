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
> Out of the box, the default harness is `agy` and the default permission is `danger` (full host access). Antigravity rejects `readonly` and `edit`. For enforced sandboxing, ask for a harness that supports it (such as `claude` or `codex`) and explicit read-only access.

---

## Requirements &amp; Install

1. **Host:** Pi `~0.99.2`.
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
- **Permission:** `readonly` (enforced sandbox: Claude cannot edit files or run shell commands)

*(Programmatic / Codemode equivalent):*

```ts
const receipt = await Agent({
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
await Agent({
  role: "reviewer",
  harness: "codex",
  permission: "readonly",
  prompt: "Review the refactoring plan we just discussed.",
  context: { mode: "recent", turns: 5 },
});
```

### 2. Background Runs &amp; Supervision

For long audits or explorations you don't want to wait for:

> **You:** "Have Claude run a security audit of our API routes in the background while we continue working."

Pi launches the run in the background, gives you a run ID, and keeps your chat session free.

- Check live progress or inspect output anytime with `/external runs`.
- Or ask Pi: *"How is that background security audit going?"*

*(Codemode):*

```ts
const receipt = await Agent({
  role: "reviewer",
  harness: "claude",
  permission: "readonly",
  prompt: "Audit security-sensitive endpoints.",
  background: true,
});

if (receipt.ok) {
  const runId = receipt.data.run.runId;
  await external_runs({ action: "wait", runIds: [runId], mode: "all" });
}
```

### 3. Multi-Agent Workflows (Parallel Delegation)

For tasks that benefit from multiple perspectives at once:

> **You:** "Run a parallel review: have Claude check for architectural issues while Codex audits test coverage."

Pi runs a trusted JavaScript workflow that runs both subagents simultaneously under a shared concurrency limiter:

*(Workflow script):*

```js
export const meta = { apiVersion: 1, name: "code-review", description: "Parallel review" };

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

Settings use version 5. If upgrading from an older version:

1. Run `/external` and choose **Preview format update…**, or run `/external config convert`.
2. Existing configurations, overrides, and disabled states are preserved.
3. See [Migration Guide](docs/migration-v4-to-v5.md) for full details and optional file purging.

---

## Documentation

- **[Harness Reference](docs/harness-reference.md):** Deep CLI flags, OpenCode 2 standalone server details, Muse session resume, Grok sandbox notes, and Pi in-process presets.
- **[Configuration Reference](docs/configuration-reference.md):** Settings v5 JSON schema, sparse inheritance, role overrides, and full command reference.
- **[Supervision &amp; Runtime](docs/supervision-and-runtime.md):** `external_runs` actions, cursor pagination, batch inspect, and byte budgets.
- **[Workflows](docs/workflows.md):** Scripting API, error handling (`ChildRunError`), and replay cache.
- **[Public Contract](docs/public-contract.md):** Contract envelope definitions for Pi codemode consumers.
- **[Troubleshooting](docs/troubleshooting.md):** Common errors, authentication checks, and `pi-cc-extensions` renderer compatibility.
