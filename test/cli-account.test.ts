import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { classifyCliLogin, resolveCliChildAccount, verifyCliChildAccount } from "../src/core/cli-account.ts";
import { runCliProcess } from "../src/core/cli-process.ts";

const roots: string[] = [];
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });

function fakeCliDirectory(): string {
  const dir = mkdtempSync(join(tmpdir(), "flow-auth-"));
  roots.push(dir);
  for (const command of ["claude", "codex"]) {
    const executable = join(dir, command);
    const code = [
      "#!/usr/bin/env node",
      "const name = process.argv[1].split(/[\\/]/).at(-1);",
      "const requested = process.argv.slice(2).join(\" \");",
      "if (requested === \"auth status --json\" && name === \"claude\") {",
      "  console.log(JSON.stringify({loggedIn:true,authMethod:process.env.FAKE_CLAUDE_METHOD || \"oauth_token\"}));",
      "} else if (requested === \"login status\" && name === \"codex\") {",
      "  console.error(process.env.FAKE_CODEX_STATUS || \"Logged in using ChatGPT\");",
      "} else {",
      "  console.log(JSON.stringify({selected:process.env.CLAUDE_CONFIG_DIR || process.env.CODEX_HOME, key:process.env.ANTHROPIC_API_KEY || process.env.CODEX_API_KEY || null}));",
      "}",
    ].join("\n");
    writeFileSync(executable, code); chmodSync(executable, 0o755);
  }
  return dir;
}

describe("installed shell external CLI account contract", () => {
  it("inherits host login, profile directories and env unchanged by default", () => {
    const parent = { ANTHROPIC_API_KEY: "api", CLAUDE_CONFIG_DIR: "/host claude", CODEX_HOME: "/host codex" };
    for (const backend of ["claude", "codex"] as const) {
      const child = resolveCliChildAccount(backend, parent);
      expect(child).toEqual({ source: "inherit", env: parent });
      expect(child.env).not.toBe(parent);
    }
  });

  it("keeps explicit API source intact, including an intentional shared API key", () => {
    const env = { PI_EXTERNAL_CLAUDE_AUTH_SOURCE: "api", ANTHROPIC_API_KEY: "same-key" };
    expect(resolveCliChildAccount("claude", env)).toEqual({ source: "api", env });
  });

  it("drops inherited API/proxy override variables only for the subscription child", () => {
    const parent = {
      PI_EXTERNAL_CLAUDE_AUTH_SOURCE: "subscription", PI_EXTERNAL_CODEX_AUTH_SOURCE: "subscription",
      CLAUDE_CONFIG_DIR: "/profiles/Claude A", CODEX_HOME: "/profiles/Codex B",
      ANTHROPIC_API_KEY: "anthropic-key", ANTHROPIC_AUTH_TOKEN: "token", ANTHROPIC_BASE_URL: "proxy",
      CLAUDE_CODE_USE_BEDROCK: "1", CLAUDE_CODE_USE_VERTEX: "1", CLAUDE_CODE_USE_FOUNDRY: "1",
      CODEX_API_KEY: "codex-key", OPENAI_API_KEY: "openai-key", OPENAI_BASE_URL: "proxy",
    };
    const claude = resolveCliChildAccount("claude", parent);
    const codex = resolveCliChildAccount("codex", parent);
    expect(claude.env.CLAUDE_CONFIG_DIR).toBe("/profiles/Claude A");
    expect(codex.env.CODEX_HOME).toBe("/profiles/Codex B");
    for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"]) expect(claude.env[name]).toBeUndefined();
    for (const name of ["CODEX_API_KEY", "OPENAI_API_KEY", "OPENAI_BASE_URL"]) expect(codex.env[name]).toBeUndefined();
    expect(claude.env.CODEX_API_KEY).toBe("codex-key");
    expect(codex.env.ANTHROPIC_API_KEY).toBe("anthropic-key");
    expect(parent.ANTHROPIC_API_KEY).toBe("anthropic-key");
    expect(parent.CODEX_API_KEY).toBe("codex-key");
    expect(claude.env).not.toBe(codex.env);
  });

  it("rejects unknown source values instead of falling back", () => {
    expect(() => resolveCliChildAccount("claude", { PI_EXTERNAL_CLAUDE_AUTH_SOURCE: "random" })).toThrow(/Unsupported PI_EXTERNAL_CLAUDE_AUTH_SOURCE/);
  });

  it("classifies each CLI independently and fails closed on unrecognized methods", () => {
    expect(classifyCliLogin("claude", JSON.stringify({ loggedIn: true, authMethod: "oauth_token" }))).toBe("subscription");
    expect(classifyCliLogin("claude", JSON.stringify({ loggedIn: true, authMethod: "api_key" }))).toBe("api");
    expect(classifyCliLogin("claude", JSON.stringify({ loggedIn: false }))).toBe("none");
    expect(classifyCliLogin("claude", "not JSON")).toBe("unknown");
    expect(classifyCliLogin("codex", "", "Logged in using ChatGPT")).toBe("subscription");
    expect(classifyCliLogin("codex", "", "Logged in using an API key - hidden")).toBe("api");
    expect(classifyCliLogin("codex", "", "unexpected")).toBe("unknown");
  });

  it("runs subscription probes under each isolated home, without inherited API keys", async () => {
    const bin = fakeCliDirectory();
    const parent = {
      PATH: bin + ":" + (process.env.PATH || ""),
      PI_EXTERNAL_CLAUDE_AUTH_SOURCE: "subscription", PI_EXTERNAL_CODEX_AUTH_SOURCE: "subscription",
      CLAUDE_CONFIG_DIR: "/private/Claude One", CODEX_HOME: "/private/Codex Two",
      ANTHROPIC_API_KEY: "parent-key", CODEX_API_KEY: "parent-key",
    };
    const claude = resolveCliChildAccount("claude", parent);
    const codex = resolveCliChildAccount("codex", parent);
    await Promise.all([
      verifyCliChildAccount("claude", claude, bin),
      verifyCliChildAccount("codex", codex, bin),
    ]);
    const outputs = await Promise.all(["claude", "codex"].map(async (name, i) => {
      const account = i === 0 ? claude : codex;
      return runCliProcess({ label: name, command: name, args: ["exec"], cwd: bin, env: account.env, rawStdout: true });
    }));
    expect(JSON.parse(outputs[0].stdout || "{}")).toEqual({ selected: "/private/Claude One", key: null });
    expect(JSON.parse(outputs[1].stdout || "{}")).toEqual({ selected: "/private/Claude One", key: "parent-key" });
    expect(parent.ANTHROPIC_API_KEY).toBe("parent-key");
    expect(parent.CODEX_API_KEY).toBe("parent-key");
  });

  it("does not launch when explicit subscription resolves to an API login", async () => {
    const bin = fakeCliDirectory();
    const env = { PATH: bin + ":" + (process.env.PATH || ""), PI_EXTERNAL_CLAUDE_AUTH_SOURCE: "subscription", FAKE_CLAUDE_METHOD: "api_key" };
    const account = resolveCliChildAccount("claude", env);
    await expect(verifyCliChildAccount("claude", account, bin)).rejects.toThrow(/authentication mismatch/);
  });
});
