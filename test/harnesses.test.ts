import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { renameMock, unlinkMock } = vi.hoisted(() => ({
  renameMock: vi.fn(),
  unlinkMock: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  renameMock.mockImplementation(actual.renameSync);
  unlinkMock.mockImplementation(actual.unlinkSync);
  return { ...actual, renameSync: renameMock, unlinkSync: unlinkMock };
});

import {
  getConfiguredHarnessNames,
  harnessesPath,
  installHarnessConfigWithSmokeTest,
  isValidHarnessName,
  loadHarnessConfigs,
  VALID_THINKING_LEVELS,
} from "../src/harnesses.ts";


const tempDirs: string[] = [];

function tempAgentDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-flow-harnesses-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("loadHarnessConfigs", () => {
  it("returns an empty map with no diagnostics when the file is missing", () => {
    const agentDir = tempAgentDir();
    const { harnesses, diagnostics } = loadHarnessConfigs(agentDir);
    expect(harnesses.size).toBe(0);
    expect(diagnostics).toEqual([]);
  });

  it("reports malformed JSON without throwing", () => {
    const agentDir = tempAgentDir();
    const dir = join(agentDir, "pi-flow-external");
    mkdirSync(dir, { recursive: true });
    writeFileSync(harnessesPath(agentDir), "{ not json");
    const { harnesses, diagnostics } = loadHarnessConfigs(agentDir);
    expect(harnesses.size).toBe(0);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatch(/not valid JSON/);
  });

  it("drops an entry with a bad key shape and keeps the rest", () => {
    const agentDir = tempAgentDir();
    const dir = join(agentDir, "pi-flow-external");
    mkdirSync(dir, { recursive: true });
    writeFileSync(harnessesPath(agentDir), JSON.stringify({
      version: 4,
      harnesses: {
        "not-pi-prefixed": { model: "openai/gpt-5" },
        "pi-deepseek": { model: "deepseek/deepseek-chat" },
      },
    }));
    const { harnesses, diagnostics } = loadHarnessConfigs(agentDir);
    expect(harnesses.has("not-pi-prefixed")).toBe(false);
    expect(harnesses.has("pi-deepseek")).toBe(true);
    expect(diagnostics.some((line) => line.includes("not-pi-prefixed"))).toBe(true);
  });

  it("drops an entry missing model", () => {
    const agentDir = tempAgentDir();
    const dir = join(agentDir, "pi-flow-external");
    mkdirSync(dir, { recursive: true });
    writeFileSync(harnessesPath(agentDir), JSON.stringify({ version: 4, harnesses: { "pi-bad": {} } }));
    const { harnesses, diagnostics } = loadHarnessConfigs(agentDir);
    expect(harnesses.has("pi-bad")).toBe(false);
    expect(diagnostics).toHaveLength(1);
  });

  it("drops an entry whose thinking value is outside the six valid literals", () => {
    const agentDir = tempAgentDir();
    const dir = join(agentDir, "pi-flow-external");
    mkdirSync(dir, { recursive: true });
    writeFileSync(harnessesPath(agentDir), JSON.stringify({
      version: 4,
      harnesses: { "pi-typo": { model: "deepseek/deepseek-chat", thinking: "med" } },
    }));
    const { harnesses, diagnostics } = loadHarnessConfigs(agentDir);
    expect(harnesses.has("pi-typo")).toBe(false);
    expect(diagnostics[0]).toContain(VALID_THINKING_LEVELS.join(", "));
  });

  it("treats an omitted thinking field as off at read time", () => {
    const agentDir = tempAgentDir();
    const dir = join(agentDir, "pi-flow-external");
    mkdirSync(dir, { recursive: true });
    writeFileSync(harnessesPath(agentDir), JSON.stringify({
      version: 4,
      harnesses: { "pi-glm": { model: "zhipu/glm-4.6" } },
    }));
    const { harnesses } = loadHarnessConfigs(agentDir);
    expect(harnesses.get("pi-glm")).toEqual({ model: "zhipu/glm-4.6", thinking: "off", preset: "minimal" });
  });

  it("keeps an explicit skills preset and defaults an omitted preset to minimal", () => {
    const agentDir = tempAgentDir();
    const dir = join(agentDir, "pi-flow-external");
    mkdirSync(dir, { recursive: true });
    writeFileSync(harnessesPath(agentDir), JSON.stringify({
      version: 4,
      harnesses: {
        "pi-skills": { model: "deepseek/deepseek-chat", thinking: "high", preset: "skills" },
        "pi-legacy": { model: "zhipu/glm-4.6", thinking: "low" },
      },
    }));
    const { harnesses, diagnostics } = loadHarnessConfigs(agentDir);
    expect(diagnostics).toEqual([]);
    expect(harnesses.get("pi-skills")).toEqual({ model: "deepseek/deepseek-chat", thinking: "high", preset: "skills" });
    expect(harnesses.get("pi-legacy")?.preset).toBe("minimal");
  });

  it("drops an entry whose preset is outside minimal or skills", () => {
    const agentDir = tempAgentDir();
    const dir = join(agentDir, "pi-flow-external");
    mkdirSync(dir, { recursive: true });
    writeFileSync(harnessesPath(agentDir), JSON.stringify({
      version: 4,
      harnesses: { "pi-typo": { model: "deepseek/deepseek-chat", thinking: "off", preset: "all" } },
    }));
    const { harnesses, diagnostics } = loadHarnessConfigs(agentDir);
    expect(harnesses.has("pi-typo")).toBe(false);
    expect(diagnostics[0]).toContain("preset");
  });

  it("loads a valid multi-entry file with no diagnostics", () => {
    const agentDir = tempAgentDir();
    const dir = join(agentDir, "pi-flow-external");
    mkdirSync(dir, { recursive: true });
    writeFileSync(harnessesPath(agentDir), JSON.stringify({
      version: 4,
      harnesses: {
        "pi-deepseek": { model: "deepseek/deepseek-chat", thinking: "high" },
        "pi-glm": { model: "zhipu/glm-4.6" },
      },
    }));
    const { harnesses, diagnostics } = loadHarnessConfigs(agentDir);
    expect(diagnostics).toEqual([]);
    expect([...harnesses.keys()].sort()).toEqual(["pi-deepseek", "pi-glm"]);
    expect(getConfiguredHarnessNames(agentDir)).toEqual(new Set(["pi-deepseek", "pi-glm"]));
  });
});

describe("installHarnessConfigWithSmokeTest", () => {
  it("stages, smoke-tests, and atomically commits a new harness", async () => {
    const agentDir = tempAgentDir();
    const path = await installHarnessConfigWithSmokeTest({
      agentDir,
      name: "pi-deepseek",
      model: "deepseek/deepseek-chat",
      thinking: "high",
      smokeTest: async () => ({ ok: true }),
    });
    expect(path).toBe(harnessesPath(agentDir));
    const { harnesses } = loadHarnessConfigs(agentDir);
    expect(harnesses.get("pi-deepseek")).toEqual({ model: "deepseek/deepseek-chat", thinking: "high", preset: "minimal" });
    // No residual staged file left behind.
    const dirEntries = readFileSync(harnessesPath(agentDir), "utf8");
    expect(dirEntries).not.toContain(".staged");
  });

  it("never accepts the wildcard marker \"pi-*\" as a registrable harness name", async () => {
    expect(isValidHarnessName("pi-*")).toBe(false);
    const agentDir = tempAgentDir();
    await expect(installHarnessConfigWithSmokeTest({
      agentDir,
      name: "pi-*",
      model: "deepseek/deepseek-chat",
      smokeTest: async () => ({ ok: true }),
    })).rejects.toThrow(/must match/);
    expect(loadHarnessConfigs(agentDir).harnesses.size).toBe(0);
  });

  it("rejects an invalid name before any write", async () => {
    const agentDir = tempAgentDir();
    let smokeCalled = false;
    await expect(installHarnessConfigWithSmokeTest({
      agentDir,
      name: "deepseek",
      model: "deepseek/deepseek-chat",
      smokeTest: async () => {
        smokeCalled = true;
        return { ok: true };
      },
    })).rejects.toThrow(/must match/);
    expect(smokeCalled).toBe(false);
    expect(loadHarnessConfigs(agentDir).harnesses.size).toBe(0);
  });

  it("rejects an unresolvable model shape before any write", async () => {
    const agentDir = tempAgentDir();
    let smokeCalled = false;
    await expect(installHarnessConfigWithSmokeTest({
      agentDir,
      name: "pi-deepseek",
      model: "not-a-provider-model",
      smokeTest: async () => {
        smokeCalled = true;
        return { ok: true };
      },
    })).rejects.toThrow(/<provider>\/<id>/);
    expect(smokeCalled).toBe(false);
  });

  it("persists an explicit skills preset", async () => {
    const agentDir = tempAgentDir();
    await installHarnessConfigWithSmokeTest({
      agentDir,
      name: "pi-deepseek",
      model: "deepseek/deepseek-chat",
      thinking: "high",
      preset: "skills",
      smokeTest: async () => ({ ok: true }),
    });
    expect(loadHarnessConfigs(agentDir).harnesses.get("pi-deepseek")?.preset).toBe("skills");
  });

  it("rejects an unknown preset before any write", async () => {
    const agentDir = tempAgentDir();
    let smokeCalled = false;
    await expect(installHarnessConfigWithSmokeTest({
      agentDir,
      name: "pi-deepseek",
      model: "deepseek/deepseek-chat",
      preset: "all" as never,
      smokeTest: async () => {
        smokeCalled = true;
        return { ok: true };
      },
    })).rejects.toThrow(/minimal, skills/);
    expect(smokeCalled).toBe(false);
    expect(loadHarnessConfigs(agentDir).harnesses.size).toBe(0);
  });

  it("rejects an unsupported thinking value before any write", async () => {
    const agentDir = tempAgentDir();
    let smokeCalled = false;
    await expect(installHarnessConfigWithSmokeTest({
      agentDir,
      name: "pi-deepseek",
      model: "deepseek/deepseek-chat",
      thinking: "med" as never,
      smokeTest: async () => {
        smokeCalled = true;
        return { ok: true };
      },
    })).rejects.toThrow(/off, minimal, low, medium, high, xhigh/);
    expect(smokeCalled).toBe(false);
  });

  it("rolls back with no entry written when the smoke test fails", async () => {
    const agentDir = tempAgentDir();
    await expect(installHarnessConfigWithSmokeTest({
      agentDir,
      name: "pi-deepseek",
      model: "deepseek/deepseek-chat",
      smokeTest: async () => ({ ok: false, error: "backend unreachable" }),
    })).rejects.toThrow(/backend unreachable/);
    expect(loadHarnessConfigs(agentDir).harnesses.size).toBe(0);
  });

  it("rejects a name that already exists without touching the existing entry", async () => {
    const agentDir = tempAgentDir();
    await installHarnessConfigWithSmokeTest({
      agentDir,
      name: "pi-deepseek",
      model: "deepseek/deepseek-chat",
      smokeTest: async () => ({ ok: true }),
    });
    let smokeCalled = false;
    await expect(installHarnessConfigWithSmokeTest({
      agentDir,
      name: "pi-deepseek",
      model: "deepseek/other-model",
      smokeTest: async () => {
        smokeCalled = true;
        return { ok: true };
      },
    })).rejects.toThrow(/already exists/);
    expect(smokeCalled).toBe(false);
    expect(loadHarnessConfigs(agentDir).harnesses.get("pi-deepseek")?.model).toBe("deepseek/deepseek-chat");
  });

  it("uses an atomic same-directory rename, never an unlink-then-link window", async () => {
    const agentDir = tempAgentDir();
    renameMock.mockClear();
    unlinkMock.mockClear();
    await installHarnessConfigWithSmokeTest({
      agentDir,
      name: "pi-deepseek",
      model: "deepseek/deepseek-chat",
      smokeTest: async () => ({ ok: true }),
    });
    expect(renameMock).toHaveBeenCalledTimes(1);
    const [stagedPath, finalPath] = renameMock.mock.calls[0] as [string, string];
    expect(finalPath).toBe(harnessesPath(agentDir));
    expect(stagedPath).toContain(".staged");
    // Cleanup may unlink the staged path after rename. It must never unlink
    // the destination; that would open an unlink-then-link window.
    for (const call of unlinkMock.mock.calls) {
      expect(call[0]).not.toBe(harnessesPath(agentDir));
      expect(String(call[0])).toContain(".staged");
    }
  });

  it("leaves an existing settings.json completely untouched, with no data loss, when the atomic rename fails", async () => {
    const agentDir = tempAgentDir();
    await installHarnessConfigWithSmokeTest({
      agentDir,
      name: "pi-existing",
      model: "deepseek/deepseek-chat",
      smokeTest: async () => ({ ok: true }),
    });
    const before = readFileSync(harnessesPath(agentDir), "utf8");

    renameMock.mockImplementationOnce(() => {
      throw new Error("simulated rename failure");
    });
    await expect(installHarnessConfigWithSmokeTest({
      agentDir,
      name: "pi-new",
      model: "deepseek/other-model",
      smokeTest: async () => ({ ok: true }),
    })).rejects.toThrow(/simulated rename failure/);

    // The pre-existing file is byte-for-byte unchanged: no window existed
    // where it could have been deleted or partially overwritten.
    expect(readFileSync(harnessesPath(agentDir), "utf8")).toBe(before);
    expect(loadHarnessConfigs(agentDir).harnesses.has("pi-existing")).toBe(true);
    expect(loadHarnessConfigs(agentDir).harnesses.has("pi-new")).toBe(false);
    // No residual staged file left behind after the failed rename.
    const { readdirSync } = await import("node:fs");
    const entries = readdirSync(join(agentDir, "pi-flow-external"));
    expect(entries.filter((name) => name.endsWith(".staged"))).toEqual([]);
  });
});
