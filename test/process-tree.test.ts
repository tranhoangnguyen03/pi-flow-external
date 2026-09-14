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
});
