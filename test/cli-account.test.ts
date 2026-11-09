import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { diagnoseCli } from "../src/doctor.ts";
import { classifyCliLogin, codexSubscriptionRoutingProblem, resolveCliChildAccount, verifyCliChildAccount } from "../src/core/cli-account.ts";
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
      "const name = process.argv[1].split(\"/\").at(-1);",
      "const requested = process.argv.slice(2).join(\" \");",
      "if (requested === \"auth status --json\" && name === \"claude\") {",
      "  console.log(JSON.stringify({loggedIn:true,authMethod:process.env.FAKE_CLAUDE_METHOD || \"oauth_token\",email:process.env.FAKE_CLAUDE_EMAIL || \"fixture@example.test\"}));",
      "} else if (requested === \"login status\" && name === \"codex\") {",
      "  console.error(process.env.FAKE_CODEX_STATUS || \"Logged in using ChatGPT\");",
      "} else {",
      "  console.log(JSON.stringify({selected:name === \"claude\" ? process.env.CLAUDE_CONFIG_DIR : process.env.CODEX_HOME, key:name === \"claude\" ? process.env.ANTHROPIC_API_KEY || null : process.env.CODEX_API_KEY || null}));",
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
    const env = {
      PI_EXTERNAL_CLAUDE_AUTH_SOURCE: "api",
      ANTHROPIC_API_KEY: "same-key",
      CLAUDE_CODE_OAUTH_TOKEN: "wrong-account",
    };
    const child = resolveCliChildAccount("claude", env);
    expect(child.source).toBe("api");
    expect(child.env.ANTHROPIC_API_KEY).toBe("same-key");
    expect(child.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("wrong-account");
  });

  it("keeps selected Codex API key but rejects inherited alternate access token", () => {
    const parent = {
      PI_EXTERNAL_CODEX_AUTH_SOURCE: "api", CODEX_API_KEY: "api-key",
      CODEX_ACCESS_TOKEN: "wrong-workspace", OPENAI_FEDERATION_RULE_ID: "another-workload",
    };
    const child = resolveCliChildAccount("codex", parent);
    expect(child.source).toBe("api");
    expect(child.env.CODEX_API_KEY).toBe("api-key");
    expect(child.env.CODEX_ACCESS_TOKEN).toBeUndefined();
    expect(child.env.OPENAI_FEDERATION_RULE_ID).toBeUndefined();
    expect(parent.CODEX_ACCESS_TOKEN).toBe("wrong-workspace");
  });

  it("drops inherited API/proxy override variables only for the subscription child", () => {
    const parent = {
      PI_EXTERNAL_CLAUDE_AUTH_SOURCE: "subscription", PI_EXTERNAL_CODEX_AUTH_SOURCE: "subscription",
      CLAUDE_CONFIG_DIR: "/profiles/Claude A", CODEX_HOME: "/profiles/Codex B",
      ANTHROPIC_API_KEY: "anthropic-key", ANTHROPIC_AUTH_TOKEN: "token", ANTHROPIC_BASE_URL: "proxy",
      CLAUDE_CODE_OAUTH_TOKEN: "alternate-subscriber", CLAUDE_CODE_OAUTH_REFRESH_TOKEN: "alternate-refresh", CLAUDE_CODE_OAUTH_SCOPES: "wrong-scope",
      CLAUDE_CODE_USE_BEDROCK: "1", CLAUDE_CODE_USE_VERTEX: "1", CLAUDE_CODE_USE_FOUNDRY: "1",
      CODEX_API_KEY: "codex-key", OPENAI_API_KEY: "openai-key", OPENAI_BASE_URL: "proxy",
      CODEX_ACCESS_TOKEN: "other-chatgpt-account", OPENAI_FEDERATION_RULE_ID: "wrong-rule",
      OPENAI_IDENTITY_TOKEN_FILE: "/other/token", OPENAI_WORKLOAD_IDENTITY_CONTEXT: "not this account",
    };
    const claude = resolveCliChildAccount("claude", parent);
    const codex = resolveCliChildAccount("codex", parent);
    expect(claude.env.CLAUDE_CONFIG_DIR).toBe("/profiles/Claude A");
    expect(codex.env.CODEX_HOME).toBe("/profiles/Codex B");
    for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_REFRESH_TOKEN", "CLAUDE_CODE_OAUTH_SCOPES", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"]) expect(claude.env[name]).toBeUndefined();
    for (const name of ["CODEX_API_KEY", "OPENAI_API_KEY", "OPENAI_BASE_URL", "CODEX_ACCESS_TOKEN", "OPENAI_FEDERATION_RULE_ID", "OPENAI_IDENTITY_TOKEN_FILE", "OPENAI_WORKLOAD_IDENTITY_CONTEXT"]) expect(codex.env[name]).toBeUndefined();
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
    expect(JSON.parse(outputs[1].stdout || "{}")).toEqual({ selected: "/private/Codex Two", key: null });
    expect(parent.ANTHROPIC_API_KEY).toBe("parent-key");
    expect(parent.CODEX_API_KEY).toBe("parent-key");
  });

  it("fails the requested Claude identity check even when OAuth authMethod matches", async () => {
    const bin = fakeCliDirectory();
    const env = {
      PATH: bin + ":" + (process.env.PATH || ""),
      PI_EXTERNAL_CLAUDE_AUTH_SOURCE: "subscription",
      PI_EXTERNAL_CLAUDE_EXPECTED_EMAIL: "expected@example.test",
      FAKE_CLAUDE_EMAIL: "different@example.test",
    };
    await expect(verifyCliChildAccount("claude", resolveCliChildAccount("claude", env), bin))
      .rejects.toThrow(/does not match the expected identity/);
  });

  it("holds separate homes for concurrent Claude children within the same parent", async () => {
    const bin = fakeCliDirectory();
    const base = {
      PATH: bin + ":" + (process.env.PATH || ""),
      PI_EXTERNAL_CLAUDE_AUTH_SOURCE: "subscription", ANTHROPIC_API_KEY: "parent-api",
    };
    const profiles = ["/subscriber/alpha", "/subscriber/beta"].map(home =>
      resolveCliChildAccount("claude", { ...base, CLAUDE_CONFIG_DIR: home }));
    const results = await Promise.all(profiles.map(async account => {
      await verifyCliChildAccount("claude", account, bin);
      return runCliProcess({ label: "claude", command: "claude", args: ["exec"], cwd: bin, env: account.env, rawStdout: true });
    }));
    expect(results.map(r => JSON.parse(r.stdout || "{}").selected)).toEqual(["/subscriber/alpha", "/subscriber/beta"]);
    expect(results.map(r => JSON.parse(r.stdout || "{}").key)).toEqual([null, null]);
    expect(base.ANTHROPIC_API_KEY).toBe("parent-api");
  });

  it("doctor probes the effective child account, reporting excluded overrides without leaking values", async () => {
    const bin = fakeCliDirectory();
    const parent = {
      PATH: bin + ":" + (process.env.PATH || ""),
      PI_EXTERNAL_CLAUDE_AUTH_SOURCE: "subscription",
      CLAUDE_CONFIG_DIR: "/private/doctor", ANTHROPIC_API_KEY: "SECRET API",
      CLAUDE_CODE_OAUTH_TOKEN: "SECRET SUBSCRIBER",
    };
    const parentExec = vi.fn().mockRejectedValue(new Error("parent exec must not be used for explicit source"));
    const report = await diagnoseCli(parentExec, "claude", parent);
    expect(parentExec).not.toHaveBeenCalled();
    expect(report).toContain("Child auth method: subscription reported by CLI");
    expect(report).toContain("Child settings: CLAUDE_CONFIG_DIR set");
    expect(report).toContain("Excluded from child: ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN");
    expect(report).not.toContain("SECRET");
  });

  it("checks Codex effective provider routing independently from login status", () => {
    for (const config of [
      "",
      "# openai_base_url = 'https://unused.invalid/v1'",
      "model = 'gpt-5.6'\nmodel_provider = 'openai'",
      "[model_providers.proxy]\nbase_url = 'https://example.invalid'",
    ]) {
      expect(codexSubscriptionRoutingProblem(config)).toBeUndefined();
    }
    for (const [config, problem] of [
      ["openai_base_url = 'https://proxy.invalid/v1'", "custom endpoint"],
      ["'chatgpt_base_url' = 'https://other.invalid'", "custom endpoint"],
      ["model_provider = 'proxy'", "nondefault model provider"],
      ['"model_provider" = "other"', "nondefault model provider"],
      ["profile = 'proxy-profile'", "selected config profile"],
    ] as const) {
      expect(codexSubscriptionRoutingProblem(config)).toBe(problem);
    }
  });

  it("refuses redirected Codex subscription configuration before exec despite ChatGPT login", async () => {
    const bin = fakeCliDirectory();
    const home = mkdtempSync(join(tmpdir(), "flow-codex-redirect-"));
    roots.push(home);
    writeFileSync(join(home, "config.toml"), 'openai_base_url = "https://alternate.invalid/v1"\n');
    const selected = resolveCliChildAccount("codex", {
      PATH: bin + ":" + (process.env.PATH || ""),
      PI_EXTERNAL_CODEX_AUTH_SOURCE: "subscription",
      CODEX_HOME: home,
      CODEX_API_KEY: "wrong-api",
    });
    await expect(verifyCliChildAccount("codex", selected, bin))
      .rejects.toThrow(/subscription routing cannot be confirmed.*custom endpoint/);
    expect(selected.env.CODEX_API_KEY).toBeUndefined();
  });

  it("accepts implicit/default OpenAI provider for a Codex subscription login", async () => {
    const bin = fakeCliDirectory();
    const home = mkdtempSync(join(tmpdir(), "flow-codex-default-"));
    roots.push(home);
    writeFileSync(join(home, "config.toml"), 'model_provider = "openai"\nmodel = "gpt-5.6"\n');
    const selected = resolveCliChildAccount("codex", {
      PATH: bin + ":" + (process.env.PATH || ""),
      PI_EXTERNAL_CODEX_AUTH_SOURCE: "subscription",
      CODEX_HOME: home,
      OPENAI_API_KEY: "parent-key",
    });
    await expect(verifyCliChildAccount("codex", selected, bin)).resolves.toBeUndefined();
  });

  it("does not launch when explicit subscription resolves to an API login", async () => {
    const bin = fakeCliDirectory();
    const env = { PATH: bin + ":" + (process.env.PATH || ""), PI_EXTERNAL_CLAUDE_AUTH_SOURCE: "subscription", FAKE_CLAUDE_METHOD: "api_key" };
    const account = resolveCliChildAccount("claude", env);
    await expect(verifyCliChildAccount("claude", account, bin)).rejects.toThrow(/authentication mismatch/);
  });
});
