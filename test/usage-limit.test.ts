import { describe, expect, it } from "vitest";
import { usageLimitFromEvent } from "../src/core/usage-limit.ts";

describe("backend usage-limit evidence", () => {
  it("recognizes Claude's structured rejection, not warnings or assistant text", () => {
    // Rejected shape follows pi-claude-bridge; not a locally captured rejection.
    expect(usageLimitFromEvent("claude", { type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 200 } }, 100_000)).toEqual({ source: "claude.rate_limit_event", observedAt: "1970-01-01T00:01:40.000Z", resetsAt: "1970-01-01T00:03:20.000Z" });
    expect(usageLimitFromEvent("claude", { type: "rate_limit_event", rate_limit_info: { status: "allowed_warning" } })).toBeUndefined();
    expect(usageLimitFromEvent("claude", { type: "assistant", text: "quota reached" })).toBeUndefined();
  });
  it("recognizes only agy's terminal error and anchors relative reset to observation", () => {
    expect(usageLimitFromEvent("agy", { type: "result", status: "ERROR", error: "Individual quota reached. Resets in 3h2m1s." }, 0)).toEqual({ source: "agy.result.error", observedAt: "1970-01-01T00:00:00.000Z", resetsAt: "1970-01-01T03:02:01.000Z" });
    expect(usageLimitFromEvent("agy", { type: "result", status: "SUCCESS", response: "Individual quota reached" })).toBeUndefined();
    for (const backend of ["codex", "grok", "muse", "pi"]) expect(usageLimitFromEvent(backend, { type: "result", status: "ERROR", error: "Individual quota reached" })).toBeUndefined();
  });
});
