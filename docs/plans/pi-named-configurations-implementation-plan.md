# Implementation plan: named Pi harness configurations (`pi-*`)

Companion to `docs/plans/pi-named-configurations-design.md` (read that first — this document assumes its schemas, precedence rules, and resolved SDK facts and does not re-derive them). This plan is executable phase-by-phase in a follow-up session; **no code, test, or settings files are touched by writing this plan.**

## Decision log

Every item the earlier draft marked `[OPEN]` is resolved in the design doc via direct source reads against the pinned SDK (`@earendil-works/pi-coding-agent@0.79.4`, confirmed exact version at `node_modules/@earendil-works/pi-coding-agent/package.json:3`, deliberately re-verified against the pinned package rather than the newer global `pi` CLI at `0.85.1`). Nothing below is deferred to an implementation-time spike.

| Topic | Resolution | Source |
| --- | --- | --- |
| Built-in tool names for tier exclusion | Seven factories exist: `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`; only the first four are in `defaultActiveToolNames` (auto-enabled without an explicit `tools:` allow-list); no `powershell` tool exists in this package | `agent-session.d.ts:96`, `sdk.d.ts:40-42`, `dist/core/sdk.js:131`, `dist/core/tools/index.js` |
| Curated child extension/tool boundary | `noExtensions/noSkills/noPromptTemplates/noThemes: true`; proven-safe combination already used by this repo's own test harness. Curation bounds tool *names*, not what `bash` can do once granted — `danger` tier on pi is not materially safer than `danger` tier on an external CLI, and no claim to the contrary ships | `resource-loader.d.ts:61-113`, `test/helpers/pi-subagent-harness.ts:170-180`, design §6 |
| Provider-extension compatibility under curated loading | Verified for the registry-data path only: `registerProvider` stores config inside the shared `ModelRegistry` instance, which the child reuses, so model/auth resolution survives `noExtensions: true`. Broader "any provider extension just works" compatibility is untested against a real third-party extension | `dist/core/model-registry.js:611-645`, `src/core/spawn.ts:513` (existing), design §6 |
| Model resolution / auth preflight API | `ModelRegistry.find()`, `.hasConfiguredAuth()` both synchronous | `model-registry.d.ts:60,64` |
| Thinking-level validation | SDK clamps a *valid* level to model capability at session creation — that covers capability mismatches only. A closed-set preflight (`off`/`minimal`/`low`/`medium`/`high`/`xhigh`, from `@earendil-works/pi-agent-core`'s `ThinkingLevel` type) is required at harness-creation time, load time, and immediately pre-session, so a typo'd or stale value fails loudly instead of being silently "clamped." Disclosure of legitimate capability clamping via post-creation `session.thinkingLevel` diff is kept, narrowed to that purpose only | `sdk.d.ts:22-23`, `agent-session.d.ts:264,426-440`, `pi-agent-core/dist/types.d.ts:249`, design §4.2/§7.2 |
| Terminal event / completion definition | Non-empty tightened to non-whitespace; the terminal `agent_end`'s `willRetry: false` is explicitly observed (captured from the subscribe callback) rather than only inferred from timing; cleanup ownership extends to a throw during `resourceLoader.reload()`/`session.subscribe()`, not just during the prompt turn; completion is only ever decided after `await session.prompt()` resolves, never mid-turn | `agent-session.d.ts:40-46`, `src/core/spawn.ts:556-591`, design §7.4 |
| SDK retry defaults | Built-in auto-retry is `enabled: true` by default and conflicts with this repo's no-auto-retry contract if left as-is. The pi branch must construct the child with retry disabled via an in-memory settings snapshot/override scoped to that child only — never mutating the user's real global/project settings file, and never framed as "can't be disabled here" | `settings-manager.js:535-551`, `agent-session.js:1958-2040`, `AGENTS.md` ("Receipt and evidence invariants"), design §7.6 |
| Cancellation semantics | `session.abort()` cooperative only, no hard-kill guarantee (unlike SIGTERM on external CLIs) | SDK extensions docs; existing code posture |
| Resume support for pi | Deliberately absent; already produces a clean error with zero code changes (ephemeral `SessionManager.inMemory`, never disposed-and-resumed) | `src/core/resume.ts:16-43`, `src/core/spawn.ts:515` |
| Budget enforcement for pi | Already generalizes (`backend !== "claude"` condition already includes `"pi"`); zero code change | `src/core/spawn.ts:319-324` |
| Replay fingerprint execution identity | Descriptor widens to `backend`/`harness`/`model`/`thinking`/`systemPrompt`/`tools`/profile-declared `permission`/`maxBudgetUsd`, plus a separately-computed `effectivePermission` (via the existing `resolveEffectivePermissionTier` resolver) and a coarse resource/policy-version tag; `workflow/tool.ts`'s `profiles` snapshot must have synthesized `pi-*` role profiles merged in once at workflow start so execution, UI callbacks, and the descriptor all see the same complete roster — a `describeSubagentType` that silently returns `undefined` for synthesized profiles is not an acceptable fallback | `src/workflow/replay-cache.ts:4-16`, `src/workflow/runtime.ts:159-189`, `src/workflow/tool.ts:118,139,309,327`, design §8 |
| Invalid/deleted default harness at delegation time | Must fail the delegation with an actionable diagnostic naming the missing default; must never silently reroute to `agy`. Session-startup/advisory reads (settings, doctor) may still tolerate and report a stale default without crashing | `src/settings.ts:231-235` (existing pattern for shape mismatch), design §5 |
| Shared role-body source | One canonical `DEFAULT_ROLES` table (extracted to `src/default-roles.ts`), no donor-fallback chain, no plural-harness file format | design §4.4 |
| Automatic vs. opt-in role availability | Automatic — matches existing unconditional three-backend seeding precedent; this is a shared-precedent argument, not a claim that pi's `danger` tier is inherently safer | design §4.4 |

Three items remain genuine product-scope judgment calls for your sign-off, not technical unknowns (§ "Open review points" at the end of this document); the two items an earlier pass of this plan listed there (deleting the `pi-subagent.ts` guard, and the `toolsUnconstrained` warning) are resolved above as required corrections, not open questions.

## Phase 0 — pre-flight verification (no code)

Nothing to spike; §"Decision log" above and the design doc's §7 are the spike, already done. This phase is a no-op, listed only so the phase numbering below matches "verify, then build" without skipping a number silently.

## Phase 1 — canonical role source extraction (no behavior change)

**Goal:** make `DEFAULT_ROLES` importable from `src/profiles.ts` without a cycle, with **zero change to any currently-seeded file's content**.

- New `src/default-roles.ts`: move the `DEFAULT_ROLES` const and the `RoleDefinition` shape (`permission`/`description`/`body`) out of `src/defaults.ts:13-44` verbatim. Export `DEFAULT_ROLES` and a `roleDefinition(role: string): RoleDefinition | undefined` lookup. No import from `profiles.ts` or anything else in this module.
- `src/defaults.ts`: import `DEFAULT_ROLES`/`roleDefinition` from the new module; `buildDefaultProfile()` body unchanged in behavior.
- **Test:** extend `test/defaults.test.ts` with one assertion that `buildDefaultProfile("claude-reviewer")`'s structural fields (`permission`, `backend`, and that `body`/`description` are sourced from the same `DEFAULT_ROLES.reviewer` entry the extracted module now exports) are unchanged by the extraction — a refactor-safety check tied to the shared data source, not a hardcoded snapshot of the role's prose body (per `AGENTS.md`'s essential-test-mandate: no default-body byte snapshots).

No settings/schema/runtime change in this phase. Safe to land alone.

## Phase 2 — schema and registry

- `src/types.ts`: add `harness?: string` to `SubagentProfile`.
- `src/profiles.ts` (`parseSubagentProfileContent`): parse `harness` from frontmatter (`optionalString(parsed.frontmatter.harness)`), no validation against the registry at parse time (that happens at resolution time, where the live registry is available) — mirrors how `model`/`thinking` are parsed today (free strings, validated downstream).
- New `src/harnesses.ts`:
  - `HarnessConfig { model: string; thinking?: ThinkingLevel; owner?: string }`, where `ThinkingLevel` here is the SDK's closed six-literal union (`"off" | "minimal" | "low" | "medium" | "high" | "xhigh"`, imported from `@earendil-works/pi-agent-core`), not this repo's existing loose `string` alias used by CLI-backend profiles.
  - `harnessesPath(agentDir): string` → `join(agentDir, "pi-flow-external", "harnesses.json")`.
  - `VALID_THINKING_LEVELS: readonly ThinkingLevel[]` — the six-literal list, defined once in this module since the pinned SDK exposes it only as a type, not a runtime constant (implementer: re-confirm this list against the pinned devDependency version at implementation time; see decision log).
  - `loadHarnessConfigs(agentDir): { harnesses: Map<string, HarnessConfig>; diagnostics: string[] }` — migrate-on-read idiom identical to `src/settings.ts:63-113`: missing file → empty map, no diagnostic; malformed JSON → empty map, one diagnostic; per-entry validation (key matches `/^pi-[a-z0-9][a-z0-9-]*$/`, `model` is a non-empty string, `thinking` when present is one of `VALID_THINKING_LEVELS`) drops only the bad entry with a diagnostic, never the whole file. An entry with no `thinking` field is treated as `"off"` at read time (never left `undefined` to fall through to the SDK's own "else 'medium'" default) — but the creation path (below) persists `"off"` explicitly rather than relying on this read-time default, so a hand-inspected `harnesses.json` is never silently ambiguous about what it means.
  - `getConfiguredHarnessNames(agentDir): Set<string>` — convenience wrapper returning just the key set.
  - `installHarnessConfigWithSmokeTest(...)` — see Phase 6; declared here, implemented alongside the profile-creator fork so it can share the exact staging/rollback code path; rejects an unsupported `thinking` value before any write, with the valid list in the error.
- **Tests (new `test/harnesses.test.ts`):**
  - Missing file → empty map, no diagnostics.
  - Malformed JSON → empty map, one diagnostic, does not throw.
  - Entry with bad key shape (no `pi-` prefix) → dropped, diagnostic; rest of file loads.
  - Entry missing `model` → dropped, diagnostic.
  - Entry with a `thinking` value outside the six valid literals (e.g. a typo like `"med"`) → dropped, diagnostic naming the valid set; never silently clamped to a nearby valid value.
  - Entry with `thinking` omitted → loads with `"off"` as the effective read-time value.
  - Valid multi-entry file → all entries present, no diagnostics.

## Phase 3 — legitimacy, role-prefix keying, canonical synthesis (`src/profiles.ts`)

- `isExternalAgentProfile(profile, configuredPiHarnesses: ReadonlySet<string>)`: widen per design §4.3. `filterExternalAgentProfiles(profiles, configuredPiHarnesses)` threads the same set through.
- `externalProfileRole(profile)`: prefix becomes `${profile.harness ?? profile.backend}-`.
- `externalRoleAvailability(profiles)`: grouping key becomes `harness ?? backend`; return type widens from `Map<string, ExternalHarness[]>` to `Map<string, string[]>`; sort comparator can no longer assume `EXTERNAL_HARNESSES.indexOf` for pi harness names — sort external harnesses first (existing `EXTERNAL_HARNESSES` order), then any pi harness names alphabetically after them, so existing three-harness sort order is byte-identical when no pi harnesses are configured.
- `resolveExternalProfile(profiles, selection, defaultHarness, configuredHarnessNames, harnessConfigs)`: two new parameters. Lookup order exactly as design §4.4: exact-name hit (body/description/permission/tools from the file; `model`/`thinking` inherited from the harness registry unless the file's own `model`/`thinking` exactly match the harness's registered values, in which case they're redundant-but-consistent — any other explicit `model`/`thinking` in the file is a conflict and fails resolution with a diagnostic naming both the file and the harness's registered config) → canonical synthesis (only for the six known role keys, only when `harness` resolves to a registered pi config) → existing "unavailable"/"unknown" error paths, message text widened to list the live harness-name set instead of `EXTERNAL_HARNESSES.join(", ")`.
- `formatExternalAgentPolicyError` — unchanged; still the error text used when an illegitimate `backend: "pi"` profile is rejected, now called from whatever replaces the old unconditional guard in `pi-subagent.ts` (Phase 6 — that replacement is mandatory, not optional; see design §9/§10).

**Tests (extend `test/profiles.test.ts`):**
- Bare `backend: pi`, no `harness` field → excluded (existing assertion, unchanged).
- `backend: pi`, `harness: "pi-unregistered"` (not in the registry map passed in) → excluded.
- `backend: pi`, `harness: "pi-deepseek"` with `"pi-deepseek"` present in the registry map → included.
- `resolveExternalProfile` with `role: "reviewer", harness: "pi-deepseek"`, no on-disk `pi-deepseek-reviewer.md`, registry has `pi-deepseek` → returns a synthesized profile with the expected `name`/`backend`/`harness`/`model`/`thinking`/`permission`.
- Same setup but an on-disk `pi-deepseek-reviewer.md` exists with different body/permission and no `model`/`thinking` frontmatter → the on-disk file's body/permission wins, `model`/`thinking` still come from the harness registry (override precedence, non-conflicting case).
- Same setup but the on-disk file additionally declares a `model` that differs from `pi-deepseek`'s registered model → resolution fails with a diagnostic naming the conflict, not a silent "file wins."
- `role: "security-reviewer"` (not one of the six) with a registered `pi-deepseek`, no on-disk file → unknown-role error, no synthesis attempt.
- `externalRoleAvailability` sort order unchanged when no pi harnesses configured (regression guard).

## Phase 4 — model resolution (`src/core/model.ts`)

- `resolveProfileModel`: remove the `: ctx.model` fallback branch for `backend === "pi"`. `findProfileModel` returns a discriminated result: `{ ok: true; model } | { ok: false; reason: "unparseable" | "not-found"; raw: string }` instead of `undefined`, so call sites can produce the two distinct messages from design §7.1.
- Call sites (`pi-subagent.ts`, `workflow/tool.ts`): update the "No model is selected" branch to surface the discriminated message.

**Tests (extend a model-resolution suite — check for an existing `test/model.test.ts`-equivalent; if none exists, add one alongside `test/profiles.test.ts`):**
- Pi profile with no `model` field → hard error, never falls back to `ctx.model`.
- Pi profile with unparseable `model` string (no `/`) → "pins no resolvable model" message.
- Pi profile with parseable but absent-from-registry `model` → "not found in registry" message.
- Pi profile with a valid, resolvable `model` → returns the model, no error.

## Phase 5 — runtime contract (`src/core/spawn.ts`, `src/core/permissions.ts`)

Per design §6–§7, in the pi branch of `spawnSubagentRuntime`:

1. Thinking preflight: reject a `thinking` value outside the SDK's closed six-literal set before any session work begins (design §7.2).
2. Auth preflight (`hasConfiguredAuth`) before session construction.
3. Build the child's effective settings from an in-memory snapshot/override of the real `SettingsManager` with retry disabled (`retry.enabled: false`), never mutating the user's real settings file (design §7.6).
4. Curated `DefaultResourceLoader` (`noExtensions`/`noSkills`/`noPromptTemplates`/`noThemes: true`), drop `extensionsOverride`.
5. Tier → tool table: `readonly`/`edit` tiers get a *default* `tools:` allow-list (`read`/`grep`/`find`/`ls` for `readonly`; those plus `edit`/`write` for `edit`) when the profile itself sets none, so a `readonly` pi child can actually search the repository instead of being limited to bare `read`; `excludeTools` stays `bash,edit,write` for `readonly` and `bash` for `edit`, merged with `CHILD_EXCLUDED_TOOLS`; `danger` gets no additions beyond `CHILD_EXCLUDED_TOOLS` (design §6).
6. Third abort guard after `resourceLoader.reload()`; cleanup ownership (session/resource-loader/subscription disposal) extends to cover a throw during resource-loader construction/reload or `session.subscribe()` itself, not only during the prompt turn (design §7.4 point 4, §7.7).
7. `onBackendEvent` wired into the existing `session.subscribe` callback; the callback also captures the last observed `agent_end` event so its `willRetry` flag can be asserted `false` before declaring success (design §7.4 point 2).
8. Remove `|| "(no final text output)"`; empty **or whitespace-only** final text throws (design §7.4 point 1).
9. Post-creation thinking-clamp comparison (`session.thinkingLevel` vs. the now-preflight-validated requested value) → `thinkingClamped` evidence field + banner note, mirroring the existing permission-elevation note pattern. This only ever fires for legitimate model-capability clamping now, never for a value that should have failed at step 1.

No `policy_warning`/`toolsUnconstrained` evidence is added — design §6 drops this entirely as a warning built on a false premise (curation does not make `bash` at `danger` tier meaningfully less exposed).

`src/core/permissions.ts`: `resolvePermission()` gains `case "pi"` (`enforced: true`; caveat `undefined` at `danger`, `"builtin tools only (read/bash/edit/write/grep/find/ls); no project extensions"`-style caveat otherwise, truthfully describing a tool-level restriction, not a sandbox). `PermissionResolution` gains `backend?: SubagentBackend` so `permissionLabel()` can branch on backend — the function currently receives only `{ tier, enforced, caveat }` and unconditionally returns `"unsandboxed external CLI"` at danger tier, so this is a real signature/interface change, not a wording edit. `permissionLabel()` gains a pi branch producing wording that never says "external CLI" (e.g. `"Pi SDK child · host access · curated tools"` at danger, `"Pi SDK child · <tier> · curated tools"` otherwise). `resolveEffectivePermissionTier()` gains a `backend === "pi"` branch: execution-profile roles at `edit` tier are elevated to `danger`, mirroring the existing claude branch — without this, a pi `implementer`/`qa`/`worker` called with `permission: "edit"` would lose `bash` and be unable to run tests or build, the exact silent-handcuffing scenario the danger floor exists to prevent.

**Tests (new `test/pi-runtime.test.ts`, built on `test/helpers/pi-subagent-harness.ts` — see Phase 9 for the harness extension this depends on):**
- Missing model → clean error, no fallback to parent model (regression guard tying Phase 4 into the actual spawn path).
- Auth not configured → clean preflight error, distinct message from "model not found."
- `thinking` set to a value outside the six-literal set (simulate a stale/hand-edited registry entry reaching the spawn path) → clean preflight error before any session/model work, distinct from a model-capability clamp.
- `resolveEffectivePermissionTier` with `backend: "pi"`, `isExecutionProfile: true`, `baseTier: "edit"` → elevated to `danger` (regression guard on the danger floor).
- `resolvePermission` for `backend: "pi"` → `enforced: true`, carries a `backend` field the label function can branch on.
- `permissionLabel` for a pi danger-tier resolution → label does not contain "external CLI" (assert substring absence, not exact prose).
- Empty final assistant text, and separately a whitespace-only final assistant text → both reported as `status: "error"`, not `"done"`.
- Fake provider that simulates a transient error mid-turn → pi child does not silently retry (assert the child's effective settings carry `retry.enabled: false` and/or that a single simulated failure surfaces as an immediate error rather than being retried internally) — regression guard on the no-auto-retry contract (design §7.6).
- `readonly` tier, profile with no explicit `tools:` → child's active tool set is `read`/`grep`/`find`/`ls` only; excludes `bash`/`edit`/`write`.
- `edit` tier, profile with no explicit `tools:` → child's active tool set adds `edit`/`write`; still excludes `bash`.
- Explicit `profile.tools` allow-list intersected with a `readonly` call-site tier → tier still wins (allow-list cannot reintroduce an excluded tool).
- Non-recursion: child tool set never contains `Agent`/`workflow` regardless of tier (defense-in-depth assertion, still worth one test even though provably unreachable via `noExtensions`).
- Extension isolation positive control: register a fake extension tool in the test fixture's `agentDir`, then confirm it is absent from a pi child's tool set — this is the single most safety-critical claim in §6 and must have its own explicit test, not just an inference from the SDK's `noExtensions` documentation.
- Cancellation before `session.prompt()` start → aborted status, no partial run recorded as done.
- Third abort guard window: abort signal fires after `resourceLoader.reload()` returns but before session construction/prompt → run reports aborted status, no session leak.
- A throw injected during `resourceLoader.reload()` (simulated) → the run reports a clean error, and any partially-constructed resources are still disposed (regression guard for the cleanup-ownership fix, design §7.4 point 4).
- `onBackendEvent` fires at least once for a normal run → `backendEventCount > 0` (regression guard for the wiring fix — today this is always `0`).
- The last observed `agent_end` for a successful run has `willRetry: false`, and this is asserted explicitly by the success path, not merely assumed (design §7.4 point 2).
- `thinkingClamped` evidence present when requested thinking differs from resolved `session.thinkingLevel`; absent when they match.
- Resume attempt on a completed pi run → the existing `resolveResume` "no session id to resume" error, unchanged (regression guard, not new behavior).
- Budget: `max_budget_usd` set on a pi profile → `budgetEnforceable: false` recorded (regression guard on the already-generalized condition).

## Phase 6 — profile-creator fork and harness-config installer

- `src/profile-creator.ts`: extract the staging/smoke-test/atomic-commit/rollback core of `installProfileWithSmokeTest` into a shared helper parameterized over "write a markdown profile" vs. "write a JSON harness entry," or keep them as two functions that both call a shared `stageWriteSmokeTestCommit()` primitive — implementer's choice at this phase, constrained only by: no duplicated staging/rollback logic between the two paths, and neither path's tests may regress.
- `installHarnessConfigWithSmokeTest({ agentDir, name, model, thinking, ctx, signal, getLimiter, getSubagentTimeoutMs, getThinkingLevel, updateStatus })` (moves into `src/harnesses.ts` or stays in `profile-creator.ts` re-exported from there — implementer's choice): validates name shape, registry-`model` resolvability, and `thinking` against the closed six-literal set (§4.2) synchronously first (fail fast, no I/O, no clamping a typo), stages the JSON write, runs the same `spawnSubagent` smoke test used for markdown profiles (`profile: { name, backend: "pi", harness: name, model, thinking, systemPrompt: undefined }`, same `SMOKE_TOKEN` contract), commits via same-directory atomic rename on success, rolls back on failure. Rejects if the name already exists in the live registry (no silent overwrite). Concurrency note: same-directory rename guarantees filesystem integrity (no partial/corrupt files or crash window), but concurrent distinct-name writers follow last-writer-wins without an inter-process file lock.
- `PROFILE_INTERVIEW_PROMPT`: rewritten to ask the three-way branch question up front (design §10).
- `profileParameters.backend` (`StringEnum(["claude","codex","agy"])`) widens to accept a live configured pi harness name too, for the "role profile targeting an existing pi harness" branch; `compileProfile()`'s prefix check uses `harness ?? backend`; a role profile that declares an explicit `model`/`thinking` conflicting with its `harness`'s registered config is rejected at compile/install time with a diagnostic (design §4.4), not written.
- `pi-subagent.ts`: the `if (profile.backend === "pi") return formatExternalAgentPolicyError(...)` block **must be removed or replaced** with a check derived from the same widened legitimacy predicate `filterExternalAgentProfiles` now implements — this is a required correctness fix (design §9/§10), since leaving the old unconditional reject in place would block every legitimate pi call reaching this point, not just dead code. This phase's tests must confirm both: a legitimate pi profile (real file or synthesized) executes normally, and an illegitimate one (bare `backend: pi`, or an unregistered `harness`) is still rejected with the existing policy error.

**Tests (extend `test/profile-creator.test.ts`):**
- Declare-new-pi-harness branch: valid name + resolvable model + valid thinking level + passing smoke test → entry appears in `harnesses.json`, atomic (no partial file on success).
- Declare-new-pi-harness branch: unresolvable model → rejected before any file write (no staged file left behind).
- Declare-new-pi-harness branch: unsupported/misspelled `thinking` value → rejected before any file write, error lists the valid six-literal set.
- Declare-new-pi-harness branch: smoke test fails → rollback, no entry written, no residual staged file.
- Declare-new-pi-harness branch: name collides with an existing entry → rejected, existing entry unchanged.
- Role-profile-for-existing-pi-harness branch: produces a `backend: pi`/`harness: <name>` markdown file that `resolveExternalProfile` then finds ahead of canonical synthesis (integration point back to Phase 3's override-precedence test).
- Role-profile-for-existing-pi-harness branch: an attempt to declare a `model`/`thinking` in the new file that conflicts with `<name>`'s registered config → rejected at install time, no file written (integration point back to Phase 3's conflict test).
- `pi-subagent.ts` dispatch: a legitimate synthesized-or-real pi profile reaches and completes execution (not rejected by the old guard's replacement); an illegitimate `backend: pi` profile (no/unregistered `harness`) is still rejected with the existing policy error text.

## Phase 7 — catalog, help, doctor, settings text

- `src/prompts.ts`: `formatExternalRoleCatalog`/`roleLabel`/`buildCoordinatorPrompt` iterate the dynamic harness-name set.
- `src/external-help.ts`: `externalHelpParameters.harness` → plain string; `permissionHelp()` re-keyed by backend (4 entries), resolving a harness name to its backend first.
- `src/external-command.ts`: `/external doctor` pi-aware branch (sync `modelRegistry.find`/`hasConfiguredAuth` check, no `pi.exec`); `/external settings` gains the "Pi harnesses:" summary line.
- `src/pi-subagent.ts` / `src/workflow/tool.ts`: `getDefaultHarness` callback type `ExternalHarness → string`; `agentToolParameters.harness` → plain string; harness registry loaded alongside `getSubagentProfiles` at each call site.
- `src/settings.ts`: `defaultHarness` shape validation widened (`pi-*` pattern or one of the three literals) at parse time; `EffectiveDefaultHarness.harness: string`. Resolution at delegation time (an `Agent`/`workflow` call with no explicit `harness`) throws/returns an actionable error naming the missing default when the configured `defaultHarness` doesn't exist in the live registry — **never** silently substitutes `"agy"` (design §5). Session-startup/advisory reads (`/external settings`, `/external doctor`, roster seeding) may still surface the stale name with a diagnostic without failing. The hard-coded `"agy"` ultimate default is unchanged for the separate case of no `defaultHarness` ever having been configured.

**Tests:**
- Extend `test/external-command.test.ts`: `/external doctor` with a registered pi harness reports model/auth status, no subprocess spawn attempted for it; with a stale/deleted `defaultHarness`, reports the diagnostic without crashing.
- Extend `test/settings.test.ts`: `defaultHarness: "pi-deepseek"` accepted at parse-shape level; a delegation call resolving to an unregistered `"pi-deepseek"` default fails with an actionable, diagnostic-bearing error (not a silent `"agy"` substitution); resolution succeeds when it is registered; a session with no `defaultHarness` configured at all still falls back to `"agy"` (regression guard distinguishing "never configured" from "configured then invalid").
- Extend `test/agent-rendering.test.ts` if the intent-card rendering path touches `getDefaultHarness`/harness label text — verify a pi-harness delegation's permission resolution takes the pi branch and carries the expected `enforced`/tier/caveat data (assert the underlying data the label is built from, not the literal rendered wording, per the essential-test mandate).
- Extend `test/external-only-agent.test.ts`: add one positive-path assertion (registered `pi-deepseek` + on-disk or synthesized `pi-deepseek-reviewer` → included in the external roster) alongside the existing negative-control assertions, which must remain unchanged in their pass/fail outcome (not asserted via a byte/prose snapshot).

## Phase 8 — profile-snapshot freezing and replay-cache fingerprint fix

This phase fixes two coupled problems together, because fixing the fingerprint alone would fingerprint a profile that workflows can't actually execute (design §8):

1. **Freeze the profile snapshot with synthesized pi profiles included.** In `src/workflow/tool.ts`'s `execute()`, at the point `profiles` is built (`workflow/tool.ts:118`), after loading the harness registry via `loadHarnessConfigs(agentDir)`: for every registered `pi-*` harness, synthesize its six canonical role profiles (reusing the same synthesis logic `resolveExternalProfile` uses in Phase 3 — extract it to a shared helper callable from both places rather than duplicating it) and insert each into the `profiles` map under `${harness}-${role}`, **skipping any key that already has a real on-disk entry** (same override precedence as Phase 3, applied once for the whole run). **Critical ordering: the `models` map (`workflow/tool.ts:114`, one line after `profiles` is built) must be constructed _after_ synthesized profiles are merged into `profiles`**, not before — otherwise `models.get(call.subagentType)` returns `undefined` for every synthesized pi role, and `runAgent`'s `usesPiBackend(profile) && !model` check (`workflow/tool.ts:171-174`) throws "No model is selected" even though the profile itself resolved fine. This map is built exactly once per workflow execution and nothing later re-resolves a profile through the harness registry or re-reads `harnesses.json` — a `harnesses.json` edit mid-run cannot desync the descriptor from what actually executes. No other change is needed to `runAgent`'s existing `profiles.get(call.subagentType)` (`workflow/tool.ts:139`) or to `onAgentQueued`/`onAgentStart`'s `profiles.get(...)?.backend` (`workflow/tool.ts:309,327`) — inserting synthesized profiles into the shared map is what makes all three consumers see them, with zero lookup-path changes.
2. `src/workflow/types.ts`/`CreateWorkflowToolOptions`-equivalent options interface passed to `runWorkflow`: add `describeSubagentType: (name: string) => Pick<SubagentProfile, "backend" | "harness" | "model" | "thinking" | "systemPrompt" | "tools" | "permission" | "maxBudgetUsd"> | undefined`.
3. `src/workflow/tool.ts`: implement it as `(name) => profiles.get(name)` against the now-complete snapshot from step 1, pass through to `runWorkflow`. Because the snapshot is complete, a caller that reaches real execution and gets `undefined` back means the name is genuinely unresolvable (the same failure `runAgent` itself surfaces) — this must not be treated as an acceptable "maybe it's fine" fallback for a synthesized profile; it is a hard error either way.
4. `src/workflow/runtime.ts`: call `describeSubagentType` once when `subagentType` resolves; also call `resolveEffectivePermissionTier(call.permission, descriptor, options.getDefaultPermission())` (imported from `src/core/permissions.ts`, not reimplemented) to compute the tier that will actually apply; pass both the descriptor and the computed `effectivePermission` into `fingerprintWorkflowAgentCall`.
5. `src/workflow/replay-cache.ts`: `fingerprintWorkflowAgentCall(call, descriptor?, effectivePermission?)` includes `descriptor.backend/harness/model/thinking/systemPrompt/tools/permission/maxBudgetUsd`, `effectivePermission`, and a coarse resource/policy-version tag (pinned SDK version + a literal tag for the current tier→tool-exclusion table, design §6) in the hashed object when present. Clarify in a code comment (not a behavior change) that `call.context`'s `ParentContextReceipt` fields contribute shape/receipt metadata to the hash, while the actual shared transcript text is already covered via `call.prompt` (which embeds it, per `prepareParentContext`) — avoid the earlier draft's "context is provenance of the actual text" framing in any code comments written here.

**Tests (extend `test/workflow.test.ts` / add to a replay-focused describe block):**
- A workflow call targeting `role: "reviewer", harness: "pi-deepseek"` with no on-disk `pi-deepseek-reviewer.md` file **executes successfully** (not "Unknown external subagent_type") — this is the core functional regression test for the snapshot-freeze fix, independent of fingerprinting.
- The same call's `describeSubagentType(name)` (or the fingerprint it feeds) reflects the synthesized profile's real `model`/`thinking`, not `undefined`.
- Two calls with identical `call` fields but different resolved `model` (simulate via the test's fake `describeSubagentType`) → different fingerprints, cache miss.
- Two calls with identical `call` fields and profile, but the profile's `systemPrompt` or `tools` differs between them → different fingerprints, cache miss (regression test for the previously-unhashed profile fields).
- A call whose requested `permission` differs from what `resolveEffectivePermissionTier` actually resolves to (e.g. a backend-level coercion) → the fingerprint reflects the resolved `effectivePermission`, not just the raw request.
- Identical `call` fields and identical resolved descriptor → same fingerprint, cache hit preserved (regression guard: the fix must not break existing successful-prefix replay for unrelated profile edits).
- A harness's registered `model` changes in `harnesses.json` mid-run (simulated) → the frozen snapshot from step 1 still reflects the value captured at workflow start for every call in that run, not the changed value (regression guard on the snapshot-freeze/no-TOCTOU property).
- No `describeSubagentType` provided (a test harness that doesn't wire it, not the real execution path) → fingerprint falls back to hashing without the new fields, doesn't throw.

## Phase 9 — test harness extension

`test/helpers/pi-subagent-harness.ts`'s `createSession()` already wires a real `ModelRegistry.create(authStorage, modelsJsonPath)` + `registerFauxProvider` + `models.json` mirror (`registerFauxProvider`/`writeModelsJson`, lines 111-160) — exactly the plumbing a pi-harness test needs. Add a small option, e.g. `piHarnesses?: Record<string, { modelId: string; thinking?: ThinkingLevel }>` (the closed six-literal type, matching `HarnessConfig` from Phase 2 — not a free string), that writes a matching `harnesses.json` alongside the existing `models.json` write, resolving `modelId` against the already-registered faux model. Also add a way for the faux provider to simulate one transient mid-turn failure on demand (e.g. a `failNextTurn: "transient"` toggle on the faux provider), needed by Phase 5's no-auto-retry regression test. No other new fake infrastructure; this is additive to the existing helper.

## Phase 10 — documentation

- `AGENTS.md`: domain-language additions (design §3), the "backend: pi... filtered out" sentence gains its registry-gated exception, routing-rule footnote noting pi harnesses run in-process rather than as a CLI.
- `CONTEXT.md`: "Known inelegance" note updated to record partial resolution (role-body duplication is now solved for a fourth backend via canonical synthesis, though the three CLI backends still duplicate files — that specific inelegance is unchanged and out of scope here); glossary gains "named Pi harness configuration."
- `README.md`: only if it currently enumerates the three harnesses by name for end users — check at implementation time and add a short pi-harness mention if so.

## Full verification commands (must all pass before this ships)

```
npm run check          # tsc --noEmit && vitest run — the whole suite, deterministic and offline
npm pack --dry-run --json
npm audit --omit=dev --audit-level=high
```

No new dependency is introduced by this feature, so `npm audit`/`npm pack` output should be unaffected; run them anyway per this repo's standing release checklist (`AGENTS.md`, "Verification and release").

## Bounded opt-in provider test — no provider calls now

`scripts/e2e/external.mjs` currently supports `--backend <claude|codex|agy>` (`parseArgs`, lines 21-53) against real, already-authenticated CLIs, run manually and never in CI. Extend it with a fourth option, `--backend pi --harness <name>`, requiring the caller to have already registered `<name>` in their own real `harnesses.json` with real credentials configured — this script makes **no provider calls today**; the extension only adds the plumbing (arg parsing, defaults object entry, doctor-style pre-check that the named harness resolves before attempting a real run) and is exercised by the user manually per `docs/field-testing.md`'s existing manual-verification posture, not by this implementation phase or by CI. This satisfies the requirement for a bounded, opt-in path without making any real provider call as part of landing this feature.

## Approved v1 scope

The user approved the bounded v1 on 2026-09-15:

1. **Built-in tools only:** Pi children use the curated built-in tool surface and do not load child extensions, skills, prompt templates, themes, or MCP-provided tools.
2. **Custom roles remain per harness in v1:** the six canonical roles are shared automatically; broader shared custom-role authoring is deferred.
3. **No Pi resume or hard budget cap in v1:** both limitations are disclosed rather than approximated.

Capability expansion is tracked in [GitHub issue #43](https://github.com/tranhoangnguyen03/pi-flow-external/issues/43), covering trusted opt-in extensions/MCP/skills, shared custom roles, resumable children, and honest cost controls.
