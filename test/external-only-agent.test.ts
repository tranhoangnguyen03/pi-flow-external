import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxToolCall } from "../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/index.js";
import { filterExternalAgentProfiles, getSubagentProfiles } from "../src/profiles.ts";
import { setupPiSubagentTestHarness } from "./helpers/pi-subagent-harness.ts";

describe("external-only Agent policy", () => {
  let agentDir = "";
  const { createSession, disposeSession } = setupPiSubagentTestHarness((state) => {
    agentDir = state.agentDir;
  });

  it("filters built-in pi-backed profiles out of the Agent roster", () => {
    const profiles = filterExternalAgentProfiles(getSubagentProfiles(agentDir));
    expect(profiles.has("general-purpose")).toBe(false);
    expect(profiles.has("explorer")).toBe(false);
  });

  it("rejects generic pi-backed profiles and points callers to native subagents", async () => {
    const { session, registration } = await createSession();
    let rootContinuation = "";
    registration.setResponses([
      fauxAssistantMessage([fauxToolCall("Agent", {
        description: "Explore repo",
        subagent_type: "explorer",
        prompt: "Map the repository.",
      })], { stopReason: "toolUse" }),
      (context) => {
        rootContinuation = JSON.stringify(context.messages);
        return fauxAssistantMessage("reported");
      },
    ]);

    await session.prompt("Use the old explorer profile.");

    expect(rootContinuation).toContain("Unknown external subagent_type");
    expect(rootContinuation).toContain("native subagent system");
    disposeSession(session);
  });

  it("keeps explicit Claude/Codex/Antigravity custom profiles in the external roster", () => {
    const subagentsDir = join(agentDir, "subagents");
    mkdirSync(subagentsDir, { recursive: true });
    writeFileSync(join(subagentsDir, "claude-explorer.md"), `---\ndescription: Explore through Claude Code.\nbackend: claude\nmodel: sonnet\n---\n\nExplore read-only.\n`);
    writeFileSync(join(subagentsDir, "codex-reviewer.md"), `---\ndescription: Review through Codex CLI.\nbackend: codex\nmodel: gpt-5.4-mini\n---\n\nReview read-only.\n`);
    writeFileSync(join(subagentsDir, "agy-planner.md"), `---\ndescription: Plan through Antigravity.\nbackend: agy\nmodel: default\n---\n\nPlan read-only.\n`);
    writeFileSync(join(subagentsDir, "local-reviewer.md"), `---\ndescription: Local pi reviewer.\nbackend: pi\n---\n\nReview locally.\n`);

    const profiles = filterExternalAgentProfiles(getSubagentProfiles(agentDir));
    expect([...profiles.keys()].sort()).toEqual(["agy-planner", "claude-explorer", "codex-reviewer"]);
  });
});
