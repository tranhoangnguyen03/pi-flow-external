# Flow inside the independently installed PiG shell — #112

Status: **qualification candidate, not accepted**. This document accompanies the upstream changes in the unmerged PR. It does not claim that a passing unit test equals a live subscriber account or a functional human TUI.

## Exact baseline

- Initial inspected PiG-Agent shell PR #2: `3f121638feaf9c8a551a2d7001481cd7d936a8c9`, PiG **0.5.3**, Node **24.15.0**. The current tested shell source is **`dcae9e35ba8dec105e2bab9b590d9d9ce43e930a`**, with Bro **0.36.1** at `738e69f6f7cba6f828b27859c172bcf69100e829` and Comms **0.2.0** at `39ad5a7888981efbeb4c819b13d31e2f8a7576a7`. Its builder records immutable extension commits and archive checksums.
- Original Flow main: `83314a17e34b6d84796a1d88cf6c1ced30d4d3ab`, package **6.3.0-external.0**. This qualification PR deliberately bumps the candidate Flow package to **6.3.0-external.1**. The baseline remains recorded.
- Qualification CI checks out current explicitly pinned PiG PR #2 commit `dcae9e35ba8dec105e2bab9b590d9d9ce43e930a`, changes **only** the test build's Flow source commit and expected candidate package version in the shell lock, and creates a **local, CI-only** shell provenance commit. Its generated `release.json` contains the exact tested Flow commit. This does not amend PiG-Agent PR #2 or publish a release. The Flow package version bump belongs to this PR.
- The CI script rebuilds the *entire* PiG shell on Linux x64 and macOS ARM64; runs the original shell smoke and then `scripts/e2e/pig-shell-flow.mjs`. The latter installs a relocated shell, launches genuine Flow model tools with a synthetic parent model and fake child CLIs, and writes a structured report. This is **fixture evidence**, not a live-account test.

## Account ownership and child execution

PiG-Agent owns account-source selection and private model configuration. Flow consumes the resulting **process environment** and does not add an account picker, duplicate CLI account registry, or global `process.env` mutation. The default is `inherit`, which preserves normal native Pi and host CLI behavior. Shared host login and shared API keys remain supported.

For a selected **Claude Code subscription**, the shell may set `PI_EXTERNAL_CLAUDE_AUTH_SOURCE=subscription` and `CLAUDE_CONFIG_DIR=/selected/claude-home`. For a **Codex ChatGPT subscription**, it may set `PI_EXTERNAL_CODEX_AUTH_SOURCE=subscription` and `CODEX_HOME=/selected/codex-home`. Both env homes apply to the selected CLI only; don't infer different accounts from two different directories. Explicit `api` and default `inherit` are also supported.

When `subscription` is explicit, Flow builds a *child-only* env. It removes Claude's inherited `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, API base URL, alternate `CLAUDE_CODE_OAUTH_TOKEN`/refresh-token settings and Bedrock/Vertex/Foundry switches. For Codex, it removes `CODEX_API_KEY`, `OPENAI_API_KEY`, `OPENAI_BASE_URL`, alternate `CODEX_ACCESS_TOKEN`, and workload-identity variables. These overrides otherwise risk another account or billing source. It then runs **that CLI's** auth-status command with **that exact env** and refuses execution if the reported method cannot be confirmed as subscription. Claude's reported email can be compared to optional `PI_EXTERNAL_CLAUDE_EXPECTED_EMAIL`; a mismatch blocks launch. Codex CLI login status presently confirms the **login type**, not a unique ChatGPT account identity: this remains a live-host verification item. The CLI may change its status schema; unknown status fails closed for explicit selection.

For explicit `api`, Flow respects an explicitly inherited API key but removes conflicting OAuth/workload credentials from that child. For `inherit`, it does not strip or select anything. No child-scoped key or subscription rule changes the parent PiG model's auth storage. CLI execution, resume and workflow children all pass through the same launcher. Doctor reports reported login method and warns when a requested source differs. **A login-status probe is not proof of a charged request or quota.** Exercise one actual model request and inspect the account in the provider's usage/billing UI before accepting an account-routing claim.

## Model and storage boundary

- Pi SDK children resolve the installed private `PI_CODING_AGENT_DIR/models.json` and `auth.json` via `ModelRuntime.create`; `ctx.modelRegistry` retains parent runtime registrations. A dedicated fixture adds a `study/probe` model **only** to the installed agent's `.pi/models.json`, registers `pi-local`, and uses a real Pi SDK child.
- Claude Code and Codex maintain their own model registries and subscriptions. A Pi `models.json` entry does not change CLI model catalogs.
- Flow settings live under `<private-agent-dir>/pi-flow-external/settings.json`; its run evidence remains under the private Flow run directory. Installed shell release code does not share the whole user's main Pi home.
- `CLAUDE_CONFIG_DIR` and `CODEX_HOME` must be chosen by the installed-shell launcher or user's explicit host environment. **PiG-Agent PR #2 does not yet implement a user-facing account-source/profile selector or a models.json seed/share policy**; this Flow PR does not claim to deliver them.

## Evidence gate

Mark individual journeys PASS only after the named test actually completes, with machine/OS, commit SHA, release ID and logs attached. FAIL retains diagnostic evidence. NOT RUN covers any unavailable live account, no local shell, or a human TUI action not exercised. Never infer one from another.

| Journey | Verified scope and evidence | Result |
|---|---|---|
| Source pins and separation from #113 | Inspected original PiG and Flow heads | PASS |
| Unit/typecheck and release metadata | [Flow CI at 105a015c](https://github.com/tranhoangnguyen03/pi-flow-external/actions/runs/42350942945), Node 22/26 and release rules | PASS at that revision; recheck final head |
| Installed PiG rebuilt on Linux/macOS | [Earlier PiG shell CI at 105a015c](https://github.com/tranhoangnguyen03/pi-flow-external/actions/runs/42350942967) used original PiG head 3f121638; current head eef71622 adds Comms 0.2.0 | PASS earlier; current pin needs its own run |
| Flow delegate/workflow/runs/help, foreground/background and inspect/wait | Native installed shell, synthetic model and fake CLIs | PASS (fixture), NOT RUN (live) |
| Private models.json custom Pi SDK child | Native installed shell with private-only study/probe provider | PASS (fixture) |
| CLI auth source, concurrent isolated homes, inherited keys, bad account | Fixture/unit tests; no live subscribed CLI | PASS (fixture), NOT RUN (live) |
| Child errors, cancel and deadline | [Linux native fixture at 75a5011](https://github.com/tranhoangnguyen03/pi-flow-external/actions/runs/42351331887) passed; other platform/final revision separate | PASS (Linux fixture); NOT RUN (live) |
| Human PiG modal navigation: /external, pickers, doctor and inspection | No interactive terminal user in CI | NOT RUN |
| Actual Claude host login, selected account and billed request | Live subscription and billing receipt unavailable | NOT RUN |
| Actual Codex ChatGPT identity, effective auth and billed request | CLI status does not prove unique ChatGPT identity; live billing unavailable | NOT RUN |
| Shutdown/reload cleanup and manual main Pi/specialist pairing | Needs host and two running agent sessions | NOT RUN |

### Manual acceptance on a real host

1. Install a shell built with the **exact Flow PR head** (check `info`/`release.json`), under an independent `PIG_AGENT_HOME`. Use a non-default directory containing a space; run `new`, another `new`, `doctor`, and exact `resume`. Confirm settings and run receipts remain in that home's private `.pi`.
2. In the **real terminal**, run `/external`, navigate the control center, switch modes, edit configuration, select a role, run `/external doctor`, and inspect runs. Test input, Esc, scroll, resize, cancellation and shutdown/reload. Record actual observations, not screenshots of registered commands.
3. Configure host/default Claude and Codex logins, then do **actual** `external_delegate` foreground and background calls and `external_workflow`. Inspect/wait/cancel using `external_runs` and inspect error/timeout receipts. Confirm the child completed and the parent accepted the result separately; check that shutdown/reload does not leave orphaned work.
4. Configure a second explicit named account directory for each backend. Set the shell-provided source to `subscription`. Repeat checks with a deliberately inherited API key and with concurrent children. Verify status **and actual account-side usage** (Claude reported identity when available; Codex identity may require a direct human account check). Do not call the choice safe until there is evidence no request was billed to the wrong account. Preserve the parent model credential.
5. Switch to explicit API source and confirm an intentional shared key still works. Test absent CLI and absent/invalid auth without blocking parent TUI, then resume/retry and relocate the package away from the developer checkout.
6. Repeat the private `models.json` custom-provider Pi SDK child with a real, authorized provider if available. Do not infer external CLI supports the same model from this check.

## 10 November 2026 continuation

The Flow candidate remains **6.3.0-external.1**, with source changes reviewed in [draft Flow PR #114](https://github.com/tranhoangnguyen03/pi-flow-external/pull/114), not merged. Flow's `main` had not moved when this continuation began.

### Native shell download and TUI

- The original browser release URL intermittently returned HTTP 504. [Flow native CI 42669090302](https://github.com/tranhoangnguyen03/pi-flow-external/actions/runs/42669090302) passed on Linux x64 and macOS ARM64 after an optional GitHub release-asset API prefetch. The API download and normal builder both enforce the original PiG **0.5.3** SHA-256. No different release is substituted.
- The durable fix belongs to the shell builder. [PiG-Agent draft PR #4](https://github.com/tranhoangnguyen03/PiG-Agent/pull/4) is a small, unmerged change that makes its builder use the same verified GitHub API route with direct-release fallback and offline integrity tests.
- A separate native pseudo-terminal test launches the **installed PiG TUI** and sends real keyboard commands for `/external`, the control center, configuration/roles, mode, doctor, and runs. This is stronger than RPC registration, but it is **automated TUI verification**, not human review. [Linux TUI CI 42669819492](https://github.com/tranhoangnguyen03/pi-flow-external/actions/runs/42669819492) passed. Check that run's macOS job separately; do not infer its status from Linux.
- The latest shell pin adds Bro **0.36.1**. The installed fixture explicitly checks Bro, Comms, PiG, Node, and the Flow commit before exercising tools.

### Effective Codex subscription routing

`codex login status` can report a saved ChatGPT login while user-level `config.toml` sends the built-in provider through a custom `openai_base_url` or selects another `model_provider`. Therefore explicit `PI_EXTERNAL_CODEX_AUTH_SOURCE=subscription` now checks the selected `CODEX_HOME/config.toml` **before any Codex CLI probe or execution**. A custom endpoint, nondefault provider, selected config profile, unreadable file, or relative `CODEX_HOME` fails closed. Omitted `model_provider` and explicit `model_provider = "openai"` remain supported. `/external doctor` uses the same check. This is a narrowly scoped routing guard, **not** a full Codex TOML interpreter or a claim that billing was verified. Use a clean account home for explicit subscription selection; choose inherited/API behavior only deliberately.

### Outstanding gates

The CI environment has no installed, logged-in Claude Code or Codex subscription sessions. Actual completed model calls, verified account identity, and charges/usage remain **NOT RUN**. Likewise, an automated TUI pass does not replace hands-on visual review. Full live reload and account rotation still require the target machine; #113 and team auto-start are independent.

## Acceptance decision

An unmerged PR and pin-ready commit are **implementation output**, not accepted qualification. Native CI checks only fixture coverage. Human TUI and live account checks stay **NOT RUN** until someone runs them on the target host. Report any failure precisely, then fix upstream without muting test assertions. #113, automatic specialists and future team wrappers stay out of scope.
