import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildDefaultProfile } from "../src/defaults.ts";
import {
  applyConfigUpgrade,
  planConfigUpgrade,
  planLegacyPurge,
  purgeLegacyFiles,
  type LegacyPurgeKind,
} from "../src/config-upgrade.ts";

const tempDirs: string[] = [];
const ROLES = ["explorer", "planner", "implementer", "reviewer", "qa", "worker"] as const;
const CLI = ["agy", "claude", "codex", "grok", "muse"] as const;

function tempAgentDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-flow-config-upgrade-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length) {
    const dir = tempDirs.pop()!;
    try {
      chmodSync(join(dir, "pi-flow-external"), 0o755);
    } catch {
      // The home directory is only locked in the activation-order case.
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

function write(root: string, rel: string, content: string): void {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

const HISTORICAL_SEED_PERMISSION: Record<string, "readonly" | "danger"> = {
  explorer: "readonly",
  planner: "readonly",
  implementer: "danger",
  reviewer: "readonly",
  qa: "danger",
  worker: "danger",
};

function seeded(name: string): string {
  const profile = buildDefaultProfile(name);
  const role = name.slice(name.indexOf("-") + 1);
  const permission = HISTORICAL_SEED_PERMISSION[role];
  if (!profile?.systemPrompt || !permission) throw new Error(`No seeded profile for ${name}`);
  const frontmatter = [
    `description: ${JSON.stringify(profile.description.trim())}`,
    `backend: ${profile.backend}`,
    `permission: ${JSON.stringify(permission)}`,
  ];
  return `---\n${frontmatter.join("\n")}\n---\n\n${profile.systemPrompt.trim()}\n`;
}

function identities(harnesses: readonly string[]): string[] {
  return harnesses.flatMap((harness) => ROLES.map((role) => `${harness}-${role}`)).sort((a, b) => a.localeCompare(b));
}

function custom(backend: string, extra = ""): string {
  return `---\ndescription: ${backend} notes.\nbackend: ${backend}\n${extra}---\n\nNotes for ${backend}.\n`;
}

function present(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function fingerprint(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const cases: Array<{ name: string; run: (agentDir: string) => void }> = [
  {
    name: "leaves a fresh directory untouched",
    run(agentDir) {
      expect(planConfigUpgrade(agentDir)).toMatchObject({ status: "empty", diagnostics: [], overrides: [] });
      expect(applyConfigUpgrade(agentDir).status).toBe("empty");
      expect(existsSync(join(agentDir, "pi-flow-external"))).toBe(false);
      expect(existsSync(join(agentDir, "subagents"))).toBe(false);
    },
  },
  {
    name: "leaves an active version 4 file and its legacy sources alone",
    run(agentDir) {
      const settings = {
        version: 4,
        defaultHarness: "claude",
        maxConcurrentSubagents: 12,
        subagentTimeoutMs: 7_200_000,
        defaultPermission: "danger",
        defaultMaxBudgetUsd: null,
        maxRunRecords: 200,
        harnesses: { "pi-kept": { model: "kept/model", thinking: "low" } },
        disabledProfiles: ["agy-worker"],
      };
      write(agentDir, "pi-flow-external/settings.json", `${JSON.stringify(settings, null, 2)}\n`);
      write(agentDir, "pi-flow-external/harnesses.json", `${JSON.stringify({ version: 1, harnesses: { "pi-other": { model: "other/model", thinking: "high" } } })}\n`);
      write(agentDir, "subagents/.pi-flow-defaults-seeded-v3", "");
      write(agentDir, "subagents/claude-notes.md", custom("claude"));
      const before = {
        settings: readFileSync(join(agentDir, "pi-flow-external/settings.json"), "utf8"),
        harnesses: readFileSync(join(agentDir, "pi-flow-external/harnesses.json"), "utf8"),
        profile: readFileSync(join(agentDir, "subagents/claude-notes.md"), "utf8"),
      };
      expect(planConfigUpgrade(agentDir).status).toBe("current");
      expect(applyConfigUpgrade(agentDir).status).toBe("current");
      expect(readFileSync(join(agentDir, "pi-flow-external/settings.json"), "utf8")).toBe(before.settings);
      expect(readFileSync(join(agentDir, "pi-flow-external/harnesses.json"), "utf8")).toBe(before.harnesses);
      expect(readFileSync(join(agentDir, "subagents/claude-notes.md"), "utf8")).toBe(before.profile);
      expect(existsSync(join(agentDir, "pi-flow-external/overrides/claude-notes.md"))).toBe(false);
    },
  },
  {
    name: "converts cohorts, raw-copies custom profiles, and keeps legacy files",
    run(agentDir) {
      for (const name of identities(CLI)) write(agentDir, `subagents/${name}.md`, seeded(name));
      rmSync(join(agentDir, "subagents/codex-explorer.md"));
      rmSync(join(agentDir, "subagents/muse-qa.md"));
      write(agentDir, "subagents/agy-worker.md", "---\ndescription: Native worker.\nbackend: pi\n---\n\nNative.\n");
      const modifiedReviewer = `${seeded("claude-reviewer")}Extra.\n`;
      write(agentDir, "subagents/claude-reviewer.md", modifiedReviewer);
      const reformattedExplorer = seeded("grok-explorer").replace('permission: "readonly"', "permission: readonly");
      write(agentDir, "subagents/grok-explorer.md", reformattedExplorer);
      const claudeNotes = "---\ndescription: claude notes.\nbackend: claude\nmodel: opus\ntools: read, grep\nmax_budget_usd: 1.5\n---\n\nNotes for claude.\n";
      write(agentDir, "subagents/claude-notes.md", claudeNotes);
      for (const backend of ["agy", "codex", "grok", "muse"] as const) {
        write(agentDir, `subagents/${backend}-notes.md`, custom(backend));
      }
      write(agentDir, "subagents/pi-deepseek-qa.md", "---\ndescription: DeepSeek qa.\nbackend: pi\nharness: pi-deepseek\n---\n\nUse deepseek.\n");
      write(agentDir, "subagents/pi-other-reviewer.md", "---\ndescription: Other reviewer.\nbackend: pi\nharness: pi-other\n---\n\nUse other.\n");
      write(agentDir, "subagents/exact-only.md", "---\ndescription: Exact only.\nbackend: muse\n---\n\nExact body.\n");
      write(agentDir, "subagents/scout.md", "---\ndescription: Native scout.\n---\n\nLook around.\n");
      write(agentDir, "subagents/nested/claude-explorer.md", "nested\n");
      for (const marker of ["v1", "v2", "v3"]) write(agentDir, `subagents/.pi-flow-defaults-seeded-${marker}`, "");
      write(agentDir, "pi-flow-external/harnesses.json", `${JSON.stringify({
        version: 1,
        harnesses: { "pi-deepseek": { model: "deepseek/deepseek-chat", thinking: "high", owner: "user" } },
      }, null, 2)}\n`);
      write(agentDir, "pi-flow-external/settings.json", `${JSON.stringify({
        version: 3,
        defaultHarness: "pi-deepseek",
        maxConcurrentSubagents: 4,
        subagentTimeoutMs: 5000,
        defaultPermission: "readonly",
        defaultMaxBudgetUsd: 2.5,
        maxRunRecords: 7,
        note: "kept",
      }, null, 2)}\n`);

      const legacyBefore = {
        harnesses: readFileSync(join(agentDir, "pi-flow-external/harnesses.json"), "utf8"),
        reviewer: readFileSync(join(agentDir, "subagents/claude-reviewer.md"), "utf8"),
        marker: readFileSync(join(agentDir, "subagents/.pi-flow-defaults-seeded-v3"), "utf8"),
        nested: readFileSync(join(agentDir, "subagents/nested/claude-explorer.md"), "utf8"),
        scout: readFileSync(join(agentDir, "subagents/scout.md"), "utf8"),
      };
      write(agentDir, "subagents/claude-qa.md", "---\ndescription: Mismatched qa.\nbackend: grok\n---\n\nNot Claude.\n");
      const plan = planConfigUpgrade(agentDir);
      expect(plan.diagnostics, plan.diagnostics.join("\n")).toEqual([]);
      expect(plan.status).toBe("ready");
      expect(plan.disabledProfiles).toEqual(["agy-worker", "codex-explorer", "muse-qa"]);
      expect(plan.unchangedDefaults).toEqual(identities(CLI).filter((name) => !["codex-explorer", "muse-qa", "agy-worker", "claude-qa", "claude-reviewer", "grok-explorer"].includes(name)).sort((a, b) => a.localeCompare(b)));
      expect(plan.excludedProfiles).toEqual(["agy-worker", "scout"]);
      expect(plan.overrides.map((override) => [override.name, override.reason]).sort()).toEqual([
        ["agy-notes", "custom-cli"],
        ["claude-notes", "custom-cli"],
        ["claude-qa", "nonstandard"],
        ["claude-reviewer", "modified-default"],
        ["codex-notes", "custom-cli"],
        ["exact-only", "nonstandard"],
        ["grok-explorer", "modified-default"],
        ["grok-notes", "custom-cli"],
        ["muse-notes", "custom-cli"],
        ["pi-deepseek-qa", "named-pi"],
        ["pi-other-reviewer", "named-pi"],
      ]);
      expect(plan.preservedFields).toEqual({ note: "kept" });

      const applied = applyConfigUpgrade(agentDir);
      expect(applied.status).toBe("applied");
      expect(applied.disabledProfiles).toEqual(["agy-worker", "codex-explorer", "muse-qa"]);
      expect(applied.settings).toMatchObject({
        version: 4,
        defaultHarness: "pi-deepseek",
        maxConcurrentSubagents: 4,
        subagentTimeoutMs: 5000,
        defaultPermission: "readonly",
        defaultMaxBudgetUsd: 2.5,
        maxRunRecords: 7,
        harnesses: { "pi-deepseek": { model: "deepseek/deepseek-chat", thinking: "high", owner: "user" } },
        disabledProfiles: ["agy-worker", "codex-explorer", "muse-qa"],
      });
      const settingsText = readFileSync(applied.settingsPath, "utf8");
      expect(JSON.parse(settingsText).harnesses["pi-deepseek"].preset).toBe("minimal");
      expect(Object.keys(JSON.parse(settingsText))).toEqual([
        "version",
        "defaultHarness",
        "maxConcurrentSubagents",
        "subagentTimeoutMs",
        "defaultPermission",
        "defaultMaxBudgetUsd",
        "maxRunRecords",
        "harnesses",
        "disabledProfiles",
        "note",
      ]);
      expect(statSync(applied.settingsPath).mode & 0o777).toBe(0o600);
      for (const override of plan.overrides) {
        const source = readFileSync(override.sourcePath, "utf8");
        const installed = readFileSync(override.destinationPath, "utf8");
        expect(installed).toBe(override.contents);
        expect(installed).not.toMatch(/^permission:/m);
        expect(installed).not.toMatch(/^capabilitySet:/m);
        if (!/^permission:/m.test(source) && !/^capabilitySet:/m.test(source)) {
          expect(installed).toBe(source);
        }
      }
      expect(statSync(join(agentDir, "pi-flow-external/overrides/claude-notes.md")).mode & 0o777).toBe(0o600);
      expect(readFileSync(join(agentDir, "pi-flow-external/harnesses.json"), "utf8")).toBe(legacyBefore.harnesses);
      expect(readFileSync(join(agentDir, "subagents/claude-reviewer.md"), "utf8")).toBe(legacyBefore.reviewer);
      expect(readFileSync(join(agentDir, "subagents/.pi-flow-defaults-seeded-v3"), "utf8")).toBe(legacyBefore.marker);
      expect(readFileSync(join(agentDir, "subagents/nested/claude-explorer.md"), "utf8")).toBe(legacyBefore.nested);
      expect(readFileSync(join(agentDir, "subagents/scout.md"), "utf8")).toBe(legacyBefore.scout);
      expect(existsSync(join(agentDir, "subagents/codex-explorer.md"))).toBe(false);
      expect(existsSync(join(agentDir, "pi-flow-external/overrides/agy-explorer.md"))).toBe(false);
      expect(existsSync(join(agentDir, "pi-flow-external/overrides/scout.md"))).toBe(false);
      expect(existsSync(join(agentDir, "pi-flow-external/roles"))).toBe(false);

      const again = applyConfigUpgrade(agentDir);
      expect(again.status).toBe("current");
      expect(readFileSync(applied.settingsPath, "utf8")).toBe(settingsText);
    },
  },
  {
    name: "records only the v1 seed cohort as disabled",
    run(agentDir) {
      write(agentDir, "pi-flow-external/settings.json", `${JSON.stringify({ version: 1, maxConcurrentSubagents: 3 })}\n`);
      write(agentDir, "subagents/.pi-flow-defaults-seeded-v1", "");
      const applied = applyConfigUpgrade(agentDir);
      expect(applied.status).toBe("applied");
      expect(applied.disabledProfiles).toEqual(identities(["agy", "claude", "codex"]));
      expect(applied.settings).toMatchObject({
        version: 4,
        defaultHarness: "agy",
        maxConcurrentSubagents: 3,
        subagentTimeoutMs: 7_200_000,
        defaultPermission: "danger",
        defaultMaxBudgetUsd: null,
        maxRunRecords: 200,
      });
      expect(applied.settings?.harnesses).toBeUndefined();
      expect(Object.keys(JSON.parse(readFileSync(applied.settingsPath, "utf8")))).toEqual([
        "version",
        "defaultHarness",
        "maxConcurrentSubagents",
        "subagentTimeoutMs",
        "defaultPermission",
        "defaultMaxBudgetUsd",
        "maxRunRecords",
        "disabledProfiles",
      ]);
      expect(existsSync(join(agentDir, "pi-flow-external/overrides"))).toBe(false);
      expect(existsSync(join(agentDir, "subagents/.pi-flow-defaults-seeded-v1"))).toBe(true);
    },
  },
  {
    name: "records the v2 cohort through grok when settings are absent",
    run(agentDir) {
      write(agentDir, "subagents/.pi-flow-defaults-seeded-v2", "");
      const applied = applyConfigUpgrade(agentDir);
      expect(applied.status).toBe("applied");
      expect(applied.disabledProfiles).toEqual(identities(["agy", "claude", "codex", "grok"]));
      expect(applied.settings).toMatchObject({ version: 4, defaultHarness: "agy", maxRunRecords: 200 });
      expect(existsSync(join(agentDir, "pi-flow-external/overrides"))).toBe(false);
      expect(existsSync(join(agentDir, "pi-flow-external/harnesses.json"))).toBe(false);
      expect(existsSync(join(agentDir, "subagents/.pi-flow-defaults-seeded-v2"))).toBe(true);
    },
  },
  {
    name: "blocks malformed settings without writing",
    run(agentDir) {
      write(agentDir, "pi-flow-external/settings.json", "{");
      expect(planConfigUpgrade(agentDir).status).toBe("blocked");
      expect(applyConfigUpgrade(agentDir).status).toBe("blocked");
      expect(readFileSync(join(agentDir, "pi-flow-external/settings.json"), "utf8")).toBe("{");
      expect(existsSync(join(agentDir, "pi-flow-external/overrides"))).toBe(false);
    },
  },
  {
    name: "blocks invalid settings fields without substituting defaults",
    run(agentDir) {
      const body = `${JSON.stringify({ version: 3, defaultHarness: "gemini", maxConcurrentSubagents: 0 })}\n`;
      write(agentDir, "pi-flow-external/settings.json", body);
      const plan = planConfigUpgrade(agentDir);
      expect(plan.status).toBe("blocked");
      expect(plan.diagnostics.join("\n")).toMatch(/defaultHarness/);
      expect(plan.diagnostics.join("\n")).toMatch(/maxConcurrentSubagents/);
      expect(applyConfigUpgrade(agentDir).status).toBe("blocked");
      expect(readFileSync(join(agentDir, "pi-flow-external/settings.json"), "utf8")).toBe(body);
    },
  },
  {
    name: "leaves a future settings version in place",
    run(agentDir) {
      const body = `${JSON.stringify({ version: 9, defaultHarness: "agy" })}\n`;
      write(agentDir, "pi-flow-external/settings.json", body);
      expect(planConfigUpgrade(agentDir).status).toBe("blocked");
      expect(applyConfigUpgrade(agentDir).status).toBe("blocked");
      expect(readFileSync(join(agentDir, "pi-flow-external/settings.json"), "utf8")).toBe(body);
    },
  },
  {
    name: "blocks a malformed harness registry",
    run(agentDir) {
      const settings = `${JSON.stringify({ version: 2, defaultHarness: "codex" })}\n`;
      write(agentDir, "pi-flow-external/settings.json", settings);
      write(agentDir, "pi-flow-external/harnesses.json", JSON.stringify({
        version: 1,
        extra: true,
        harnesses: {
          "pi-deepseek": { model: "deepseek/deepseek-chat", thinking: "high", tier: 1 },
          "pi-bare": { model: "noslash", thinking: "off" },
          nope: { model: "x" },
        },
      }));
      const plan = planConfigUpgrade(agentDir);
      expect(plan.status).toBe("blocked");
      expect(plan.diagnostics.join("\n")).toMatch(/unsupported field "extra"/);
      expect(plan.diagnostics.join("\n")).toMatch(/unsupported field "tier"/);
      expect(plan.diagnostics.join("\n")).toMatch(/Harness "nope"/);
      expect(plan.diagnostics.join("\n")).toMatch(/pi-bare/);
      expect(applyConfigUpgrade(agentDir).status).toBe("blocked");
      expect(readFileSync(join(agentDir, "pi-flow-external/settings.json"), "utf8")).toBe(settings);
    },
  },
  {
    name: "blocks an unparseable legacy profile",
    run(agentDir) {
      const settings = `${JSON.stringify({ version: 3 })}\n`;
      write(agentDir, "pi-flow-external/settings.json", settings);
      write(agentDir, "subagents/claude-custom.md", "nope\n");
      const plan = planConfigUpgrade(agentDir);
      expect(plan.status).toBe("blocked");
      expect(plan.diagnostics.join("\n")).toMatch(/claude-custom\.md/);
      expect(applyConfigUpgrade(agentDir).status).toBe("blocked");
      expect(readFileSync(join(agentDir, "pi-flow-external/settings.json"), "utf8")).toBe(settings);
      expect(existsSync(join(agentDir, "pi-flow-external/overrides"))).toBe(false);
    },
  },
  {
    name: "blocks a non-regular legacy profile",
    run(agentDir) {
      const settings = `${JSON.stringify({ version: 3 })}\n`;
      write(agentDir, "pi-flow-external/settings.json", settings);
      write(agentDir, "subagents/target.md", "---\ndescription: Target.\n---\n\nBody.\n");
      symlinkSync("target.md", join(agentDir, "subagents/claude-notes.md"));
      expect(planConfigUpgrade(agentDir).diagnostics.join("\n")).toMatch(/regular file/);
      expect(applyConfigUpgrade(agentDir).status).toBe("blocked");
      expect(readFileSync(join(agentDir, "pi-flow-external/settings.json"), "utf8")).toBe(settings);
    },
  },
  {
    name: "rejects a differing override collision and keeps the previous settings",
    run(agentDir) {
      const settings = `${JSON.stringify({ version: 3, defaultHarness: "agy" })}\n`;
      const source = custom("claude");
      write(agentDir, "pi-flow-external/settings.json", settings);
      write(agentDir, "subagents/claude-notes.md", source);
      write(agentDir, "pi-flow-external/overrides/claude-notes.md", "different\n");
      expect(planConfigUpgrade(agentDir).diagnostics.join("\n")).toMatch(/differs/);
      expect(applyConfigUpgrade(agentDir).status).toBe("blocked");
      expect(readFileSync(join(agentDir, "pi-flow-external/settings.json"), "utf8")).toBe(settings);
      expect(readFileSync(join(agentDir, "pi-flow-external/overrides/claude-notes.md"), "utf8")).toBe("different\n");
      expect(readFileSync(join(agentDir, "subagents/claude-notes.md"), "utf8")).toBe(source);
    },
  },
  {
    name: "accepts identical override copies from an interrupted activation",
    run(agentDir) {
      const agy = custom("agy");
      const claude = custom("claude");
      write(agentDir, "pi-flow-external/settings.json", `${JSON.stringify({ version: 3 })}\n`);
      write(agentDir, "subagents/agy-notes.md", agy);
      write(agentDir, "subagents/claude-notes.md", claude);
      write(agentDir, "pi-flow-external/overrides/agy-notes.md", agy);
      const agyOverride = join(agentDir, "pi-flow-external/overrides/agy-notes.md");
      const mtime = statSync(agyOverride, { bigint: true }).mtimeNs;
      const applied = applyConfigUpgrade(agentDir);
      expect(applied.status).toBe("applied");
      expect(statSync(agyOverride, { bigint: true }).mtimeNs).toBe(mtime);
      expect(readFileSync(join(agentDir, "pi-flow-external/overrides/agy-notes.md"), "utf8")).toBe(agy);
      expect(readFileSync(join(agentDir, "pi-flow-external/overrides/claude-notes.md"), "utf8")).toBe(claude);
      expect(JSON.parse(readFileSync(applied.settingsPath, "utf8")).version).toBe(4);
      expect(readFileSync(join(agentDir, "subagents/agy-notes.md"), "utf8")).toBe(agy);
    },
  },
  {
    name: "converts a pi-* template into a cross-harness role and drops obsolete settings",
    run(agentDir) {
      write(agentDir, "pi-flow-external/settings.json", `${JSON.stringify({
        version: 3,
        defaultHarness: "agy",
        piCapabilitySets: { docs: { skills: ["writer"], promptTemplates: [] } },
      })}\n`);
      const template = [
        "---",
        "description: Security review.",
        "backend: pi",
        'harness: "pi-*"',
        'permission: "readonly"',
        'capabilitySet: "docs"',
        "---",
        "",
        "Review the diff.",
        "",
      ].join("\n");
      write(agentDir, "subagents/pi-security-reviewer.md", template);
      const plan = planConfigUpgrade(agentDir);
      expect(plan.status, plan.diagnostics.join("\n")).toBe("ready");
      expect(plan.overrides).toEqual([]);
      expect(plan.roles.map((role) => role.name)).toEqual(["security-reviewer"]);
      expect(plan.notes.join("\n")).toMatch(/cross-harness/);
      expect(plan.notes.join("\n")).toMatch(/piCapabilitySets/);
      expect(plan.preservedFields).toEqual({});
      const applied = applyConfigUpgrade(agentDir);
      expect(applied.status, applied.diagnostics.join("\n")).toBe("applied");
      const role = readFileSync(join(agentDir, "pi-flow-external/roles/security-reviewer.md"), "utf8");
      expect(role).toBe('---\ndescription: "Security review."\n---\n\nReview the diff.\n');
      expect(role).not.toContain("capabilitySet");
      expect(role).not.toContain("permission");
      expect(role).not.toContain("backend");
      expect(JSON.parse(readFileSync(applied.settingsPath, "utf8")).piCapabilitySets).toBeUndefined();
      expect(readFileSync(join(agentDir, "subagents/pi-security-reviewer.md"), "utf8")).toBe(template);
    },
  },
];

describe("configuration upgrade", () => {
  it.each(cases)("$name", ({ run }) => {
    run(tempAgentDir());
  });

  it("installs override copies before it activates settings version 4", () => {
    const agentDir = tempAgentDir();
    const home = join(agentDir, "pi-flow-external");
    const overrides = join(home, "overrides");
    const source = custom("claude");
    mkdirSync(overrides, { recursive: true });
    write(agentDir, "pi-flow-external/settings.json", `${JSON.stringify({ version: 3, defaultHarness: "agy" })}\n`);
    write(agentDir, "subagents/claude-notes.md", source);
    chmodSync(home, 0o555);
    try {
      const result = applyConfigUpgrade(agentDir);
      expect(result.status).toBe("blocked");
      expect(result.overridesInstalled).toEqual([join(overrides, "claude-notes.md")]);
      expect(result.diagnostics.join(" ")).toMatch(/not activated|EACCES|permission denied/i);
      expect(JSON.parse(readFileSync(join(home, "settings.json"), "utf8")).version).toBe(3);
      expect(readFileSync(join(overrides, "claude-notes.md"), "utf8")).toBe(source);
    } finally {
      chmodSync(home, 0o755);
    }
  });
});

describe("legacy purge", () => {
  it("purges the legacy inventory and leaves everything else in place", () => {
    const agentDir = tempAgentDir();
    const claudeSecurity = custom("claude", "model: opus\n");
    const museSecurity = custom("muse");
    const piQa = "---\ndescription: DeepSeek qa.\nbackend: pi\nharness: pi-deepseek\n---\n\nUse deepseek.\n";
    const codexReviewer = `${seeded("codex-reviewer")}Custom review.\n`;
    const notes = "---\ndescription: Exact notes.\nbackend: agy\n---\n\nExact.\n";
    write(agentDir, "pi-flow-external/settings.json", `${JSON.stringify({ version: 3, defaultHarness: "agy" })}\n`);
    write(agentDir, "pi-flow-external/harnesses.json", `${JSON.stringify({ version: 1, harnesses: { "pi-other": { model: "other/model", thinking: "off" } } })}\n`);
    write(agentDir, "pi-flow-external/overrides/claude-security.md", claudeSecurity);
    write(agentDir, "pi-flow-external/overrides/muse-security.md", "stale override\n");
    write(agentDir, "pi-flow-external/overrides/pi-deepseek-qa.md", piQa);
    write(agentDir, "pi-flow-external/roles/security.md", "role\n");
    write(agentDir, "pi-flow-external/runs/summary.json", "{}\n");
    write(agentDir, ".pi/pi-flow-external/settings.json", "{}\n");
    for (const marker of ["v1", "v2", "v3"]) write(agentDir, `subagents/.pi-flow-defaults-seeded-${marker}`, "");
    write(agentDir, "subagents/agy-explorer.md", seeded("agy-explorer"));
    write(agentDir, "subagents/agy-implementer.md", seeded("agy-implementer"));
    write(agentDir, "subagents/claude-explorer.md", "---\ndescription: Native explorer.\nbackend: pi\n---\n\nNative.\n");
    write(agentDir, "subagents/claude-reviewer.md", "---\ndescription: Mismatched reviewer.\nbackend: grok\n---\n\nNot Claude.\n");
    write(agentDir, "subagents/claude-security.md", claudeSecurity);
    write(agentDir, "subagents/codex-reviewer.md", codexReviewer);
    write(agentDir, "subagents/grok-planner.md", seeded("grok-planner"));
    write(agentDir, "subagents/muse-security.md", museSecurity);
    write(agentDir, "subagents/pi-deepseek-qa.md", piQa);
    write(agentDir, "subagents/pi-auditor.md", "---\ndescription: Audit.\nbackend: pi\nharness: \"pi-*\"\n---\n\nAudit the diff.\n");
    write(agentDir, "subagents/scout.md", "---\ndescription: Native scout.\n---\n\nLook around.\n");
    write(agentDir, "subagents/notes.md", notes);
    write(agentDir, "subagents/nested/codex-explorer.md", seeded("codex-explorer"));
    mkdirSync(join(agentDir, "subagents/codex-qa.md"));
    write(agentDir, "subagents/codex-qa.md/hidden.md", "hidden\n");
    symlinkSync("agy-explorer.md", join(agentDir, "subagents/link.md"));

    const marker = join(agentDir, "subagents/.pi-flow-defaults-seeded-v1");
    expect(planLegacyPurge(agentDir)).toMatchObject({ status: "blocked", candidates: [] });
    const blocked = purgeLegacyFiles(agentDir, [{ path: marker, fingerprint: "abc" }]);
    expect(blocked).toMatchObject({ status: "blocked", deleted: [] });
    expect(present(marker)).toBe(true);

    write(agentDir, "pi-flow-external/settings.json", '{"version":4}\n');
    const rows: Array<{ relativePath: string; kind?: LegacyPurgeKind; inventory?: boolean; copied?: boolean; outcome: "deleted" | "kept" | "changed" }> = [
      { relativePath: ".pi/pi-flow-external/settings.json", outcome: "kept" },
      { relativePath: "pi-flow-external/harnesses.json", kind: "harness-registry", inventory: true, copied: false, outcome: "deleted" },
      { relativePath: "pi-flow-external/overrides/claude-security.md", outcome: "kept" },
      { relativePath: "pi-flow-external/overrides/muse-security.md", outcome: "kept" },
      { relativePath: "pi-flow-external/overrides/pi-deepseek-qa.md", outcome: "kept" },
      { relativePath: "pi-flow-external/roles/security.md", outcome: "kept" },
      { relativePath: "pi-flow-external/runs/summary.json", outcome: "kept" },
      { relativePath: "pi-flow-external/settings.json", outcome: "kept" },
      { relativePath: "subagents/.pi-flow-defaults-seeded-v1", kind: "seed-marker", inventory: true, copied: false, outcome: "deleted" },
      { relativePath: "subagents/.pi-flow-defaults-seeded-v2", kind: "seed-marker", inventory: true, copied: false, outcome: "deleted" },
      { relativePath: "subagents/.pi-flow-defaults-seeded-v3", kind: "seed-marker", inventory: true, copied: false, outcome: "deleted" },
      { relativePath: "subagents/agy-explorer.md", kind: "seeded-profile", inventory: true, copied: false, outcome: "deleted" },
      { relativePath: "subagents/agy-implementer.md", kind: "seeded-profile", inventory: true, copied: false, outcome: "changed" },
      { relativePath: "subagents/claude-explorer.md", outcome: "kept" },
      { relativePath: "subagents/claude-reviewer.md", kind: "nonstandard-profile", inventory: false, copied: false, outcome: "kept" },
      { relativePath: "subagents/claude-security.md", kind: "custom-cli-profile", inventory: true, copied: true, outcome: "deleted" },
      { relativePath: "subagents/codex-qa.md", outcome: "kept" },
      { relativePath: "subagents/codex-qa.md/hidden.md", outcome: "kept" },
      { relativePath: "subagents/codex-reviewer.md", kind: "seeded-profile", inventory: true, copied: false, outcome: "deleted" },
      { relativePath: "subagents/grok-planner.md", kind: "seeded-profile", inventory: true, copied: false, outcome: "deleted" },
      { relativePath: "subagents/link.md", outcome: "kept" },
      { relativePath: "subagents/muse-security.md", kind: "custom-cli-profile", inventory: true, copied: false, outcome: "deleted" },
      { relativePath: "subagents/nested/codex-explorer.md", outcome: "kept" },
      { relativePath: "subagents/notes.md", kind: "nonstandard-profile", inventory: false, copied: false, outcome: "kept" },
      { relativePath: "subagents/pi-auditor.md", kind: "shared-pi-template", inventory: true, copied: false, outcome: "deleted" },
      { relativePath: "subagents/pi-deepseek-qa.md", kind: "named-pi-profile", inventory: true, copied: true, outcome: "deleted" },
      { relativePath: "subagents/scout.md", outcome: "kept" },
    ];

    const preview = planLegacyPurge(agentDir);
    expect(preview.status).toBe("ready");
    for (const row of rows) {
      const found = preview.candidates.find((candidate) => candidate.relativePath === row.relativePath);
      if (row.kind) expect(found, row.relativePath).toMatchObject({ kind: row.kind, inventory: row.inventory, copied: row.copied });
      else expect(found, row.relativePath).toBeUndefined();
    }

    write(agentDir, "subagents/agy-implementer.md", `${seeded("agy-implementer")}changed after preview\n`);
    const outsideRoot = tempAgentDir();
    const outside = join(outsideRoot, "secret.md");
    writeFileSync(outside, "keep\n");
    const settingsPath = join(agentDir, "pi-flow-external/settings.json");
    const scoutPath = join(agentDir, "subagents/scout.md");
    const linkPath = join(agentDir, "subagents/link.md");
    const inventory = preview.candidates.filter((candidate) => candidate.inventory);
    const selections = [
      ...inventory,
      { path: settingsPath, fingerprint: fingerprint(settingsPath) },
      { path: scoutPath, fingerprint: fingerprint(scoutPath) },
      { path: outside, fingerprint: fingerprint(outside) },
      { path: linkPath, fingerprint: "unused" },
    ];
    const report = purgeLegacyFiles(agentDir, selections);
    expect(report.status).toBe("purged");
    expect(report.failed).toEqual([]);
    expect(report.deleted.map((path) => relative(agentDir, path)).sort()).toEqual(rows.filter((row) => row.outcome === "deleted").map((row) => row.relativePath).sort());
    for (const row of rows) {
      expect(present(join(agentDir, row.relativePath)), row.relativePath).toBe(row.outcome !== "deleted");
    }
    expect(report.skipped).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: "changed-since-preview" }),
      expect.objectContaining({ path: settingsPath, reason: "outside-inventory" }),
      expect.objectContaining({ path: scoutPath, reason: "outside-inventory" }),
      expect.objectContaining({ path: outside, reason: "outside-inventory" }),
      expect.objectContaining({ path: linkPath, reason: "not-regular" }),
    ]));
    expect(readFileSync(settingsPath, "utf8")).toBe('{"version":4}\n');
    expect(readFileSync(join(agentDir, "subagents/agy-implementer.md"), "utf8")).toContain("changed after preview");
    expect(existsSync(join(agentDir, "subagents"))).toBe(true);

    const repeat = purgeLegacyFiles(agentDir, selections);
    expect(repeat).toMatchObject({ status: "purged", deleted: [], failed: [] });
    expect(repeat.skipped.some((item) => item.reason === "already-absent")).toBe(true);
    expect(repeat.skipped.some((item) => item.reason === "changed-since-preview")).toBe(true);
    expect(present(join(agentDir, "subagents/agy-implementer.md"))).toBe(true);
    expect(present(outside)).toBe(true);

    const later = planLegacyPurge(agentDir);
    const explicit = later.candidates.find((candidate) => candidate.relativePath === "subagents/notes.md");
    expect(explicit).toMatchObject({ kind: "nonstandard-profile", inventory: false });
    const removed = purgeLegacyFiles(agentDir, [explicit!]);
    expect(removed.deleted.map((path) => relative(agentDir, path))).toEqual(["subagents/notes.md"]);
    expect(present(join(agentDir, "subagents/notes.md"))).toBe(false);
    expect(purgeLegacyFiles(agentDir, [explicit!])).toMatchObject({
      deleted: [],
      skipped: [{ path: explicit!.path, reason: "already-absent" }],
    });
  });
});
