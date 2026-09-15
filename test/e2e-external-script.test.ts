import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const scriptPath = new URL("../scripts/e2e/external.mjs", import.meta.url).pathname;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

async function makeAgentDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-flow-e2e-script-"));
  temporaryDirectories.push(dir);
  return dir;
}

function runScript(args: string[], env: Record<string, string | undefined> = {}): { code: number; stderr: string } {
  try {
    execFileSync(process.execPath, [scriptPath, ...args], {
      encoding: "utf8",
      env: { ...process.env, ...env },
      timeout: 10_000,
    });
    return { code: 0, stderr: "" };
  } catch (error) {
    const err = error as { status?: number; stderr?: string };
    return { code: err.status ?? 1, stderr: err.stderr ?? "" };
  }
}

describe("e2e external script argument validation", () => {
  it("rejects an unknown --backend value", () => {
    const result = runScript(["--backend", "gemini"]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("--backend must be claude, codex, agy, or pi");
  });

  it("requires --harness with --backend pi", () => {
    const result = runScript(["--backend", "pi"]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("--backend pi requires --harness");
  });

  it("rejects --harness with a non-pi backend", () => {
    const result = runScript(["--backend", "codex", "--harness", "pi-deepseek"]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("--harness only applies to --backend pi");
  });

  it("rejects combining --workflow and --interrupt", () => {
    const result = runScript(["--backend", "codex", "--workflow", "--interrupt"]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("--workflow and --interrupt are separate checks");
  });
});

describe("e2e external script pi harness precheck", () => {
  it("fails fast with a clear message when no harnesses.json exists, before ever launching pi", async () => {
    const agentDir = await makeAgentDir();
    const result = runScript(["--backend", "pi", "--harness", "pi-deepseek", "--agent-dir", agentDir]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("No harnesses.json found");
    expect(result.stderr).toContain("pi-deepseek");
  });

  it("fails fast and lists registered harnesses when the requested one is missing", async () => {
    const agentDir = await makeAgentDir();
    await mkdir(join(agentDir, "pi-flow-external"), { recursive: true });
    await writeFile(
      join(agentDir, "pi-flow-external", "harnesses.json"),
      JSON.stringify({ version: 1, harnesses: { "pi-other": { model: "deepseek/deepseek-chat", thinking: "high" } } }),
    );
    const result = runScript(["--backend", "pi", "--harness", "pi-deepseek", "--agent-dir", agentDir]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('Harness "pi-deepseek" is not registered');
    expect(result.stderr).toContain("pi-other");
  });

  it("fails fast on malformed harnesses.json", async () => {
    const agentDir = await makeAgentDir();
    await mkdir(join(agentDir, "pi-flow-external"), { recursive: true });
    await writeFile(join(agentDir, "pi-flow-external", "harnesses.json"), "{ not json");
    const result = runScript(["--backend", "pi", "--harness", "pi-deepseek", "--agent-dir", agentDir]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("is not valid JSON");
  });

  it("passes the precheck (and only fails later, trying to launch the real pi CLI) once the harness is registered", async () => {
    const agentDir = await makeAgentDir();
    await mkdir(join(agentDir, "pi-flow-external"), { recursive: true });
    await writeFile(
      join(agentDir, "pi-flow-external", "harnesses.json"),
      JSON.stringify({ version: 1, harnesses: { "pi-deepseek": { model: "deepseek/deepseek-chat", thinking: "high" } } }),
    );
    const result = runScript(["--backend", "pi", "--harness", "pi-deepseek", "--agent-dir", agentDir, "--timeout-ms", "3000"], {
      // Force the (unavailable in CI) "pi" binary to fail to spawn quickly
      // rather than hang, so this stays a fast, deterministic unit check of
      // the precheck itself, not a real end-to-end provider run.
      PATH: "/nonexistent",
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).not.toContain("No harnesses.json found");
    expect(result.stderr).not.toContain("is not registered");
  });
});
