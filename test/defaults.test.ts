import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { archiveProfiles, buildDefaultProfile, defaultProfileNames, findRetiredDefaultProfiles, retiredDefaultProfileNames, seedDefaultProfiles } from "../src/defaults.ts";
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
    expect(defaultProfileNames()).toHaveLength(18);
    expect(defaultProfileNames()).not.toContain("claude-debugger");
    expect(defaultProfileNames()).not.toContain("codex-debugger");
    expect(defaultProfileNames()).not.toContain("agy-debugger");

    const profiles = filterExternalAgentProfiles(getSubagentProfiles(agentDir));
    expect(profiles.size).toBe(18);
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
});

describe("retired default profile clean-up", () => {
  it("finds only retired pi-flow defaults; native Pi and user-created profiles are never candidates", () => {
    const agentDir = tempAgentDir();
    const dir = join(agentDir, "subagents");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "claude-debugger.md"), "---\ndescription: Debug.\nbackend: claude\n---\nDebug failures.\n");
    writeFileSync(join(dir, "agy-debugger.md"), "---\ndescription: My own debugger.\nbackend: agy\nowner: user\n---\nUser-owned debugger.\n");
    writeFileSync(join(dir, "scout.md"), "---\ndescription: Pi scout.\nbackend: pi\n---\nNative scout.\n");
    writeFileSync(join(dir, "oracle.md"), "---\ndescription: No backend declared.\n---\nNative oracle.\n");
    writeFileSync(join(dir, "claude-security-reviewer.md"), "---\ndescription: Custom.\nbackend: claude\nowner: user\n---\nUser-created.\n");
    writeFileSync(join(dir, "claude-explorer.md"), "---\ndescription: Current default.\nbackend: claude\n---\nExplore.\n");

    const retired = findRetiredDefaultProfiles(agentDir);
    expect(retired.map((profile) => profile.name)).toEqual(["claude-debugger"]);

    const result = archiveProfiles(agentDir, retired.map((profile) => profile.name));
    expect(result).toEqual({ archived: ["claude-debugger"], skipped: [] });
    expect(existsSync(join(dir, "archive", "claude-debugger.md"))).toBe(true);
    for (const untouched of ["scout.md", "oracle.md", "claude-security-reviewer.md", "claude-explorer.md", "agy-debugger.md"]) {
      expect(existsSync(join(dir, untouched)), untouched).toBe(true);
    }

    // Re-running with the source gone and an archive collision is safe.
    const again = archiveProfiles(agentDir, ["claude-debugger"]);
    expect(again).toEqual({ archived: [], skipped: ["claude-debugger"] });
    expect(existsSync(join(dir, "archive", "claude-debugger.md"))).toBe(true);
  });

  it("refuses to archive owner:user profiles even when named directly", () => {
    const agentDir = tempAgentDir();
    const dir = join(agentDir, "subagents");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "codex-debugger.md"), "---\ndescription: My debugger.\nbackend: codex\nowner: user\n---\nMine.\n");

    const result = archiveProfiles(agentDir, ["codex-debugger"]);
    expect(result).toEqual({ archived: [], skipped: ["codex-debugger"] });
    expect(existsSync(join(dir, "codex-debugger.md"))).toBe(true);
    expect(existsSync(join(dir, "archive"))).toBe(true);
  });

  it("retired names never overlap the shipped default roster", () => {
    const overlap = retiredDefaultProfileNames().filter((name) => defaultProfileNames().includes(name));
    expect(overlap).toEqual([]);
  });

  it("skips invalid names instead of touching paths outside the subagents directory", () => {
    const agentDir = tempAgentDir();
    const result = archiveProfiles(agentDir, ["../evil", "UPPER"]);
    expect(result).toEqual({ archived: [], skipped: ["../evil", "UPPER"] });
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
