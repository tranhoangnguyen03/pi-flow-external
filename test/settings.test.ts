import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createSubagentExtension } from "../src/pi-subagent.ts";
import {
  DEFAULT_EXTERNAL_SETTINGS,
  loadExternalSettings,
  projectExternalSettingsPath,
  renderCapabilitySets,
  renderDefaultHarness,
  resolveCapabilitySets,
  resolveCtxCapabilitySets,
  resolveCtxDefaultHarness,
  resolveDefaultHarness,
} from "../src/settings.ts";

const roots: string[] = [];
function agentDir(): string {
  const path = mkdtempSync(join(tmpdir(), "pi-flow-settings-"));
  roots.push(path);
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
  it("creates a private default file once", () => {
    const root = agentDir();
    const first = loadExternalSettings(root);
    const original = readFileSync(first.path, "utf8");

    expect(first.settings).toEqual(DEFAULT_EXTERNAL_SETTINGS);
    expect(first.diagnostics).toEqual([]);
    expect(statSync(first.path).mode & 0o777).toBe(0o600);

    writeFileSync(first.path, original.replace('"agy"', '"claude"').replace("12", "7"));
    expect(loadExternalSettings(root).settings).toMatchObject({ defaultHarness: "claude", maxConcurrentSubagents: 7 });
  });

  it("uses safe defaults and diagnostics for invalid files", () => {
    const root = agentDir();
    const loaded = loadExternalSettings(root);
    writeFileSync(loaded.path, '{"version":1,"defaultHarness":"gemini","maxConcurrentSubagents":0,"subagentTimeoutMs":"forever","extra":true}\n');

    const invalid = loadExternalSettings(root);
    expect(invalid.settings).toEqual(DEFAULT_EXTERNAL_SETTINGS);
    expect(invalid.diagnostics.join(" ")).toMatch(/defaultHarness|Unknown setting/);
  });

  it("migrates a valid v1 file on read and fills current defaults", () => {
    const root = agentDir();
    const loaded = loadExternalSettings(root);
    writeFileSync(loaded.path, `${JSON.stringify({
      version: 1,
      maxConcurrentSubagents: 7,
      subagentTimeoutMs: 600_000,
    })}\n`);

    const migrated = loadExternalSettings(root);
    expect(migrated.settings).toEqual({
      version: 3,
      defaultHarness: "agy",
      maxConcurrentSubagents: 7,
      subagentTimeoutMs: 600_000,
      defaultPermission: "danger",
      defaultMaxBudgetUsd: null,
      maxRunRecords: 200,
      piCapabilitySets: {},
    });
    // A v1 file is valid input, not a warning.
    expect(migrated.diagnostics).toEqual([]);
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
  });

  it("reports malformed JSON without preventing startup", () => {
    const root = agentDir();
    const loaded = loadExternalSettings(root);
    writeFileSync(loaded.path, "{broken\n");

    const malformed = loadExternalSettings(root);
    expect(malformed.settings).toEqual(DEFAULT_EXTERNAL_SETTINGS);
    expect(malformed.diagnostics[0]).toMatch(/valid JSON/);
  });

  it("applies file, factory, then CLI precedence through the extension", async () => {
    const root = agentDir();
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = root;
    const loaded = loadExternalSettings(root);
    writeFileSync(loaded.path, JSON.stringify({ version: 1, maxConcurrentSubagents: 3, subagentTimeoutMs: 4_000 }));

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
      expect(load().flags.get("max-concurrent-subagents")?.default).toBe("3");
      const configured = load(5);
      expect(configured.flags.get("max-concurrent-subagents")?.default).toBe("5");
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

describe("piCapabilitySets (issue #43 second slice)", () => {
  it("parses valid entries and drops an invalid one with a diagnostic, keeping the rest", () => {
    const root = agentDir();
    const loaded = loadExternalSettings(root);
    writeFileSync(loaded.path, JSON.stringify({
      ...DEFAULT_EXTERNAL_SETTINGS,
      piCapabilitySets: {
        docs: { skills: ["writer", "writer"], promptTemplates: ["release-notes"] },
        "Bad Name": { skills: ["x"] },
        broken: { skills: [true] },
      },
    }));
    const parsed = loadExternalSettings(root);
    expect(parsed.settings.piCapabilitySets).toEqual({ docs: { skills: ["writer"], promptTemplates: ["release-notes"] } });
    expect(parsed.diagnostics.join(" ")).toMatch(/Bad Name/);
    expect(parsed.diagnostics.join(" ")).toMatch(/broken/);
  });

  it("defaults absent skills/promptTemplates arrays to empty rather than rejecting the entry", () => {
    const root = agentDir();
    const loaded = loadExternalSettings(root);
    writeFileSync(loaded.path, JSON.stringify({ ...DEFAULT_EXTERNAL_SETTINGS, piCapabilitySets: { docs: {} } }));
    const parsed = loadExternalSettings(root);
    expect(parsed.settings.piCapabilitySets).toEqual({ docs: { skills: [], promptTemplates: [] } });
  });

  it("rejects an entry with an unknown field instead of silently dropping it", () => {
    const root = agentDir();
    const loaded = loadExternalSettings(root);
    writeFileSync(loaded.path, JSON.stringify({
      ...DEFAULT_EXTERNAL_SETTINGS,
      piCapabilitySets: {
        docs: { skills: ["writer"], promptTempaltes: ["release-notes"] },
        ok: { skills: ["writer"] },
      },
    }));
    const parsed = loadExternalSettings(root);
    expect(parsed.settings.piCapabilitySets).toEqual({ ok: { skills: ["writer"], promptTemplates: [] } });
    expect(parsed.diagnostics.join(" ")).toMatch(/piCapabilitySets entry "docs" ignored: unknown field\(s\) promptTempaltes/);
  });

  describe("project override", () => {
    const project = () => {
      const cwd = mkdtempSync(join(tmpdir(), "pi-flow-capsets-"));
      roots.push(cwd);
      return cwd;
    };
    const writeProjectSettings = (cwd: string, body: string) => {
      mkdirSync(dirname(projectExternalSettingsPath(cwd)), { recursive: true });
      writeFileSync(projectExternalSettingsPath(cwd), body);
    };
    const global = { docs: { skills: ["writer"], promptTemplates: ["release-notes"] } };

    it("replaces a same-named global set wholesale rather than merging its arrays, only when trusted", () => {
      const cwd = project();
      writeProjectSettings(cwd, JSON.stringify({ piCapabilitySets: { docs: { skills: ["project-writer"] } } }));
      const untrusted = resolveCapabilitySets(global, cwd, false);
      expect(untrusted.sets.get("docs")).toEqual(global.docs);
      expect(untrusted.diagnostics.join(" ")).toMatch(/not trusted/);

      const trusted = resolveCapabilitySets(global, cwd, true);
      expect(trusted.sets.get("docs")).toEqual({ skills: ["project-writer"], promptTemplates: [] });
    });

    it("shadows a same-named global set with an unknown-set failure when the project override is malformed, rather than silently keeping the global definition", () => {
      const cwd = project();
      writeProjectSettings(cwd, JSON.stringify({ piCapabilitySets: { docs: { skills: [true] } } }));
      const trusted = resolveCapabilitySets(global, cwd, true);
      expect(trusted.sets.has("docs")).toBe(false);
      expect(trusted.diagnostics.join(" ")).toMatch(/piCapabilitySets entry "docs" ignored/);
    });

    it("shadows a same-named global set when the project override has a typo'd field, rather than silently inheriting the global definition", () => {
      const cwd = project();
      writeProjectSettings(cwd, JSON.stringify({ piCapabilitySets: { docs: { skils: ["project-writer"] } } }));
      const trusted = resolveCapabilitySets(global, cwd, true);
      expect(trusted.sets.has("docs")).toBe(false);
      expect(trusted.diagnostics.join(" ")).toMatch(/piCapabilitySets entry "docs" ignored: unknown field\(s\) skils/);
    });

    it("adds a project-only set name alongside untouched global sets", () => {
      const cwd = project();
      writeProjectSettings(cwd, JSON.stringify({ piCapabilitySets: { "project-only": { skills: ["scout"] } } }));
      const trusted = resolveCapabilitySets(global, cwd, true);
      expect(trusted.sets.get("docs")).toEqual(global.docs);
      expect(trusted.sets.get("project-only")).toEqual({ skills: ["scout"], promptTemplates: [] });
    });

    it("falls back to global-only when no project file exists", () => {
      const cwd = project();
      const result = resolveCapabilitySets(global, cwd, true);
      expect(result.sets).toEqual(new Map(Object.entries(global)));
      expect(result.diagnostics).toEqual([]);
    });

    it("remembers the last ctx-resolved sets for render paths, like renderDefaultHarness", () => {
      const cwd = project();
      writeProjectSettings(cwd, JSON.stringify({ piCapabilitySets: { docs: { skills: ["project-writer"] } } }));
      expect(renderCapabilitySets(global, join(cwd, "elsewhere")).sets.get("docs")).toEqual(global.docs);
      resolveCtxCapabilitySets(global, { cwd, isProjectTrusted: () => true });
      expect(renderCapabilitySets(global, cwd).sets.get("docs")).toEqual({ skills: ["project-writer"], promptTemplates: [] });
    });
  });
});
