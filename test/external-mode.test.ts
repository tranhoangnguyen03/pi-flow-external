import { SessionManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, getCurrentSystemPrompt, type Context } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { EXTERNAL_MODE_ENTRY, getExternalMode, nextExternalMode } from "../src/external-mode.ts";
import { EXTERNAL_MODE_PROMPTS, FRONTLINE_WORKER_MODE_PROMPT, ORCHESTRATOR_MODE_PROMPT } from "../src/prompts.ts";
import { setupPiSubagentTestHarness } from "./helpers/pi-subagent-harness.ts";

describe("external session mode", () => {
  const { createSession } = setupPiSubagentTestHarness();

  it("cycles normal → orchestrator → frontline-worker → normal", () => {
    expect(nextExternalMode("normal")).toBe("orchestrator");
    expect(nextExternalMode("orchestrator")).toBe("frontline-worker");
    expect(nextExternalMode("frontline-worker")).toBe("normal");
  });

  it("restores legacy on/off entries and current mode from the active branch", () => {
    const manager = SessionManager.inMemory("/tmp");
    expect(getExternalMode({ sessionManager: manager })).toBe("normal");

    manager.appendCustomEntry("another-extension", { mode: "frontline-worker" });
    expect(getExternalMode({ sessionManager: manager })).toBe("normal");

    const legacyOn = manager.appendCustomEntry("pi-flow-external-orchestrator-mode", { enabled: true });
    expect(getExternalMode({ sessionManager: manager })).toBe("orchestrator");
    manager.appendCustomEntry("pi-flow-external-orchestrator-mode", { enabled: false });
    expect(getExternalMode({ sessionManager: manager })).toBe("normal");

    manager.branch(legacyOn);
    expect(getExternalMode({ sessionManager: manager })).toBe("orchestrator");

    const frontline = manager.appendCustomEntry(EXTERNAL_MODE_ENTRY, { mode: "frontline-worker" });
    expect(getExternalMode({ sessionManager: manager })).toBe("frontline-worker");
    manager.appendCustomEntry(EXTERNAL_MODE_ENTRY, { mode: "normal" });
    expect(getExternalMode({ sessionManager: manager })).toBe("normal");

    manager.branch(frontline);
    expect(getExternalMode({ sessionManager: manager })).toBe("frontline-worker");
  });

  it("injects only the active strong nudge, with no Flow prompt in normal mode", async () => {
    const { session, registration } = await createSession();
    const prompts: string[] = [];
    const reply = (context: Context) => {
      prompts.push(getCurrentSystemPrompt(context.messages));
      return fauxAssistantMessage("done");
    };
    registration.setResponses([reply, reply, reply, reply]);

    await session.prompt("Normal turn");
    session.sessionManager.appendCustomEntry(EXTERNAL_MODE_ENTRY, { mode: "orchestrator" });
    await session.prompt("Orchestrator turn");
    session.sessionManager.appendCustomEntry(EXTERNAL_MODE_ENTRY, { mode: "frontline-worker" });
    await session.prompt("Frontline turn");
    session.sessionManager.appendCustomEntry(EXTERNAL_MODE_ENTRY, { mode: "normal" });
    await session.prompt("Normal again");

    expect(prompts).toHaveLength(4);
    expect(EXTERNAL_MODE_PROMPTS.normal).toBeUndefined();
    expect(prompts[0]).not.toContain("# Orchestrator Mode");
    expect(prompts[0]).not.toContain("# Frontline Worker Mode");
    expect(prompts[1]).toContain(ORCHESTRATOR_MODE_PROMPT);
    expect(prompts[1]).not.toContain(FRONTLINE_WORKER_MODE_PROMPT);
    expect(prompts[2]).toContain(FRONTLINE_WORKER_MODE_PROMPT);
    expect(prompts[2]).not.toContain(ORCHESTRATOR_MODE_PROMPT);
    expect(prompts[3]).not.toContain("# Orchestrator Mode");
    expect(prompts[3]).not.toContain("# Frontline Worker Mode");
    expect(prompts[1]).not.toContain("# External delegation");
    expect(prompts[2]).not.toContain("# External delegation");
  });
});
