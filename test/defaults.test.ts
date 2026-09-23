import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildDefaultProfile, defaultProfileNames } from "../src/defaults.ts";
import { compileProfile } from "../src/profile-creator.ts";
import { filterExternalAgentProfiles, getSubagentProfiles, parseSubagentProfileContent, resolveExternalProfile } from "../src/profiles.ts";

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
  it("exposes the six-role roster for all five CLIs without writing profiles or seed markers", () => {
    const agentDir = tempAgentDir();
    const profiles = filterExternalAgentProfiles(getSubagentProfiles(agentDir));

    expect(defaultProfileNames()).toHaveLength(30);
    expect(profiles.size).toBe(30);
    expect([...profiles.keys()].sort()).toEqual([...defaultProfileNames()].sort());
    for (const name of defaultProfileNames()) {
      const profile = profiles.get(name);
      const expected = buildDefaultProfile(name);
      expect(profile, name).toBeDefined();
      expect(profile?.description, name).toBe(expected?.description);
      expect(profile?.systemPrompt, name).toBe(expected?.systemPrompt);
      expect(profile?.backend, name).toBe(expected?.backend);
      expect(profile?.model, name).toBeUndefined();
    }
    expect(profiles.get("agy-worker")?.description).toContain("Antigravity");
    expect(profiles.get("grok-worker")?.description).toContain("Grok CLI");
    expect(profiles.get("muse-worker")?.description).toContain("Muse Code");
    expect(readdirSync(agentDir)).toEqual([]);

    getSubagentProfiles(agentDir);
    expect(readdirSync(agentDir)).toEqual([]);
    expect(existsSync(join(agentDir, "subagents"))).toBe(false);
    expect(existsSync(join(agentDir, "pi-flow-external"))).toBe(false);
  });

  it("lets an exact override replace one builtin, keeps a disabled canonical identity unselectable, and ignores subagents files", () => {
    const agentDir = tempAgentDir();
    const overridesDir = join(agentDir, "pi-flow-external", "overrides");
    const subagentsDir = join(agentDir, "subagents");
    mkdirSync(overridesDir, { recursive: true });
    mkdirSync(subagentsDir, { recursive: true });
    const customExplorer = "---\ndescription: Mine.\nbackend: claude\n---\nMy custom explorer.\n";
    writeFileSync(join(overridesDir, "claude-explorer.md"), customExplorer, "utf8");
    writeFileSync(join(subagentsDir, "claude-worker.md"), "---\ndescription: Legacy disk worker.\nbackend: claude\n---\nShould not load.\n", "utf8");
    writeFileSync(join(subagentsDir, "scout.md"), "---\ndescription: Native Pi scout.\nbackend: pi\n---\nNative work.\n", "utf8");
    writeFileSync(
      join(agentDir, "pi-flow-external", "settings.json"),
      JSON.stringify({ version: 4, disabledProfiles: ["codex-worker"] }),
      "utf8",
    );

    const profiles = getSubagentProfiles(agentDir);
    expect(profiles.get("claude-explorer")?.systemPrompt).toBe("My custom explorer.");
    expect(profiles.get("claude-explorer")?.description).toBe("Mine.");
    expect(profiles.get("claude-worker")?.systemPrompt).not.toBe("Should not load.");
    expect(profiles.get("claude-worker")?.description).toBe(buildDefaultProfile("claude-worker")?.description);
    expect(profiles.has("scout")).toBe(false);
    expect(profiles.get("codex-worker")?.configurationError).toMatch(/disabled/i);
    expect(() => resolveExternalProfile(profiles, { role: "worker", harness: "codex" }, "agy")).toThrow(/disabled/i);
    expect(() => resolveExternalProfile(profiles, { subagentType: "codex-worker" }, "agy")).toThrow(/disabled/i);
    expect(resolveExternalProfile(profiles, { role: "worker", harness: "agy" }, "agy").name).toBe("agy-worker");

    const external = filterExternalAgentProfiles(profiles);
    expect(external.has("scout")).toBe(false);
    expect(external.has("codex-worker")).toBe(true);
    expect([...external.keys()].sort()).toEqual([...defaultProfileNames()].sort());

    getSubagentProfiles(agentDir);
    expect(existsSync(join(subagentsDir, ".pi-flow-defaults-seeded-v1"))).toBe(false);
    expect(existsSync(join(subagentsDir, ".pi-flow-defaults-seeded-v2"))).toBe(false);
    expect(existsSync(join(subagentsDir, ".pi-flow-defaults-seeded-v3"))).toBe(false);
    expect(readdirSync(overridesDir)).toEqual(["claude-explorer.md"]);
    expect(readdirSync(subagentsDir).sort()).toEqual(["claude-worker.md", "scout.md"]);
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

describe("default profile content", () => {
  it("compiles every default through the same validator as created profiles", () => {
    for (const name of defaultProfileNames()) {
      const profile = buildDefaultProfile(name)!;
      const compiled = compileProfile(profile);
      const parsed = parseSubagentProfileContent(compiled, name, { requireBody: true });
      expect(parsed, `${name}:\n${compiled}`).toBeDefined();
      expect(parsed?.backend).toBe(profile.backend);
      expect(compiled).not.toContain("permission:");
    }
  });
});
