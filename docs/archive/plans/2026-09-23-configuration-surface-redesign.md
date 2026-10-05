# Configuration surface redesign — proposal and delivery plan

**Status:** Implemented, then amended. The shipped conversion command is `/external settings convert`; `/external settings` points there. A later approval removed permission floors, profile `permission` metadata, and the PR #59 capability-set runtime. Shared roles are cross-harness and describe intent. Each named Pi registration selects preset `minimal` or `skills` (`minimal` when the field is absent). `minimal` leaves skills unloaded. `skills` loads installed skills, and project skills only when the project is trusted. Extensions and prompt templates stay unloaded. The proposal below is unchanged history except this status line.

**Goal:** One extension-owned home, one execution-settings file, six built-in roles with zero generated profile files, and one file per genuinely authored role.

**Architecture:** Roles describe work; harnesses describe execution. Resolve them into the existing internal profile shape at the execution boundary. Keep the current Agent/workflow selection contract, backend runners, permission floors, and evidence formats.

**Tech stack:** Existing TypeScript, Node filesystem APIs, Markdown/frontmatter parser, Pi command/UI APIs, Vitest. No new configuration language or dependency.

## 1. Diagnosis grounded in the repository

- `src/defaults.ts` writes six roles for each of five CLIs into the shared `subagents/` directory, with three historical seed markers. The file count grows with the role × harness product.
- `src/default-roles.ts` already owns the six canonical definitions. `src/profiles.ts` already synthesizes those roles for named Pi harnesses. There is no need for disk materialization on CLI harnesses.
- `src/settings.ts` owns runtime settings while `src/harnesses.ts` independently owns named Pi model settings. Their loaders and writers have different lifecycle behavior.
- `src/profile-creator.ts` combines role authoring and harness registration into a three-way interview called “profile create”, and enforces harness-qualified role filenames.
- Catalog consumers do not all share the same composition path. Agent/help/workflow use Pi synthesis, but `src/external-command.ts` lists disk profiles directly. Thus command discovery can disagree with executable availability.

This is a modeling and ownership problem, not simply too many JSON files.

## 2. Recommended user model

Only three configuration concepts:

1. **Settings:** default harness, concurrency, timeouts, permission/budget defaults, retention.
2. **Harnesses:** where and how a role executes — CLI backend or named Pi model configuration.
3. **Roles:** the work instructions, description, and permission floor.

“Profile” remains an internal resolved execution object, not a user-facing command concept. The five first-class CLI harnesses are **agy, claude, codex, grok, and muse**, alongside registered named Pi harnesses. Every applicable flow, catalog, help surface, and verification matrix must cover all five—not a historical subset.

A fresh installation needs no role authoring. The six built-ins are available in memory. A configured backend is not necessarily installed/authenticated: discovery and readiness remain distinct.

## 3. Storage contract

```text
$PI_CODING_AGENT_DIR/pi-flow-external/
  settings.json             # only execution-configuration file; optional with defaults
  roles/                    # only user-authored shared roles; created on demand
    security-reviewer.md
  overrides/                # optional exact execution profiles; never generated
    claude-reviewer.md
  runs/                     # existing operational evidence, not configuration
```

Do not create empty directories. Reads do not write defaults. Retain `settings.json` rather than introduce a new `config.json` path for cosmetic reasons. Do not write into Pi's root settings file or native `subagents/` directory.

Markdown is intentionally separate from JSON: long instructions are authored content, not scalar settings. This is one configuration home, not a promise that every artifact must be escaped into one enormous JSON file.

### Settings v4

Preserve existing field names and units. Example:

```json
{
  "version": 4,
  "defaultHarness": "pi-deepseek",
  "maxConcurrentSubagents": 12,
  "subagentTimeoutMs": 7200000,
  "defaultPermission": "danger",
  "defaultMaxBudgetUsd": null,
  "maxRunRecords": 200,
  "harnesses": {
    "pi-deepseek": {
      "model": "deepseek/deepseek-chat",
      "thinking": "high"
    }
  },
  "disabledProfiles": ["codex-explorer"]
}
```

The five CLI harnesses are built in; no five-entry boilerplate is required. Named `pi-*` entries retain their current model/thinking contract and optional owner metadata. `disabledProfiles` is an explicit list of exact execution identities, supporting deliberate exclusions and migration of deleted defaults. Empty maps/lists may be omitted.

For this release, do not add named CLI aliases or a new matrix of per-role JSON overrides. Existing per-role CLI model/thinking customizations remain exact Markdown overrides. A later harness-wide CLI model default could use the same harness section, but is not necessary to fix this surface.

### Shared role

`roles/security-reviewer.md`:

```markdown
---
description: Review security-sensitive changes and report actionable findings.
permission: readonly
---
Review the supplied changes without editing files. Prioritize exploitable
issues, cite locations, and distinguish verified findings from speculation.
```

- One file works with any harness. Do not require a backend prefix.
- Shared roles have no backend/model/thinking fields; reject these with an actionable diagnostic rather than silently ignoring them.
- A shared file named `reviewer.md` intentionally replaces that built-in role across harnesses.
- Role instructions and permission floors do not erase backend differences: agy remains unsandboxed and a CLI does not gain Pi's curated tool enforcement.
- Backend-specific tools/model/budget/instruction customizations belong in an exact override, retaining the existing profile schema. Explain that `tools` is enforceable only on Pi, as today.

### Exact override

`overrides/claude-reviewer.md` preserves the existing profile format. It is a complete replacement, not a field-by-field or prompt-body merge. This supports customized legacy profiles without forcing users to rewrite them or accidentally spreading a backend-specific prompt to other harnesses.

Nonstandard legacy exact names remain exact-only through `subagent_type`. New guided overrides use `<harness>-<role>` names.

## 4. Resolution and lifecycle

At a direct invocation, load one validated configuration/catalog snapshot. A workflow freezes that same snapshot once for its entire run.

1. Select harness: explicit call > trusted project default > global default > built-in default.
2. Reject unknown harnesses and explicitly disabled execution identities.
3. Select role definition: exact override > shared custom role > built-in role.
4. Bind the selected definition to the chosen harness and produce the existing internal profile.
5. Reconcile Pi model/thinking against its named harness, resolve current permission floors/budgets, and launch through existing runners.

Important details:

- An invalid higher-priority override blocks that selection; it must not silently disappear and expose a lower-priority default.
- Unrelated invalid entries are diagnosed without preventing unrelated valid role execution. Invalid global JSON or an unsupported schema version blocks delegation rather than silently running with a different execution configuration; inspection and settings conversion remain available.
- Disabled identities block both `role` selection and exact `subagent_type` selection.
- No fallback to another harness.
- Preserve stable `<harness>-<role>` identities and exact legacy names in receipts and workflow descriptors.
- Preserve current permission-floor semantics, including backend execution-lane floors. This redesign does not change permission policy.
- Keep the trusted project's existing path and `defaultHarness`-only allow-list. Do not add project role/harness injection or generalized deep merging.
- Manual edits use `/reload` consistently. Guided saves become available for the next invocation; running children and frozen workflows retain their prior snapshot. Do not automatically reload Pi while children are active.
- One catalog composition function serves Agent, workflows, coordinator guidance, external_help, `/external roles`, and doctor. Consumers may format it differently; they must not rediscover different rosters.

### Writes

All settings mutations use one validated read-modify-write helper with private staged files and same-directory atomic replacement. Preserve unrelated fields; refuse to overwrite malformed/future-version files. Smoke-test a harness before entering the short commit window, then reread and check duplicate/conflict conditions.

Atomic replacement prevents torn writes, not all multi-process races. Keep the currently accepted concurrent-writer limitation explicit; do not pretend consolidation creates a transaction database. Do not expand this redesign into a lock service. Migration revalidates source fingerprints before commit and refuses observed changes.

## 5. Command experience

Keep `/external` as the single entrypoint and reuse standard Pi dialogs.

| Command | Result |
|---|---|
| `/external` | Overview: default harness/source, roles, harnesses, configuration path, actionable problems |
| `/external settings` | Effective values with origins; same canonical JSON path |
| `/external settings edit` | Edit and validate canonical settings with the standard editor |
| `/external harnesses` | CLI/Pi list, model/thinking where configured; readiness separate from registration |
| `/external harness create` | Register a named Pi harness; no role interview |
| `/external roles` | Six built-ins plus user roles; show restrictions/overrides without dumping the Cartesian product |
| `/external role create` | Author a reusable role once |
| `/external role inspect <role> [harness]` | Effective instructions, source, model, permission floor, and actual backend authority |
| `/external role override <role> <harness>` | Materialize just one intentional full override |
| `/external doctor` | Validate config/catalog and report runtime readiness separately |
| `/external [danger]purge-old-files` | List and explicitly delete obsolete extension files; secondary maintenance operation, not setup or migration |

Existing run/workflow commands are unchanged. Remove `/external profiles`, `/external profile create`, and `/pi-flow-profile create`, including registrations, completions, interview routing, and advertised instructions. No compatibility aliases or redirect handlers. Ordinary unknown-command help lists the new commands. The literal `[danger]` is part of the purge subcommand spelling.

This is a breaking command-surface change. Announce removed commands and their replacements in release notes, CHANGELOG, and the upgrade section before release. This decision does not independently remove the Agent/workflow `subagent_type` API; that remains a separate compatibility contract, not a slash-command alias.

Typical overview:

```text
External agents
Default: pi-deepseek (global)
Roles: 6 built-in · 1 custom · 1 harness override
Harnesses: 5 CLI · 1 named Pi
Settings: ~/.pi/agent/pi-flow-external/settings.json
```

Role creation is offline validation and writing of authored content. A role is not an authenticated connection. Real readiness smoke testing belongs to harness registration/testing, not one paid call per role × harness pair. Do not claim that a harness smoke proves role quality.

## 6. Upgrade and secondary destructive cleanup

Separate **configuration conversion** from **file deletion**. Normal use must never require a purge. Stop seeding immediately; new commands write only the new layout. Do not build a migration dashboard, archive service, or long-lived dual-layout mode.

### One-time upgrade

On detecting a pre-v4 installation, offer one conversion through `/external settings`: combine valid settings and named harness registrations, copy customized external profiles into exact overrides, and record deleted seeded identities using the historical seed cohorts. Leave original files in place as the recovery copy. Recognize unchanged generated content conservatively; uncertain valid external content is preserved as an override, not discarded.

Validate before activation; conflicting destinations or malformed inputs produce concrete diagnostics instead of lossy conversion. Install copied overrides before atomically activating v4. Before activation, staged copies are not live catalog inputs. Retrying an interrupted conversion accepts identical copies and rejects differing collisions. Once v4 is active, old sources are ignored rather than merged or used as fallback. New runtime consumers use only the canonical catalog; conversion is an isolated upgrade helper, not a second resolver.

Older configurations requiring conversion get an actionable setup error on delegation, not a silent run with new defaults. The settings command remains usable to finish conversion. No `/external migrate` command and no old-command aliases.

### `/external [danger]purge-old-files`

A small, explicit destructive maintenance operation. List the exact candidate paths and indicate whether customized content has been copied; one confirmation authorizes deletion. It is a purge, not an archive or conversion operation. Require completed v4 conversion so it cannot erase the only active harness registry or deletion markers before their intent is captured.

Cleanup inventory:

| Candidate | Scope |
|---|---|
| Legacy seeded profiles | The exact 30 `<agy|claude|codex|grok|muse>-<explorer|planner|implementer|reviewer|qa|worker>.md` names under the old `subagents/` directory |
| Legacy custom CLI profiles | Harness-prefixed Markdown files declaring the matching external backend |
| Legacy named Pi profiles | `pi-<label>-<role>.md` declaring `backend: pi` and the matching external harness; identify declarations structurally, not by current registry membership alone |
| Seed markers | Exact `.pi-flow-defaults-seeded-v1`, `-v2`, and `-v3` files |
| Old harness registry | Exact `pi-flow-external/harnesses.json` path |

Be aggressive within that inventory: customized legacy copies can be purged too, not only byte-identical defaults. Unique names narrow candidate discovery, but contradictory native-Pi metadata excludes a file. Nonstandard exact-only legacy profile names are listed separately for explicit selection, not caught by an unrestricted glob. Skip symlinks and nonregular entries; do not recurse.

Never remove the whole `subagents/` directory, native/unrelated profiles, current settings, roles, overrides, project configuration, or run evidence. Report deleted/skipped/failed paths; repeat invocation is harmless. If a file changes after preview, skip it and report the change.

One small table-driven filesystem test covers the inventory: all five CLI prefixes, named Pi files, customized candidates, marker/registry cleanup, unrelated/native files, symlinks, and repeat invocation. Extend this one check for regressions rather than creating a cleanup framework or duplicating coverage.

Release communication must explicitly state: old commands are removed; v4 ignores old locations; purge deletes old custom copies too; downgrade after purge requires the user's own backup. Do not promise simultaneous old/new-version support or dual-write either layout.

## 7. Alternatives rejected

1. **Move the 30 files elsewhere:** tidier directory, same duplication and upgrade machinery.
2. **Put all profiles/prompts into one JSON document:** fewer files, still a role × harness matrix and worse authoring.
3. **Only virtualize defaults:** fixes the immediate explosion but leaves custom-role duplication, confused creation flow, and split configuration ownership.
4. **General configuration framework:** arbitrary inheritance, includes, environment interpolation, role packs, project overlays, and named CLI aliases are not necessary here.

## 8. Delivery plan

Implement as one coordinated release behind a coherent final contract, using reviewable internal commits. Do not ship an intermediate release that advertises new roles but forgets migration or workflow resolution.

### Phase 1 — unified configuration contract

**Files:** `src/settings.ts`, `src/harnesses.ts`; `test/settings.test.ts`, `test/harnesses.test.ts`.

- Extend v4 with harness registrations and disabled identities; optional-on-disk defaults.
- Introduce one canonical loader/writer and isolated one-time legacy conversion; retain harness validation/domain helpers without independent storage ownership. Do not retain a legacy runtime read adapter.
- Test missing versus malformed files, supported/future versions, config precedence, unrelated-field preservation, invalid harness entries, and no writes on reads.
- Preserve project trust and defaultHarness-only behavior.

### Phase 2 — roles and the one effective catalog

**Files:** `src/default-roles.ts`, `src/defaults.ts`, `src/profiles.ts`, `src/types.ts`, `src/pi-subagent.ts`, `src/workflow/tool.ts`, `src/external-help.ts`; `test/defaults.test.ts`, `test/profiles.test.ts`, `test/agent-contract.test.ts`, `test/workflow.test.ts`, `test/replay-cache.test.ts`.

- Replace seeding with shared in-memory synthesis for CLI and Pi harnesses.
- Load shared authored roles and exact overrides in the extension namespace.
- Build one catalog with source provenance and diagnostics; wire all execution/catalog consumers to it.
- Replace seeding tests with the authoritative zero-generated-files contract; test role precedence, disabled identities, native-profile exclusion, invalid-override blocking, and exact aliases.
- Extend workflow coverage to prove frozen role/model snapshots and fingerprint behavior. Preserve replay only when the effective descriptor is identical; changed instructions must invalidate reuse.

### Phase 3 — one-time upgrade; secondary purge

**Files:** new `src/config-upgrade.ts`, new `test/config-upgrade.test.ts`; purge helper alongside upgrade code, command routing in `src/external-command.ts`.

- Implement the one-time conversion invoked from settings; preserve originals, validate copies, activate v4 last, and keep conversion outside normal catalog resolution.
- Cover legacy cohorts, custom/deleted/native profiles, malformed inputs, destination collisions, and restart after interrupted activation at the lowest useful layer.
- Add the exact cleanup inventory and one small table-driven filesystem test for `/external [danger]purge-old-files`.
- Cleanup is secondary: it is not a prerequisite to delegation after conversion and must not grow into a compatibility subsystem.

### Phase 4 — coherent human and agent surfaces

**Files:** `src/external-command.ts`, `src/profile-creator.ts`, `src/external-help.ts`, `src/prompts.ts`; `test/external-command.test.ts`, `test/profile-creator.test.ts`, `test/external-help.test.ts`.

- Split role authoring from harness registration; point both at canonical storage.
- Reuse standard editor/select/confirm dialogs; no custom configuration dashboard framework.
- Show effective source and real execution boundaries. Stop reporting profile-file counts as available capability.
- Delete old command registrations, completions, routing and creator activation paths; test their absence and the new command destinations, not cosmetic prose.
- Update human-facing command descriptions and agent-facing creator tool schemas, activation rules, interview instructions, errors, coordinator catalog, and external_help together. No instruction may send a user or agent to a removed command or inactive finalizer.

### Phase 5 — documentation and verification

**Files:** `README.md`, `AGENTS.md`, `docs/ARCHITECTURE_SNAPSHOT.md`, `docs/field-testing.md`, release notes/CHANGELOG and package version per release policy.

- Lead quick start with built-in roles, not “create a profile.” Explain one home and the role/harness distinction, consistently naming agy, claude, codex, grok, muse, and named Pi harnesses.
- Ship an explicit breaking-update notice with old→new command mapping, settings conversion instructions, custom-role/override examples, purge inventory and deletion risks, and downgrade limitations. Coordinate semantic versioning with the repository release policy; do not hide the break in a patch note.
- Mark historical design documents superseded rather than rewriting history.
- Run `npm run check` (typecheck plus deterministic offline tests), `npm pack --dry-run --json`, and `npm audit --omit=dev --audit-level=high` before release.
- Run change-triggered real-backend direct/workflow smoke checks using the existing opt-in E2E harness, including one named Pi harness. Verify migrated custom configuration and frozen workflow behavior; do not rely on auth-blocked lanes as passing evidence.
- Use a routing smoke because catalog/command guidance changes. Verify no new subagent files appear across first start, reload, harness registration, and upgrade.

## 9. Flow integrity and acceptance criteria

Documentation and instructions are part of each feature, not a final cleanup pass. Every phase must identify its human entrypoint, agent entrypoint, authoritative data source, validation/error route, persistence effect, next action, and affected instruction/doc surfaces.

Review these complete journeys before release:

| Journey | Required self-consistency |
|---|---|
| Fresh install → discover → delegate | Six built-ins; all five CLI harnesses and named Pi support represented accurately; no profile creation prerequisite |
| Register Pi harness → inspect → Agent/workflow | One settings write; roles immediately visible for subsequent calls; same model binding in both execution paths |
| Create shared role → choose any harness | One authored file; creator, help, catalog, selection, and receipts agree |
| Create exact override → inspect → execute | Explicit source/precedence and actual backend permission boundary; no silent fallback on errors |
| Edit settings → next invocation | Report when values take effect; frozen active workflows remain unchanged |
| Upgrade → delegate → optional purge | Conversion preserves effective configuration; deletion is separate; removed commands are never advertised |
| Bad config or unavailable backend → recover | Error names the real problem and a command that exists; no hidden harness substitution |

Instruction-surface inventory: README quick start/reference/troubleshooting; AGENTS.md; architecture and field-testing docs; release notes/CHANGELOG; slash-command descriptions/completions; creator interviews/tool schemas/activation; Agent/workflow schemas and examples; coordinator prompt/catalog; external_help; validation/error next-step text; E2E fixtures. Audit all of these for old commands, old paths, stale backend lists, and incompatible lifecycle claims. Preserve historical plans as history, marked superseded where appropriate.

Acceptance criteria:

- Fresh installation generates zero default profile files and zero seed markers.
- Adding a harness generates zero role files.
- Seven authored roles require seven authored role files, not seven times the number of harnesses.
- Runtime configuration and named Pi model bindings have one authoritative file.
- Native Pi subagent files are never changed by ordinary operation.
- Every discovery surface agrees with actual resolution.
- Existing custom prompts/model pins/tools/budgets and deleted-default intent survive migration.
- Existing Agent/workflow selectors, permission floors, cancellation, evidence, and replay invariants remain intact; legacy slash commands are removed, not aliased.
- Grok and Muse appear alongside agy, Claude, and Codex in every applicable discovery, authoring, instruction, and verification surface.
- Purge has a bounded inventory and one focused automated filesystem check; ordinary use does not require cleanup.
- No obsolete seeder, independent harness-store writer, or second active configuration source remains after migration.

## 10. Consultation record and limits

Requested four independent read-only reviews:

- **agy:** completed architectural proposal; supports virtual defaults, unified settings, and reusable roles.
- **Claude:** failed before reviewing because configured `claude-opus-5.5` was unavailable/inaccessible.
- **Grok:** failed before reviewing because the readonly sandbox rejected a symlinked runtime socket path.
- **Muse:** emitted substantive design analysis agreeing on virtual defaults and one settings store, but the run failed its verified-final-result boundary. Used only as advisory text, cross-checked against source.

No failed runs were retried or silently moved to a different model/permission tier. A separate Bro consultation was quota-blocked. This proposal is the parent synthesis from repository inspection plus the successful agy review and explicitly unverified Muse analysis, not a claim of four-way consensus.

Important corrections to the advisory proposals: do not keep authoring new overrides in native `subagents/`; do not automatically delete defaults; do not resurrect deliberately deleted profiles; do not promise replay compatibility without comparing effective descriptors; do not treat atomic rename as full concurrent-writer protection.
