# Documentation Directory

Welcome to the `pi-flow-external` documentation suite. This directory contains user guides, architectural specifications, contributor runbooks, and design proposals.

---

## Documentation Map by Audience

### 🚀 For Users & Operators
Core reference guides for configuring and using the extension with Pi:

| Document | Purpose |
|---|---|
| **[Harness Reference](harness-reference.md)** | Sandboxing mechanisms, permission flags, session resume, and adapter specifics for Claude, Codex, Grok, Muse, OpenCode, Antigravity, and Pi. |
| **[Configuration Reference](configuration-reference.md)** | Interactive TUI navigation, settings v5 schema, sparse overrides, and full 34-row command table. |
| **[Supervision & Runtime](supervision-and-runtime.md)** | Live terminal intent cards, background execution, the `external_runs` tool, and local evidence storage. |
| **[Workflows](workflows.md)** | Scripting API, parallel fan-out (`parallel()`), `ChildRunError` handling, structured schemas, and replay cache. |
| **[Troubleshooting](troubleshooting.md)** | Diagnostic recipes, authentication checks, and `pi-cc-extensions` renderer compatibility. |
| **[Migration Guide (v4 → v5)](migration-v4-to-v5.md)** | Upgrading from older configurations, backups, command mappings, and safe file purging. |

---

### 💻 For Codemode & Script Integrators
Specifications for programmatic subagent delegation and tool outputs:

| Document | Status | Purpose |
|---|---|---|
| **[Public Contract v1](public-contract.md)** | `Normative Contract` | Schema definitions, envelope shapes (`{ ok, data, error }`), and delivery invariants for `Agent`, `workflow`, and `external_runs`. |

---

### 🛠️ For Maintainers & Contributors
Internal system architecture, testing procedures, and release processes:

| Document | Status | Purpose |
|---|---|---|
| **[Architecture Spec](maintainer/architecture.md)** | `Current Spec` | Component mapping, settings resolution order, and execution boundary invariants. |
| **[Field Testing](maintainer/field-testing.md)** | `Maintainer Runbook` | Offline check suite, fake-backend smokes, and real-provider E2E test execution lanes. |
| **[Releasing](maintainer/releasing.md)** | `Maintainer Runbook` | Automated release pipeline, versioning labels, OIDC trusted publishing, and npm checks. |
| **[Tool Schema Compatibility](maintainer/tool-schema-compatibility.md)** | `Investigation` | Downstream client schema compatibility notes (#62). |
| **[Maintainer Index](maintainer/README.md)** | `Overview` | Maintainer documentation suite index and active RFCs. |

---

### 🏛️ Historical Archives & RFCs
Non-normative proposals, design investigations, and dated implementation records:

| Directory | Status | Notes |
|---|---|---|
| **[Active RFCs](maintainer/rfcs/)** | `Design Direction` | Product vision (`delegation-experience-north-star.md`) and terminal visual styling guidelines. |
| **[Historical Archive](archive/README.md)** | `Historical Archive` | 38 dated milestone plans (`archive/plans/`) and codemode handoff bundle. |

---

## Document Status Legend

- **`Normative Guide` / `Normative Contract`:** Authoritative documentation reflecting current production behavior in version 3.x.
- **`Design Direction`:** Approved future UX/architectural targets; does not claim current implementation satisfies it.
- **`Historical Record` / `Archive`:** Preserved investigation notes and dated planning documents. Superseded where newer contracts exist.
