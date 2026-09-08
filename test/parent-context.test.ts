import { describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { captureParentContext, prepareParentContext, parseParentContext } from "../src/core/parent-context.ts";

const user = (content: string) => ({ role: "user" as const, content, timestamp: 0 });
const assistant = (content: unknown[]) => ({ role: "assistant", content, timestamp: 0 }) as any;

describe("parent context transfer", () => {
  it("shares recent user turns with complete tool exchanges, excluding thinking and metadata", () => {
    const messages = [user("old requirement"), assistant([{ type: "text", text: "old answer" }]), user("current requirement"),
      assistant([{ type: "thinking", thinking: "PRIVATE" }, { type: "toolCall", id: "read1", name: "read", arguments: { path: "/repo/a" } }]),
      { role: "toolResult", toolCallId: "read1", toolName: "read", content: [{ type: "text", text: "file evidence" }], details: { secret: "PRIVATE" }, isError: false, timestamp: 0 } as any,
      assistant([{ type: "toolCall", id: "delegation", name: "Agent", arguments: { prompt: "recursive briefing" } }]),
    ];
    const result = prepareParentContext("Review only", { mode: "recent", turns: 1 }, messages, "delegation");
    expect(result.prompt).toContain("current requirement");
    expect(result.prompt).toContain("file evidence");
    expect(result.prompt).toContain("/repo/a");
    expect(result.prompt).not.toMatch(/old requirement|PRIVATE|recursive briefing/);
    expect(result.prompt.endsWith("Review only")).toBe(true);
    expect(result.context).toMatchObject({ mode: "recent", requestedTurns: 1, sharedTurns: 1 });
    expect(prepareParentContext("task", { mode: "full" }, messages, "delegation").prompt).toContain("old requirement");
  });

  it("keeps a tool result linked to its call when a user turn interrupts the exchange", () => {
    const messages = [user("older task"), assistant([{ type: "toolCall", id: "read1", name: "read", arguments: { path: "/repo/interrupted" } }]),
      user("new instruction"), { role: "toolResult", toolCallId: "read1", toolName: "read", content: [{ type: "text", text: "evidence" }], isError: false, timestamp: 0 } as any];
    const result = prepareParentContext("task", { mode: "recent", turns: 1 }, messages);
    expect(result.prompt).toContain("/repo/interrupted");
    expect(result.prompt).not.toContain("older task");
    expect(result.context?.sharedTurns).toBe(1);
  });

  it("defaults to no transfer and rejects invalid selectors and resume combinations", () => {
    expect(prepareParentContext("task", undefined, undefined)).toEqual({ prompt: "task" });
    expect(prepareParentContext("task", { mode: "none" }, undefined, undefined, "prior")).toEqual({ prompt: "task" });
    for (const value of [null, "full", {}, { mode: "selected" }, { mode: "recent" }, { mode: "recent", turns: 0 }, { mode: "recent", turns: 1.5 }, { mode: "full", turns: 2 }, { mode: "none", refs: [] }]) {
      expect(() => parseParentContext(value)).toThrow(/context/i);
    }
    expect(() => prepareParentContext("task", { mode: "full" }, [], undefined, "prior")).toThrow(/resume/);
    expect(() => prepareParentContext("task", { mode: "full" }, undefined)).toThrow(/unavailable/);
  });

  it("captures only the active compacted branch and freezes it before later messages", () => {
    const sm = SessionManager.inMemory();
    const root = sm.appendMessage(user("root"));
    sm.appendMessage(user("other branch"));
    sm.branch(root);
    const kept = sm.appendMessage(user("retained"));
    sm.appendCompaction("earlier summary", kept, 100);
    const snapshot = captureParentContext(sm);
    sm.appendMessage(user("later"));
    const full = prepareParentContext("task", { mode: "full" }, snapshot);
    expect(full.prompt).toContain("earlier summary");
    expect(full.prompt).toContain("retained");
    expect(full.prompt).not.toMatch(/other branch|later|\"root\"/);
    expect(full.context?.compacted).toBe(true);
    const recent = prepareParentContext("task", { mode: "recent", turns: 9 }, snapshot);
    expect(recent.context).toMatchObject({ requestedTurns: 9, sharedTurns: 1, compacted: true });
    expect(recent.prompt).not.toContain("earlier summary");
  });

  it("fails explicitly for unsupported attachments and oversized snapshots, never truncates", () => {
    expect(() => prepareParentContext("task", { mode: "full" }, [{ ...user(""), content: [{ type: "image", data: "secret-image", mimeType: "image/png" }] }])).toThrow(/image/);
    expect(() => prepareParentContext("task", { mode: "full" }, [user("x".repeat(1_100_000))])).toThrow(/too large/);
    const messages = [{ role: "bashExecution", command: "secret", output: "private", excludeFromContext: true } as any, user("public")];
    expect(prepareParentContext("task", { mode: "full" }, messages).prompt).not.toContain("private");
  });
});
