# Flow External: programmable public contracts
## Issue, design, and implementation handoff • 1 October 2026

**Build the public contract improvements. Keep Flow's execution runtime.**

This package is ready for an implementing agent or developer. It contains a proposed issue, a concrete design, an ordered delivery plan, contract fixtures, acceptance tests, and a separate context-handoff analysis. It is not an implemented patch, a published GitHub issue, or a claim that repository tests have passed.

### The decision already made

The maintainer uses `pi-flow-external` to let the main Pi agent orchestrate delegated work. They use `pi-bro` primarily for private sideline conversations while staying informed. Native Pi codemode is an additional tool-composition surface, not a replacement for Flow or Bro.

The maintainer approved the direction of these three improvements:

1. Stable machine-facing results and errors for Flow's public tools.
2. Coordinated machine data, readable status, and inspectable evidence from the same run state.
3. Concise discoverable interfaces and harness capabilities instead of a large memorized playbook.

**Explicitly excluded:** migrating to QuickJS, replacing Flow's worker/VM, embedding the codemode runtime in Flow, or redesigning agent execution. Do not implement the last recommendation from the preceding discussion. This handoff also does not authorize a blackboard, a new context-sharing mode, automatic transcript transfer, Bro changes, or publication/deployment.

The API details below are implementation-ready design choices made for this handoff, not claims that the maintainer separately approved each field name. Adjust a detail only when source compatibility or a failing test justifies it; record the reason. Do not reopen the three agreed goals.

### Read and act

| Read | Purpose |
|---|---|
| [01_ISSUE.md](01_ISSUE.md) | Copy-ready issue and scope/acceptance statement. |
| [02_DESIGN.md](02_DESIGN.md) | Public contract, errors, projections, compatibility, and discovery. |
| [03_IMPLEMENTATION_PLAN.md](03_IMPLEMENTATION_PLAN.md) | File-level sequence, dependency order, and first executable slice. |
| [04_TESTS_AND_ACCEPTANCE.md](04_TESTS_AND_ACCEPTANCE.md) | Regression matrix and real-host checks required before completion. |
| [05_CONTEXT_HANDOFF_INTERPLAY.md](05_CONTEXT_HANDOFF_INTERPLAY.md) | What codemode can improve now, and what remains research-only. |
| [06_SOURCE_MAP.md](06_SOURCE_MAP.md) | Pinned evidence, exact files/symbols, and known limitations. |
| [07_IMPLEMENTER_BRIEF.md](07_IMPLEMENTER_BRIEF.md) | Paste into the recipient's new session. |
| [contracts/README.md](contracts/README.md) | Normative draft envelope/schema and positive/negative fixtures. |

Start with `01`, `02`, and the first slice of `03`. Read the repository's current `AGENTS.md` before editing. The source map makes the package understandable without this chat; it does not replace checking the actual checkout.

### Baseline

- Flow repository: `tranhoangnguyen03/pi-flow-external`.
- Inspected commit: `ae04c8883470dcc16995f75ea2a39b5b32e729db` (`main` as inspected); manifest version `2.10.0-external.0`.
- Pi repository: `earendil-works/pi`.
- Inspected commit: `8ce69e9d2b171d173fe4b6b2b6256f1f4411e69d`; coding-agent version `0.99.2`.
- Flow's existing development dependencies pin Pi packages to `0.79.4`; that is a real compatibility/test gap, not evidence that structured public results work on that version. [S01, S02, S03]

Do not reset a newer checkout to these commits. Inspect the diff and preserve later fixes. Use an isolated checkout/test environment for the Pi 0.99.2 integration lane; do not upgrade the user's global Pi or rewrite their settings.

```sh
# Run from the unpacked handoff directory. This script does not change the repo.
node scripts/preflight.mjs /absolute/path/to/pi-flow-external

# Validate THIS PACKAGE's draft schemas/fixtures, not Flow's implementation.
# Requires Python 3 and jsonschema 4.x.
python scripts/validate_contracts.py
```

### Initial action

Build one thin vertical slice: a fake-backed foreground `Agent` call, through real Pi 0.99.2 codemode, producing a validated structured receipt. Cover a successful child, a failed child with retained evidence, and a pre-launch error. Preserve the existing direct tool card. Then extend the same contract builder to `workflow` and `external_runs`.

### Authorization and working style

Carry the scoped local implementation through tests and reporting when this package is assigned. Do not make the user manage each task. Use direct work by default. Coordinated multi-agent work still requires a sufficiently specific approved coordination plan; codemode is not a way around that rule. Keep brief milestone updates. Ask before materially expanding scope or resource use. Pushing, opening an issue/PR, merging, publishing, paid provider runs, or editing external/shared systems require authorization; this package alone does not grant it.

### Verification status

Source was inspected through the GitHub connector and Pi documentation. The build environment could not resolve `github.com` for a local clone. Consequently, no repository build, baseline suite, real Pi integration test, or provider run was executed here. Package-level checks are recorded in [08_VALIDATION.md](08_VALIDATION.md). The recipient must execute the implementation acceptance gates. No unsupported success claim is hidden in the fixtures.

Sources: [06_SOURCE_MAP.md](06_SOURCE_MAP.md).
