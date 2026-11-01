import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildDefaultProfile, defaultProfileNames } from "../src/defaults.ts";
import { getSubagentProfiles } from "../src/profiles.ts";

const tempDirs: string[] = [];

function tempAgentDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-flow-defaults-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("built-in profiles with zero generated files", () => {
  it("exposes the six-role roster for all six CLIs without writing profiles or seed markers", () => {
    const agentDir = tempAgentDir();
    const profiles = getSubagentProfiles(agentDir);

    expect(defaultProfileNames()).toHaveLength(36);
    expect(profiles.size).toBe(36);
    expect([...profiles.keys()].sort()).toEqual(defaultProfileNames().map(name => name.replace('-', '/')).sort());
    for (const name of defaultProfileNames()) {
      const profile = profiles.get(name.replace('-', '/'));
      const expected = buildDefaultProfile(name);
      expect(profile, name).toBeDefined();
      expect(profile?.description, name).toBe(expected?.description);
      expect(profile?.systemPrompt, name).toBe(expected?.systemPrompt);
      expect(profile?.backend, name).toBe(expected?.backend);
      expect(profile?.model, name).toBeUndefined();
    }
    expect(profiles.get("agy/worker")?.description).toContain("Antigravity");
    expect(profiles.get("grok/worker")?.description).toContain("Grok CLI");
    expect(profiles.get("muse/worker")?.description).toContain("Muse Code");
    expect(profiles.get("opencode/worker")?.description).toContain("OpenCode");
    expect(readdirSync(agentDir)).toEqual([]);

    getSubagentProfiles(agentDir);
    expect(readdirSync(agentDir)).toEqual([]);
    expect(existsSync(join(agentDir, "subagents"))).toBe(false);
    expect(existsSync(join(agentDir, "pi-flow-external"))).toBe(false);
  });

  it("blocks catalog reads when a legacy seed marker or harnesses.json is present and writes nothing", () => {
    const marked = tempAgentDir();
    const subagentsDir = join(marked, "subagents");
    mkdirSync(subagentsDir, { recursive: true });
    writeFileSync(join(subagentsDir, ".pi-flow-defaults-seeded-v1"), "", "utf8");
    writeFileSync(join(subagentsDir, ".pi-flow-defaults-seeded-v2"), "", "utf8");
    expect(() => getSubagentProfiles(marked)).toThrow(/convert/i);
    expect(readdirSync(subagentsDir).sort()).toEqual([".pi-flow-defaults-seeded-v1", ".pi-flow-defaults-seeded-v2"]);
    expect(existsSync(join(marked, "pi-flow-external", "settings.json"))).toBe(false);

    const legacyRegistry = tempAgentDir();
    mkdirSync(join(legacyRegistry, "pi-flow-external"), { recursive: true });
    writeFileSync(
      join(legacyRegistry, "pi-flow-external", "harnesses.json"),
      JSON.stringify({ version: 1, harnesses: { "pi-deepseek": { model: "deepseek/deepseek-chat", thinking: "high" } } }),
      "utf8",
    );
    expect(() => getSubagentProfiles(legacyRegistry)).toThrow(/convert/i);
    expect(existsSync(join(legacyRegistry, "pi-flow-external", "settings.json"))).toBe(false);
    expect(readdirSync(join(legacyRegistry, "pi-flow-external"))).toEqual(["harnesses.json"]);
  });
});
