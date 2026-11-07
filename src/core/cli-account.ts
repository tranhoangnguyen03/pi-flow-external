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
}
