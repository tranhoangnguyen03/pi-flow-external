// The shared spawn loop behind every CLI backend. Backend test files cover
// event interpretation; these cover process lifecycle once for all of them.
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCliProcess } from "../src/core/cli-process.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fakeCli(body: string): { command: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "pi-flow-cli-process-"));
  dirs.push(dir);
  const command = join(dir, "fake-cli");
  writeFileSync(command, `#!/usr/bin/env node\n${body}`);
  chmodSync(command, 0o755);
  return { command, dir };
}

describe("runCliProcess", () => {
  it("delivers stdin, every stdout line including an unterminated tail, stderr, and the exit code", async () => {
    const { command, dir } = fakeCli(`let input = '';
for await (const chunk of process.stdin) input += chunk;
process.stdout.write(JSON.stringify({ got: input }) + '\\n{"n":2}\\n{"tail":true}');
process.stderr.write('warning');
process.exit(3);`);
    const lines: string[] = [];
    const result = await runCliProcess({ label: "fake", command, args: [], cwd: dir, stdin: "hello", onLine: (line) => lines.push(line) });
    expect(lines).toEqual(['{"got":"hello"}', '{"n":2}', '{"tail":true}']);
    expect(result).toMatchObject({ code: 3, stderr: "warning" });
  });

  it("kills the whole process tree when the caller aborts after spawn", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-flow-cli-tree-"));
    dirs.push(dir);
    const marker = (name: string) => JSON.stringify(join(dir, name));
    const { command } = fakeCli(`import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
spawn(process.execPath, ['-e', "setTimeout(() => require('fs').writeFileSync(" + JSON.stringify(${marker("grandchild-done")}) + ", '1'), 700)"], { stdio: 'ignore' });
setTimeout(() => writeFileSync(${marker("child-done")}, '1'), 700);
console.log('started');
setInterval(() => {}, 1000);`);
    const controller = new AbortController();
    const run = runCliProcess({ label: "fake", command, args: [], cwd: dir, signal: controller.signal, onLine: () => controller.abort() });
    await expect(run).rejects.toThrow("Subagent aborted");
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(existsSync(join(dir, "child-done"))).toBe(false);
    expect(existsSync(join(dir, "grandchild-done"))).toBe(false);
  });

  it("fails and kills the child when one stdout line exceeds the cap", async () => {
    const { command, dir } = fakeCli(`process.stdout.write('x'.repeat(2048) + '\\n'); setInterval(() => {}, 1000);`);
    const lines: string[] = [];
    await expect(runCliProcess({ label: "fake", command, args: [], cwd: dir, maxStdoutChars: 1024, onLine: (line) => lines.push(line) }))
      .rejects.toThrow("fake emitted a stdout line over 1024 chars");
    expect(lines).toEqual([]);
  });

  it("rejects a missing executable and never starts when already aborted", async () => {
    await expect(runCliProcess({ label: "fake", command: "/nonexistent/pi-flow-fake", args: [], cwd: tmpdir() })).rejects.toThrow(/ENOENT/);
    const { command, dir } = fakeCli(`import { writeFileSync } from 'node:fs'; writeFileSync('started', '1');`);
    const controller = new AbortController();
    controller.abort();
    await expect(runCliProcess({ label: "fake", command, args: [], cwd: dir, signal: controller.signal })).rejects.toThrow("aborted before prompt start");
    expect(existsSync(join(dir, "started"))).toBe(false);
  });
});
