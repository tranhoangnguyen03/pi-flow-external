# Agent public contract v1

`Agent` declares `outputSchema` and returns matching `structuredContent`. Human `content` and renderer `details` remain separate. Native Pi codemode receives the structured receipt, including failures: **check `ok`**, not just whether the call threw.

```js
const receipt = await tools.Agent({ role: "worker", description: "Check build", prompt: "Run the build and report." });
if (!receipt.ok) return receipt.error;
return receipt.data.run;
```

The envelope carries `contractVersion: 1`, `tool: "Agent"`, `action: "delegate"`, ISO `observedAt`, `ok`, `data: {run}`, and `warnings`. `error: {code,message}` exists only on failure. Unknown fields must be ignored by v1 consumers; removing fields or changing their meaning requires a new contract version. The host uses the schema for declarations, not runtime output validation; tests validate actual receipts.

Pre-registration failures have `run:null`. Run receipts expose task identity, registry-confirmed liveness, lifecycle state/outcome, timing, evidence integrity (`complete`, `incomplete`, `damaged`, or `unknown`), output availability/delivery, and inspect references when resolvable. Missing evidence does not turn a settled successful run into an uncertain execution. While a run is live, `incomplete` means evidence has not yet been finalized, not that execution failed. Unreadable evidence reports `unknown` without discarding the child result. Private evidence paths and launch/configuration are not included.

Only complete canonical results are inline, within **16 KiB of UTF-8 JSON after secret redaction**. Larger values use references. False, null, zero, and empty strings are valid results. Partial narration is never the canonical value. Both model-visible channels use the existing secret redactor; `warnings` includes `output_redacted` when it changes canonical output. this is best-effort pattern redaction, not a guarantee that arbitrary sensitive prose is identified.

Codes include `configuration_invalid`, `harness_unavailable`, `selection_invalid`, `model_unavailable`, `context_invalid`, `session_closed`, and terminal outcomes `failed`, `cancelled`, `timed_out`. Unexpected exceptions remain host errors, as do predispatch schema/permission failures. A content-replacing host redaction hook drops structured content unless it explicitly supplies a replacement.

Background `ok:true` means accepted, not completed. Await foreground calls; use `background:true` for work that must outlive a codemode script. Inspect/wait through the existing `external_runs` API; its versioned contract is separate work in #77.

Pi 0.99.2 generates a useful discriminated return type (native `describeTool` result: 2941 UTF-8 bytes). Its input declaration currently loses all input properties because Pi renders the existing root `anyOf` constraints before properties; input validation itself remains intact. This is a known input-discovery limitation, not a runtime validation bypass.
