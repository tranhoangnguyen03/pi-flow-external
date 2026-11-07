import { runCliProcess } from "./cli-process.ts";

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
    "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY",
  ],
  codex: ["CODEX_API_KEY", "OPENAI_API_KEY", "OPENAI_BASE_URL"],
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

/** Only called for an explicit source; inherit preserves native Pi/Flow behavior. */
export async function verifyCliChildAccount(
  backend: CliAccountBackend,
  account: CliChildAccount,
  cwd: string,
  signal?: AbortSignal,
): Promise<void> {
  if (account.source === "inherit") return;
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
