import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { renameMock } = vi.hoisted(() => ({ renameMock: vi.fn() }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  renameMock.mockImplementation(actual.renameSync);
  return { ...actual, renameSync: renameMock };
});

import { installHarnessConfigWithSmokeTest, loadHarnessConfigs } from "../src/harnesses.ts";
import { externalSettingsPath as harnessesPath } from "../src/settings.ts";


const tempDirs: string[] = [];

function tempAgentDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-flow-harnesses-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
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
