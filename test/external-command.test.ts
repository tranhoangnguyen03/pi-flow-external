import { describe, expect, it, vi } from "vitest";
import { registerExternalCommand } from "../src/external-command.ts";
import type { LoadedExternalSettings } from "../src/settings.ts";

describe("/external command", () => {
  it("registers one completed command surface and keeps profile creation routed", async () => {
    let command: { getArgumentCompletions: (prefix: string) => Array<{ value: string }> | null; handler: (args: string, ctx: unknown) => Promise<void> } | undefined;
    const pi = {
      registerCommand(name: string, options: typeof command) {
        expect(name).toBe("external");
        command = options;
      },
    };
    const settings: LoadedExternalSettings = {
      path: "/tmp/agent/pi-flow-external/settings.json",
      settings: { version: 1, maxConcurrentSubagents: 12, subagentTimeoutMs: 7200000 },
      diagnostics: [],
    };
    const startProfileInterview = vi.fn(async () => {});
    registerExternalCommand(pi as never, {
      settings,
      getRuntimeSettings: () => ({ maxConcurrentSubagents: 4, subagentTimeoutMs: 60_000 }),
      startProfileInterview,
    });

    expect(command?.getArgumentCompletions("")?.map((item) => item.value)).toEqual([
      "doctor", "settings", "profiles", "profile create", "workflows", "runs", "help",
    ]);

    const notices: string[] = [];
    const ctx = { ui: { notify: (message: string) => notices.push(message) } };
    await command?.handler("settings", ctx);
    expect(notices.at(-1)).toContain("maxConcurrentSubagents: 4");
    expect(notices.at(-1)).toContain(settings.path);

    await command?.handler("profile create", ctx);
    expect(startProfileInterview).toHaveBeenCalledOnce();
  });
});
