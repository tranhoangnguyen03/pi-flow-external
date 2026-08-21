import { afterEach, describe, expect, it, vi } from "vitest";
import { createTimeoutSignal, markSubagentTimedOut } from "../src/core/timeout.ts";
import type { SubagentToolDetails } from "../src/types.ts";

describe("subagent timeout helpers", () => {
  afterEach(() => vi.useRealTimers());

  it("extends the deadline once when nested work appears", async () => {
    vi.useFakeTimers();
    const timeout = createTimeoutSignal(undefined, 100, "Nested child");

    await vi.advanceTimersByTimeAsync(80);
    expect(timeout.extendOnce()).toBe(true);
    expect(timeout.wasExtended()).toBe(true);
    expect(timeout.effectiveTimeoutMs()).toBe(180);
    expect(timeout.extendOnce()).toBe(false);

    await vi.advanceTimersByTimeAsync(99);
    expect(timeout.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(timeout.signal?.aborted).toBe(true);
    expect(timeout.timedOut()).toBe(true);
    timeout.cleanup();
  });

  it("treats a late successful result as timed out once the timeout has fired", () => {
    const details: SubagentToolDetails = {
      description: "Late child",
      subagentType: "general-purpose",
      backend: "pi",
      status: "done",
      result: "late success after timeout",
      progress: {
        id: "late-child",
        description: "Late child",
        subagentType: "general-purpose",
        backend: "pi",
        status: "done",
        startedAt: 1,
        endedAt: 2,
        activity: [],
        activityCount: 0,
        result: "late success after timeout",
      },
    };

    const timedOut = markSubagentTimedOut(details, 20);

    expect(timedOut.status).toBe("aborted");
    expect(timedOut.timedOut).toBe(true);
    expect(timedOut.error).toBe("Subagent timed out after 20ms");
    expect(timedOut.result).toBeUndefined();
    expect(timedOut.progress?.status).toBe("aborted");
    expect(timedOut.progress?.timedOut).toBe(true);
    expect(timedOut.progress?.error).toBe("Subagent timed out after 20ms");
    expect(timedOut.progress?.result).toBeUndefined();
  });
});
