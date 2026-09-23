# Configuration redesign verification

Implementation branch: `feat/configuration-redesign`; proposed release: `3.0.0-external.0` (breaking command/configuration surface).

## Automated verification

- Baseline before implementation: 40 test files, 442 tests passing.
- Final `npm run check`: TypeScript passes; 42 files, 459 tests passing.
- `git diff --check`: passes.
- `npm pack --dry-run --json`: 3.0.0-external.0; runtime sources included, tests excluded.
- `npm audit --omit=dev --audit-level=high`: zero vulnerabilities.
- One full-suite attempt hit the existing workflow fatal-cleanup test's 200ms wall-clock assertion under load. Its targeted rerun and the subsequent full check passed. Do not interpret this as a backend failure or silently relax the assertion.

## Real-provider checks

| Lane | Direct | Workflow |
|---|---|---|
| Claude (E2E Sonnet model) | Passed | Passed |
| Grok (explicit danger) | Passed | Passed |
| Muse | Passed | Passed |
| Named Pi (`pi-deepseek`) | Passed | Passed |
| Codex | Blocked: CLI installation missing `@openai/codex-darwin-arm64` | Not attempted after direct startup failure |
| Agy | Quota blocked during delegated implementation | Not attempted while quota blocked |

Natural-language routing smoke: passed with a real `9-router/big-brain` root calling Grok in danger mode.

Named Pi and routing checks used a private temporary agent directory with copied local model/auth configuration and v4 harness settings. No conversion or purge ran against the user's real configuration. Temporary credential copies were removed after verification. CLI checks used the runner's isolated fixtures.

Claude's external reviewer profile still selected inaccessible `claude-opus-5.5`; that review failed. This is distinct from the successful Sonnet E2E checks. Failed external runs were not retried or silently switched to another model/permission tier.

## Review and integration

Grok reviewed upgrade/purge boundaries, canonical selection, and integrated flows. Muse reviewed instruction surfaces and implemented creator/command flows. Parent inspected changes and fixed mismatched-override fallback, stale settings messages, native-profile legacy detection, explicit editor repair, and atomic role/override publication. All five CLI harnesses and named Pi are represented in catalog and documentation.

A delegated test initially wrote a temporary fixture to the real agent overrides directory in error. The delegate removed it; the parent independently checked that the reported fixture was absent. Command tests now use awaited isolated agent-directory scopes.

## Release hold

Keep the PR draft until Agy/Codex required real-provider lanes and broader manual discovery checks can run. Do not merge/publish based only on the passing subset. No merge or publication was performed.
