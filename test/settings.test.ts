import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createSubagentExtension } from "../src/pi-subagent.ts";
import {
  DEFAULT_EXTERNAL_SETTINGS,
  loadExternalSettings,
  saveExternalSettings,
  projectExternalSettingsPath,
  renderDefaultHarness,
  resolveCtxDefaultHarness,
  resolveDefaultHarness,
} from "../src/settings.ts";
import { EXTERNAL_HARNESSES } from "../src/types.ts";

const roots: string[] = [];
function agentDir(): string {
  const path = mkdtempSync(join(tmpdir(), "pi-flow-settings-"));
  roots.push(path);
  mkdirSync(join(path, "pi-flow-external"));
  return path;
}

afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("project default-harness override", () => {
  const project = () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-flow-project-"));
    roots.push(cwd);
    return cwd;
  };
  const writeProjectSettings = (cwd: string, body: string) => {
    mkdirSync(dirname(projectExternalSettingsPath(cwd)), { recursive: true });
    writeFileSync(projectExternalSettingsPath(cwd), body);
  };

  it("honors a trusted project override and falls back to global without one", () => {
    const cwd = project();
    expect(resolveDefaultHarness("agy", cwd, true)).toMatchObject({ harness: "agy", source: "global" });
    writeProjectSettings(cwd, JSON.stringify({ defaultHarness: "claude" }));
    expect(resolveDefaultHarness("agy", cwd, true)).toMatchObject({ harness: "claude", source: "project" });
  });

  it("ignores the project file when the project is not trusted", () => {
    const cwd = project();
    writeProjectSettings(cwd, JSON.stringify({ defaultHarness: "claude" }));
    const result = resolveDefaultHarness("agy", cwd, false);
    expect(result).toMatchObject({ harness: "agy", source: "global" });
    expect(result.diagnostics.join(" ")).toMatch(/not trusted/);
  });

  it("accepts a pi-* harness name shape at the project-override level", () => {
    const cwd = project();
    writeProjectSettings(cwd, JSON.stringify({ defaultHarness: "pi-deepseek" }));
    expect(resolveDefaultHarness("agy", cwd, true)).toMatchObject({ harness: "pi-deepseek", source: "project" });
  });

  it("rejects invalid values and unknown keys with diagnostics, keeping the global default", () => {
    const cwd = project();
    writeProjectSettings(cwd, JSON.stringify({ defaultHarness: "gemini", extra: 1 }));
    const result = resolveDefaultHarness("codex", cwd, true);
    expect(result).toMatchObject({ harness: "codex", source: "global" });
    expect(result.diagnostics.join(" ")).toMatch(/defaultHarness must be/);
    expect(result.diagnostics.join(" ")).toMatch(/Unknown project setting/);

    writeProjectSettings(cwd, "{broken\n");
    expect(resolveDefaultHarness("codex", cwd, true).diagnostics.join(" ")).toMatch(/valid JSON/);
  });

  it("remembers the last ctx-resolved harness for render paths", () => {
    const cwd = project();
    writeProjectSettings(cwd, JSON.stringify({ defaultHarness: "claude" }));
    // Unknown cwd (never resolved with a live ctx): falls back to global.
    expect(renderDefaultHarness("agy", join(cwd, "elsewhere"))).toBe("agy");
    resolveCtxDefaultHarness("agy", { cwd, isProjectTrusted: () => true });
    expect(renderDefaultHarness("agy", cwd)).toBe("claude");
  });
});

describe("external settings", () => {
  it("reads built-in defaults without creating configuration files", () => {
    const root = agentDir();
    const first = loadExternalSettings(root);
    expect(first.settings).toEqual(DEFAULT_EXTERNAL_SETTINGS);
    expect(first.diagnostics).toEqual([]);
    expect(existsSync(first.path)).toBe(false);
  });

  it("does not confuse a native prefixed role with legacy external configuration and permits explicit malformed-file repair", () => {
    const root = agentDir();
    mkdirSync(join(root, "subagents"));
    writeFileSync(join(root, "subagents", "claude-native.md"), "---\ndescription: Native\n---\nNative instructions");
    expect(loadExternalSettings(root).blocked).toBe(false);
    const path = join(root, "pi-flow-external", "settings.json");
    writeFileSync(path, "broken");
    expect(() => saveExternalSettings(root, { version: 4 })).toThrow();
    saveExternalSettings(root, { version: 4 }, { repair: true });
    expect(loadExternalSettings(root).blocked).toBe(false);
    writeFileSync(path, '{"version":3}');
    expect(() => saveExternalSettings(root, { version: 4 }, { repair: true })).toThrow();
  });

  it("uses safe defaults and diagnostics for invalid files", () => {
    const root = agentDir();
    const loaded = loadExternalSettings(root);
    writeFileSync(loaded.path, '{"version":1,"defaultHarness":"gemini","maxConcurrentSubagents":0,"subagentTimeoutMs":"forever","extra":true}\n');

    const invalid = loadExternalSettings(root);
    expect(invalid.settings).toEqual(DEFAULT_EXTERNAL_SETTINGS);
    expect(invalid.diagnostics.join(" ")).toMatch(/defaultHarness|Unknown setting/);
  });

  it("requires explicit conversion of a v1 file without rewriting it", () => {
    const root = agentDir();
    const loaded = loadExternalSettings(root);
    writeFileSync(loaded.path, `${JSON.stringify({
      version: 1,
      maxConcurrentSubagents: 7,
      subagentTimeoutMs: 600_000,
    })}\n`);

    const migrated = loadExternalSettings(root);
    expect(migrated.settings).toEqual({
      version: 4,
      defaultHarness: "agy",
      maxConcurrentSubagents: 7,
      subagentTimeoutMs: 600_000,
      defaultPermission: "danger",
      defaultMaxBudgetUsd: null,
      maxRunRecords: 200,
    });
    expect(migrated.blocked).toBe(true);
    expect(migrated.upgradeRequired).toBe(true);
    expect(JSON.parse(readFileSync(loaded.path, "utf8")).version).toBe(1);
  });

  it("accepts a pi-* harness name at the global settings parse-shape level", () => {
    const root = agentDir();
    const loaded = loadExternalSettings(root);
    writeFileSync(loaded.path, JSON.stringify({ ...DEFAULT_EXTERNAL_SETTINGS, defaultHarness: "pi-deepseek" }));
    const parsed = loadExternalSettings(root);
    expect(parsed.settings.defaultHarness).toBe("pi-deepseek");
    expect(parsed.diagnostics).toEqual([]);
  });

  it("still rejects a defaultHarness that matches neither a literal nor the pi-* shape", () => {
    const root = agentDir();
    const loaded = loadExternalSettings(root);
    writeFileSync(loaded.path, JSON.stringify({ ...DEFAULT_EXTERNAL_SETTINGS, defaultHarness: "gemini" }));
    const parsed = loadExternalSettings(root);
    expect(parsed.settings.defaultHarness).toBe("agy");
    expect(parsed.diagnostics.join(" ")).toMatch(/defaultHarness must be/);
    // The listed harnesses must stay in sync with EXTERNAL_HARNESSES (e.g. grok), not a hardcoded string.
    expect(parsed.diagnostics.join(" ")).toContain(EXTERNAL_HARNESSES.join(", "));
  });

  it("accepts grok as a global defaultHarness", () => {
    const root = agentDir();
    const loaded = loadExternalSettings(root);
    writeFileSync(loaded.path, JSON.stringify({ ...DEFAULT_EXTERNAL_SETTINGS, defaultHarness: "grok" }));
    const parsed = loadExternalSettings(root);
    expect(parsed.settings.defaultHarness).toBe("grok");
    expect(parsed.diagnostics).toEqual([]);
  });

  it("reports malformed JSON without preventing startup", () => {
    const root = agentDir();
    const loaded = loadExternalSettings(root);
    writeFileSync(loaded.path, "{broken\n");

    const malformed = loadExternalSettings(root);
    expect(malformed.settings).toEqual(DEFAULT_EXTERNAL_SETTINGS);
    expect(malformed.blocked).toBe(true);
    expect(malformed.diagnostics[0]).toMatch(/Could not read settings/);
  });

  it("applies file, factory, then CLI precedence through the extension", async () => {
    const root = agentDir();
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = root;
    const loaded = loadExternalSettings(root);
    writeFileSync(loaded.path, JSON.stringify({ version: 4, maxConcurrentSubagents: 3, subagentTimeoutMs: 4_000 }));

    const load = (factoryValue?: number) => {
      const flags = new Map<string, { default: string }>();
      const values = new Map<string, string>();
      let settingsCommand: ((args: string, ctx: any) => Promise<void>) | undefined;
      const pi = {
        registerFlag: (name: string, options: { default: string }) => flags.set(name, options),
        getFlag: (name: string) => values.get(name) ?? flags.get(name)?.default,
        registerTool: vi.fn(),
        registerCommand: (name: string, options: { handler: typeof settingsCommand }) => {
          if (name === "external") settingsCommand = options.handler;
        },
        on: vi.fn(),
        getThinkingLevel: () => "high",
        getActiveTools: () => [],
        setActiveTools: vi.fn(),
      } as unknown as ExtensionAPI;
      createSubagentExtension(factoryValue === undefined ? {} : { maxConcurrentSubagents: factoryValue })(pi);
      return { flags, values, settingsCommand };
    };

    try {
      expect(load().flags.get("max-concurrent-subagents")?.default).toBe("");
      const configured = load(5);
      expect(configured.flags.get("max-concurrent-subagents")?.default).toBe("");
      configured.values.set("max-concurrent-subagents", "7");
      const notices: string[] = [];
      await configured.settingsCommand?.("settings", { cwd: root, isProjectTrusted: () => false, ui: { notify: (text: string) => notices.push(text) } });
      expect(notices.at(-1)).toContain("maxConcurrentSubagents: 7");
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
    }
  });
});
