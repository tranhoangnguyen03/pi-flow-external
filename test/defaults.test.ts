import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildDefaultProfile, defaultProfileNames, seedDefaultProfiles } from "../src/defaults.ts";
import { compileProfile } from "../src/profile-creator.ts";
import { filterExternalAgentProfiles, getSubagentProfiles, parseSubagentProfileContent } from "../src/profiles.ts";

const tempDirs: string[] = [];

function tempAgentDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-flow-defaults-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("default profile seeding", () => {
  it("seeds the six-role roster (five code roles + worker) once, as valid external profiles", () => {
    const agentDir = tempAgentDir();
    const first = seedDefaultProfiles(agentDir);

    expect(first.seeded).toBe(true);
    expect([...first.added].sort()).toEqual(defaultProfileNames().sort());
    expect(defaultProfileNames()).toHaveLength(30);

    const profiles = filterExternalAgentProfiles(getSubagentProfiles(agentDir));
    expect(profiles.size).toBe(30);
    for (const name of defaultProfileNames()) {
      const profile = profiles.get(name);
      expect(profile, name).toBeDefined();
      const expected = buildDefaultProfile(name);
      expect(profile?.permission, name).toBe(expected?.permission);
      expect(profile?.description, name).toBe(expected?.description);
      expect(profile?.model, name).toBeUndefined();
    }
    expect(profiles.get("claude-explorer")?.permission).toBe("readonly");
    expect(profiles.get("claude-qa")?.permission).toBe("danger");
    expect(profiles.get("agy-worker")?.description).toContain("Antigravity");
    expect(profiles.get("grok-explorer")?.permission).toBe("readonly");
    expect(profiles.get("grok-qa")?.permission).toBe("danger");
    expect(profiles.get("grok-worker")?.description).toContain("Grok CLI");
    expect(profiles.get("muse-explorer")?.permission).toBe("readonly");
    expect(profiles.get("muse-qa")?.permission).toBe("danger");
    expect(profiles.get("muse-worker")?.description).toContain("Muse Code");
    expect(existsSync(join(agentDir, "subagents", ".pi-flow-defaults-seeded-v3"))).toBe(true);

    const second = seedDefaultProfiles(agentDir);
    expect(second).toEqual({ seeded: false, added: [] });
  });

  it("never overwrites existing profiles, and user deletions stay deleted", () => {
    const agentDir = tempAgentDir();
    const dir = join(agentDir, "subagents");
    mkdirSync(dir, { recursive: true });
    const custom = "---\ndescription: Mine.\nbackend: claude\n---\nMy custom explorer.\n";
    writeFileSync(join(dir, "claude-explorer.md"), custom, "utf8");

    const first = seedDefaultProfiles(agentDir);
    expect(first.seeded).toBe(true);
    expect(first.added).not.toContain("claude-explorer");
    expect(readFileSync(join(dir, "claude-explorer.md"), "utf8")).toBe(custom);

    rmSync(join(dir, "codex-worker.md"));
    const second = seedDefaultProfiles(agentDir);
    expect(second.seeded).toBe(false);
    expect(existsSync(join(dir, "codex-worker.md"))).toBe(false);
  });

  it("migrates a v1-only install straight to v3 by adding missing grok and muse profiles without resurrecting deleted profiles", () => {
    const agentDir = tempAgentDir();
    const dir = join(agentDir, "subagents");
    mkdirSync(dir, { recursive: true });

    // Simulate an existing v1 installation (never seeded through v2) where the
    // user deleted claude-worker and codex-qa, and already created a custom
    // grok-explorer profile.
    writeFileSync(join(dir, ".pi-flow-defaults-seeded-v1"), "", "utf8");
    writeFileSync(join(dir, "claude-explorer.md"), "---\ndescription: Claude explorer.\nbackend: claude\n---\nExplore.\n", "utf8");
    const customGrokExplorer = "---\ndescription: Custom Grok explorer.\nbackend: grok\n---\nCustom grok explore.\n";
    writeFileSync(join(dir, "grok-explorer.md"), customGrokExplorer, "utf8");

    const migration = seedDefaultProfiles(agentDir);
    expect(migration.seeded).toBe(true);

    // Only missing grok-* and muse-* profiles are added
    const expectedAdded = [
      "grok-planner",
      "grok-implementer",
      "grok-reviewer",
      "grok-qa",
      "grok-worker",
      "muse-explorer",
      "muse-planner",
      "muse-implementer",
      "muse-reviewer",
      "muse-qa",
      "muse-worker",
    ];
    expect([...migration.added].sort()).toEqual(expectedAdded.sort());

    // Never overwrite existing custom grok profile
    expect(migration.added).not.toContain("grok-explorer");
    expect(readFileSync(join(dir, "grok-explorer.md"), "utf8")).toBe(customGrokExplorer);

    // Deleted claude/codex/agy profiles are NOT resurrected
    expect(existsSync(join(dir, "claude-worker.md"))).toBe(false);
    expect(existsSync(join(dir, "codex-qa.md"))).toBe(false);
    expect(migration.added).not.toContain("claude-worker");
    expect(migration.added).not.toContain("codex-qa");

    // v3 marker is written
    expect(existsSync(join(dir, ".pi-flow-defaults-seeded-v3"))).toBe(true);

    // Subsequent calls are idempotent
    const rerun = seedDefaultProfiles(agentDir);
    expect(rerun).toEqual({ seeded: false, added: [] });
  });

  it("migrates v2 marker to v3 by adding only missing muse profiles without resurrecting deleted profiles", () => {
    const agentDir = tempAgentDir();
    const dir = join(agentDir, "subagents");
    mkdirSync(dir, { recursive: true });

    // Simulate an existing v2 installation (already seeded grok) where the
    // user deleted grok-worker and already created a custom muse-explorer profile.
    writeFileSync(join(dir, ".pi-flow-defaults-seeded-v1"), "", "utf8");
    writeFileSync(join(dir, ".pi-flow-defaults-seeded-v2"), "", "utf8");
    writeFileSync(join(dir, "grok-explorer.md"), "---\ndescription: Grok explorer.\nbackend: grok\n---\nExplore.\n", "utf8");
    const customMuseExplorer = "---\ndescription: Custom Muse explorer.\nbackend: muse\n---\nCustom muse explore.\n";
    writeFileSync(join(dir, "muse-explorer.md"), customMuseExplorer, "utf8");

    const migration = seedDefaultProfiles(agentDir);
    expect(migration.seeded).toBe(true);

    const expectedAdded = ["muse-planner", "muse-implementer", "muse-reviewer", "muse-qa", "muse-worker"];
    expect([...migration.added].sort()).toEqual(expectedAdded.sort());

    expect(migration.added).not.toContain("muse-explorer");
    expect(readFileSync(join(dir, "muse-explorer.md"), "utf8")).toBe(customMuseExplorer);

    expect(existsSync(join(dir, "grok-worker.md"))).toBe(false);
    expect(migration.added).not.toContain("grok-worker");

    expect(existsSync(join(dir, ".pi-flow-defaults-seeded-v3"))).toBe(true);

    const rerun = seedDefaultProfiles(agentDir);
    expect(rerun).toEqual({ seeded: false, added: [] });
  });
});

describe("default profile content", () => {
  it("compiles every default through the same validator as created profiles", () => {
    for (const name of defaultProfileNames()) {
      const profile = buildDefaultProfile(name)!;
      const compiled = compileProfile(profile);
      const parsed = parseSubagentProfileContent(compiled, name, { requireBody: true });
      expect(parsed, `${name}:\n${compiled}`).toBeDefined();
      expect(parsed?.permission).toBe(profile.permission);
      expect(parsed?.backend).toBe(profile.backend);
    }
  });
});
