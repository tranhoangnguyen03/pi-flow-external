#!/usr/bin/env node
/**
 * Opt-in *live* Antigravity timing comparison. Uses a fixed harmless prompt.
 * This script stays outside the published npm package and regular CI.
 */
import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";

const PROMPT = "Reply with exactly AGY_LATENCY_CHECK. Do not use tools.";
const USAGE = `Antigravity CLI comparison (real requests require --execute)

  node scripts/e2e/agy-latency.mjs --execute [--rounds 3] [--model NAME] [--effort low|medium|high] [--cwd PATH] [--timeout-ms 180000]

Compares --print with --input-format stream-json. Both ALWAYS use
--dangerously-skip-permissions. --print exposes this script's fixed harmless
prompt in process arguments; NEVER replace it with a private task prompt.
No provider calls occur with --help or without --execute.
`;

function parseOptions(argv) {
  const options = { execute: false, rounds: 3, model: undefined, effort: undefined, cwd: process.cwd(), timeoutMs: 180000 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { help: true };
    if (arg === "--execute") { options.execute = true; continue; }
    const key = { "--rounds": "rounds", "--model": "model", "--effort": "effort", "--cwd": "cwd", "--timeout-ms": "timeoutMs" }[arg];
    if (!key || !argv[i + 1] || argv[i + 1].startsWith("--")) throw new Error(`Unknown or incomplete option: ${arg}`);
    options[key] = argv[++i];
  }
  options.rounds = Number(options.rounds);
  options.timeoutMs = Number(options.timeoutMs);
  if (!Number.isInteger(options.rounds) || options.rounds < 1 || options.rounds > 10) throw new Error("--rounds must be 1–10");
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1000 || options.timeoutMs > 3600000) throw new Error("--timeout-ms must be 1000–3600000");
  if (options.effort !== undefined && !["low", "medium", "high"].includes(options.effort)) throw new Error("--effort must be low, medium or high");
  if (options.model !== undefined && !/^[a-zA-Z0-9._/:+-]+$/.test(options.model)) throw new Error("Invalid model name");
  options.cwd = resolve(options.cwd);
  return options;
}

function delta(a, b) {
  return a === undefined || b === undefined ? undefined : Math.max(0, Math.round(b - a));
}

function killTree(child, signal) {
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch { /* Already stopped. */ }
}

async function run(mode, options, round) {
  const args = ["--dangerously-skip-permissions", "--output-format", "stream-json",
    "--print-timeout", `${options.timeoutMs}ms`];
  if (options.model) args.push("--model", options.model);
  if (options.effort) args.push("--effort", options.effort);
  if (mode === "print") args.push("--print", PROMPT);
  else args.push("--input-format", "stream-json");

  const started = performance.now();
  const child = spawn("agy", args, {
    cwd: options.cwd,
    env: process.env,
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
  });
  let spawned, firstLine, init, firstActivity, terminal, exited;
  let events = 0, malformed = 0, stderrBytes = 0;
  let terminalStatus;
  let timedOut = false;
  let pending = "";
  let protocolOverrun = false;
  const processLine = (line) => {
    if (!line.trim()) return;
    firstLine ??= performance.now();
    let event;
    try { event = JSON.parse(line); } catch { malformed++; return; }
    if (!event || typeof event !== "object" || Array.isArray(event)) { malformed++; return; }
    events++;
    if (event.event === "init") init ??= performance.now();
    if (event.event === "step_update" &&
      (event.step_update?.tool_name || event.step_update?.text_delta)) firstActivity ??= performance.now();
    if (event.event === "result") {
      terminal ??= performance.now();
      terminalStatus = event.result?.status;
    }
  };
  child.once("spawn", () => { spawned = performance.now(); });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    pending += chunk;
    if (pending.length > 2_000_000) { protocolOverrun = true; killTree(child, "SIGTERM"); return; }
    let end;
    while ((end = pending.indexOf("\n")) >= 0) {
      processLine(pending.slice(0, end));
      pending = pending.slice(end + 1);
    }
  });
  child.stderr.on("data", (chunk) => { stderrBytes += chunk.length; });
  child.stdin.on("error", () => {});
  child.stdin.end(mode === "stdin" ? `${JSON.stringify({ event: "user", message: { content: PROMPT } })}\n` : undefined);
  const timeout = setTimeout(() => { timedOut = true; killTree(child, "SIGTERM"); }, options.timeoutMs + 5000);
  const hardKill = setTimeout(() => { if (timedOut) killTree(child, "SIGKILL"); }, options.timeoutMs + 7000);
  try {
    const { code, signal } = await new Promise((done, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => done({ code, signal }));
    });
    if (pending.trim()) processLine(pending);
    exited = performance.now();
    return {
      round, mode, success: !timedOut && !protocolOverrun && code === 0 && terminalStatus === "SUCCESS",
      exitCode: code, exitSignal: signal, timedOut, protocolOverrun, events, malformed, stderrBytes,
      elapsedMs: delta(started, exited),
      adapterToSpawnMs: delta(started, spawned),
      spawnToFirstEventMs: delta(spawned, firstLine),
      spawnToInitMs: delta(spawned, init),
      spawnToFirstActivityMs: delta(spawned, firstActivity),
      spawnToTerminalMs: delta(spawned, terminal),
      terminalToExitMs: delta(terminal, exited),
    };
  } finally {
    clearTimeout(timeout);
    clearTimeout(hardKill);
  }
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a,b) => a-b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid-1] + sorted[mid]) / 2);
}

try {
  const options = parseOptions(process.argv.slice(2));
  if (options.help || !options.execute) {
    process.stdout.write(USAGE);
  } else {
    process.stderr.write("Running real, potentially billable AGY requests. --dangerously-skip-permissions is enabled; work in a trusted directory.\n");
    const rows = [];
    for (let round=1;round<=options.rounds;round++) {
      for (const mode of round % 2 === 1 ? ["stdin", "print"] : ["print", "stdin"]) {
        const result = await run(mode, options, round);
        rows.push(result);
        process.stdout.write(JSON.stringify(result) + "\n");
        if (!result.success) {
          process.stderr.write("A run failed; stopping to avoid misleading comparisons. Inspect AGY logs privately.\n");
          process.exitCode = 1;
          break;
        }
      }
      if (process.exitCode) break;
    }
    const summary = Object.fromEntries(["stdin","print"].map(mode => {
      const r = rows.filter(row => row.mode === mode && row.success);
      return [mode, { count: r.length, medianElapsedMs: median(r.map(x=>x.elapsedMs)),
        medianSpawnToInitMs: median(r.map(x=>x.spawnToInitMs)),
        medianTerminalToExitMs: median(r.map(x=>x.terminalToExitMs)) }];
    }));
    process.stdout.write(JSON.stringify({ summary, warning: "Different harness settings, caches, process exit delays or model behavior can invalidate the comparison." }) + "\n");
  }
} catch (error) {
  process.stderr.write(`Benchmark error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
