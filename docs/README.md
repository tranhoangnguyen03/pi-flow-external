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
| **[Architecture Snapshot](ARCHITECTURE_SNAPSHOT.md)** | `Current Spec` | Component mapping, settings resolution order, and execution boundary invariants. |
| **[Field Testing](field-testing.md)** | `Maintainer Runbook` | Offline check suite, fake-backend smokes, and real-provider E2E test execution lanes. |
| **[Releasing](releasing.md)** | `Maintainer Runbook` | Automated release pipeline, versioning labels, OIDC trusted publishing, and npm checks. |

---

### 🎨 Design RFCs & Historical Archives
Non-normative proposals, design investigations, and dated implementation records:

| Document / Directory | Status | Notes |
|---|---|---|
| **[Delegation North Star](delegation-experience-north-star.md)** | `Design Direction` | Product vision for supervisor UX and assignment tracking (non-normative). |
| **[Visual Guidelines](delegation-visual-guidelines.md)** | `Design Direction` | Terminal card palette, semantic coloring, and contrast rules. |
| **[Tool Schema Compatibility](tool-schema-compatibility.md)** | `Historical Record` | Investigation notes for downstream client schema compatibility (#62). |
| **`plans/`** | `Historical Archive` | 38 dated design specifications and implementation plans from prior development milestones. |
| **`pi-flow-external-codemode-handoff/`** | `Historical Archive` | Checksummed handoff bundle for the codemode contract implementation. |

---

## Document Status Legend

- **`Normative Guide` / `Normative Contract`:** Authoritative documentation reflecting current production behavior in version 3.x.
- **`Design Direction`:** Approved future UX/architectural targets; does not claim current implementation satisfies it.
- **`Historical Record` / `Archive`:** Preserved investigation notes and dated planning documents. Superseded where newer contracts exist.
