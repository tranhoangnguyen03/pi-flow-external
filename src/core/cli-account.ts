import { runCliProcess } from "./cli-process.ts";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

/** The shell chooses an account source. Flow only applies it to one CLI child. */
export type CliAccountBackend = "claude" | "codex";
export type CliAuthSource = "inherit" | "subscription" | "api";

const SOURCE_VARIABLES: Record<CliAccountBackend, string> = {
  claude: "PI_EXTERNAL_CLAUDE_AUTH_SOURCE",
  codex: "PI_EXTERNAL_CODEX_AUTH_SOURCE",
};

const SUBSCRIPTION_BLOCKED_ENV: Record<CliAccountBackend, readonly string[]> = {
  claude: [
    "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_REFRESH_TOKEN", "CLAUDE_CODE_OAUTH_SCOPES",
    "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY",
  ],
  codex: [
    "CODEX_API_KEY", "OPENAI_API_KEY", "OPENAI_BASE_URL", "CODEX_ACCESS_TOKEN",
    "OPENAI_FEDERATION_RULE_ID", "OPENAI_IDENTITY_TOKEN_FILE", "OPENAI_WORKLOAD_IDENTITY_CONTEXT",
  ],
};

export interface CliChildAccount {
  source: CliAuthSource;
  /** A new object, never process.env; safe for concurrent children. */
  env: NodeJS.ProcessEnv;
}

export function resolveCliChildAccount(backend: CliAccountBackend, inherited: NodeJS.ProcessEnv = process.env): CliChildAccount {
  const setting = SOURCE_VARIABLES[backend];
  const raw = inherited[setting];
  if (raw !== undefined && raw !== "" && raw !== "inherit" && raw !== "subscription" && raw !== "api") {
    throw new Error("Unsupported " + setting + " value; expected inherit, subscription, or api");
  }
  const source: CliAuthSource = (raw || "inherit") as CliAuthSource;
  const env = { ...inherited };
  if (source === "subscription") {
    for (const name of SUBSCRIPTION_BLOCKED_ENV[backend]) delete env[name];
  } else if (source === "api") {
    // An explicitly selected API key must not accidentally reuse an unrelated
    // subscriber's OAuth token or a different workload identity. Stored CLI
    // API login remains available if no direct API key was configured.
    const alternateAuth = backend === "claude"
      ? ["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_REFRESH_TOKEN", "CLAUDE_CODE_OAUTH_SCOPES"]
      : ["CODEX_ACCESS_TOKEN", "OPENAI_FEDERATION_RULE_ID", "OPENAI_IDENTITY_TOKEN_FILE", "OPENAI_WORKLOAD_IDENTITY_CONTEXT"];
    for (const name of alternateAuth) delete env[name];
  }
  return { source, env };
}

/** Only allow a recognized CLI status to certify an explicit billing source. */
export function classifyCliLogin(backend: CliAccountBackend, stdout: string, stderr = ""): "subscription" | "api" | "none" | "unknown" {
  if (backend === "claude") {
    let payload: unknown;
    try { payload = JSON.parse(stdout); } catch { return "unknown"; }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return "unknown";
    const status = payload as Record<string, unknown>;
    if (status.loggedIn === false) return "none";
    if (status.loggedIn !== true || typeof status.authMethod !== "string") return "unknown";
    const method = status.authMethod.toLowerCase();
    if (method === "api_key" || method === "apikey" || method === "api-key") return "api";
    if (["oauth_token", "oauth", "claude.ai", "claude_ai", "subscription"].includes(method)) return "subscription";
    return "unknown";
  }
  const status = (stderr || stdout).trim();
  if (status === "Logged in using ChatGPT") return "subscription";
  if (/^Logged in using an API key(?: - [^\r\n]*)?$/.test(status)) return "api";
  if (status === "Not logged in") return "none";
  return "unknown";
}

/**
 * Codex's login status reports the stored login type, but config.toml can
 * redirect the builtin provider to another endpoint. Do not assert an
 * explicit ChatGPT subscription source while the effective route is unclear.
 *
 * This is a conservative guard, not a TOML account manager: the shell owns
 * account profiles. Unused provider definitions are allowed; active provider,
 * endpoint, and config-profile overrides are not.
 */
export function codexSubscriptionRoutingProblem(toml: string): string | undefined {
  let table = "";
  for (const line of toml.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const heading = /^\[([^\]]+)\]\s*(?:#.*)?$/.exec(trimmed);
    if (heading) {
      table = heading[1].trim();
      continue;
    }
    // Only root values apply without --profile, which Flow does not set.
    // A selected profile itself must be rejected, as it loads other config
    // files and would require a full Codex config resolution to verify.
    if (table) continue;
    const redirect = /^(?:openai_base_url|chatgpt_base_url)\s*=/.test(trimmed);
    if (redirect) return "custom endpoint";
    const provider = /^model_provider\s*=\s*(.*)$/.exec(trimmed);
    if (provider && !/^(?:"openai"|'openai')\s*(?:#.*)?$/.test(provider[1])) {
      return "nondefault model provider";
    }
    if (/^profile\s*=/.test(trimmed)) return "selected config profile";
  }
  return undefined;
}

async function verifyCodexSubscriptionRoute(env: NodeJS.ProcessEnv): Promise<void> {
  const home = env.CODEX_HOME ?? join(env.HOME || homedir(), ".codex");
  if (!isAbsolute(home)) {
    throw new Error("Codex subscription selection requires an absolute CODEX_HOME path");
  }
  let config: string;
  try {
    config = await readFile(join(home, "config.toml"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error("Codex subscription configuration could not be checked; task was not launched");
  }
  const problem = codexSubscriptionRoutingProblem(config);
  if (problem) {
    throw new Error("Codex subscription routing cannot be confirmed (" + problem + "); use a clean CODEX_HOME or explicitly select inherit/API. Task was not launched");
  }
}

/** Only called for an explicit source; inherit preserves native Pi/Flow behavior. */
export async function verifyCliChildAccount(
  backend: CliAccountBackend,
  account: CliChildAccount,
  cwd: string,
  signal?: AbortSignal,
): Promise<void> {
  if (account.source === "inherit") return;
  if (backend === "codex" && account.source === "subscription") {
    await verifyCodexSubscriptionRoute(account.env);
  }
  // These are the documented direct-API override paths. A login status probe
  // can still report a stored subscription even though exec uses this key.
  if (account.source === "api" && (
    (backend === "claude" && Boolean(account.env.ANTHROPIC_API_KEY || account.env.ANTHROPIC_AUTH_TOKEN)) ||
    (backend === "codex" && Boolean(account.env.CODEX_API_KEY))
  )) return;
  const args = backend === "claude" ? ["auth", "status", "--json"] : ["login", "status"];
  const result = await runCliProcess({
    label: backend + " authentication check", command: backend, args, cwd,
    env: account.env, signal, rawStdout: true, maxStdoutChars: 16_384,
  });
  if (result.code !== 0) throw new Error(backend + " authentication cannot be confirmed for explicit " + account.source + " selection");
  const actual = classifyCliLogin(backend, result.stdout ?? "", result.stderr);
  if (actual !== account.source) {
    throw new Error(backend + " authentication mismatch: selected " + account.source + ", CLI reported " + actual + "; task was not launched");
  }
  // Claude exposes a reported account email on some CLI versions. The shell
  // may provide an expected identity without giving Flow access to secrets.
  // Codex login status does not reliably expose account identity.
  const expectedEmail = backend === "claude" ? account.env.PI_EXTERNAL_CLAUDE_EXPECTED_EMAIL : undefined;
  if (expectedEmail) {
    let reported: unknown;
    try { reported = JSON.parse(result.stdout ?? ""); } catch { /* Already classified above. */ }
    const email = reported && typeof reported === "object" && !Array.isArray(reported)
      ? (reported as Record<string, unknown>).email : undefined;
    if (typeof email !== "string" || email.trim().toLowerCase() !== expectedEmail.trim().toLowerCase()) {
      throw new Error("claude selected subscription account does not match the expected identity; task was not launched");
    }
  }
}
