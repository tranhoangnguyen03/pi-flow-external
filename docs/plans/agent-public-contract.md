# Agent Public Contract Implementation Plan

**Goal:** Deliver #76: a versioned Agent receipt usable through native Pi codemode without changing execution ownership or rendering.

**Architecture:** Serialize existing RunRegistry and durable run projections after settlement. Keep renderer details separate; attach outputSchema, structuredContent, and isError at the Agent boundary. Expected failures receive codes at their source; unexpected errors still throw.

**Tech Stack:** Pi 0.99.2, TypeBox, Vitest, existing faux providers and fake CLI executables.

## 1. Contract and serializer
- Add `src/public-contract.ts` and `test/public-contract.test.ts`.
- Write failing checks for envelope discrimination, canonical false/null/zero/empty-string values, 16 KiB UTF-8 JSON cutoff, authoritative settlement, unknown/damaged/incomplete evidence, and inspectable refs only.
- Implement explicit narrow schemas and reuse `projectLiveAgent` / `projectDurableAgent`. Exclude launch/configuration and private paths. Redact both model-visible channels.
- Run `npx vitest run test/public-contract.test.ts`.

## 2. Agent boundary
- Modify `src/pi-subagent.ts`; introduce coded expected errors only where causes are known in selector/context helpers.
- Attach receipts for prelaunch failure (run:null), background registration, foreground success, and evidence-bearing failure. Wait for registry settlement before projecting foreground state. Preserve renderer details and progress.
- Extend existing Agent tests instead of duplicating lifecycle coverage.

## 3. Native codemode acceptance
- Extend `test/helpers/pi-subagent-harness.ts` to optionally load Pi's native codemode extension.
- Add isolated `test/agent-codemode.test.ts` calling the actual registered Agent through codemode, using faux/fake execution, never paid inference.
- Test structured error data separately from host dispatch rejection and programming throws; test host redaction hooks. Validate actual receipts with the advertised schema and record generated declaration size/useful types.
- Document v1 compatibility (ignore unknown fields; breaking changes require a new contractVersion), inline cap, and error semantics.
- Run `npm run check`, `git diff --check`, and `npm pack --dry-run --json`.

No push, PR, release, global configuration changes, workflow/public-supervision conversion (#77), or new execution runtime.
