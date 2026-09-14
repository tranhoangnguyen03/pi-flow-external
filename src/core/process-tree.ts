import { spawn, type ChildProcess } from "node:child_process";

const FORCE_KILL_DELAY_MS = 3_000;

export function abortChildTree(child: ChildProcess, options: {
  platform?: NodeJS.Platform;
  spawnProcess?: typeof spawn;
  forceKillDelayMs?: number;
} = {}): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const platform = options.platform ?? process.platform;
  if (platform === "win32" && child.pid) {
    const killer = (options.spawnProcess ?? spawn)("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
    killer.once?.("error", () => {});
    killer.unref();
    return;
  }
  signal(child, "SIGTERM");
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) signal(child, "SIGKILL");
  }, options.forceKillDelayMs ?? FORCE_KILL_DELAY_MS).unref();
}

function signal(child: ChildProcess, value: NodeJS.Signals): void {
  if (child.pid) {
    try {
      process.kill(-child.pid, value);
      return;
    } catch {
      // The group may have exited between the state check and signal.
    }
  }
  child.kill(value);
}
