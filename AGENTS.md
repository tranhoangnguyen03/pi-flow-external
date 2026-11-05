# Agent Notes

## Agent-first product direction

**North star:** an agent sees useful work, hands it to the right helpers, uses their results, and keeps moving.

For changes to the delegation experience, read [Agent-first development principles](docs/maintainer/agent-first-development.md). Develop for a **parent agent completing a user's task**, not a workflow operator completing a checklist. Prefer direct delegation for independent work, JavaScript workflows for coordination that earns its cost, concise ambient guidance, adaptable examples and targeted technical help. Trust the agent's judgment while keeping actual authority, execution and result contracts truthful.

The core contract below (and its [detailed version](docs/maintainer/contracts.md)) remains in force; the agent-first direction complements it rather than overriding mechanics, configuration, backends or safety guarantees. For exact behavior consult current source and tests. Verify work with `npm run check`; use [maintainer field testing](docs/maintainer/field-testing.md) for live routing checks.

Guidance-only playbook edits need an accuracy review, not new tests. Claims of better model judgment need a small matched real-agent trial ([orchestration evaluation](docs/maintainer/orchestration-evaluation.md)); simulated child tests cannot prove them.

## Core contract

Full detail, including per-backend permission mapping, Muse/OpenCode/Grok specifics, receipts and `external_runs` paging: [docs/maintainer/contracts.md](docs/maintainer/contracts.md). Read the relevant section before changing that area.

- **External only.** `external_delegate` and `external_workflow` delegate to the six CLI harnesses (`agy`, `claude`, `codex`, `grok`, `muse`, `opencode`) and registered in-process `pi-*` harnesses, selected by `role` plus optional `harness`. Never route work to Pi's native subagent tool or modify native subagent files.
- **One configuration source.** Settings v5 is the only execution source; one catalog (`src/catalog-v5.ts`) feeds selection, discovery, inspection and workflows. Invalid global settings block delegation. No harness fallback. v4 needs explicit `/external config convert`; pre-v4 is blocked with the last converting release named. Reads never create files; writes are private atomic replacements that keep unrelated fields.
- **Authority is the call.** Permission is the call's `permission`, else `defaultPermission`. Roles describe intent and grant nothing. Each backend maps a tier it can enforce and rejects one it cannot; never broaden silently. Pi tool lists are curated, not an OS sandbox.
- **Truthful results.** Success needs a recognized terminal-success event, exit 0 and a non-empty result. Keep complete-failure and damaged-record evidence distinct. No automatic retries except agy's single disclosed infrastructure retry.
- **Process control.** Every CLI child runs through `src/core/cli-process.ts`: abort kills the whole process tree; oversized output fails the run. Background work belongs to its session; shutdown cancels it.
- **Disclosure.** Receipts and intent cards show the resolved tier, the real boundary (`unsandboxed external CLI` vs `Pi SDK child`), and any shared parent context. Before a workflow, tell the user its purpose, assignments, order, allowed changes and deliverable.
- **Guidance layers.** Normal mode injects no Flow system prompt; `/external mode` cycles Orchestrator (delegate-first), Frontline Worker (execute-first), and Normal. Both nudges stay short; `external_help` topics and the orchestration skill remain on-demand. Do not copy the playbook or schemas into prompts.
- **Human command UX.** Bare `/external` opens Modes, Runs, Workflows, Configuration (Global / Agents / Roles), and Help; `/external config` opens Configuration. Default completion shows only four entries; deep commands remain executable and discoverable by prefix. Modal and commands reuse the same settings and run operations. Runs maintenance confirms pruning; Workflows is a trusted-scope read-only browser; opening Help or Config must not run diagnostics.
- **Workflows.** Trusted JavaScript with `meta.apiVersion: 1`; one frozen catalog snapshot per run; replay reuses only the longest unchanged successful prefix.
- **Public contract v1.** Tool results use one `ok` envelope (`src/contract/`); expected errors are coded at the source and returned, not thrown.

## Testing rules

Goal: enough confidence at the lowest ongoing cost.

1. **Change existing tests first.** Search for the test that already owns the behavior and extend it. Add a new test only for a distinct, credible failure, and name that failure in the test title.
2. **Test the cheapest layer that proves it.** Prefer a direct function call over a Pi session, a session over a subprocess. One authoritative test per behavior; do not repeat it at unit, integration and E2E levels.
3. **Representative, not exhaustive.** One or two examples per rule, not every enum value, malformed shape or backend. Shared mechanisms (process lifecycle, capability claims) are tested once, not per backend.
4. **Skip low-value tests.** No cosmetic rendering, prose fragments, exact help text, trivial accessors, coverage quotas or recommendation-to-test mappings.
5. **Delete with the behavior.** Removing a feature or code path removes its tests, fixtures and docs in the same change.
6. **Always worth protecting:** unauthorized or broadened permissions, unintended writes to user configuration, lost data, uncontrolled child processes, broken cancellation, and misleading success.
7. `npm test` stays deterministic and offline. Real-provider checks are opt-in and chosen by the affected backend: `npm run e2e -- --backend <name> [--workflow|--interrupt]` (see [field testing](docs/maintainer/field-testing.md)). An auth-blocked run is not a pass.

## Verification and release

- Run `npm run check`, `npm pack --dry-run --json`, and `npm audit --omit=dev --audit-level=high` before release.
- Follow `docs/maintainer/field-testing.md` for real-backend checks and `docs/maintainer/releasing.md` for the automated release flow, versioning, trusted publishing, and registry verification.
- Releases are automated: merging a PR that bumps the version (labelled `release:patch|minor|major|prerelease`, or `release:none` to skip) tags the commit, publishes to npm via OIDC trusted publishing, and creates the GitHub release. `release:none` PRs must not change shipped files without a bump; CI enforces the label/version/CHANGELOG contract. The v4 redesign shipped as `2.6.0-external.0` with `release:minor`. Subsequent command removals still require explicit old→new mappings in the CHANGELOG section that becomes the GitHub release notes. Existing v4 settings require explicit v5 conversion. Pre-v4 installations are blocked untouched and must convert with `5.5.0-external.2` first; there is no purge command. Do not hide command breaks in a patch note.
- Never republish an existing npm version or force-push release history.
