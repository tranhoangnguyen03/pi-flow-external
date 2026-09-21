import { chmodSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
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

// The default (non --routing-smoke) lane dynamically imports the extension's
// own TypeScript sources (parameter-property constructors etc.), which plain
// Node strip-only parsing rejects; --experimental-transform-types performs a
// full transform instead. Argument-validation and precheck failures happen
// before that import ever runs, so they pass with or without the flag, but
// carrying it here keeps every case realistic to how `npm run e2e` actually
// invokes the script.
// The script now preserves its runRoot on any failure (not just --keep), so
// callers can inspect it after a real, unexpected failure. That is exactly
// what several tests below intentionally trigger, so capture and schedule
// cleanup of any preserved path here — once, for every runScript call —
// instead of relying on each test to remember it.
function captureAndScheduleCleanup(stdout: string): void {
  const match = stdout.match(/(?:Preserved failing run|Kept) artifacts at (\S+)/);
  if (match) temporaryDirectories.push(match[1]!);
}

function runScript(args: string[], env: Record<string, string | undefined> = {}, timeout = 10_000): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, ["--experimental-transform-types", scriptPath, ...args], {
      encoding: "utf8",
      env: { ...process.env, ...env },
      timeout,
    });
    captureAndScheduleCleanup(stdout);
    return { code: 0, stdout, stderr: "" };
  } catch (error) {
    const err = error as { status?: number; stdout?: string; stderr?: string };
    captureAndScheduleCleanup(err.stdout ?? "");
    return { code: err.status ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

describe("e2e external script argument validation", () => {
  it("rejects an unknown --backend value", () => {
    const result = runScript(["--backend", "gemini"]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("--backend must be claude, codex, agy, grok, muse, or pi");
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

  it("rejects --root-model without --routing-smoke", () => {
    const result = runScript(["--backend", "codex", "--root-model", "openai-codex/gpt-5.6-sol"]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("--root-model and --root-thinking only apply to --routing-smoke");
  });

  it("rejects --root-thinking without --routing-smoke", () => {
    const result = runScript(["--backend", "codex", "--root-thinking", "high"]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("--root-model and --root-thinking only apply to --routing-smoke");
  });

  it("accepts --root-model and --root-thinking together with --routing-smoke", () => {
    const result = runScript(["--backend", "gemini", "--routing-smoke", "--root-model", "x", "--root-thinking", "high"]);
    expect(result.code).not.toBe(0);
    // Still rejected for the unrelated --backend value, not for combining routing-smoke with root flags.
    expect(result.stderr).toContain("--backend must be claude, codex, agy, grok, muse, or pi");
    expect(result.stderr).not.toContain("only apply to --routing-smoke");
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

  it("passes the precheck (and only fails later, on real model resolution) once the harness is registered", async () => {
    const agentDir = await makeAgentDir();
    await mkdir(join(agentDir, "pi-flow-external"), { recursive: true });
    await writeFile(
      join(agentDir, "pi-flow-external", "harnesses.json"),
      JSON.stringify({ version: 1, harnesses: { "pi-deepseek": { model: "deepseek/deepseek-chat", thinking: "high" } } }),
    );
    // The default lane never spawns a "pi" binary at all (it builds the SDK
    // session in-process), so unlike the old spawn-based check this fails
    // for a real, later reason: "pi-deepseek" points at a deepseek model
    // that isn't registered anywhere in this fresh, credential-less agent
    // dir. That keeps this a fast, deterministic unit check of the precheck
    // itself (no network access), not a real end-to-end provider run.
    const result = runScript(["--backend", "pi", "--harness", "pi-deepseek", "--agent-dir", agentDir, "--timeout-ms", "3000"], {}, 20_000);
    expect(result.code).not.toBe(0);
    expect(result.stderr).not.toContain("No harnesses.json found");
    expect(result.stderr).not.toContain("is not registered");
    expect(result.stderr).toContain("was not found in the registry");
  });
});

// These exercise the default deterministic lane end-to-end (argument
// parsing, in-process SDK session construction, and the Agent/workflow/
// external_runs tool executors) against a fake "codex" binary standing in
// for the real CLI, so they stay offline and deterministic while still
// running the actual script rather than duplicating the SDK-level coverage
// already in test/agent-contract.test.ts.
describe("e2e external script deterministic fake-backend smoke", () => {
  async function makeFakeCodexBin(scriptBody: string): Promise<string> {
    const binDir = await mkdtemp(join(tmpdir(), "pi-flow-e2e-fake-bin-"));
    temporaryDirectories.push(binDir);
    const fakeCodex = join(binDir, "codex");
    writeFileSync(fakeCodex, `#!/usr/bin/env node\n${scriptBody}`);
    chmodSync(fakeCodex, 0o755);
    return binDir;
  }

  // Reads the target file path out of the prompt on stdin (the same way the
  // real codex CLI would receive it) and echoes back the file's own trimmed
  // content, rather than any hardcoded string. scripts/e2e/external.mjs's
  // fixture content is now an unpredictable per-run nonce that this fake
  // binary never sees in advance, so only actually reading the file can
  // reproduce it — this is what lets the exact-equality assertion in
  // scripts/e2e/external.mjs prove something: a fake binary that ignored the
  // prompt and returned a fixed string would fail it (see wrongReplyScript
  // below).
  function readingReplyScript(): string {
    return `let stdin = '';
for await (const chunk of process.stdin) stdin += chunk;
const { readFileSync } = await import('node:fs');
const match = stdin.match(/"([^"]+)"/);
const content = match ? readFileSync(match[1], 'utf8').trim() : '';
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'e2e-fake' }));
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: content } }));
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } }));
`;
  }

  // Replies with a fixed string that can never match the fixture's random
  // per-run nonce — proves the script's exact-equality gate actually rejects
  // a wrong/canned answer instead of passing on a loose substring match.
  function wrongReplyScript(): string {
    return `let stdin = '';
for await (const chunk of process.stdin) stdin += chunk;
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'e2e-fake' }));
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'not-the-file-content' } }));
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } }));
`;
  }

  // Emits one structured tool-activity event before hanging, so the
  // interrupt lane's wait-for-firstActivityAt poll (which now requires real
  // activity before it will cancel, not merely "running") has something to
  // observe offline.
  function hungWithActivityScript(): string {
    return `let stdin = '';
for await (const chunk of process.stdin) stdin += chunk;
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'e2e-fake-hung' }));
console.log(JSON.stringify({ type: 'item.started', item: { type: 'command_execution', command: 'inspecting fixture' } }));
setInterval(() => {}, 1000);
`;
  }

  it("runs a direct Agent call against a fake codex binary with no root LLM call", async () => {
    const binDir = await makeFakeCodexBin(readingReplyScript());
    const result = runScript(["--backend", "codex"], { PATH: `${binDir}:${process.env.PATH ?? ""}` }, 20_000);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("PASS codex Agent deterministic E2E");
  });

  it("runs a blocking two-child workflow against a fake codex binary", async () => {
    const binDir = await makeFakeCodexBin(readingReplyScript());
    const result = runScript(["--backend", "codex", "--workflow"], { PATH: `${binDir}:${process.env.PATH ?? ""}` }, 20_000);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("PASS codex workflow deterministic E2E");
  });

  it("cancels a backgrounded Agent through external_runs against a hung fake codex binary", async () => {
    const binDir = await makeFakeCodexBin(hungWithActivityScript());
    const result = runScript(["--backend", "codex", "--interrupt"], { PATH: `${binDir}:${process.env.PATH ?? ""}` }, 20_000);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("PASS codex interrupted Agent deterministic E2E");
  });

  it("fails the exact-result gate when the fake codex reply is a fixed string instead of the file's actual content", async () => {
    const binDir = await makeFakeCodexBin(wrongReplyScript());
    const result = runScript(["--backend", "codex"], { PATH: `${binDir}:${process.env.PATH ?? ""}` }, 20_000);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("Expected exact result");
  });

  it("ignores an inherited PI_CODING_AGENT_DIR and stays isolated when --agent-dir is not passed", async () => {
    const binDir = await makeFakeCodexBin(readingReplyScript());
    const sentinelAgentDir = await makeAgentDir();
    const sentinelFile = join(sentinelAgentDir, "sentinel.json");
    await writeFile(sentinelFile, "{}");
    const entriesBefore = await readdir(sentinelAgentDir);

    const result = runScript(
      ["--backend", "codex"],
      { PATH: `${binDir}:${process.env.PATH ?? ""}`, PI_CODING_AGENT_DIR: sentinelAgentDir },
      20_000,
    );
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("PASS codex Agent deterministic E2E");

    expect(await readFile(sentinelFile, "utf8")).toBe("{}");
    expect((await readdir(sentinelAgentDir)).sort()).toEqual(entriesBefore.sort());
  });
});
