import { open, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Summary-only, bounded reads: never scan potentially huge backend event logs.
export async function usageLimitHistory(directory: string, project: string, now = Date.now()): Promise<string> {
  const latest = new Map<string, { time: number; runId: string; reset?: number }>();
  const successes = new Map<string, number>();
  let skipped = 0;
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch { return "Usage-limit history: unavailable (run records could not be read)."; }
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^run_[A-Za-z0-9_-]{1,128}$/.test(entry.name)) continue;
    let file;
    try {
      file = await open(join(directory, entry.name, "summary.json"), "r");
      const buffer = Buffer.alloc(256 * 1024 + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length === buffer.length) { skipped++; continue; }
      const doc = JSON.parse(buffer.subarray(0, length).toString("utf8"));
      if (doc?.runId !== entry.name) { skipped++; continue; }
      const cwd = doc.metadata?.project ?? doc.metadata?.cwd;
      if (typeof cwd !== "string" || resolve(cwd) !== resolve(project)) continue;
      const summary = doc.summary;
      const harness = doc.metadata?.harness ?? summary?.backend;
      if (typeof harness !== "string" || !/^(claude|codex|agy|grok|muse|pi-[a-z0-9-]+)$/.test(harness)) continue;
      const finished = Date.parse(doc.finishedAt);
      if (summary?.status === "done" && Number.isFinite(finished)) successes.set(harness, Math.max(successes.get(harness) ?? 0, finished));
      const limit = summary?.usageLimit;
      if (summary?.status !== "error" || !limit || !["claude.rate_limit_event", "agy.result.error"].includes(limit.source)) continue;
      if (limit.source !== `${summary.backend}.${summary.backend === "claude" ? "rate_limit_event" : "result.error"}`) continue;
      const time = Date.parse(limit.observedAt);
      if (!Number.isFinite(time) || time > now) continue;
      const reset = typeof limit.resetsAt === "string" ? Date.parse(limit.resetsAt) : NaN;
      if (!latest.has(harness) || latest.get(harness)!.time < time) latest.set(harness, { time, runId: entry.name, ...(Number.isFinite(reset) ? { reset } : {}) });
    } catch { skipped++; }
    finally { await file?.close(); }
  }
  const lines = ["Usage-limit history (this project only; not a live account check):"];
  for (const [harness, limit] of latest) {
    const success = successes.get(harness);
    lines.push(`  ${harness}: limit reported ${new Date(limit.time).toISOString()} · ${limit.runId}${limit.reset === undefined ? "" : ` · reset ${new Date(limit.reset).toISOString()}${limit.reset <= now ? " (time passed)" : ""}`}${success !== undefined && success > limit.time ? " · a later run succeeded" : ""}. Current availability unverified.`);
  }
  if (!latest.size) lines.push("  No recorded limit evidence found. This does not mean allowance is available.");
  lines.push("  New Claude/Antigravity records can report limits; other backends and older records may not. Retained records only.");
  if (skipped) lines.push(`  ${skipped} missing, oversized, or unreadable summaries skipped.`);
  return lines.join("\n");
}

// Names only: values and raw CLI diagnostics can contain credentials.
const ENV_WARNINGS: Record<string, string[]> = {
  claude: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"],
  codex: ["CODEX_API_KEY", "OPENAI_API_KEY", "OPENAI_BASE_URL", "CODEX_HOME"],
  agy: [],
  grok: ["XAI_API_KEY"],
  muse: ["META_API_KEY"],
};

export async function diagnoseCli(exec: ExtensionAPI["exec"], backend: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const lines = [`${backend}:`];
  let available = false;
  try {
    const result = await exec(backend, ["--version"], { timeout: 10_000 });
    available = result.code === 0 && !result.killed;
    // Only display a version number, never echo arbitrary subprocess output.
    const version = (result.stdout || result.stderr).match(/\b\d+\.\d+\.\d+\b/)?.[0];
    lines.push(available
      ? `  CLI: available${version ? ` (${backend} ${version})` : ""}`
      : result.killed ? "  CLI: version check timed out" : "  CLI: could not start; check the installation with --version");
  } catch (error) {
    lines.push(error && typeof error === "object" && "code" in error && error.code === "ENOENT"
      ? "  CLI: not found; install it or check PATH"
      : "  CLI: check failed; check the installation with --version");
  }

  let login = "not verified (no supported status check)";
  if (!available) login = "not checked (CLI unavailable)";
  else if (backend === "claude" || backend === "codex") {
    try {
      const result = await exec(backend, backend === "claude" ? ["auth", "status", "--json"] : ["login", "status"], { timeout: 10_000 });
      login = result.killed ? "not verified (status check timed out)" : "not verified (status check failed)";
      if (!result.killed) {
        if (backend === "claude") {
          let status: unknown;
          try { status = JSON.parse(result.stdout); } catch { /* Unknown output stays unverified. */ }
          const loggedIn = status && typeof status === "object" && "loggedIn" in status ? status.loggedIn : undefined;
          if (loggedIn === false) login = "no login reported; use claude auth login if account login is intended";
          else if (result.code === 0) login = loggedIn === true ? "login reported by CLI; requests not tested" : "not verified (unrecognized status)";
        } else {
          const text = (result.stderr || result.stdout).trim();
          if (text === "Not logged in") login = "no login reported; use codex login if account login is intended";
          else if (result.code === 0) login = text === "Logged in using ChatGPT"
            ? "ChatGPT login reported by CLI; requests not tested"
            : /^Logged in using an API key(?: - [^\r\n]*)?$/.test(text)
              ? "API key login reported by CLI; requests not tested"
              : "not verified (unrecognized status)";
        }
      }
    } catch {
      login = "not verified (status check failed)";
    }
  }
  lines.push(`  Login: ${login}`);
  const set = (ENV_WARNINGS[backend] ?? []).filter(name => Boolean(env[name]));
  if (set.length) lines.push(`  Settings: ${set.join(", ")} set; inherited by child and may affect authentication or routing. Values hidden.`);
  lines.push("  Remaining allowance: unavailable (no quota request made)");
  return lines.join("\n");
}
