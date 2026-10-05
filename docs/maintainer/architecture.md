# pi-flow-external — Architecture Snapshot

This is the current implementation map for settings v5 and the guided configuration window. Read [CONTEXT.md](../../CONTEXT.md) for vocabulary and [AGENTS.md](../../AGENTS.md) for contributor invariants. [README.md](../../README.md) owns user journeys and command syntax.

Dated files under `docs/archive/plans/` and released changelog sections are historical evidence, not competing runtime contracts. Offline checks do not reverify past live-provider receipts. Current verification procedures are in [field-testing.md](field-testing.md); publication procedures are in [releasing.md](releasing.md).

## 1. Entry points and execution environments

`index.ts` loads `src/pi-subagent.ts`. The ordinary driver sees `Agent`, `external_help`, `external_runs`, and optional `workflow`. Assisted authoring finalizers are exposed only during `/external config role assist` or `/external config harness assist`.

Six built-in CLI harnesses (`agy`, `claude`, `codex`, `grok`, `muse`, `opencode`) and registered `pi-*` harnesses share the same role-selection path. Pi harnesses run in-process through the SDK with the parent's model registry, not through a spawned CLI. Native Pi `subagents/` files are outside this catalog and are never modified.

## 2. Configuration ownership and resolution

The only execution settings source is `$PI_CODING_AGENT_DIR/pi-flow-external/settings.json`, version 5. Missing settings use in-memory defaults without writing files. Invalid settings block delegation; v4 is readable for explicit migration/legacy inspection, not normal execution.

| On-disk owner | Contents |
| --- | --- |
| Global settings fields | Default harness, concurrency, timeout, permission, budget, retention |
| `harnesses.<name>` | CLI defaults or named Pi registration; model, thinking, enabled state; Pi preset |
| `harnesses.<name>.roles.<role>` | Sparse binding model/thinking/tools/budget exceptions and enabled gate |
| `roles.<role>` | Role-wide enabled gate |
| `exact.<selector>` | Converted exact-only compatibility definitions, including retained instructions |
| `roles/<role>.md` | Shared description and instructions |
| `overrides/<harness>/<role>.md` | Scoped description and complete instruction replacement |

Normal Markdown frontmatter supports `description` only. An absent scoped file inherits; an empty replacement body is explicitly empty. A scoped-only role exists on that harness, not automatically on every other harness. Six built-in roles are defined in memory; loading a session seeds no files.

Canonical structured identities are `harness/role`. Explicit stored exact selectors take precedence when selected directly; inferred legacy hyphen selectors must be unambiguous. They do not replace structured bindings.

Scalars resolve **binding > harness > backend defaults**. CLI `native` leaves the CLI argument unset; `parent` snapshots the root's effort for that invocation; `off` is a value, not reset. Fresh CLI effort defaults to native, whereas conversion preserves prior parent inheritance where applicable. Pi model/effort defaults allow validated binding exceptions; preset is harness-owned. Access is **call permission > global default**, never granted by role name or Markdown.

Enablement is the conjunction of harness, role, binding, retained legacy exclusions, and valid configuration. Enabling one scope clears only its gate; reset never enables. Invalid higher-priority instructions block affected bindings, while unrelated diagnostics do not block valid bindings. No harness substitution occurs.

A trusted project `.pi/pi-flow-external/settings.json` may override only `defaultHarness`: explicit call > trusted project > global > built-in `agy`. An unavailable default fails instead of falling back.

### Modules

- `src/settings.ts`: validation, defaults, trusted project default, private staged atomic replacement. Disk uses `harnesses`; internal `harnessSettings` is the full v5 projection, while internal `harnesses` retains the Pi registration projection. There is no second configuration file.
- `src/config-v5.ts`: harness/binding schema, supported policies and name validation.
- `src/catalog-v5.ts`: v5 bindings, scoped/shared/built-in instructions, scalar origins, gates and exact compatibility records.
- `src/profiles.ts`: common catalog/selection entry points; legacy profile parsing is retained for conversion and diagnostics.
- `src/default-roles.ts`: the six in-memory roles. `src/defaults.ts`: labels and historical seed inventory, not a live seeder.
- `src/harnesses.ts`: Pi registration validation/projection.
- `src/execution-config.ts`: effective model/effort/budget resolution used by Agent and workflow before launch.

## 3. Guided settings and deterministic lifecycle

`src/external-command.ts` routes `/external` and bare `/external config` to `src/config-hub.ts`: one `src/config-modal.ts` overlay in TUI, ordinary client dialogs in RPC, text without UI. `/external config text` always emits configuration details. Explicit `config harness ...` and `config role ...` commands remain the secondary automation/diagnostic interface; README contains the command matrix and removed-route mappings.

The hub shows agents first, then effective model/reasoning, role customizations and contextual Advanced controls. Terminal lists support `/` filtering, current markers, remembered selection, resizing and Esc back. Terminal confirmations start on Cancel; `$VISUAL`/`$EDITOR` can edit instructions via the configured external-editor key. Saved changes survive closing the window. RPC does not provide terminal search or a busy-operation cancel control.

Opening the hub does not probe installations, contact providers, send prompts or write settings. `src/config-models.ts` loads model choices only on picker entry:

- Codex: local cache under `$CODEX_HOME` or `~/.codex`.
- Claude: CLI aliases, not an account-specific catalog.
- Antigravity/Grok/OpenCode: bounded CLI metadata listing, potentially networked, with no prompt.
- Muse: existing/configured IDs and custom entry fallback.
- Pi: registry models grouped by provider, initially filtering to configured credentials, with an all-provider option.

Listing has a 10-second bound and terminal cancellation. Names can be humanized IDs; cache entries, aliases, credentials and setup checks are not proof of model access.

`src/config-lifecycle.ts` owns deterministic creation, editing, scalar updates, toggles, reset and deletion. Managed paths reject symlinks/non-regular files and validate ancestors; catalog reads fail closed on linked configuration/instruction roots. Exact-selector exclusions never become structured-binding gates. Destructive previews fingerprint settings/files and revalidate at apply. Default guards cover both global and effective project defaults. Deletion disables before multi-file cleanup so partial failure remains blocked. Writes preserve unrelated fields; separate sessions are last-writer-wins, with no inter-process lock. Role reset removes files before scalar settings and skips scalar deletion if unlinking fails. If the later atomic settings write fails, it reports already-removed instructions and unchanged scalars; a fresh preview can finish. Credentials, native configuration and run evidence are not owned cleanup targets.

Guided/direct creation is offline. `src/profile-creator.ts` owns the separate assisted interviews; the Pi finalizer confirms and smoke-tests with rollback on failure. Explicit Pi tests confirm cost and model, use an empty temporary workspace with readonly curated tools, wait for the shared concurrency slot, are bounded to 60 seconds and retain no normal run receipt. Terminal Esc can abort waiting/running tests. CLI checks inspect installation/reported sign-in only, not model access.

### Conversion and purge

`src/config-upgrade.ts` handles pre-v4 conversion and legacy purge inventory. `src/config-v5-upgrade.ts` handles the separately confirmed v4 → v5 step: validate sources/collisions, preserve immutable `settings.v4.backup.json`, install nested instruction copies, revalidate, then activate v5 through the canonical writer. Originals remain. Identical interrupted copies may be reused; differing copies block. Nonstandard/ambiguous selectors remain explicit compatibility records. Conversion does not consolidate repeated pins or delete copied bodies. Unenforced legacy CLI tools metadata is omitted with a source note; Pi tools are preserved. Unsupported effort blocks with source-specific repair guidance. Preview notes disclose frozen effective Pi exact pins and retained exclusions. The shared settings writer prevents editor version changes; only the converter's verified activation can switch v4 to v5.

Recovery offers conversion only for supported inputs; malformed/future settings require repair or an updated extension, not a fabricated runnable fallback. `/external [danger]purge-old-files` is separately previewed, selected and confirmed; it never deletes current settings, native profiles or receipts. Downgrade after purge requires the user's backup.

## 4. Launch, adapters and authority

```text
Agent selection ────────────┐
                           ├─ effective execution config ─ spawn ─ backend ─ verified result
Workflow frozen catalog ───┘                                      └─ evidence/progress
```

`src/pi-subagent.ts` registers tools and owns the session limiter, runtime flags, coordinator guidance and shutdown. `src/core/spawn.ts` handles effective permissions, resume, timeout, records, backend dispatch and terminal mapping. `src/core/permissions.ts` owns tier mapping and Pi tool allow-lists. Queue time is excluded from the normal run timeout; confirmed nested activity may extend it once, capped at twice the base. Process cancellation uses the CLI process-tree helpers; Pi cancellation is cooperative.

Adapters are `src/core/{claude,codex,agy,grok,muse,opencode}.ts`; the Pi branch uses `createAgentSession`. All require verified terminal success and nonempty output, not progress narration. Backend-specific trust and receipt details are in AGENTS.md; important distinctions are:

- Antigravity supports full/danger access only and refuses narrower tiers.
- Codex/Grok use native sandbox axes; Grok readonly network isolation is Linux-only, and sandbox startup failures remain fail-closed.
- Claude edit denies shell headlessly. Muse tiers use its own approval/sandbox controls; danger also trusts workspace resources for that run.
- OpenCode targets v2 only, uses a private `--standalone` server and verifies the completed invocation through bounded session exports. Restricted agents are explicitly selected on resume; plugins/MCP still load, so this is not an OS sandbox.
- Pi has curated tools, not an OS sandbox; minimal/skills presets both leave extensions, templates and themes unloaded. Project skills require trust. Retry is disabled call-scoped. Pi has no persisted resume or enforced budget cap.

Only Claude enforces the requested spending cap. Other backends record it without enforcement; unknown usage is not fabricated as zero. The extension does not retry failed/aborted runs except one disclosed Antigravity infrastructure retry. Backend-internal retries are separate.

## 5. Workflows, context and replay

`src/workflow/tool.ts` freezes one catalog and parent-context snapshot. `source.ts`/`registry.ts` resolve scripts; `script-validation.ts` validates `meta.apiVersion: 1`; `script-worker.ts` executes trusted JavaScript, not a security sandbox; `runtime.ts` coordinates children. Successful children return values; structured child errors are catchable; escaping errors fail the workflow and drain siblings. `journal.ts` records workflow evidence.

`replay-cache.ts` fingerprints effective instructions, model/effort/tools/budget/preset, permission, context and call data, with a versioned policy/SDK salt. Explicit replay through persisted `scriptPath` plus `resumeFromRunId` reuses only an unchanged successful prefix. Unresolved native CLI configuration cannot establish equivalence; changed/failed calls and their suffix execute again. Replay is not automatically repaired, free or side-effect-free.

Parent history is absent by default. `src/core/parent-context.ts` freezes opt-in recent/full text before queueing, excluding system instructions, thinking and pending calls; unsupported content or snapshots over 1 MiB fail. Sharing goes to the chosen harness and local evidence, is disclosed, and cannot be combined with child resume.

## 6. Progress, receipts and supervision

`src/core/progress.ts` supplies live presentation. `run-record.ts` writes private best-effort redacted records; `run-registry.ts` owns live work; `run-inspection.ts` pages durable evidence; `run-projection.ts` unifies live/durable/workflow timing and task identity. `src/external-runs.ts` and `/external runs` share the readers. Render modules do not create a separate evidence format.

Background work belongs to the originating session, not a daemon. List/inspect/wait/cancel are session/project scoped. Wait observes rather than cancels work, and its interruption only stops waiting. `final` exposes only the verified canonical terminal result. Output/diagnostics and workflow children have cursor navigation; unknown, incomplete and damaged evidence are not success. Live elapsed/activity age requires confirmed registry ownership, not a persisted running-looking status.

Retention prunes eligible completed records only, preserving active/interrupted/incomplete/damaged records. Records may contain sensitive prompts and output despite redaction. Orderly shutdown requests bounded cancellation; a crash leaves interrupted/uncertain evidence and restart never adopts orphaned work.

## 7. Verification and maintenance

`npm run check` is deterministic and offline. Real-backend E2E is opt-in and change-triggered; direct SDK-tool execution and real-root routing smoke are distinct lanes. Auth-blocked runs are not passing evidence. See field-testing.md for disposable UI checks and separately authorized provider tests.

Release label/version/changelog checks, OIDC publication and registry verification are documented in releasing.md. This snapshot makes no claim about current registry state or new live-provider verification. Remaining capability limitations belong in the current README/AGENTS contract; dated investigation evidence remains under its original scope.
