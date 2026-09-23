import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxToolCall } from "../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/index.js";
import { defaultProfileNames } from "../src/defaults.ts";
import { filterExternalAgentProfiles, getSubagentProfiles } from "../src/profiles.ts";
import { getConfiguredHarnessNames } from "../src/harnesses.ts";
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
    const overridesDir = join(agentDir, "pi-flow-external", "overrides");
    const subagentsDir = join(agentDir, "subagents");
    mkdirSync(overridesDir, { recursive: true });
    mkdirSync(subagentsDir, { recursive: true });
    writeFileSync(join(overridesDir, "claude-explorer.md"), `---\ndescription: Explore through Claude Code.\nbackend: claude\nmodel: sonnet\n---\n\nExplore read-only.\n`);
    writeFileSync(join(overridesDir, "codex-reviewer.md"), `---\ndescription: Review through Codex CLI.\nbackend: codex\nmodel: gpt-5.4-mini\n---\n\nReview read-only.\n`);
    writeFileSync(join(overridesDir, "agy-planner.md"), `---\ndescription: Plan through Antigravity.\nbackend: agy\nmodel: default\n---\n\nPlan read-only.\n`);
    writeFileSync(join(overridesDir, "local-reviewer.md"), `---\ndescription: Local pi reviewer.\nbackend: pi\n---\n\nReview locally.\n`);
    writeFileSync(join(subagentsDir, "scout.md"), `---\ndescription: Native Pi scout.\nbackend: pi\n---\n\nNative work.\n`);

    const profiles = filterExternalAgentProfiles(getSubagentProfiles(agentDir));
    expect([...profiles.keys()].sort()).toEqual([...defaultProfileNames()].sort());
    expect(profiles.get("claude-explorer")).toMatchObject({ backend: "claude", model: "sonnet" });
    expect(profiles.get("codex-reviewer")).toMatchObject({ backend: "codex", model: "gpt-5.4-mini" });
    expect(profiles.get("agy-planner")).toMatchObject({ backend: "agy", model: "default" });
    expect(profiles.has("local-reviewer")).toBe(false);
    expect(profiles.has("scout")).toBe(false);
  });

  it("includes a registered pi-* harness's on-disk or synthesized role profiles in the external roster", () => {
    mkdirSync(join(agentDir, "pi-flow-external", "overrides"), { recursive: true });
    mkdirSync(join(agentDir, "subagents"), { recursive: true });
    writeFileSync(
      join(agentDir, "pi-flow-external", "settings.json"),
      JSON.stringify({ version: 4, harnesses: { "pi-deepseek": { model: "deepseek/deepseek-chat", thinking: "high" } } }),
    );
    writeFileSync(
      join(agentDir, "pi-flow-external", "overrides", "pi-deepseek-reviewer.md"),
      `---\ndescription: Security review through pi-deepseek.\nbackend: pi\nharness: pi-deepseek\n---\n\nReview for security defects.\n`,
    );
    writeFileSync(
      join(agentDir, "subagents", "pi-deepseek-worker.md"),
      `---\ndescription: Native-looking worker.\nbackend: pi\nharness: pi-deepseek\n---\n\nIgnored.\n`,
    );

    const configuredPiHarnesses = getConfiguredHarnessNames(agentDir);
    const profiles = filterExternalAgentProfiles(getSubagentProfiles(agentDir), configuredPiHarnesses);
    expect(profiles.has("pi-deepseek-reviewer")).toBe(true);
    expect(profiles.get("pi-deepseek-reviewer")).toMatchObject({
      backend: "pi",
      harness: "pi-deepseek",
      description: "Security review through pi-deepseek.",
    });
    expect(profiles.get("pi-deepseek-worker")?.description).toContain("pi-deepseek");
    expect(profiles.get("pi-deepseek-worker")?.description).not.toBe("Native-looking worker.");
    expect(profiles.has("scout")).toBe(false);
  });
});
