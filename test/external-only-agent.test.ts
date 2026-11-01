import { describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { setupPiSubagentTestHarness } from "./helpers/pi-subagent-harness.ts";

describe("external-only external_delegate policy", () => {
  const { createSession, disposeSession } = setupPiSubagentTestHarness();

  it("rejects an unknown exact profile instead of sending the caller to native subagents", async () => {
    const { session, registration } = await createSession();
    let rootContinuation = "";
    registration.setResponses([
      fauxAssistantMessage([fauxToolCall("external_delegate", {
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
    expect(rootContinuation).not.toContain("native subagent");
    disposeSession(session);
  });
});

describe("tool loadout restored from a pre-rename transcript", () => {
  const { createSession } = setupPiSubagentTestHarness();
  const builtins = ["read", "bash", "edit", "write"];

  // Pi restores the transcript loadout when it opens a saved session, and again
  // on tree navigation after extensions are bound. `tools` reaches both Pi and
  // the extension, as `--tools` does.
  async function restoredLoadouts(transcriptToolNames: string[], tools?: string[]) {
    const argv = process.argv;
    if (tools) process.argv = [...argv, "--tools", tools.join(",")];
    try {
      const { session } = await createSession({ transcriptToolNames, tools });
      const opened = session.getActiveToolNames();
      await session.navigateTree(session.sessionManager.getEntries()[0].id);
      return [opened, session.getActiveToolNames()];
    } finally {
      process.argv = argv;
    }
  }

  it("activates the replacement of each legacy launcher name, without companion tools", async () => {
    for (const active of await restoredLoadouts([...builtins, "Agent", "workflow"])) {
      expect(active).toEqual(expect.arrayContaining(["external_delegate", "external_workflow"]));
    }
  });

  it("activates only the launchers whose legacy names the loadout declares", async () => {
    for (const active of await restoredLoadouts([...builtins, "Agent", "external_help"])) {
      expect(active).toContain("external_delegate");
      expect(active).not.toContain("external_workflow");
    }
  });

  it("leaves a current loadout without launchers unchanged", async () => {
    for (const active of await restoredLoadouts([...builtins, "external_help", "external_runs"])) {
      expect(active).not.toContain("external_delegate");
      expect(active).not.toContain("external_workflow");
    }
  });

  it("keeps a launcher excluded by a --tools modifier off", async () => {
    for (const active of await restoredLoadouts([...builtins, "Agent", "workflow"], ["-external_delegate"])) {
      expect(active).not.toContain("external_delegate");
      expect(active).toContain("external_workflow");
    }
  });
});
