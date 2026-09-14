import { spawn, type ChildProcess } from "node:child_process";

const FORCE_KILL_DELAY_MS = 3_000;

export function abortChildTree(child: ChildProcess, options: {
  platform?: NodeJS.Platform;
  spawnProcess?: typeof spawn;
  forceKillDelayMs?: number;
} = {}): void {
  const platform = options.platform ?? process.platform;
  if (platform === "win32" && child.pid) {
    const killer = (options.spawnProcess ?? spawn)("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
    killer.once?.("error", () => {});
    killer.unref();
    return;
  }
  if (platform !== "win32" && child.pid) {
    const processGroup = -child.pid;
    signalGroup(processGroup, "SIGTERM");
    setTimeout(() => signalGroup(processGroup, "SIGKILL"), options.forceKillDelayMs ?? FORCE_KILL_DELAY_MS).unref();
    return;
  }
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }, options.forceKillDelayMs ?? FORCE_KILL_DELAY_MS).unref();
}

function signalGroup(processGroup: number, signal: NodeJS.Signals): void {
  try {
    process.kill(processGroup, signal);
  } catch {
    // The group may already be gone.
  }
}
