import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { planV5Upgrade, applyV5Upgrade } from "../src/config-v5-upgrade.ts";
import * as settings from "../src/settings.ts";
import type { SubagentProfile } from "../src/types.ts";
import { loadExternalCatalog } from "../src/profiles.ts";

vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, linkSync: vi.fn(fs.linkSync) };
});
const roots: string[] = [];
function fixture(document: object = { version: 4 }, files: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), "external-v5-upgrade-")); roots.push(root);
  write(root, "settings.json", JSON.stringify(document));
  for (const [path, contents] of Object.entries(files)) write(root, path, contents);
  return root;
}
function path(root: string, relative: string) { return join(root, "pi-flow-external", relative); }
function write(root: string, relative: string, contents: string) {
  const target = path(root, relative); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, contents);
}
function profile(backend: string, fields = "", body = "Custom instructions.") {
  return `---\ndescription: Custom description\nbackend: ${backend}\n${fields}---\n\n${body}\n`;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("explicit v4 to v5 conversion", () => {
  it("preserves full replacements, empty instructions, Pi defaults, scalars, originals and unknown settings", () => {
    const files = {
      "roles/audit.md": "---\ndescription: Shared audit\n---\nShared instructions.\n",
      "overrides/codex-reviewer.md": profile("codex", "model: pinned\nthinking: xhigh\nmax_budget_usd: 2\n"),
      "overrides/claude-worker.md": profile("claude", "", ""),
      "overrides/pi-check-worker.md": profile("pi", "harness: pi-check\ntools: read, grep\nmax_budget_usd: 3\n"),
      "overrides/opencode-qa.md": profile("opencode", "model: p/model\nthinking: precise\n"),
    };
    const root = fixture({ version: 4, defaultHarness: "codex", defaultPermission: "readonly", defaultMaxBudgetUsd: 8,
      maxConcurrentSubagents: 3, subagentTimeoutMs: 12000, maxRunRecords: 9, unrelated: { keep: true },
      harnesses: { "pi-check": { model: "p/model", thinking: "high", owner: "owner" } } }, files);
    const original = readFileSync(path(root, "settings.json"), "utf8");
    const before = loadExternalCatalog(root, { legacyInspection: true });
    const plan = planV5Upgrade(root);
    expect(plan.status).toBe("ready");
    expect(plan.settings).toMatchObject({ version: 5, defaultHarness: "codex", defaultPermission: "readonly", defaultMaxBudgetUsd: 8,
      maxConcurrentSubagents: 3, subagentTimeoutMs: 12000, maxRunRecords: 9, unrelated: { keep: true },
      harnesses: {
        codex: { thinking: "parent", roles: { reviewer: { model: "pinned", thinking: "xhigh", max_budget_usd: 2 } } },
        claude: { thinking: "parent", roles: { worker: { model: "native", thinking: "parent" } } },
        opencode: { thinking: "native", roles: { qa: { model: "p/model", thinking: "precise" } } },
        "pi-check": { model: "p/model", thinking: "high", preset: "minimal", owner: "owner", roles: { worker: { tools: ["read", "grep"], max_budget_usd: 3 } } },
      } });
    expect(plan.copies).toHaveLength(4);
    expect(readFileSync(path(root, "settings.json"), "utf8")).toBe(original);
    expect(applyV5Upgrade(root).status).toBe("applied");
    expect(JSON.parse(readFileSync(path(root, "settings.json"), "utf8"))).toEqual(plan.settings);
    for (const [file, contents] of Object.entries(files)) expect(readFileSync(path(root, file), "utf8")).toBe(contents);
    const after = loadExternalCatalog(root);
    const effective = (profile: SubagentProfile) => ({
      description: profile.description, body: profile.systemPrompt ?? "", model: profile.model,
      thinking: profile.thinking === "parent" ? "high" : profile.thinking === "native" ? undefined
        : profile.thinking ?? (profile.backend === "opencode" ? undefined : "high"),
      tools: profile.tools, budget: profile.maxBudgetUsd ?? 8, preset: profile.preset,
    });
    for (const copy of plan.copies) {
      const key = `${basename(dirname(copy.destinationPath))}/${basename(copy.destinationPath, ".md")}`;
      expect(effective(after.profiles.get(key)!)).toEqual(effective(before.profiles.get(basename(copy.sourcePath, ".md"))!));
      expect(readFileSync(copy.destinationPath, "utf8")).toBe(copy.contents);
      expect(parseFrontmatter(copy.contents).frontmatter).toEqual({ description: "Custom description" });
    }
    expect(readFileSync(path(root, "overrides/claude/worker.md"), "utf8")).toBe('---\ndescription: "Custom description"\n---\n\n');
    expect(readFileSync(plan.backups[0]!.destinationPath, "utf8")).toBe(original);
    expect(statSync(plan.backups[0]!.destinationPath).mode & 0o777).toBe(0o600);
    expect(planV5Upgrade(root).status).toBe("current");
  });

  it("drops only unenforced legacy CLI tools with source-specific preview notes", () => {
    const root = fixture({ version: 4 }, {
      'overrides/codex-reviewer.md': profile('codex', 'tools: read, grep\n'),
      'overrides/special.md': profile('claude', 'tools: read\n'),
    });
    const original = readFileSync(path(root, 'settings.json'), 'utf8');
    const plan = planV5Upgrade(root);
    expect(plan.status).toBe('ready');
    expect(plan.settings!.harnesses.codex!.roles!.reviewer!.tools).toBeUndefined();
    expect(plan.settings!.exact!.special!.tools).toBeUndefined();
    for (const name of ['codex-reviewer', 'special']) expect(plan.notes.join(' ')).toContain(path(root, `overrides/${name}.md`));
    expect(plan.notes.join(' ')).toMatch(/tools.*never enforced/i);
    expect(readFileSync(path(root, 'settings.json'), 'utf8')).toBe(original);
    expect(applyV5Upgrade(root).status).toBe('applied');
  });

  it("blocks unsupported legacy effort with its source and a non-lossy repair path", () => {
    for (const [backend, effort] of [['claude', 'minimal'], ['claude', 'off'], ['codex', 'off'], ['grok', 'typo']]) {
      const file = `overrides/${backend}-reviewer.md`;
      const root = fixture({ version: 4 }, { [file]: profile(backend!, `thinking: ${effort}\n`) });
      const plan = planV5Upgrade(root);
      expect(plan.status).toBe('blocked');
      expect(plan.diagnostics.join(' ')).toContain(path(root, file));
      expect(plan.diagnostics.join(' ')).toMatch(/supported.*effort|effort.*supported/i);
      expect(plan.diagnostics.join(' ')).toMatch(/preview again/i);
      expect(JSON.parse(readFileSync(path(root, 'settings.json'), 'utf8')).version).toBe(4);
      expect(existsSync(path(root, 'settings.v4.backup.json'))).toBe(false);
    }
  });

  it("preserves future-role effort defaults and individual exclusions without disabling whole harnesses", () => {
    const disabledProfiles = ["codex-explorer", "codex-planner", "codex-implementer", "codex-reviewer", "codex-qa", "codex-worker", "oddball", "unknown-name"];
    const root = fixture({ version: 4, disabledProfiles, disabledHarnesses: ["muse", "pi-gone"] }, {
      "overrides/oddball.md": profile("claude"),
      "overrides/claude-reviewer.md": profile("codex", "model: special\n"),
      "overrides/codex-audit-only.md": profile("codex"),
    });
    const plan = planV5Upgrade(root);
    expect(plan.status).toBe("ready");
    for (const harness of ["agy", "claude", "codex", "grok", "muse"]) expect(plan.settings!.harnesses[harness]!.thinking).toBe("parent");
    expect(plan.settings!.harnesses.opencode!.thinking).toBe("native");
    expect(plan.settings!.harnesses.codex!.enabled).toBeUndefined();
    expect(plan.impact.disabledProfiles).toEqual(disabledProfiles);
    expect(plan.settings!.disabledProfiles).toEqual(["unknown-name"]);
    for (const role of ["explorer", "planner", "implementer", "reviewer", "qa", "worker"]) expect(plan.settings!.harnesses.codex!.roles![role]!.enabled).toBe(false);
    expect(plan.settings!.disabledHarnesses).toEqual(["muse", "pi-gone"]);
    expect(plan.settings!.harnesses.claude!.roles).toMatchObject({ reviewer: { enabled: false } });
    expect(plan.settings!.exact).toMatchObject({
      oddball: { harness: "claude", description: "Custom description", instructions: "Custom instructions.", model: "native", thinking: "parent", enabled: false },
      "claude-reviewer": { harness: "codex", model: "special", thinking: "parent" },
    });
    expect(plan.copies.some((copy: { destinationPath: string }) => copy.destinationPath === path(root, "overrides/codex/audit-only.md"))).toBe(true);
    expect(existsSync(path(root, "roles/audit-only.md"))).toBe(false);
    expect(applyV5Upgrade(root).status).toBe("applied");
    expect(existsSync(path(root, "roles/audit-only.md"))).toBe(false);
    write(root, "roles/future.md", "---\ndescription: Future role\n---\nFuture instructions.");
    const catalog = loadExternalCatalog(root);
    expect(catalog.profiles.get("codex/audit-only")).toMatchObject({ systemPrompt: "Custom instructions.", thinking: "parent" });
    expect(catalog.profiles.has("claude/audit-only")).toBe(false);
    expect(catalog.profiles.get("grok/future")).toMatchObject({ thinking: "parent", systemPrompt: "Future instructions." });
  });

  it("pins effective Pi defaults on exact records and preserves ambiguous identities without widening exact gates", () => {
    const root = fixture({ version: 4, disabledProfiles: ["pi-deep-seek-reviewer", "legacy-pi"],
      harnesses: { "pi-deep": { model: "p/first", thinking: "low" }, "pi-deep-seek": { model: "p/second", thinking: "high", preset: "skills" } } }, {
      "overrides/legacy-pi.md": profile("pi", "harness: pi-deep\n"),
      "overrides/pi-deep-seek-reviewer.md": profile("pi", "harness: pi-deep-seek\n", ""),
    });
    const plan = planV5Upgrade(root);
    expect(plan.diagnostics).toEqual([]);
    expect(plan.status).toBe("ready");
    expect(plan.settings!.exact).toMatchObject({
      "legacy-pi": { harness: "pi-deep", model: "p/first", thinking: "low", enabled: false },
      "pi-deep-seek-reviewer": { harness: "pi-deep-seek", model: "p/second", thinking: "high", instructions: "", enabled: false },
    });
    expect(plan.settings!.disabledProfiles).toBeUndefined();
    expect(plan.notes.join(' ')).toMatch(/exact.*Pi.*pin|Pi.*exact.*pin/i);
    expect(plan.settings!.harnesses["pi-deep-seek"]!.roles).toMatchObject({ reviewer: { enabled: false } });
    expect(plan.settings!.harnesses["pi-deep"]!.roles).toMatchObject({ "seek-reviewer": { enabled: false } });
    expect(applyV5Upgrade(root).status).toBe("applied");
    const catalog = loadExternalCatalog(root);
    expect(catalog.profiles.get("legacy-pi")).toMatchObject({ model: "p/first", thinking: "low", configurationError: expect.stringContaining("disabled") });
    expect(catalog.profiles.get("pi-deep-seek/reviewer")).toMatchObject({ systemPrompt: "", configurationError: expect.stringContaining("disabled") });
  });

  it("blocks conflicting copies, immutable backup collisions, symlinks and missing registrations", () => {
    for (const target of ["overrides/codex/worker.md", "settings.v4.backup.json"]) {
      const root = fixture({ version: 4 }, { "overrides/codex-worker.md": profile("codex"), [target]: "different" });
      expect(planV5Upgrade(root).status).toBe("blocked");
      expect(applyV5Upgrade(root).status).toBe("blocked");
      expect(JSON.parse(readFileSync(path(root, "settings.json"), "utf8")).version).toBe(4);
    }
    const root = fixture({ version: 4 }, { "overrides/pi-missing-worker.md": profile("pi", "harness: pi-missing\n") });
    expect(planV5Upgrade(root).diagnostics.join(" ")).toMatch(/pi-missing.*not registered/i);
    const linked = fixture();
    const outside = join(linked, "outside"); mkdirSync(outside);
    symlinkSync(outside, path(linked, "overrides"));
    expect(applyV5Upgrade(linked).status).toBe("blocked");
    expect(existsSync(join(outside, "codex"))).toBe(false);
  });

  it("accepts identical interrupted copies and never activates before all files install", () => {
    const root = fixture({ version: 4 }, { "overrides/codex-worker.md": profile("codex"), "overrides/claude-qa.md": profile("claude") });
    const plan = planV5Upgrade(root);
    const first = plan.copies[0]!;
    mkdirSync(dirname(first.destinationPath), { recursive: true }); writeFileSync(first.destinationPath, first.contents);
    const writer = vi.spyOn(settings, "saveExternalSettings").mockImplementationOnce(() => { throw new Error("activation interrupted"); });
    expect(applyV5Upgrade(root)).toMatchObject({ status: "blocked", diagnostics: [expect.stringContaining("activation interrupted")] });
    expect(JSON.parse(readFileSync(path(root, "settings.json"), "utf8")).version).toBe(4);
    for (const copy of plan.copies) expect(readFileSync(copy.destinationPath, "utf8")).toBe(copy.contents);
    writer.mockRestore();
    const backupTime = statSync(plan.backups[0]!.destinationPath).mtimeMs;
    expect(applyV5Upgrade(root).status).toBe("applied");
    expect(statSync(plan.backups[0]!.destinationPath).mtimeMs).toBe(backupTime);
  });

  it("leaves v4 active after a partial copy failure and resumes identical staged copies", async () => {
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    const root = fixture({ version: 4 }, { "overrides/codex-worker.md": profile("codex"), "overrides/claude-worker.md": profile("claude") });
    const plan = planV5Upgrade(root), last = plan.copies.at(-1)!;
    vi.mocked(linkSync).mockImplementation((source, target) => {
      if (String(target) === last.destinationPath) throw new Error("copy interrupted");
      actual.linkSync(source, target);
    });
    const partial = applyV5Upgrade(root);
    expect(partial).toMatchObject({ status: "blocked", diagnostics: [expect.stringContaining("copy interrupted")] });
    expect(partial.installedPaths).toContain(plan.copies[0]!.destinationPath);
    expect(existsSync(last.destinationPath)).toBe(false);
    expect(JSON.parse(readFileSync(path(root, "settings.json"), "utf8")).version).toBe(4);
    vi.mocked(linkSync).mockImplementation(actual.linkSync);
    expect(applyV5Upgrade(root).status).toBe("applied");
  });

  it("rejects stale previews and rechecks instruction, settings and inventory fingerprints after installing copies", async () => {
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    const stale = fixture();
    const preview = planV5Upgrade(stale);
    write(stale, "settings.json", JSON.stringify({ version: 4, maxRunRecords: 77 }));
    expect(applyV5Upgrade(stale, preview.sourceDigest).status).toBe("blocked");
    expect(JSON.parse(readFileSync(path(stale, "settings.json"), "utf8")).version).toBe(4);
    expect(existsSync(path(stale, "settings.v4.backup.json"))).toBe(false);
    for (const change of ["source", "settings", "inventory"]) {
      const root = fixture({ version: 4 }, { "overrides/codex-worker.md": profile("codex") });
      const original = readFileSync(path(root, "settings.json"), "utf8");
      let changed = false;
      vi.mocked(linkSync).mockImplementation((source, file) => {
        actual.linkSync(source, file);
        if (String(file) === path(root, "overrides/codex/worker.md") && !changed) {
          changed = true;
          if (change === "source") actual.writeFileSync(path(root, "overrides/codex-worker.md"), profile("codex", "", "Changed"));
          if (change === "settings") actual.writeFileSync(path(root, "settings.json"), JSON.stringify({ version: 4, maxRunRecords: 77 }));
          if (change === "inventory") actual.writeFileSync(path(root, "overrides/codex-qa.md"), profile("codex"));
        }
      });
      expect(applyV5Upgrade(root).status).toBe("blocked");
      expect(changed).toBe(true);
      expect(JSON.parse(readFileSync(path(root, "settings.json"), "utf8")).version).toBe(4);
      if (change !== "settings") expect(readFileSync(path(root, "settings.json"), "utf8")).toBe(original);
      vi.mocked(linkSync).mockImplementation(actual.linkSync);
    }
  });

  it("refuses malformed, unsupported and pre-v4 settings and invalid authored entries", () => {
    for (const document of [{ version: 3 }, { version: 6 }, { version: 4, maxConcurrentSubagents: 0 }, { version: 4, harnesses: { "pi-bad": { model: "missing-provider" } } }, { version: 4, defaultHarness: "pi-missing" },
      { version: 4, harnesses: { "pi-check": { model: "p/model", owner: 7 } } }]) {
      const root = fixture(document);
      const original = readFileSync(path(root, "settings.json"), "utf8");
      expect(planV5Upgrade(root).status).toBe("blocked");
      expect(applyV5Upgrade(root).status).toBe("blocked");
      expect(readFileSync(path(root, "settings.json"), "utf8")).toBe(original);
      expect(existsSync(path(root, "settings.v4.backup.json"))).toBe(false);
    }
    const malformed = fixture(); write(malformed, "settings.json", "{bad");
    expect(applyV5Upgrade(malformed).status).toBe("blocked");
    const nonUtf8 = fixture();
    const originalBytes = Buffer.concat([Buffer.from('{"version":4,"note":"'), Buffer.from([0xff]), Buffer.from('"}')]);
    writeFileSync(path(nonUtf8, "settings.json"), originalBytes);
    expect(applyV5Upgrade(nonUtf8).status).toBe("blocked");
    expect(readFileSync(path(nonUtf8, "settings.json"))).toEqual(originalBytes);
    for (const contents of [profile("unsupported"), profile("grok", "thinking: typo\n"), profile("codex", "permission: danger\n"), profile("codex", "max_budget_usd: -1\n")]) {
      const root = fixture({ version: 4 }, { "overrides/codex-worker.md": contents });
      expect(planV5Upgrade(root).status).toBe("blocked");
    }
  });

  it("leaves fresh installations and current v5 installations untouched", () => {
    const root = mkdtempSync(join(tmpdir(), "external-v5-empty-")); roots.push(root);
    expect(planV5Upgrade(root).status).toBe("empty");
    expect(applyV5Upgrade(root).status).toBe("empty");
    expect(existsSync(path(root, "settings.json"))).toBe(false);
    const current = fixture({ version: 5 });
    expect(planV5Upgrade(current).status).toBe("current");
    expect(applyV5Upgrade(current).status).toBe("current");
  });
});
