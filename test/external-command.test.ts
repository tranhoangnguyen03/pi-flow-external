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

/** external_runs results as `/external runs` reads them: the public contract, not renderer details. */
function listResult(data: Record<string, unknown>) {
  return { content: [{ type: "text", text: "list" }], details: data, structuredContent: { ok: true, data } };
}

function pageResult(text: string, { nextCursor, ...extra }: { nextCursor?: string; finalAvailable?: boolean } = {}) {
  return { content: [{ type: "text", text }], details: {}, structuredContent: { ok: true, data: { mode: "single", page: { text, ...(nextCursor ? { nextCursor } : {}) }, ...extra } } };
}

function failureResult(code: string, message: string) {
  return { content: [{ type: "text", text: message }], details: { error: message, code }, isError: true, structuredContent: { ok: false, data: null, error: { code, message } } };
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

        const verbs = (group: string, list: string[]) => list.map((verb) => `config ${group} ${verb}`);
        expect(command?.getArgumentCompletions("")?.map((item) => item.value)).toEqual([
          "doctor", "config", "config text", "config edit", "config convert",
          ...verbs("harness", ["list", "inspect", "create", "edit", "enable", "disable", "set", "reset", "delete", "default", "test", "assist"]),
          ...verbs("role", ["list", "inspect", "create", "edit", "enable", "disable", "set", "reset", "delete", "assist"]),
          "[danger]purge-old-files", "workflows", "runs", "runs summary", "runs --prune", "help",
        ]);
        expect(command?.getArgumentCompletions("config role inspect rev")?.map((item) => item.value)).toEqual(["config role inspect reviewer"]);

        const notices: string[] = [];
        const ctx = { cwd: root, isProjectTrusted: () => false, ui: { notify: (message: string) => notices.push(message) } };

        // Overview names the default, role/harness counts, and settings path.
        await command?.handler("", ctx);
        expect(notices.at(-1)).toContain("Default: agy (global)");
        expect(notices.at(-1)).toContain("Harnesses: 6 CLI");
        expect(notices.at(-1)).toContain(options.settings.path);

        // Roles list one row per role instead of the harness × role product.
        await command?.handler("config role list", ctx);
        expect(notices.at(-1)).toContain("- reviewer · built-in · enabled");
        expect(notices.at(-1)).not.toContain("claude/reviewer");

        // Assisted interviews are explicit; deterministic creation never starts one.
        await command?.handler("config harness create", ctx);
        expect(notices.at(-1)).toContain("Usage: /external config harness create pi-NAME --model");
        await command?.handler("config harness assist", ctx);
        expect(options.startHarnessInterview).toHaveBeenCalledOnce();
        await command?.handler("config role assist", ctx);
        expect(options.startRoleInterview).toHaveBeenCalledOnce();

        // Replaced routes do not run; help names their replacements.
        for (const old of ["roles", "role create", "role inspect reviewer", "role override reviewer claude", "config harnesses", "config enable codex", "config disable codex", "config default codex"]) {
          await command?.handler(old, ctx);
          expect(notices.at(-1)).toContain("Usage: /external doctor");
        }
        await command?.handler("config role frobnicate", ctx);
        expect(notices.at(-1)).toContain("/external config role set NAME --harness NAME");
        await command?.handler("help", ctx);
        expect(notices.at(-1)).toContain("/external role override <role> <harness> → /external config role edit <role> --harness NAME");
        expect(notices.at(-1)).toContain("/external config enable|disable|default <harness> → /external config harness enable|disable|default <harness>");

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

        // The explicit text route must not open a dialog, even with a TUI context.
        const custom = vi.fn();
        await command?.handler("config text", { ...ctx, mode: "tui", hasUI: true, ui: { ...ctx.ui, custom } });
        expect(notices.at(-1)).toContain("defaultHarness: agy (global)");
        expect(custom).not.toHaveBeenCalled();
        expect(exec).not.toHaveBeenCalled();

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

        await command?.handler("config harness list", ctx);
        expect(notices.at(-1)).toContain("- codex · CLI (model native · effort native) · enabled");
        expect(notices.at(-1)).toContain("no named Pi harnesses");

        // Readiness is explicit and honest that no model request was made.
        await command?.handler("config harness test claude", ctx);
        expect(notices.at(-1)).toContain("CLI: available (claude 1.2.3)");
        expect(notices.at(-1)).toContain("No model request was made");
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports the configured Pi parent effort policy instead of the legacy projection", async () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-flow-command-parent-'));
    try {
      await withAgentDir(root, async () => {
        mkdirSync(join(root, 'pi-flow-external'));
        writeFileSync(join(root, 'pi-flow-external/settings.json'), JSON.stringify({ version: 5, harnesses: { 'pi-check': { model: 'p/m', thinking: 'parent' } } }));
        let command: { handler: (args: string, ctx: unknown) => Promise<void> } | undefined;
        registerExternalCommand({ exec: vi.fn(), registerCommand: (_name: string, options: typeof command) => { command = options; } } as never,
          commandOptions({ settings: settingsV4(root) }) as never);
        const notices: string[] = [];
        await command?.handler('config text', { cwd: root, isProjectTrusted: () => false, ui: { notify: (text: string) => notices.push(text) } });
        expect(notices.at(-1)).toContain('Pi (p/m · parent');
        expect(notices.at(-1)).not.toContain('default thinking');
      });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("manages harnesses through the validated writer, guarding defaults, previewing deletes, and skipping disabled readiness", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-flow-command-toggle-"));
    const settingsPath = join(root, "pi-flow-external", "settings.json");
    mkdirSync(join(root, "pi-flow-external"), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({ version: 5, defaultHarness: "agy", futureField: { keep: true }, disabledHarnesses: ["future-cli"], harnesses: { "pi-check": { model: "test/model", thinking: "off", preset: "minimal" } } }));
    try {
      await withAgentDir(root, async () => {
        let command: { getArgumentCompletions: (prefix: string) => Array<{ value: string }> | null; handler: (args: string, ctx: unknown) => Promise<void> } | undefined;
        const exec = vi.fn(async () => ({ code: 0, killed: false, stdout: "v1\n", stderr: "" }));
        const pi = { exec, registerCommand: (_name: string, options: typeof command) => { command = options; } };
        registerExternalCommand(pi as never, commandOptions({ settings: settingsV4(root) }) as never);
        const notices: string[] = [];
        const find = vi.fn(() => undefined);
        const confirm = vi.fn(async () => false);
        const ctx = { cwd: root, hasUI: true, isProjectTrusted: () => false, modelRegistry: { find }, ui: { notify: (message: string) => notices.push(message), confirm } };
        const saved = () => JSON.parse(readFileSync(settingsPath, "utf8"));

        expect(command?.getArgumentCompletions("config harness disable pi")?.map((item) => item.value)).toEqual(["config harness disable pi-check"]);

        // The effective default cannot be disabled, and a disabled harness cannot become the default.
        await command?.handler("config harness disable agy", ctx);
        expect(notices.at(-1)).toMatch(/Cannot disable "agy".*harness default/);
        await command?.handler("config harness disable nope", ctx);
        expect(notices.at(-1)).toMatch(/Unknown harness "nope"/);
        await command?.handler("config harness disable codex", ctx);
        await command?.handler("config harness disable pi-check", ctx);
        await command?.handler("config harness default codex", ctx);
        expect(notices.at(-1)).toMatch(/Cannot make "codex" the default.*harness enable codex/);
        expect(saved()).toEqual({ version: 5, defaultHarness: "agy", futureField: { keep: true }, disabledHarnesses: ["future-cli"], harnesses: { "pi-check": { model: "test/model", thinking: "off", preset: "minimal", enabled: false }, codex: { enabled: false } } });

        await command?.handler("config harness list", ctx);
        expect(notices.at(-1)).toContain("- codex · CLI (model native · effort native) · disabled");
        expect(notices.at(-1)).toContain("- pi-check · Pi (model test/model · effort off · preset minimal) · disabled");
        expect(notices.at(-1)).toContain("- future-cli · unknown · disabled");

        // Doctor skips readiness probes for disabled CLI and Pi harnesses.
        await command?.handler("doctor", ctx);
        expect(exec.mock.calls.map((call) => (call as unknown[])[0])).not.toContain("codex");
        expect(find).not.toHaveBeenCalled();
        expect(notices.at(-1)).toContain("○ codex: disabled (readiness not checked)");

        // Set and field reset change only named properties; the gate survives and nothing is re-enabled.
        await command?.handler('config harness set codex --model "gpt-x" --effort high', ctx);
        await command?.handler("config harness reset codex --effort", ctx);
        expect(saved().harnesses.codex).toEqual({ enabled: false, model: "gpt-x" });
        await command?.handler("config harness inspect codex", ctx);
        expect(notices.at(-1)).toContain("Model: gpt-x · settings harnesses.codex");
        expect(notices.at(-1)).toContain("Effort: native (backend's own default) · backend default");
        await command?.handler("config harness set codex --effort hgh", ctx);
        expect(notices.at(-1)).toMatch(/Settings were not changed: .*unsupported reasoning effort/);

        // A project default is also guarded; enabling an unknown preserved name removes only that name.
        mkdirSync(join(root, ".pi", "pi-flow-external"), { recursive: true });
        writeFileSync(join(root, ".pi", "pi-flow-external", "settings.json"), JSON.stringify({ defaultHarness: "claude" }));
        await command?.handler("config harness disable claude", { ...ctx, isProjectTrusted: () => true });
        expect(notices.at(-1)).toMatch(/Cannot disable "claude": it is the project default/);
        await command?.handler("config harness enable future-cli", ctx);
        await command?.handler("config harness enable codex", ctx);
        await command?.handler("config harness default codex", ctx);
        expect(saved()).toMatchObject({ defaultHarness: "codex", futureField: { keep: true }, disabledHarnesses: [], harnesses: { codex: { model: "gpt-x" } } });

        // Deterministic creation, then delete with an impact preview; built-ins and cancelled deletes change nothing.
        await command?.handler("config harness create pi-new --model p/m --preset skills", ctx);
        expect(saved().harnesses["pi-new"]).toEqual({ model: "p/m", thinking: "off", preset: "skills", owner: "user" });
        expect(notices.at(-1)).toContain("No readiness check was run");
        await command?.handler("config harness test pi-new", ctx);
        expect(notices.at(-1)).toContain("No model test");
        await command?.handler("config harness delete codex", ctx);
        expect(notices.at(-1)).toMatch(/built-in CLI harness and cannot be deleted/);
        await command?.handler("config harness delete pi-new", ctx);
        expect(confirm).toHaveBeenLastCalledWith("Delete harness pi-new?", expect.stringContaining("- harnesses.pi-new"));
        expect(saved().harnesses["pi-new"]).toBeDefined();
        confirm.mockResolvedValueOnce(true);
        await command?.handler("config harness delete pi-new", ctx);
        expect(saved().harnesses["pi-new"]).toBeUndefined();

        // Arguments are strict: duplicate flags, extra positionals, and irrelevant flags change nothing.
        const before = readFileSync(settingsPath, "utf8");
        for (const bad of ["config harness set codex --model a --model b", "config harness set codex extra --model a", "config harness inspect codex --model a", "config harness list extra", "config role list --harness codex", "config role set reviewer --harness codex --harness claude --effort high", "config role enable reviewer extra"]) {
          await command?.handler(bad, ctx);
          expect(notices.at(-1), bad).toMatch(/more than once|Unexpected argument|Unknown option/);
        }
        expect(readFileSync(settingsPath, "utf8")).toBe(before);

        // A change between preview and confirmation (here: the default moves to the target) refuses the delete.
        await command?.handler("config harness create pi-late --model p/m", ctx);
        confirm.mockImplementationOnce(async () => { writeFileSync(settingsPath, JSON.stringify({ ...saved(), defaultHarness: "pi-late" })); return true; });
        await command?.handler("config harness delete pi-late", ctx);
        expect(notices.at(-1)).toMatch(/not deleted: .*global default/);
        expect(saved().harnesses["pi-late"]).toBeDefined();
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("authors, customizes, inspects, resets, and deletes roles deterministically in the editor", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-flow-command-roles-"));
    const base = join(root, "pi-flow-external");
    mkdirSync(base, { recursive: true });
    writeFileSync(join(base, "settings.json"), JSON.stringify({ version: 5 }));
    try {
      await withAgentDir(root, async () => {
        let command: { handler: (args: string, ctx: unknown) => Promise<void> } | undefined;
        const pi = { exec: vi.fn(), registerCommand: (_name: string, options: typeof command) => { command = options; } };
        const options = commandOptions({ settings: settingsV4(root) });
        registerExternalCommand(pi as never, options as never);
        const notices: string[] = [];
        const editor = vi.fn(async (_title: string, _content: string) => "---\ndescription: Audit changes\n---\nAudit now.");
        const confirm = vi.fn(async () => true);
        const ctx = { cwd: root, hasUI: true, isProjectTrusted: () => false, ui: { notify: (message: string) => notices.push(message), editor, confirm } };
        const saved = () => JSON.parse(readFileSync(join(base, "settings.json"), "utf8"));

        await command?.handler("config role create audit", ctx);
        expect(readFileSync(join(base, "roles", "audit.md"), "utf8")).toBe('---\ndescription: "Audit changes"\n---\nAudit now.\n');
        editor.mockResolvedValueOnce("---\ndescription: Codex audit\n---\n");
        await command?.handler("config role edit audit --harness codex", ctx);
        expect(editor).toHaveBeenLastCalledWith("role audit on codex", expect.stringContaining("Audit now."));
        expect(existsSync(join(base, "overrides", "codex", "audit.md"))).toBe(true);
        await command?.handler("config role set audit --model gpt-x", ctx);
        expect(notices.at(-1)).toContain("--harness NAME");
        await command?.handler("config role set audit --harness codex --model gpt-x --budget 3", ctx);
        expect(saved()).toEqual({ version: 5, harnesses: { codex: { roles: { audit: { model: "gpt-x", max_budget_usd: 3 } } } } });

        await command?.handler("config role inspect audit --harness codex", ctx);
        expect(notices.at(-1)).toContain("codex/audit: Codex audit");
        expect(notices.at(-1)).toContain("Model: gpt-x · role audit on codex");
        expect(notices.at(-1)).toContain(`Instructions: ${join(base, "overrides", "codex", "audit.md")}`);
        expect(notices.at(-1)).toContain("(empty instructions)");
        expect(notices.at(-1)).toContain("Codex --sandbox axis");
        await command?.handler("config role inspect audit", ctx);
        expect(notices.at(-1)).toContain("- codex: available · model gpt-x · effort native · instruction override");
        expect(notices.at(-1)).toContain("- claude: available · model native");

        // Enabling one gate reports the remaining one instead of implying availability.
        await command?.handler("config role disable audit", ctx);
        await command?.handler("config role enable audit --harness codex", ctx);
        expect(notices.at(-1)).toMatch(/already enabled\. Still blocked: role "audit" is disabled/);

        // Broad binding reset previews, keeps the gate, and removes the override and scalars.
        await command?.handler("config role reset audit --harness codex", ctx);
        expect(confirm).toHaveBeenLastCalledWith("Reset codex/audit?", expect.stringContaining(join(base, "overrides", "codex", "audit.md")));
        expect(saved()).toEqual({ version: 5, roles: { audit: { enabled: false } } });
        expect(existsSync(join(base, "overrides", "codex", "audit.md"))).toBe(false);

        await command?.handler("config role delete reviewer", ctx);
        expect(notices.at(-1)).toMatch(/built-in role and cannot be deleted/);
        await command?.handler("config role delete audit", { ...ctx, hasUI: false });
        expect(notices.at(-1)).toContain("needs interactive confirmation");
        expect(existsSync(join(base, "roles", "audit.md"))).toBe(true);
        await command?.handler("config role delete audit", ctx);
        expect(existsSync(join(base, "roles", "audit.md"))).toBe(false);
        expect(saved()).toEqual({ version: 5 });
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

        // v5 previews disclose retained unresolved exclusions before confirmation.
        const settingsPath = join(root, 'pi-flow-external/settings.json');
        writeFileSync(settingsPath, JSON.stringify({ ...JSON.parse(readFileSync(settingsPath, 'utf8')), disabledProfiles: ['unknown-name'], disabledHarnesses: ['pi-gone'] }));
        await command?.handler("config convert", ctx);
        expect(confirm.mock.calls.at(-1)).toEqual(expect.arrayContaining([expect.stringContaining('Retained unresolved disabled identity unknown-name')]));
        expect(notices.at(-1)).toContain("Converted to v5");
        await command?.handler("config convert", ctx);
        expect(notices.at(-1)).toContain("already version 5");
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
            return listResult({
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
            });
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
            if (params.action === "list") return listResult({ workflows: [], runs: [{ runId: "run_1", status: "done" }] });
            return pageResult(summaryJson);
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

  it("restarts a stale paged summary from page 1 by error code, and keeps navigating after any other returned failure", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-flow-command-stale-summary-"));
    try {
      await withAgentDir(root, async () => {
        let command: { handler: (args: string, ctx: unknown) => Promise<void> } | undefined;
        const pi = { exec: vi.fn(), registerCommand: (_name: string, options: typeof command) => { command = options; } };
        let staleServed = false;
        const externalRuns = {
          execute: vi.fn(async (_id: string, params: any) => {
            if (params.action === "list") return listResult({ workflows: [], runs: [{ runId: "run_1", status: "done" }, { runId: "run_gone", status: "done" }] });
            if (params.runId === "run_gone") return failureResult("run_unavailable", "Run is unknown or unavailable in this session");
            if (!params.cursor) return pageResult('{"runId":"run_1",', { nextCursor: "c1" });
            if (!staleServed) {
              staleServed = true;
              return failureResult("cursor_stale", "Run changed while paging; restart inspection without a cursor");
            }
            return pageResult('"state":{"status":"done"}}');
          }),
        };
        registerExternalCommand(pi as never, commandOptions({ settings: settingsV4(root), externalRuns: externalRuns as never }));
        const opened: string[] = [];
        const ctx = {
          cwd: root,
          isProjectTrusted: () => false,
          hasUI: true,
          ui: {
            notify: vi.fn(),
            editor: vi.fn(async () => ""),
            select: vi.fn(async (title: string, choices: string[]) => {
              if (title === "External runs") {
                const next = ["run_gone", "run_1"].find((runId) => !opened.includes(runId));
                if (!next) return "Back";
                opened.push(next);
                return choices.find((choice) => choice.includes(next));
              }
              return "Back";
            }),
          },
        };
        await command?.handler("runs", ctx as never);
        expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Could not inspect run_gone"), "warning");
        // run_1 was reached after the failure, and its summary was re-read from page 1 after the stale cursor.
        expect(ctx.ui.select).toHaveBeenCalledWith("Run run_1", expect.any(Array));
        expect(externalRuns.execute.mock.calls.filter(([, params]) => params.runId === "run_1" && !params.cursor)).toHaveLength(2);
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
            if (params.action === "list") return listResult({ workflows: [], runs: [{ runId: "run_1", status: "done" }] });
            if (params.view === "launch") {
              // Recovery keys on the returned code, never on the message prose.
              if (params.cursor) return failureResult("cursor_stale", "Evidence moved on");
              return pageResult("launch snapshot", { nextCursor: "old-page" });
            }
            if (params.action === "inspect" && params.view === "final") return pageResult("canonical final answer", { finalAvailable: true });
            return pageResult(JSON.stringify({ runId: "run_1", state: { status: "done" } }));
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
