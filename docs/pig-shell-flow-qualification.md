# Flow inside the independently installed PiG shell — #112

Status: **qualification candidate, not accepted**. This document accompanies the upstream changes in the unmerged PR. It does not claim that a passing unit test equals a live subscriber account or a functional human TUI.

## Exact baseline

- Original PiG-Agent shell PR #2: `3f121638feaf9c8a551a2d7001481cd7d936a8c9`, PiG **0.5.3**, Node **24.15.0**. Its reference builder pins extension source commits and records the final archive checksum.
- Original Flow main: `83314a17e34b6d84796a1d88cf6c1ced30d4d3ab`, package **6.3.0-external.0**. This qualification PR deliberately bumps the candidate Flow package to **6.3.0-external.1**. The baseline remains recorded.
- Qualification CI checks out that exact PiG shell commit, changes **only** the test build's Flow source commit and expected candidate package version in the shell lock, and creates a **local, CI-only** shell provenance commit. Its generated `release.json` contains the exact tested Flow commit. This does not amend PiG-Agent PR #2 or publish a release. The Flow package version bump belongs to this PR.
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
| Installed PiG rebuilt on Linux/macOS | [PiG shell CI at 105a015c](https://github.com/tranhoangnguyen03/pi-flow-external/actions/runs/42350942967) | PASS at that revision; recheck final head |
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

## Acceptance decision

An unmerged PR and pin-ready commit are **implementation output**, not accepted qualification. Native CI checks only fixture coverage. Human TUI and live account checks stay **NOT RUN** until someone runs them on the target host. Report any failure precisely, then fix upstream without muting test assertions. #113, automatic specialists and future team wrappers stay out of scope.
