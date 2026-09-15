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
    expect(defaultProfileNames()).toHaveLength(18);

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
