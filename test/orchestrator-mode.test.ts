import { SessionManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, getCurrentSystemPrompt, type Context } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { ORCHESTRATOR_MODE_ENTRY, isOrchestratorMode } from "../src/orchestrator-mode.ts";
import { ORCHESTRATOR_MODE_PROMPT } from "../src/prompts.ts";
import { setupPiSubagentTestHarness } from "./helpers/pi-subagent-harness.ts";

describe("orchestrator mode", () => {
  const { createSession } = setupPiSubagentTestHarness();

  it("persists mode on the active branch, including a switch to an earlier branch", () => {
    const manager = SessionManager.inMemory("/tmp");
    expect(isOrchestratorMode({ sessionManager: manager })).toBe(false);

    manager.appendCustomEntry("another-extension", { enabled: true });
    expect(isOrchestratorMode({ sessionManager: manager })).toBe(false);

    const enabledEntry = manager.appendCustomEntry(ORCHESTRATOR_MODE_ENTRY, { enabled: true });
    manager.appendCustomEntry(ORCHESTRATOR_MODE_ENTRY, { enabled: false });
    expect(isOrchestratorMode({ sessionManager: manager })).toBe(false);

    manager.branch(enabledEntry);
    expect(isOrchestratorMode({ sessionManager: manager })).toBe(true);
  });

  it("injects only the chosen short prompt while enabled, never in normal mode", async () => {
    const { session, registration } = await createSession();
    const prompts: string[] = [];
    const reply = (context: Context) => {
      prompts.push(getCurrentSystemPrompt(context.messages));
      return fauxAssistantMessage("done");
    };
    registration.setResponses([reply, reply, reply]);

    await session.prompt("Normal turn");
    session.sessionManager.appendCustomEntry(ORCHESTRATOR_MODE_ENTRY, { enabled: true });
    await session.prompt("Orchestrator turn");
    session.sessionManager.appendCustomEntry(ORCHESTRATOR_MODE_ENTRY, { enabled: false });
    await session.prompt("Normal again");

    expect(prompts).toHaveLength(3);
    expect(prompts[0]).not.toContain("# Orchestrator Mode");
    expect(prompts[1]).toContain(ORCHESTRATOR_MODE_PROMPT);
    expect(prompts[1]).not.toContain("# External delegation");
    expect(prompts[2]).not.toContain("# Orchestrator Mode");
  });
});
