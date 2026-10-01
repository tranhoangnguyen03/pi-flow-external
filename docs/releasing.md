# Releasing to npm

Releases are automated. Merging a PR that bumps `package.json`'s version tags
the commit, publishes to npm via OIDC trusted publishing (no npm token or 2FA
in CI), and creates the GitHub release. npm versions are immutable: never
republish an existing version, and never force-push release history.

## Versioning

Versions are always `X.Y.Z-external.N`:

- A core bump (patch/minor/major) resets the counter: `1.9.0-external.1` → `1.10.0-external.0`.
- A same-core publish increments it: `1.9.0-external.0` → `1.9.0-external.1`.

Bump on the PR branch with:

```bash
npm version <new-version> --no-git-tag-version
```

Do not create Git tags manually; the release workflow owns them.

## The PR contract (CI-enforced)

CI validates release metadata on every PR to `main`, and re-validates when
labels change:

- The version must be a clean bump of the published npm version (patch,
  minor, major with `external.0`, or `prerelease` with `external.N+1`).
- Exactly one label matches the bump: `release:patch`, `release:minor`,
  `release:major`, or `release:prerelease`. A no-release PR carries
  `release:none` instead and must not bump the version.
- Changing shipped files (the `files` list in `package.json`, plus
  `package.json`/`package-lock.json`) without a version bump fails.
- `package-lock.json` must carry the same version (run `npm install` after
  bumping).
- `CHANGELOG.md` must have a `## [X.Y.Z-external.N] - YYYY-MM-DD` section for
  the new version.

## What merging does

`release.yml` runs on every push to `main`:

1. **verify** — `npm run check`, `npm pack --dry-run --json`, and
   `npm audit --omit=dev --audit-level=high` on the merged commit. The same
   gate AGENTS.md requires locally.
2. **release** — only when the version differs from npm's latest:
   - tags `vX.Y.Z-external.N` and checks out the tagged tree, so publishing
     always happens from the source the tag points at;
   - publishes with `--provenance --ignore-scripts`, skipping if npm already
     has the version;
   - creates the GitHub release with the CHANGELOG section as notes and a
     full-changelog compare link, only after npm serves the version.

Every step is idempotent: a failed run can be re-run and resumes at the first
missing artifact. Runs are serialized (`concurrency: release`).

## One-time setup

Already done or needed once, manually:

- On npmjs.com, link `@tranhoangnguyen0310/pi-flow-external` as a trusted
  publisher bound to repository `tranhoangnguyen03/pi-flow-external` and
  workflow filename `release.yml`.
- Create the labels `release:patch`, `release:minor`, `release:major`,
  `release:prerelease`, `release:none`.
- Prove trusted publishing without publishing: Actions → release → Run
  workflow with `verify_only`. The `oidc-check` job exchanges an OIDC token
  with npm and reports the claims npm will match.

## Before pushing a release PR

Run the same gate CI will run, so the PR is green on arrival:

```bash
npm run check
git diff --check
npm pack --dry-run --json
npm audit --omit=dev --audit-level=high
```

Inspect the dry-run manifest: expected version and files, including
`index.ts`, `README.md`, runtime sources, `scripts/field-report.mjs`, and
operational docs. Development E2E scripts and tests must not be shipped.

Run the essential real-provider gate from [`field-testing.md`](field-testing.md)
before merging: all six direct backends are mandatory (`agy`, `claude`,
`codex`, `grok`, `muse`, `opencode`), plus their workflow receipts, and one named Pi
harness direct plus workflow receipt when a real harness is registered. Add the routing smoke when
discovery, coordinator guidance, or slash commands changed, the configuration
surface check and task-based modal/RPC/headless checks when settings, roles, upgrade, or purge changed, and the nested
timeout scenario when nested detection or timeout behavior changed. An
auth-blocked lane is not a pass.

Moving execution settings to version 5, introducing the guided configuration
hub modal, and replacing prior command routes with symmetric `/external config harness`
and `/external config role` commands is a breaking configuration change. The
release PR must choose an explicitly approved version bump and matching CI label.
The historical v4 redesign shipped with `release:minor`; that does not decide the
version or label for this unreleased change. Whatever the approved classification,
the break must be prominently disclosed, not hidden in a routine patch note. Execution requires settings version 5;
unconverted version 4 settings are blocked at runtime rather than executed under
fallback compatibility. The CHANGELOG section, which becomes the GitHub release
notes, must include the README upgrade notice:
- The old-to-new command mapping:
  - `/external config harnesses` → `/external config harness list`
  - `/external config enable|disable|default <harness>` → `/external config harness enable|disable|default <harness>`
  - `/external config harness create` (interview) → `/external config harness create pi-NAME --model provider/model` (direct) or `/external config harness assist` (assisted)
  - `/external roles` → `/external config role list`
  - `/external role create` → `/external config role create NAME` (editor) or `/external config role assist` (assisted)
  - `/external role inspect <role> [harness]` → `/external config role inspect <role> [--harness NAME]`
  - `/external role override <role> <harness>` → `/external config role edit <role> --harness NAME`
  - Former `/external settings`, `/external profiles`, `/external profile create`, and `/pi-flow-profile create` remain removed.
- The guided configuration hub modal in TUI, native dialogs in RPC, and text overview/configuration in headless/no-UI mode.
- One-time conversion through `/external config convert` (staged pre-v4 to v4, then v4 to v5): originals kept, `settings.v4.backup.json` preserved, instruction overrides landing in nested `overrides/<harness>/<role>.md` directories with `description` frontmatter only, and legacy exact selectors mapped to `exact` in `settings.json`.
- `/external [danger]purge-old-files` deletes only the legacy paths you select (customized copies included); downgrade after purge needs the user's own backup. Do not claim side-by-side old and new layouts.

The version bump and CHANGELOG text are owned by the release PR; this file only states the contract.

## After the release

Confirm the registry:

```bash
npm view @tranhoangnguyen0310/pi-flow-external@<new-version> version
npm view @tranhoangnguyen0310/pi-flow-external dist-tags --json
npm view @tranhoangnguyen0310/pi-flow-external@<new-version> dist --json
```

`latest` must resolve to the release (automation publishes with the default
`latest` dist-tag; override only for an intentional non-latest channel).

Install the exact published version into a temporary Pi agent directory so an
older global installation cannot produce a false pass:

```bash
export VERIFY_AGENT_DIR="$(mktemp -d /tmp/pi-flow-release-check.XXXXXX)"
PI_CODING_AGENT_DIR="$VERIFY_AGENT_DIR" pi install "npm:@tranhoangnguyen0310/pi-flow-external@<new-version>"
PI_CODING_AGENT_DIR="$VERIFY_AGENT_DIR" pi list
PI_CODING_AGENT_DIR="$VERIFY_AGENT_DIR" pi
# In Pi:
# /external (opens guided modal in TUI, or text overview in headless)
# /external doctor (checks catalog and reports CLI/Pi readiness)
# /external config harness list (lists all 6 built-in CLIs and any pi-* entries)
# /external config role list (lists the 6 built-in roles)
# Confirm removed routes (/external settings, /external roles, /external role create, /external profile create)
# report current usage and point to /external help, which lists replacement mappings.
# None may launch obsolete paths. Also verify /external config text emits text in TUI.
# Confirm the fresh directory has no seeded subagents/*.md files or markers.
rm -rf "$VERIFY_AGENT_DIR"
unset VERIFY_AGENT_DIR
```

Confirm `pi list` shows the exact version and `/external doctor`,
`/external config`, and `/external config harness list` respond. Note that
`doctor` reports readiness separately from catalog validity — fresh installs
without all CLIs installed or authenticated are normal and pass catalog
validation. A fresh directory must not gain the old 30 seeded profile files or
seed markers. Keep resulting evidence private and remove the temporary agent
directory afterward.

## Drift watchdog

`sync-check.yml` runs daily and compares npm's latest with the latest GitHub
release. On drift above the pre-automation baseline (`1.9.0-external.0`) it
opens or comments on a "Release drift" issue and closes it once back in sync.
Fix drift by re-running the release workflow, never by manual publishing.

## Emergency manual publish

Only when automation itself is broken. Follow the normal PR contract
(version, lockfile, CHANGELOG, review), then:

```bash
git switch main && git pull --ff-only origin main && git status --short
npm whoami   # npm login --auth-type=web if needed; npm may require publish-time 2FA
npm publish --access public --provenance --ignore-scripts
```

Then create the tag and GitHub release exactly as `release.yml` would
(`vX.Y.Z-external.N`, CHANGELOG section as notes), verify the registry as
above, and file an issue about the broken automation. Do not paste npm
tokens, one-time passwords, or browser authentication URLs into issues, PRs,
logs, or agent prompts. If a publish attempt fails, verify whether the
registry accepted the version before retrying; never bump to retry.
