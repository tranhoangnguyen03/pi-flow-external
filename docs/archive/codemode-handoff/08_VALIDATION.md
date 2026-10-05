# Package validation record

Prepared 1 October 2026. This report distinguishes the handoff's checks from the feature implementation's required checks.

## Executed here

| Check | Observed result |
|---|---|
| Draft 2020-12 schema validity | Passed with jsonschema 4.26.0. |
| Contract fixtures | 39 cases: 27 valid examples accepted; 12 invalid examples rejected as intended. |
| Mock example execution | 11 checks passed, including pagination, typed failure, null handoff, missing final, oversized evidence, malformed JSON, and wrong-source rejection. |
| Preflight utility syntax | `node --check scripts/preflight.mjs` passed. |
| Preflight help route | Executed successfully; no repository inspection or mutation. |
| Local links/checksums/archive | Verified during final packaging; rerunnable local checks are in `scripts/verify_package.py`. |

Package test environment: Python 3.13.5, Node 22.16.0. The mock utilities run in that environment; this does NOT meet or certify the Flow application's Node >=22.19.0 baseline. No Flow application was executed.

## Not executed here

No Flow repository baseline/build/test suite, target Pi 0.99.2 integration, real tool-hook/redaction test, actual TUI interaction, external CLI, provider call, paid evaluation, or installed-package compatibility check. A local clone attempt failed because the build container could not resolve `github.com`; source inspection used the connected GitHub reader instead.

Nothing was implemented in the target repository. No GitHub issue, PR, commit, release, or external publication was created. The design schemas and fixtures describe the PROPOSED API, not a captured production interface.

## Rerun package checks

```sh
python scripts/verify_package.py
python scripts/validate_contracts.py
node scripts/test_examples.mjs
node --check scripts/preflight.mjs
```

`validate_contracts.py` requires Python's `jsonschema` 4.x; the other package checks use standard libraries. For implementation completion, execute the repository and real-host gates in [04_TESTS_AND_ACCEPTANCE.md](04_TESTS_AND_ACCEPTANCE.md). Package tests alone do not satisfy those gates.
