import { spawn } from "node:child_process";
import { abortChildTree } from "./process-tree.ts";
import { createBoundedBuffer, MAX_STDERR_CHARS, MAX_STDOUT_LINE_CHARS } from "./stream.ts";

export interface CliProcessOptions {
  /** Short backend name used in errors, e.g. "claude". */
  label: string;
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Written to stdin, which is then closed. Omitted closes stdin immediately. */
  stdin?: string;
  signal?: AbortSignal;
  /** Called once the OS reports the process started. Observation only. */
  onSpawn?: (pid: number | undefined) => void;
  /** Each complete stdout line, plus a non-blank unterminated tail at close. */
  onLine?: (line: string) => void;
  /** Collect stdout as one document instead of lines. */
  rawStdout?: boolean;
  /** Cap for one line (or the raw document). Defaults to MAX_STDOUT_LINE_CHARS. */
  maxStdoutChars?: number;
}

export interface CliProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  /** Present only with rawStdout. */
  stdout?: string;
}

/**
 * The one spawn loop for every CLI backend: detached process group, abort
 * kills the whole tree, a single stdout line (or raw document) over
 * MAX_STDOUT_LINE_CHARS kills the child and fails, stderr is bounded. Adapters
 * own event interpretation and success rules; this owns process lifecycle.
 */
export async function runCliProcess(options: CliProcessOptions): Promise<CliProcessResult> {
  const { label, signal } = options;
  const cap = options.maxStdoutChars ?? MAX_STDOUT_LINE_CHARS;
  if (signal?.aborted) throw new Error("Subagent aborted before prompt start");
  const proc = spawn(options.command, options.args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  const abort = () => abortChildTree(proc);
  let settled = false;
  try {
    proc.once("spawn", () => {
      try { options.onSpawn?.(proc.pid); } catch { /* observation is best-effort */ }
    });
    if (!proc.stdin || !proc.stdout || !proc.stderr) throw new Error(`${label} stdin/stdout/stderr pipes were not available`);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) throw new Error("Subagent aborted before prompt start");

    const stderr = createBoundedBuffer(MAX_STDERR_CHARS);
    let pending = "";
    let oversize: string | undefined;
    proc.stdout.setEncoding("utf8");
    proc.stderr.setEncoding("utf8");
    // A child that exits before reading stdin is reported by the close path.
    proc.stdin.on("error", () => {});
    proc.stdout.on("data", (chunk: string) => {
      if (oversize) return;
      pending += chunk;
      const lines = options.rawStdout ? [] : pending.split(/\r?\n/);
      if (!options.rawStdout) pending = lines.pop() ?? "";
      if (pending.length > cap || lines.some((line) => line.length > cap)) {
        oversize = `${label} emitted a stdout ${options.rawStdout ? "payload" : "line"} over ${cap} chars; stream is unparseable`;
        pending = "";
        abort();
        return;
      }
      for (const line of lines) options.onLine?.(line);
    });
    proc.stderr.on("data", (chunk: string) => stderr.append(chunk));
    proc.stdin.end(options.stdin);

    const { code, signal: exitSignal } = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      proc.once("error", reject);
      proc.once("close", (code, closeSignal) => resolve({ code, signal: closeSignal }));
    });
    settled = true;
    if (!options.rawStdout && pending.trim()) options.onLine?.(pending);
    if (signal?.aborted) throw new Error("Subagent aborted");
    if (oversize) throw new Error(oversize);
    return { code, signal: exitSignal, stderr: stderr.text(), ...(options.rawStdout ? { stdout: pending } : {}) };
  } catch (error) {
    if (!settled) abort();
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}
