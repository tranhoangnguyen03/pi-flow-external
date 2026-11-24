# Harness Reference

Detailed specifications, sandbox mappings, resume capabilities, and runtime behaviors for all supported harnesses in `pi-flow-external`.

---

## Overview

| Harness | Execution Engine | Enforced Sandbox | Session Resume | Budget Enforcement | Auto-Retry |
|---|---|---|---|---|---|
| `claude` | Claude Code CLI | ✅ Native permission modes | ✅ Native (`--resume`) | ✅ Native (`--max-budget-usd`) | ❌ None |
| `codex` | Codex CLI | ✅ Kernel sandbox | ✅ Native (`exec resume`) | ⚠️ Unenforceable (estimated) | ❌ None |
| `muse` | Muse Code CLI | ✅ Process sandbox | ✅ Native (`--session-id`) | ❌ Unknown cost | ❌ None |
| `agy` | Antigravity | ❌ Unsandboxed only | ✅ Native (`--conversation`) | ❌ Unknown cost | ✅ 1 infra retry |
| `pi-*` | In-process Pi SDK | ⚠️ Curated tool lists | ❌ Not supported | ⚠️ Unenforceable | ❌ None |

---

## 1. Claude Code (`claude`)

- **CLI Check:** `claude --version`
- **Permission Mapping:**
  - `readonly`: `--permission-mode plan` (denies shell and file edits).
  - `edit`: `--permission-mode acceptEdits` (permits file modifications; denies Bash commands headlessly).
  - `danger`: `--dangerously-skip-permissions` (unrestricted host execution).
- **Root UID Fallback:** When running as UID 0 (root), Claude refuses `--dangerously-skip-permissions`. The adapter automatically falls back to `--permission-mode auto`.
- **Budgets:** Natively enforces `max_budget_usd` mid-flight using `--max-budget-usd`.
- **Session Resume:** Supports `resume: "<runId>"` forwarding to Claude's native `--resume`. Sessions persist in Claude Code's local storage.

---

## 2. OpenAI Codex CLI (`codex`)

- **CLI Check:** `codex --version`
- **Permission Mapping:**
  - `readonly`: `--sandbox read-only`
  - `edit`: `--sandbox workspace-write`
  - `danger`: `--sandbox danger-full-access`
- **Sandbox Boundary:** Enforced via Codex's native platform kernel sandboxing.
- **Budgets:** Costs are calculated locally from price tables; `max_budget_usd` is recorded in receipts but cannot be enforced mid-run.
- **Session Resume:** Resumes via `codex exec resume <sessionId>`.

---

## 3. Muse Code (`muse`)

- **CLI Check:** `muse --version` (verified against 1.3.0 on `meta` provider).
- **Permission Mapping:**
  - Every tier passes `--disable-approval` so headless runs never hang on prompts.
  - `readonly`: Adds `--disable-write --disable-shell`.
  - `edit`: Retains process sandbox with write enabled.
  - `danger`: Passes `--yolo`, which disables approval, turns off the sandbox, and trusts the workspace for this run (loading local rules/skills).
- **Budgets:** Muse does not report token usage or cost; receipts report `costKnown: false`.
- **Session Resume:** Verified via `--session-id <uuid>`. Cross-process session continuity preserves shared memory context.

---

## 4. Antigravity (`agy`)

- **CLI Check:** `agy --version`
- **Permission Mapping:** Only supports `--dangerously-skip-permissions`. Requests for `readonly` or `edit` are rejected.
- **Infrastructure Retry Exception:** While this extension generally enforces a strict no-auto-retry contract, `agy` is granted **one automatic retry for infrastructure-classified failures** (network drops, auth expiration, quota eligibility errors). It never retries task-level failures, model errors, or aborts. The retry is disclosed in receipt metadata.
- **Budgets:** Cost is not reported; budgets are unenforceable.
- **Session Resume:** Resumes using `--conversation <sessionId>`.

---

## 5. Named Pi Harnesses (`pi-<label>`)

A named Pi harness runs in-process using Pi's own SDK, targeting any provider and model supported by Pi's model registry.

- **Registration:**
  ```bash
  /external config harness create pi-fast --model <provider/model> --effort low --preset minimal
  ```
- **Resource Presets:**
  - `minimal` (default): Extensions, prompt templates, themes, and installed skills are not loaded.
  - `skills`: Loads installed skills from `DefaultResourceLoader`. Project-local skills load only if the repository is marked trusted.
- **Curated Tool Surface:**
  - `readonly`: `read`, `grep`, `find`, `ls`
  - `edit`: `read`, `grep`, `find`, `ls`, `edit`, `write`
  - `danger`: `read`, `bash`, `edit`, `write`
  - ⚠️ **Notice:** Curated tool lists restrict tool definitions; they are **not an OS sandbox**. `bash` at `danger` provides unrestricted host access.
- **V1 Scope Limitations:**
  - Cannot resume previous conversations.
  - Budget caps are unenforceable.
  - SDK auto-retries are disabled per child in memory to maintain extension predictability.

---

## Related Documentation

- **[Configuration Reference](configuration-reference.md):** Managing harnesses, setting default models, and command line tools.
- **[Supervision & Runtime](supervision-and-runtime.md):** Inspecting and supervising runs across backends.
- **[Public Contract v1](public-contract.md):** Canonical execution and error envelope schemas.
