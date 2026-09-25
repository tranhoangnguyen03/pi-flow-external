import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { registerExternalCommand } from "../src/external-command.ts";
import { createExternalRunsTool } from "../src/external-runs.ts";
import { createRunRecord } from "../src/core/run-record.ts";
import { RunRegistry } from "../src/core/run-registry.ts";
import { createWorkflowJournalWriter, createWorkflowRunIdentity, getSessionWorkflowDir } from "../src/workflow/journal.ts";
import type { LoadedExternalSettings } from "../src/settings.ts";
import type { SubagentProfile } from "../src/types.ts";

function settingsV4(root: string, overrides: Partial<LoadedExternalSettings["settings"]> = {}): LoadedExternalSettings {
  return {
    path: join(root, "pi-flow-external", "settings.json"),
    settings: {
      version: 4,
      defaultHarness: "agy",
      maxConcurrentSubagents: 12,
      subagentTimeoutMs: 7200000,
      defaultPermission: "danger",
      defaultMaxBudgetUsd: null,
      maxRunRecords: 200,
      ...overrides,
    },
    diagnostics: [],
  };
}

function commandOptions(overrides: Record<string, unknown> = {}) {
  return {
    settings: overrides.settings as LoadedExternalSettings,
    getRuntimeSettings: () => ({ maxConcurrentSubagents: 4, subagentTimeoutMs: 60_000 }),
    getMaxRunRecords: () => 200,
    startRoleInterview: vi.fn(async () => {}),
    startHarnessInterview: vi.fn(async () => {}),
    externalRuns: { execute: vi.fn() } as never,
    ...overrides,
  };
}

async function withAgentDir<T>(root: string, run: () => Promise<T>): Promise<T> {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  try {
    return await run();
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
}

describe("/external command", () => {
  it("registers the new surface, drops the old profile commands, and routes overview without model turns", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-flow-command-"));
    try {
      await withAgentDir(root, async () => {
        let command: { getArgumentCompletions: (prefix: string) => Array<{ value: string }> | null; handler: (args: string, ctx: unknown) => Promise<void> } | undefined;
        const pi = {
          exec: vi.fn(),
          registerCommand(name: string, options: typeof command) {
            expect(name).toBe("external");
            command = options;
          },
        };
        const options = commandOptions({ settings: settingsV4(root) });
        registerExternalCommand(pi as never, options as never);

        expect(command?.getArgumentCompletions("")?.map((item) => item.value)).toEqual([
          "doctor", "config", "config edit", "config convert", "config harnesses", "config harness create",
          "config enable", "config disable", "config default", "roles", "role create", "role inspect", "role override", "[danger]purge-old-files",
          "workflows", "runs", "runs summary", "runs --prune", "help",
        ]);
        expect(command?.getArgumentCompletions("role")?.map((item) => item.value)).toEqual([
          "roles", "role create", "role inspect", "role override",
        ]);

        const notices: string[] = [];
        const ctx = { cwd: root, isProjectTrusted: () => false, ui: { notify: (message: string) => notices.push(message) } };

        // Overview names the default, role/harness counts, and settings path.
        await command?.handler("", ctx);
        expect(notices.at(-1)).toContain("Default: agy (global)");
        expect(notices.at(-1)).toContain("Harnesses: 6 CLI");
        expect(notices.at(-1)).toContain(options.settings.path);

        // Roles groups by role instead of dumping the harness × role product.
        await command?.handler("roles", ctx);
        expect(notices.at(-1)).toContain("reviewer: 6 harness(es)");
        expect(notices.at(-1)).not.toContain("claude-reviewer: claude");

        // Harness creation routes to the harness interview, role creation to the role interview.
        await command?.handler("config harness create", ctx);
        expect(options.startHarnessInterview).toHaveBeenCalledOnce();
        await command?.handler("role create", ctx);
        expect(options.startRoleInterview).toHaveBeenCalledOnce();

        // Unknown commands get ordinary usage help only: no alias, no interview, no legacy pointer.
        await command?.handler("profiles", ctx);
        expect(notices.at(-1)).toContain("Usage: /external doctor");
        expect(notices.at(-1)).not.toContain("Removed:");
        await command?.handler("profile create", ctx);
        expect(notices.at(-1)).toContain("Usage: /external doctor");
        // Superseded settings/harness routes are not aliases either.
        await command?.handler("settings", ctx);
        expect(notices.at(-1)).toContain("Usage: /external doctor");
        await command?.handler("harness create", ctx);
        expect(notices.at(-1)).toContain("Usage: /external doctor");
        expect(options.startRoleInterview).toHaveBeenCalledOnce();
        expect(options.startHarnessInterview).toHaveBeenCalledOnce();
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("shows effective settings with project-override precedence and doctor readiness separately", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-flow-command-settings-"));
    try {
      await withAgentDir(root, async () => {
        let command: { handler: (args: string, ctx: unknown) => Promise<void> } | undefined;
        const exec = vi.fn(async (program: string) => program === "claude"
          ? { code: 0, killed: false, stdout: "claude 1.2.3\n", stderr: "" }
          : { code: 1, killed: false, stdout: "", stderr: "missing" });
        const pi = { exec, registerCommand: (_name: string, options: typeof command) => { command = options; } };
        const options = commandOptions({ settings: settingsV4(root) });
        registerExternalCommand(pi as never, options as never);

        const notices: string[] = [];
        const ctx = { cwd: root, isProjectTrusted: () => false, ui: { notify: (message: string) => notices.push(message) } };
        await command?.handler("config", ctx);
        expect(notices.at(-1)).toContain("maxConcurrentSubagents: 4");
        expect(notices.at(-1)).toContain("defaultHarness: agy (global)");
        expect(notices.at(-1)).toContain(options.settings.path);

        mkdirSync(join(root, ".pi", "pi-flow-external"), { recursive: true });
        writeFileSync(join(root, ".pi", "pi-flow-external", "settings.json"), JSON.stringify({ defaultHarness: "claude" }));
        await command?.handler("config", { ...ctx, isProjectTrusted: () => true });
        expect(notices.at(-1)).toContain("defaultHarness: claude (project: ");
        await command?.handler("config", ctx);
        expect(notices.at(-1)).toContain("defaultHarness: agy (global)");
        expect(notices.at(-1)).toMatch(/not trusted/);

        // Doctor probes CLI backends but reports readiness separately from registration.
        await command?.handler("doctor", ctx);
        expect(notices.at(-1)).toContain("CLI: available (claude 1.2.3)");
        expect(exec).toHaveBeenCalledWith("claude", ["--version"], { timeout: 10_000 });

        await command?.handler("config harnesses", ctx);
        expect(notices.at(-1)).toContain("- codex · CLI · enabled");
        expect(notices.at(-1)).toContain("no named Pi harnesses");
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("toggles harnesses and the default through the validated writer, guarding the effective default and skipping disabled readiness", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-flow-command-toggle-"));
    const settingsPath = join(root, "pi-flow-external", "settings.json");
    mkdirSync(join(root, "pi-flow-external"), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({ version: 4, defaultHarness: "agy", futureField: { keep: true }, disabledHarnesses: ["future-cli"], harnesses: { "pi-check": { model: "test/model", thinking: "off", preset: "minimal" } } }));
    try {
      await withAgentDir(root, async () => {
        let command: { getArgumentCompletions: (prefix: string) => Array<{ value: string }> | null; handler: (args: string, ctx: unknown) => Promise<void> } | undefined;
        const exec = vi.fn(async () => ({ code: 0, killed: false, stdout: "v1\n", stderr: "" }));
        const pi = { exec, registerCommand: (_name: string, options: typeof command) => { command = options; } };
        registerExternalCommand(pi as never, commandOptions({ settings: settingsV4(root) }) as never);
        const notices: string[] = [];
        const find = vi.fn(() => undefined);
        const ctx = { cwd: root, isProjectTrusted: () => false, modelRegistry: { find }, ui: { notify: (message: string) => notices.push(message) } };
        const saved = () => JSON.parse(readFileSync(settingsPath, "utf8"));

        expect(command?.getArgumentCompletions("config disable pi")?.map((item) => item.value)).toEqual(["config disable pi-check"]);

        // The effective default cannot be disabled, and a disabled harness cannot become the default.
        await command?.handler("config disable agy", ctx);
        expect(notices.at(-1)).toMatch(/Cannot disable "agy".*config default/);
        await command?.handler("config disable nope", ctx);
        expect(notices.at(-1)).toMatch(/Unknown harness "nope"/);
        await command?.handler("config disable codex", ctx);
        await command?.handler("config disable pi-check", ctx);
        await command?.handler("config default codex", ctx);
        expect(notices.at(-1)).toMatch(/Cannot make "codex" the default.*config enable codex/);
        expect(saved()).toEqual({ version: 4, defaultHarness: "agy", futureField: { keep: true }, disabledHarnesses: ["future-cli", "codex", "pi-check"], harnesses: { "pi-check": { model: "test/model", thinking: "off", preset: "minimal" } } });

        await command?.handler("config harnesses", ctx);
        expect(notices.at(-1)).toContain("- codex · CLI · disabled");
        expect(notices.at(-1)).toContain("- pi-check · Pi (test/model · default thinking · minimal) · disabled");
        expect(notices.at(-1)).toContain("- future-cli · unknown · disabled");

        // Doctor skips readiness probes for disabled CLI and Pi harnesses.
        await command?.handler("doctor", ctx);
        expect(exec.mock.calls.map((call) => (call as unknown[])[0])).not.toContain("codex");
        expect(find).not.toHaveBeenCalled();
        expect(notices.at(-1)).toContain("○ codex: disabled (readiness not checked)");

        // A project default is also guarded; enabling an unknown preserved name removes only that name.
        mkdirSync(join(root, ".pi", "pi-flow-external"), { recursive: true });
        writeFileSync(join(root, ".pi", "pi-flow-external", "settings.json"), JSON.stringify({ defaultHarness: "claude" }));
        await command?.handler("config disable claude", { ...ctx, isProjectTrusted: () => true });
        expect(notices.at(-1)).toMatch(/Cannot disable "claude": it is the project default/);
        await command?.handler("config enable future-cli", ctx);
        await command?.handler("config enable codex", ctx);
        await command?.handler("config default codex", ctx);
        expect(saved()).toMatchObject({ defaultHarness: "codex", futureField: { keep: true }, disabledHarnesses: ["pi-check"] });
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("inspects the effective role for a harness and refuses unknown bindings with candidates", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-flow-command-inspect-"));
    try {
      await withAgentDir(root, async () => {
        let command: { handler: (args: string, ctx: unknown) => Promise<void> } | undefined;
        const pi = { exec: vi.fn(), registerCommand: (_name: string, options: typeof command) => { command = options; } };
        const profiles = new Map<string, SubagentProfile>([
          ["agy-reviewer", { name: "agy-reviewer", description: "Review.", backend: "agy", systemPrompt: "Check diffs.", source: "built-in" }],
          ["claude-reviewer", { name: "claude-reviewer", description: "Review.", backend: "claude", systemPrompt: "Check diffs.", source: "built-in" }],
        ]);
        const options = commandOptions({
          settings: settingsV4(root),
          getCatalog: () => ({ profiles, diagnostics: [], blocked: false, harnessConfigs: new Map() }),
        });
        registerExternalCommand(pi as never, options as never);

        const notices: Array<{ message: string; level: string }> = [];
        const ctx = { cwd: root, isProjectTrusted: () => false, ui: { notify: (message: string, level: string) => notices.push({ message, level }) } };

        await command?.handler("role inspect reviewer", ctx);
        expect(notices.at(-1)?.message).toContain("agy-reviewer: Review.");
        expect(notices.at(-1)?.message).toContain("Source: built-in");
        expect(notices.at(-1)?.message).toContain("call permission danger");
        expect(notices.at(-1)?.message).toContain("autonomous");
        expect(notices.at(-1)?.message).toContain("Check diffs.");

        await command?.handler("role inspect reviewer claude", ctx);
        expect(notices.at(-1)?.message).toContain("claude-reviewer");

        await command?.handler("role inspect reviewer pi-missing", ctx);
        expect(notices.at(-1)?.message).toContain("Available bindings: agy-reviewer, claude-reviewer");

        await command?.handler("role inspect nope", ctx);
        expect(notices.at(-1)?.message).toContain('Unknown role "nope"');
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("materializes one exact override without touching the live catalog source", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-flow-command-override-"));
    try {
      await withAgentDir(root, async () => {
        let command: { handler: (args: string, ctx: unknown) => Promise<void> } | undefined;
        const pi = { exec: vi.fn(), registerCommand: (_name: string, options: typeof command) => { command = options; } };
        const profiles = new Map<string, SubagentProfile>([
          ["claude-reviewer", { name: "claude-reviewer", description: "Review.", backend: "claude", systemPrompt: "Check diffs.", source: "built-in" }],
        ]);
        const options = commandOptions({
          settings: settingsV4(root),
          getCatalog: () => ({ profiles, diagnostics: [], blocked: false, harnessConfigs: new Map() }),
        });
        registerExternalCommand(pi as never, options as never);

        const notices: string[] = [];
        const ctx = { cwd: root, isProjectTrusted: () => false, ui: { notify: (message: string) => notices.push(message) } };

        await command?.handler("role override", ctx);
        expect(notices.at(-1)).toContain("Usage: /external role override <role> <harness>");

        await command?.handler("role override reviewer claude", ctx);
        const finalPath = join(root, "pi-flow-external", "overrides", "claude-reviewer.md");
        expect(existsSync(finalPath)).toBe(true);
        expect(notices.at(-1)).toContain("complete replacement (not a merge)");
        expect(notices.at(-1)).toContain("Values apply from the next invocation; frozen workflows keep their prior snapshot");
        expect(notices.at(-1)).not.toContain("parent syncs");

        // Repeat invocation refuses to overwrite.
        await command?.handler("role override reviewer claude", ctx);
        expect(notices.at(-1)).toContain("already exists");
        expect(notices.at(-1)).toContain("was not changed");

        // Unknown bindings name the missing identity instead of writing.
        await command?.handler("role override reviewer agy", ctx);
        expect(notices.at(-1)).toContain("no effective role");
        expect(existsSync(join(root, "pi-flow-external", "overrides", "agy-reviewer.md"))).toBe(false);
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("edits settings through the standard editor and the validated writer", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-flow-command-settings-edit-"));
    try {
      await withAgentDir(root, async () => {
        let command: { handler: (args: string, ctx: unknown) => Promise<void> } | undefined;
        const pi = { exec: vi.fn(), registerCommand: (_name: string, options: typeof command) => { command = options; } };
        const saved: Array<{ agentDir: string; record: unknown; options: unknown }> = [];
        const options = commandOptions({
          settings: settingsV4(root),
          saveSettings: ((agentDir: string, record: unknown, saveOptions: unknown) => {
            saved.push({ agentDir, record, options: saveOptions });
            return join(agentDir, "pi-flow-external", "settings.json");
          }) as never,
        });
        registerExternalCommand(pi as never, options as never);

        const notices: string[] = [];
        const unchangedCtx = {
          cwd: root,
          isProjectTrusted: () => false,
          hasUI: true,
          ui: { notify: (message: string) => notices.push(message), editor: vi.fn(async (_title: string, content: string) => content) },
        };
        await command?.handler("config edit", unchangedCtx);
        expect(notices.at(-1)).toContain("unchanged");
        expect(saved).toHaveLength(0);

        const invalidCtx = {
          cwd: root,
          isProjectTrusted: () => false,
          hasUI: true,
          ui: { notify: (message: string) => notices.push(message), editor: vi.fn(async () => "{not json") },
        };
        await command?.handler("config edit", invalidCtx);
        expect(notices.at(-1)).toContain("not valid JSON");
        expect(saved).toHaveLength(0);

        const valid = JSON.stringify({ version: 4, defaultHarness: "claude" });
        const validCtx = {
          cwd: root,
          isProjectTrusted: () => false,
          hasUI: true,
          ui: { notify: (message: string) => notices.push(message), editor: vi.fn(async () => valid) },
        };
        await command?.handler("config edit", validCtx);
        expect(saved).toHaveLength(1);
        expect(saved[0]).toMatchObject({ agentDir: root, options: { repair: true } });
        expect(saved[0]!.record).toEqual({ version: 4, defaultHarness: "claude" });
        expect(notices.at(-1)).toContain("frozen workflows keep their prior snapshot");
        expect(notices.at(-1)).toContain("Concurrency changes wait for active/queued runs to drain");
        expect(notices.at(-1)).not.toContain("parent syncs");
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("settings edit repairs a malformed current file through the real writer", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-flow-command-settings-repair-"));
    mkdirSync(join(root, "pi-flow-external"), { recursive: true });
    writeFileSync(join(root, "pi-flow-external", "settings.json"), "{malformed");
    try {
      await withAgentDir(root, async () => {
        let command: { handler: (args: string, ctx: unknown) => Promise<void> } | undefined;
        const pi = { exec: vi.fn(), registerCommand: (_name: string, options: typeof command) => { command = options; } };
        // No saveSettings stub: the real parent writer must accept this
        // explicit editor replacement because of {repair: true}.
        const options = commandOptions({ settings: settingsV4(root) });
        registerExternalCommand(pi as never, options as never);

        const notices: string[] = [];
        const valid = JSON.stringify({ version: 4, defaultHarness: "codex" });
        const ctx = {
          cwd: root,
          isProjectTrusted: () => false,
          hasUI: true,
          ui: { notify: (message: string) => notices.push(message), editor: vi.fn(async () => valid) },
        };
        await command?.handler("config edit", ctx);
        expect(notices.at(-1)).toContain("Settings saved to");
        expect(JSON.parse(readFileSync(join(root, "pi-flow-external", "settings.json"), "utf8"))).toEqual({ version: 4, defaultHarness: "codex" });
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("settings edit still refuses a valid pre-v4 file even as an explicit repair", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-flow-command-settings-norepair-"));
    mkdirSync(join(root, "pi-flow-external"), { recursive: true });
    writeFileSync(join(root, "pi-flow-external", "settings.json"), JSON.stringify({ version: 2, defaultHarness: "claude" }));
    try {
      await withAgentDir(root, async () => {
        let command: { handler: (args: string, ctx: unknown) => Promise<void> } | undefined;
        const pi = { exec: vi.fn(), registerCommand: (_name: string, options: typeof command) => { command = options; } };
        const options = commandOptions({ settings: settingsV4(root) });
        registerExternalCommand(pi as never, options as never);

        const notices: string[] = [];
        const valid = JSON.stringify({ version: 4, defaultHarness: "claude" });
        const ctx = {
          cwd: root,
          isProjectTrusted: () => false,
          hasUI: true,
          ui: { notify: (message: string) => notices.push(message), editor: vi.fn(async () => valid) },
        };
        await command?.handler("config edit", ctx);
        expect(notices.at(-1)).toContain("Settings not saved:");
        expect(JSON.parse(readFileSync(join(root, "pi-flow-external", "settings.json"), "utf8")).version).toBe(2);
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("settings convert previews and applies the one-time v4 conversion", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-flow-command-convert-"));
    mkdirSync(join(root, "subagents"), { recursive: true });
    mkdirSync(join(root, "pi-flow-external"), { recursive: true });
    writeFileSync(join(root, "pi-flow-external", "settings.json"), JSON.stringify({ version: 2, defaultHarness: "claude" }));
    writeFileSync(
      join(root, "subagents", "claude-security-reviewer.md"),
      "---\ndescription: Custom review.\nbackend: claude\n---\nCheck diffs.\n",
    );
    try {
      await withAgentDir(root, async () => {
        let command: { handler: (args: string, ctx: unknown) => Promise<void> } | undefined;
        const pi = { exec: vi.fn(), registerCommand: (_name: string, options: typeof command) => { command = options; } };
        const options = commandOptions({ settings: settingsV4(root) });
        registerExternalCommand(pi as never, options as never);

        const notices: string[] = [];
        const confirm = vi.fn(async () => true);
        const ctx = { cwd: root, isProjectTrusted: () => false, hasUI: true, ui: { notify: (message: string) => notices.push(message), confirm } };
        await command?.handler("config convert", ctx);
        expect(confirm).toHaveBeenCalledOnce();
        expect(notices.at(-1)).toContain("Conversion applied");
        expect(notices.at(-1)).toContain("Values apply from the next invocation; frozen workflows keep their prior snapshot");
        expect(notices.at(-1)).not.toContain("parent syncs");

        // Activation wrote v4; the custom profile was raw-copied; the original stays as recovery.
        expect(JSON.parse(readFileSync(join(root, "pi-flow-external", "settings.json"), "utf8")).version).toBe(4);
        expect(existsSync(join(root, "pi-flow-external", "overrides", "claude-security-reviewer.md"))).toBe(true);
        expect(existsSync(join(root, "subagents", "claude-security-reviewer.md"))).toBe(true);

        // A second run reports current instead of converting again.
        await command?.handler("config convert", ctx);
        expect(notices.at(-1)).toContain("already version 4");
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("settings convert cancels without writing anything", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-flow-command-convert-cancel-"));
    mkdirSync(join(root, "subagents"), { recursive: true });
    mkdirSync(join(root, "pi-flow-external"), { recursive: true });
    writeFileSync(join(root, "pi-flow-external", "settings.json"), JSON.stringify({ version: 2 }));
    writeFileSync(
      join(root, "subagents", "claude-security-reviewer.md"),
      "---\ndescription: Custom review.\nbackend: claude\n---\nCheck diffs.\n",
    );
    try {
      await withAgentDir(root, async () => {
        let command: { handler: (args: string, ctx: unknown) => Promise<void> } | undefined;
        const pi = { exec: vi.fn(), registerCommand: (_name: string, options: typeof command) => { command = options; } };
        const options = commandOptions({ settings: settingsV4(root) });
        registerExternalCommand(pi as never, options as never);

        const notices: string[] = [];
        const ctx = { cwd: root, isProjectTrusted: () => false, hasUI: true, ui: { notify: (message: string) => notices.push(message), confirm: vi.fn(async () => false) } };
        await command?.handler("config convert", ctx);
        expect(notices.at(-1)).toContain("cancelled");
        expect(JSON.parse(readFileSync(join(root, "pi-flow-external", "settings.json"), "utf8")).version).toBe(2);
        expect(existsSync(join(root, "pi-flow-external", "overrides", "claude-security-reviewer.md"))).toBe(false);
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("purge-old-files selects inventory entries individually and deletes only the selection", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-flow-command-purge-"));
    mkdirSync(join(root, "subagents"), { recursive: true });
    mkdirSync(join(root, "pi-flow-external"), { recursive: true });
    writeFileSync(join(root, "pi-flow-external", "settings.json"), JSON.stringify({ version: 4, defaultHarness: "agy" }));
    const keep = join(root, "subagents", "claude-security-reviewer.md");
    const drop = join(root, "subagents", "codex-security-reviewer.md");
    writeFileSync(keep, "---\ndescription: Keep.\nbackend: claude\n---\nKeep me.\n");
    writeFileSync(drop, "---\ndescription: Drop.\nbackend: codex\n---\nDrop me.\n");
    try {
      await withAgentDir(root, async () => {
        let command: { handler: (args: string, ctx: unknown) => Promise<void> } | undefined;
        const pi = { exec: vi.fn(), registerCommand: (_name: string, options: typeof command) => { command = options; } };
        const options = commandOptions({ settings: settingsV4(root) });
        registerExternalCommand(pi as never, options as never);

        const notices: string[] = [];
        let selections = 0;
        const ctx = {
          cwd: root,
          isProjectTrusted: () => false,
          hasUI: true,
          ui: {
            notify: (message: string) => notices.push(message),
            select: vi.fn(async (_title: string, choices: string[]) => {
              selections++;
              // Toggle only the codex entry, then delete the selection of one.
              if (selections === 1) return choices.find((choice) => choice.includes("codex-security-reviewer.md"));
              return choices.find((choice) => choice.startsWith("Delete "));
            }),
            confirm: vi.fn(async () => true),
          },
        };
        await command?.handler("[danger]purge-old-files", ctx);
        expect(notices.at(-1)).toContain("Deleted: 1");
        expect(existsSync(drop)).toBe(false);
        expect(existsSync(keep)).toBe(true);
        expect(readFileSync(keep, "utf8")).toContain("Keep me.");
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("purge-old-files without v4 settings is blocked and deletes nothing", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-flow-command-purge-blocked-"));
    const legacy = join(root, "subagents", "claude-reviewer.md");
    mkdirSync(join(root, "subagents"), { recursive: true });
    writeFileSync(legacy, "keep me");
    try {
      await withAgentDir(root, async () => {
        let command: { handler: (args: string, ctx: unknown) => Promise<void> } | undefined;
        const pi = { exec: vi.fn(), registerCommand: (_name: string, options: typeof command) => { command = options; } };
        const options = commandOptions({ settings: settingsV4(root) });
        registerExternalCommand(pi as never, options as never);

        const notices: string[] = [];
        const ctx = { cwd: root, isProjectTrusted: () => false, hasUI: true, ui: { notify: (message: string) => notices.push(message), select: vi.fn(), confirm: vi.fn() } };
        await command?.handler("[danger]purge-old-files", ctx);
        expect(notices.at(-1)).toContain("blocked");
        expect((ctx.ui.select as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
        expect((ctx.ui.confirm as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
        expect(existsSync(legacy)).toBe(true);
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("shows timing/output-availability row detail and Refresh resets pagination to page one without navigating into a run", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-flow-command-refresh-"));
    try {
      await withAgentDir(root, async () => {
        let command: { handler: (args: string, ctx: unknown) => Promise<void> } | undefined;
        const pi = { exec: vi.fn(), registerCommand: (_name: string, options: typeof command) => { command = options; } };
        let listCalls = 0;
        const externalRuns = {
          execute: vi.fn(async (_id: string, params: any) => {
            listCalls++;
            return {
              content: [{ type: "text", text: "list" }],
              details: {
                workflows: [],
                runs: [
                  {
                    runId: "run_1",
                    description: "Audit repo",
                    status: "done",
                    outputAvailable: true,
                    finalAvailable: true,
                    timing: { elapsedMs: 42_300 },
                    live: false,
                  },
                  {
                    runId: "run_queued_live",
                    description: "Still queued, registry-confirmed live",
                    status: "queued",
                    outputAvailable: false,
                    finalAvailable: false,
                    timing: { queuedAt: new Date(Date.now() - 5_000).toISOString() },
                    live: true,
                  },
                  {
                    runId: "run_queued_orphan",
                    description: "Queued-looking durable row with no live registry entry",
                    status: "queued",
                    outputAvailable: false,
                    finalAvailable: false,
                    timing: { queuedAt: new Date(Date.now() - 5_000).toISOString() },
                    live: false,
                  },
                ],
                nextCursor: listCalls === 1 ? "run-next" : undefined,
              },
            };
          }),
        };
        registerExternalCommand(pi as never, commandOptions({ settings: settingsV4(root), externalRuns: externalRuns as never }));

        let selectCalls = 0;
        const ctx = {
          cwd: root,
          isProjectTrusted: () => false,
          hasUI: true,
          ui: {
            notify: vi.fn(),
            select: vi.fn(async (_title: string, choices: string[]) => {
              selectCalls++;
              if (selectCalls === 1) {
                expect(choices[0]).toContain("run_1");
                expect(choices[0]).toContain("Audit repo");
                expect(choices[0]).toContain("done");
                expect(choices[0]).toContain("elapsed");
                expect(choices[0]).toContain("final ready");
                const liveQueuedRow = choices.find((choice) => choice.includes("run_queued_live"));
                expect(liveQueuedRow).toMatch(/queued \d/);
                const orphanQueuedRow = choices.find((choice) => choice.includes("run_queued_orphan"));
                expect(orphanQueuedRow).toBeDefined();
                expect(orphanQueuedRow).not.toMatch(/queued \d/);
                expect(choices).toContain("Next run page");
                expect(choices).toContain("Refresh");
                return "Refresh";
              }
              expect(choices).not.toContain("Next run page");
              return "Back";
            }),
          },
        };
        await command?.handler("runs", ctx as never);
        expect(listCalls).toBe(2);
        expect(externalRuns.execute).toHaveBeenNthCalledWith(1, expect.any(String), { action: "list", limit: 50 }, undefined, undefined, ctx);
        expect(externalRuns.execute).toHaveBeenNthCalledWith(2, expect.any(String), { action: "list", limit: 50 }, undefined, undefined, ctx);
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("prefixes the run-detail summary editor with a human-readable timing/output-availability header above the raw JSON", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-flow-command-summary-"));
    try {
      await withAgentDir(root, async () => {
        let command: { handler: (args: string, ctx: unknown) => Promise<void> } | undefined;
        const pi = { exec: vi.fn(), registerCommand: (_name: string, options: typeof command) => { command = options; } };
        const summaryJson = JSON.stringify({
          runId: "run_1",
          state: { status: "done" },
          timing: { queueDelayMs: 500, elapsedMs: 42_300 },
          output: { available: true, finalAvailable: true },
        });
        const externalRuns = {
          execute: vi.fn(async (_id: string, params: any) => {
            if (params.action === "list") {
              return { content: [{ type: "text", text: "list" }], details: { workflows: [], runs: [{ runId: "run_1", status: "done" }] } };
            }
            return { content: [{ type: "text", text: summaryJson }], details: {} };
          }),
        };
        registerExternalCommand(pi as never, commandOptions({ settings: settingsV4(root), externalRuns: externalRuns as never }));

        const editor = vi.fn(async (_title: string, _content: string) => "");
        let rootCalls = 0;
        let runDetailCalls = 0;
        const ctx = {
          cwd: root,
          isProjectTrusted: () => false,
          hasUI: true,
          ui: {
            notify: vi.fn(),
            editor,
            select: vi.fn(async (title: string, choices: string[]) => {
              if (title === "External runs") return rootCalls++ === 0 ? choices.find((choice) => choice.startsWith("Run run_1")) : "Back";
              if (title === "Run run_1") return runDetailCalls++ === 0 ? "Summary" : "Back";
              return "Back";
            }),
          },
        };
        await command?.handler("runs", ctx as never);
        expect(runDetailCalls).toBeGreaterThanOrEqual(2);
        expect(editor).toHaveBeenCalledWith("summary run_1", expect.stringContaining("status: done"));
        const [, content] = editor.mock.calls[0]!;
        expect(content).toContain("queue delay 500ms");
        expect(content).toContain("elapsed 42s");
        expect(content).toContain("final answer available");
        expect(JSON.parse(content.slice(content.indexOf("\n\n") + 2))).toEqual(JSON.parse(summaryJson));
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("routes Final and recovers stale Launch pages without leaving run navigation", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-flow-command-final-"));
    try {
      await withAgentDir(root, async () => {
        let command: { handler: (args: string, ctx: unknown) => Promise<void> } | undefined;
        const pi = { exec: vi.fn(), registerCommand: (_name: string, options: typeof command) => { command = options; } };
        const externalRuns = {
          execute: vi.fn(async (_id: string, params: any) => {
            if (params.action === "list") {
              return { content: [{ type: "text", text: "list" }], details: { workflows: [], runs: [{ runId: "run_1", status: "done" }] } };
            }
            if (params.view === "launch") {
              if (params.cursor) throw new Error("Run changed while paging; restart inspection without a cursor");
              return { content: [{ type: "text", text: "launch snapshot" }], details: { nextCursor: "old-page" } };
            }
            if (params.action === "inspect" && params.view === "final") {
              return { content: [{ type: "text", text: "canonical final answer" }], details: { finalAvailable: true } };
            }
            return { content: [{ type: "text", text: JSON.stringify({ runId: "run_1", state: { status: "done" } }) }], details: {} };
          }),
        };
        registerExternalCommand(pi as never, commandOptions({ settings: settingsV4(root), externalRuns: externalRuns as never }));

        const editor = vi.fn(async (_title: string, _content: string) => "");
        let rootCalls = 0;
        let runDetailCalls = 0;
        const ctx = {
          cwd: root,
          isProjectTrusted: () => false,
          hasUI: true,
          ui: {
            notify: vi.fn(),
            editor,
            select: vi.fn(async (title: string, choices: string[]) => {
              if (title === "External runs") return rootCalls++ === 0 ? choices.find((choice) => choice.startsWith("Run run_1")) : "Back";
              if (title === "Run run_1") {
                expect(choices).toContain("Final");
                return ["Launch", "Refresh", "Final", "Back"][runDetailCalls++];
              }
              if (title === "launch run_1") return editor.mock.calls.filter(([title]) => title === "launch run_1").length === 1 ? "Next page" : "Back";
              if (title === "final run_1") return "Back";
              return "Back";
            }),
          },
        };
        await command?.handler("runs", ctx as never);
        expect(externalRuns.execute).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ action: "inspect", runId: "run_1", view: "final" }), undefined, undefined, ctx);
        expect(editor).toHaveBeenCalledWith("final run_1", "canonical final answer");
        expect(editor.mock.calls.filter(([title]) => title === "launch run_1")).toHaveLength(2);
        expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Reopening"), "info");
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("shows an informative notice (never a blank/raw editor) when Final is unavailable for a real agent or workflow run, while a legitimate null workflow result still opens as available", async () => {
    const runsDirectory = mkdtempSync(join(tmpdir(), "pi-flow-command-final-real-"));
    try {
      let command: { handler: (args: string, ctx: unknown) => Promise<void> } | undefined;
      const pi = { exec: vi.fn(), registerCommand: (_name: string, options: typeof command) => { command = options; } };
      const registry = new RunRegistry();
      const externalRuns = createExternalRunsTool({ registry, runsDirectory: () => runsDirectory });
      registerExternalCommand(pi as never, commandOptions({ settings: settingsV4(runsDirectory), externalRuns: externalRuns as never }));

      const ctx = {
        cwd: "/project",
        isProjectTrusted: () => false,
        hasUI: true,
        sessionManager: { isPersisted: () => true, getSessionDir: () => runsDirectory, getSessionId: () => "session-a" },
        ui: {
          notify: vi.fn(),
          editor: vi.fn(async () => ""),
          select: vi.fn(),
        },
      };

      const failedAgent = createRunRecord({
        directory: runsDirectory,
        metadata: { parentSessionId: "session-a", project: "/project", description: "Failed agent" },
      });
      await failedAgent.finish({ status: "error", error: "boom" });

      const workflowDir = getSessionWorkflowDir(ctx)!;
      const failedWorkflowIdentity = createWorkflowRunIdentity("failed workflow script", null);
      const failedWorkflowJournal = await createWorkflowJournalWriter({ dir: workflowDir, identity: failedWorkflowIdentity, name: "failed-workflow", source: "inline", project: "/project" });
      await failedWorkflowJournal.fail("boom", "failed");

      const nullWorkflowIdentity = createWorkflowRunIdentity("null workflow script", null);
      const nullWorkflowJournal = await createWorkflowJournalWriter({ dir: workflowDir, identity: nullWorkflowIdentity, name: "null-workflow", source: "inline", project: "/project" });
      await nullWorkflowJournal.complete(null);

      async function selectFinalFor(runId: string) {
        let rootChosen = false;
        let detailCalls = 0;
        (ctx.ui.select as ReturnType<typeof vi.fn>).mockReset();
        (ctx.ui.select as ReturnType<typeof vi.fn>).mockImplementation(async (title: string, choices: string[]) => {
          if (title === "External runs") {
            if (rootChosen) return "Back";
            rootChosen = true;
            return choices.find((choice) => choice.includes(runId)) ?? "Back";
          }
          if (title === `Run ${runId}`) {
            detailCalls++;
            if (detailCalls === 1) {
              expect(choices).toContain("Final");
              return "Final";
            }
            return "Back";
          }
          return "Back";
        });
        (ctx.ui.notify as ReturnType<typeof vi.fn>).mockClear();
        (ctx.ui.editor as ReturnType<typeof vi.fn>).mockClear();
        await command?.handler("runs", ctx as never);
      }

      await selectFinalFor(failedAgent.runId);
      expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringMatching(/no verified final answer.*available/i), "info");
      expect(ctx.ui.editor).not.toHaveBeenCalled();

      await selectFinalFor(failedWorkflowIdentity.runId);
      expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringMatching(/no verified final answer.*available/i), "info");
      expect(ctx.ui.editor).not.toHaveBeenCalled();

      await selectFinalFor(nullWorkflowIdentity.runId);
      expect(ctx.ui.notify).not.toHaveBeenCalled();
      expect(ctx.ui.editor).toHaveBeenCalledWith(`final ${nullWorkflowIdentity.runId}`, expect.stringContaining('"result":null'));
      expect(ctx.ui.editor).toHaveBeenCalledWith(`final ${nullWorkflowIdentity.runId}`, expect.stringContaining('"finalAvailable":true'));
    } finally {
      rmSync(runsDirectory, { recursive: true, force: true });
    }
  });
});
