# Issue 73: coherent harness and role configuration implementation plan

**Status:** Approved for implementation in this conversation. No release, remote writes, or live-user configuration conversion authorized.

**Goal:** Separate harness execution defaults from role instructions and complete configuration lifecycle without weakening execution guarantees.

**Architecture:** settings v5 owns scalar settings and gates; Markdown owns descriptions/instructions. A canonical catalog resolves sparse defaults into existing execution profiles. Existing runners remain the execution boundary. Native CLI defaults remain explicitly unresolved.

**Tech stack:** Existing TypeScript, Node filesystem APIs, Vitest, Pi editor/select/confirm. No dependencies.

## Contract

- Preserve `settings.json`, global defaults, and trusted-project defaultHarness-only scope.
- v5 `harnesses` accepts built-in CLI names and named pi-* entries. CLI entries optional; Pi entries require provider/model, thinking (default off), preset (default minimal).
- Harness scalar fields: model, thinking, enabled, plus Pi preset/owner. `roles` contains sparse role-specific model/thinking/max_budget_usd/tools/enabled. Role model/effort overrides apply on Pi too; preset remains harness-owned.
- Root `roles` contains role-wide enabled state only. Gate resolution is AND, never narrower escalation.
- `thinking`: omitted inherits; native omits CLI effort; parent snapshots root effort; explicit native backend effort validated by adapter rules. Fresh CLI fallback native, Pi fallback off. Migration pins parent on legacy CLI bindings, native on OpenCode.
- `model: native` selects native CLI model, including an explicit escape from a harness pin. Pi requires a real model. Scalar reset deletes only that property.
- `roles/<role>.md` owns shared description/body. `overrides/<harness>/<role>.md` owns instruction replacement only; backend identity comes from directory. Empty body is explicit empty instructions, never accidental inheritance. Absence means inherit. Nested paths prevent hyphen collisions.
- Legacy nonstandard exact identities are preserved in explicit v5 compatibility records, not guessed by splitting names. Ambiguous legacy selectors fail. Canonical binding keys use an unambiguous encoding; receipts retain human labels and explicit harness/role.
- Structured pair selection must agree across Agent, workflow, help and inspection. Invalid higher-priority entries block; unrelated invalid entries are diagnostics.
- Permission remains call > global default, never role metadata. Smoke tests use explicit readonly tier.
- Resolve effective effort and budget into workflow descriptors before hashing. Do not reuse cached native-unresolved execution as proven equivalent.
- Reset preserves enabled state. Disable preserves definitions. Delete custom definitions previews all owned paths/state and guards defaults. Before multi-file cleanup, persist a disable gate; cleanup failure leaves the entity blocked. Never delete receipts or native configuration.
- Built-in definitions cannot be deleted; reset or disable instead. Active runs and frozen workflows retain snapshots.

## Command contract

All new operations under `/external config harness` and `/external config role`:

- list; inspect NAME; create NAME; edit NAME; enable/disable NAME; set NAME flags; reset NAME flags; delete NAME.
- Harness `default NAME` selects the global default. `test NAME` is explicit readiness, separate from structural saving.
- Role operations accept `--harness NAME` for binding scope. model/effort/tools/budget require binding scope.
- set supports --model VALUE, --effort VALUE; binding also --budget VALUE and Pi --tools comma-list. Harness supports --preset minimal|skills for Pi.
- reset supports selected fields, --instructions for role customization, or confirmed broad reset. No reset implicitly enables.
- Deterministic editor-based creation/editing does not need an LLM. Optional role-authoring interview remains explicitly assisted.
- Remove superseded routes with precise old-to-new guidance in release notes and current help, not hidden aliases.

## Migration

- Explicit v4->v5 preview/apply; preserve an original snapshot. Never auto-convert on read.
- Preserve each full override body (including empty), description, model/native selection, effective legacy thinking policy, budget/tools, and exclusions independently.
- Copy instructions before v5 activation. Validate destinations; identical interrupted copies accepted; conflicting content fails. Revalidate originals before activation.
- Pre-v4 conversion remains staged through its existing conservative process, followed by v5 conversion, without introducing a second live resolver.
- No automatic six-file consolidation. Harness-wide promotion and instruction reset require a separate reviewed action.
- Ambiguous/nonstandard exact names preserve an explicit exact-selection mapping; do not silently drop or reinterpret them.

## Delivery and ownership

1. Parent: isolated baseline; contract; schema/catalog/resolution integration. Baseline: 515 tests and TypeScript pass, single worker.
2. Codex: bounded runtime correctness fixes in creator/spawn/workflow/adapter paths, focused existing tests. No catalog/schema overlap.
3. Parent: v5 core and authoritative tests. Codex then receives migration/persistence assignment with fixed schema.
4. Claude: lifecycle/inspection commands and tests against settled core API. Parent updates agent guidance/docs and integrates.
5. Cross-review: fresh focused review of other's work; parent verifies integrated behavior. No nested delegation.

## Verification per checkpoint

- Extend authoritative tests, demonstrate failure first for changed behavior, then minimal implementation.
- Run targeted suites per assignment. Full check uses `npm run check -- --maxWorkers=1 --minWorkers=1` due observed baseline timing sensitivity with default workers.
- Acceptance: one Codex default covers future roles; scalar exception copies no body; global role gate covers future harnesses; enable explains remaining gates; field reset preserves other values/gates; safe delete preview/failure; inspector and spawn agree; replay hashes effective values; unambiguous hyphenated bindings; migration preserves behavior; zero generated role files.
- Final: full typecheck/tests, package dry-run, production audit. Real-provider tests only if specifically warranted/authorized; don't claim offline checks establish account/model compatibility.

## Checkpoints

At every phase: report completed work, fresh checks, gaps/deviations, next assignment. Scope expansion or remote/destructive actions require approval. Real user settings remain untouched.
