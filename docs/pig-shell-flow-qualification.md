# Flow inside independently installed PiG — qualification #112

**Status: automated native compatibility PASS on Linux x64 and macOS ARM64; live account and human acceptance NOT RUN.** Keep [Flow PR #114](https://github.com/tranhoangnguyen03/pi-flow-external/pull/114) and [PiG-Agent PR #4](https://github.com/tranhoangnguyen03/PiG-Agent/pull/4) draft/unmerged. No Flow fork. No main Pi automatic specialist startup (#113).

## Exact tested versions and sources

- Flow base `83314a17e34b6d84796a1d88cf6c1ced30d4d3ab`, candidate **6.3.0-external.1** in [PR #114](https://github.com/tranhoangnguyen03/pi-flow-external/pull/114). The [passing native run](https://github.com/tranhoangnguyen03/pi-flow-external/actions/runs/42756857238) tested code commit **`3312ed8ab49207828f246d958481ae0202cd38a3`**.
- Shell owner [PiG-Agent PR #4](https://github.com/tranhoangnguyen03/PiG-Agent/pull/4) exact commit **`943a23ceb70678e3d2908b090adced05fa297c48`**, stacked on PiG-Agent PR #2. This source includes the verified asset API fallback and macOS canonical session path fix.
- Runtime **PiG 0.5.3**, **Node 24.15.0**; installed **Bro 0.36.1**, **Comms 0.2.0**, **Flow 6.3.0-external.1**. CI locally rewrites only Flow's entry in the pinned shell source lock to the checked-out Flow commit/version, then makes a test-only local git commit so the shell builder's clean checkout rule remains intact. The published release is not changed.

## Ownership and behavior

**PiG-Agent owns** the installed home, shell launcher, private `models.json` and account/profile choices. Its [issue #5](https://github.com/tranhoangnguyen03/PiG-Agent/issues/5) tracks the still-missing user-facing account selection and optional model seeding. The shell does **not** copy the whole main Pi home.

**Flow owns** external child execution, models resolved through the Pi SDK, supervision, receipts, cancellation, resumption and observations. The default child CLI auth source `inherit` preserves host behavior. For explicitly selected `subscription` or `api`, Flow creates a per-child environment and uses it for account status probes and actual execution. No parent `process.env` mutation, no account selection UI in Flow.

A subscription choice remains a **request**, not proof of who will pay:
- Claude child filters inherited API key/token/endpoint variables, but Claude's user, project and managed settings and `apiKeyHelper` can affect the effective credential. `claude auth status` is not a billable-request receipt.
- Codex child filters inherited API keys/endpoint variables. For explicit ChatGPT subscription selection, Flow also checks a narrow set of root `CODEX_HOME/config.toml` selectors (`openai_base_url`, `chatgpt_base_url`, nondefault `model_provider`, selected `profile`). `codex login status` alone cannot establish an effective account or request endpoint. Neither can the static scan.
- Reviewed `openai/codex` **rust-v0.165.0** source: default provider is `openai`; configured `model_providers.openai` does not replace that built-in provider in the inspected provider merge. The valid form `[model_providers]\nopenai = { base_url = "..." }` does **not**, by itself, prove a redirected billable request in that version. Flow no longer rejects provider-map shapes on a false inference. CLI version drift and higher-priority configuration need re-qualification.
- Custom Pi SDK providers belong in the installed private `PI_CODING_AGENT_DIR/models.json`; external CLI model catalogs are not interchangeable with that registry.

## Evidence matrix

| Gate | Result | Evidence |
|---|---|---|
| Flow Node 22/26 unit tests, typecheck and release metadata | **PASS** for tested runtime code | [CI 42756857221](https://github.com/tranhoangnguyen03/pi-flow-external/actions/runs/42756857221) |
| PiG-Agent owner-side unit tests, native shell builds and package/RPC smoke on Linux x64 + macOS ARM64 | **PASS** | [PR #4 run 42756789789](https://github.com/tranhoangnguyen03/PiG-Agent/actions/runs/42756789789) |
| Full installed PiG shell + Flow tools (`external_delegate`, `external_workflow`, `external_runs`, `external_help`), synthetic Claude/Codex children, structured receipts, foreground/background, streaming evidence, inspect/wait, cancel, resume, timeout, error and shutdown | **PASS — fixture, Linux + macOS** | [Flow native run 42756857238](https://github.com/tranhoangnguyen03/pi-flow-external/actions/runs/42756857238) |
| Installed-only custom `models.json` Pi SDK child | **PASS — synthetic provider on both OS** | Same Flow native run |
| Native PiG TUI keyboard for `/external`, configuration/roles, mode, doctor and runs | **PASS — automated on both OS** | Same Flow native run, not a human visual review |
| Real Claude Code and Codex authenticated model calls, chosen account, effective billing source/charges | **NOT RUN** | No authorized signed-in CLI accounts on CI hosts |
| Full human TUI review, real account rotation/reload, manual main Pi ↔ installed specialist pairing | **NOT RUN** | Requires target host; separate from fixture |

**Full native build IDs for code commit `3312ed8...`:**
- Linux x64: `0.1.0-preview.1-linux-x64-bbce3db3e823f324` ([artifact](https://github.com/tranhoangnguyen03/pi-flow-external/actions/runs/42756857238/artifacts/13736071511)).
- macOS ARM64: `0.1.0-preview.1-darwin-arm64-2ab9f46fe1c40e25` ([artifact](https://github.com/tranhoangnguyen03/pi-flow-external/actions/runs/42756857238/artifacts/13736660344)).

### Historical failure and correction

[Run 42674933619](https://github.com/tranhoangnguyen03/pi-flow-external/actions/runs/42674933619) **FAILED on macOS** in the PiG lifecycle test comparing `/var/...` with `/private/var/...`. Six new archive tests passed, but native compilation, Flow fixtures and TUI were **NOT RUN** in that failed job. PiG-Agent PR #4 now compares canonical paths in the test **and** fixes `resume`: compare a realpath transcript to a realpath sessions root so macOS aliases work without accepting outside files. A dedicated symlinked-home regression preserves the private-home boundary. The new run **42756857238 passed fully on both OS**; the old failure remains recorded.

### Ongoing compatibility policy

Expensive native builds run on the qualification PR while it is open, then **weekly (Monday 03:17 UTC)** and by manual `workflow_dispatch` after merge. They do **not** run on every ordinary subsequent PR. The fixture reads the checked-out Flow version from `package.json`. The PiG-Agent source stays pinned to a reviewed exact SHA until someone deliberately updates it. This is periodic compatibility coverage, not automatic testing against every newest upstream shell or CLI.

## Required live host acceptance (still NOT RUN)

1. Install an exact pinned shell under a separate `PIG_AGENT_HOME` with a space in its path. Exercise first use, fresh session, exact resume, rollback and release change while checking private state.
2. In a **human-operated terminal**, open `/external`, configure agents/roles/mode, diagnose auth, browse runs/workflows/help; check rendering, Esc, scroll, resize, loading and reload.
3. Run actual Claude Code and Codex foreground/background delegates, workflow, resume and cancellation with known host logins. Check child completion and parent acceptance separately; confirm shutdown cleanup.
4. Deliberately select different authenticated account homes, run concurrent children with an inherited API key in the parent, and compare the **actual effective account and account-side usage** to expected subscription/API billing. Include Claude `apiKeyHelper` and managed/project settings, and Codex layered config. A status command or config scan alone is not evidence.
5. Verify intentional API-key sharing, absent CLI, invalid auth, private custom Pi provider/model with an actual authorized endpoint and fresh/resumed sessions. Do not copy the main Pi home or silently change its credentials.

## Acceptance decision

**Automated native compatibility is green. Full #112 qualification is not complete.** Keep the issue and both PRs open/draft until live account/billing and human interaction checks are independently recorded. #113 and future team startup remain separate, non-blocking work.
