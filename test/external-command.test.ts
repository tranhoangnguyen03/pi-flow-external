import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { registerExternalCommand } from "../src/external-command.ts";
import type { LoadedExternalSettings } from "../src/settings.ts";

describe("/external command", () => {
  it("registers the complete surface and routes operational checks without model turns", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-flow-command-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = root;
    mkdirSync(join(root, "subagents"), { recursive: true });
    writeFileSync(join(root, "subagents", "claude-reviewer.md"), "---\ndescription: Review code.\nbackend: claude\n---\nReview read-only.\n");
    try {
      let command: { getArgumentCompletions: (prefix: string) => Array<{ value: string }> | null; handler: (args: string, ctx: unknown) => Promise<void> } | undefined;
      const exec = vi.fn(async (program: string) => program === "claude"
        ? { code: 0, killed: false, stdout: "claude 1.2.3\n", stderr: "" }
        : { code: 0, killed: false, stdout: JSON.stringify({ runs: 2, byStatus: { done: 2 }, incompleteRecords: 0, recentFailures: [] }), stderr: "" });
      const pi = {
        exec,
        registerCommand(name: string, options: typeof command) {
          expect(name).toBe("external");
          command = options;
        },
      };
      const settings: LoadedExternalSettings = {
        path: join(root, "pi-flow-external", "settings.json"),
        settings: {
          version: 2,
          maxConcurrentSubagents: 12,
          subagentTimeoutMs: 7200000,
          defaultPermission: "danger",
          defaultMaxBudgetUsd: null,
          maxRunRecords: 200,
        },
        diagnostics: ['Unknown setting "futureOption".'],
      };
      const startProfileInterview = vi.fn(async () => {});
      registerExternalCommand(pi as never, {
        settings,
        getRuntimeSettings: () => ({ maxConcurrentSubagents: 4, subagentTimeoutMs: 60_000 }),
        getMaxRunRecords: () => 200,
        startProfileInterview,
      });

      expect(command?.getArgumentCompletions("")?.map((item) => item.value)).toEqual([
        "doctor", "settings", "profiles", "profile create", "workflows", "runs", "help",
      ]);

      const notices: string[] = [];
      const ctx = { cwd: root, isProjectTrusted: () => false, ui: { notify: (message: string) => notices.push(message) } };
      await command?.handler("settings", ctx);
      expect(notices.at(-1)).toContain("maxConcurrentSubagents: 4");
      expect(notices.at(-1)).toContain(settings.path);

      await command?.handler("doctor", ctx);
      expect(notices.at(-1)).toContain("⚠ Settings:");
      expect(notices.at(-1)).toContain("claude 1.2.3");
      expect(exec).toHaveBeenCalledWith("claude", ["--version"], { timeout: 10_000 });

      await command?.handler("runs", ctx);
      expect(notices.at(-1)).toContain("Runs: 2");

      await command?.handler("profile create", ctx);
      expect(startProfileInterview).toHaveBeenCalledOnce();
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
