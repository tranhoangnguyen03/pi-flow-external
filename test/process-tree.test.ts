import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { abortChildTree } from "../src/core/process-tree.ts";

describe("abortChildTree", () => {
  it("uses Windows taskkill tree termination instead of claiming direct-child kill is enough", () => {
    const child = { pid: 42, exitCode: null, signalCode: null, kill: vi.fn() } as any;
    const unref = vi.fn();
    const spawnProcess = vi.fn(() => ({ unref }));

    abortChildTree(child, { platform: "win32", spawnProcess: spawnProcess as any });

    expect(spawnProcess).toHaveBeenCalledWith("taskkill", ["/pid", "42", "/t", "/f"], { stdio: "ignore", windowsHide: true });
    expect(child.kill).not.toHaveBeenCalled();
    expect(unref).toHaveBeenCalledOnce();
  });

  it.skipIf(process.platform === "win32")("force-kills a surviving POSIX process group after its leader exits", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-flow-process-tree-"));
    const pidPath = join(root, "descendant.pid");
    const leader = spawn(process.execPath, ["-e", `
      const { spawn } = require("node:child_process");
      const { writeFileSync } = require("node:fs");
      const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });
      writeFileSync(${JSON.stringify(pidPath)}, String(child.pid));
      child.unref();
    `], { detached: true, stdio: "ignore" });
    const closed = new Promise<void>((resolve) => leader.once("close", () => resolve()));
    let descendantPid = 0;
    try {
      await vi.waitFor(() => expect(existsSync(pidPath)).toBe(true));
      descendantPid = Number(readFileSync(pidPath, "utf8"));
      await closed;
      expect(leader.exitCode).not.toBeNull();

      abortChildTree(leader, { forceKillDelayMs: 25 });

      await vi.waitFor(() => expect(() => process.kill(descendantPid, 0)).toThrow(), { timeout: 2_000, interval: 20 });
    } finally {
      if (descendantPid) {
        try { process.kill(-leader.pid!, "SIGKILL"); } catch {}
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
});
