import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { preflightPiHarness } from "../scripts/e2e/preflight.mjs";

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
// own TypeScript sources. They use erasable syntax only (tsconfig
// `erasableSyntaxOnly`), so Node's built-in type stripping loads them on every
// supported Node version without a transform flag.
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
    const stdout = execFileSync(process.execPath, [scriptPath, ...args], {
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

// Keep the read-only rejection cases direct: the separate process smoke above
// proves that the CLI calls this precheck before starting a Pi child.
function preflightError(agentDir: string): string {
  try {
    preflightPiHarness(agentDir, "pi-deepseek");
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("Expected the Pi harness precheck to reject invalid settings");
}

describe("e2e external script pi harness precheck", () => {
  it("rejects a missing harness and any non-v5 settings without modifying the real agent directory", async () => {
    for (const settings of [
      { version: 5, harnesses: { "pi-other": { model: "deepseek/deepseek-chat", thinking: "high", preset: "minimal" } } },
      { version: 4, harnesses: { "pi-deepseek": { model: "deepseek/deepseek-chat", thinking: "high" } } },
    ]) {
      const agentDir = await makeAgentDir();
      const settingsPath = join(agentDir, "pi-flow-external", "settings.json");
      const body = `${JSON.stringify(settings, null, 2)}\n`;
      await mkdir(join(agentDir, "pi-flow-external"), { recursive: true });
      await writeFile(settingsPath, body);
      expect(preflightError(agentDir)).toMatch(settings.version === 5 ? /"pi-deepseek" is not registered.*pi-other/ : /version 4.*will not modify/);
      expect(await readFile(settingsPath, "utf8")).toBe(body);
      expect(await readdir(join(agentDir, "pi-flow-external"))).toEqual(["settings.json"]);
    }
  });
});

// These exercise the default deterministic lane end-to-end (argument
// parsing, in-process SDK session construction, and the external_delegate/workflow/
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

  it("adds only a temporary binding to an existing version 5 --agent-dir and restores it byte-for-byte", async () => {
    const binDir = await makeFakeCodexBin(readingReplyScript());
    const agentDir = await makeAgentDir();
    const settingsPath = join(agentDir, "pi-flow-external", "settings.json");
    const body = `${JSON.stringify({ version: 5, futureField: { keep: true }, harnesses: { codex: { model: "gpt-x" } } }, null, 2)}\n`;
    await mkdir(join(agentDir, "pi-flow-external"), { recursive: true });
    await writeFile(settingsPath, body);
    const result = runScript(["--backend", "codex", "--agent-dir", agentDir], { PATH: `${binDir}:${process.env.PATH ?? ""}` }, 20_000);
    expect(result.code, result.stderr).toBe(0);
    expect(await readFile(settingsPath, "utf8")).toBe(body);
    expect(existsSync(join(agentDir, "pi-flow-external", "overrides"))).toBe(false);
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
    expect(result.stdout).toContain("PASS codex external_delegate deterministic E2E");

    expect(await readFile(sentinelFile, "utf8")).toBe("{}");
    expect((await readdir(sentinelAgentDir)).sort()).toEqual(entriesBefore.sort());
  });
});
