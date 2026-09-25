import { describe, expect, it, vi } from "vitest";
import { diagnoseCli, usageLimitHistory } from "../src/doctor.ts";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ok = (stdout = "1.2.3", stderr = "") => ({ code: 0, killed: false, stdout, stderr });

describe("doctor CLI diagnostics", () => {
  it("reads historical summaries only, scopes by project, and labels recovery and expired resets", async () => {
    const root = await mkdtemp(join(tmpdir(), "doctor-history-"));
    try {
      for (const [id, project, summary, finishedAt] of [
        ["run_limit", "/project", { backend: "agy", status: "error", usageLimit: { source: "agy.result.error", observedAt: "2020-01-01T00:00:00Z", resetsAt: "2020-01-01T01:00:00Z" } }, "2020-01-01T00:00:00Z"],
        ["run_success", "/project", { backend: "agy", status: "done" }, "2020-01-02T00:00:00Z"],
        ["run_other", "/other", { backend: "claude", status: "error", usageLimit: { source: "claude.rate_limit_event", observedAt: "2020-01-01T00:00:00Z" } }, "2020-01-01T00:00:00Z"],
      ] as const) {
        await mkdir(join(root, id));
        await writeFile(join(root, id, "summary.json"), JSON.stringify({ runId: id, metadata: { project }, summary, finishedAt }));
      }
      await mkdir(join(root, "run_broken"));
      await writeFile(join(root, "run_broken", "summary.json"), "broken");
      const text = await usageLimitHistory(root, "/project");
      expect(text).toContain("run_limit");
      expect(text).toContain("time passed");
      expect(text).toContain("later run succeeded");
      expect(text).toContain("1 missing, oversized, or unreadable");
      expect(text).not.toContain("run_other");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("reports configured login without exposing arbitrary CLI fields or environment values", async () => {
    const exec = vi.fn().mockResolvedValueOnce(ok()).mockResolvedValueOnce(ok(JSON.stringify({ loggedIn: true, authMethod: "oauth_token", email: "SECRET", apiKey: "SECRET" })));
    const text = await diagnoseCli(exec, "claude", { ANTHROPIC_API_KEY: "SECRET", ANTHROPIC_BASE_URL: "SECRET" });
    expect(text).toContain("login reported by CLI");
    expect(text).toContain("ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL");
    expect(text).not.toContain("SECRET");
    expect(exec.mock.calls.map(call => call[1])).toEqual([["--version"], ["auth", "status", "--json"]]);
  });

  it.each([
    ["Logged in using ChatGPT", "ChatGPT login"],
    ["Logged in using an API key - SECRET", "API key login"],
    ["SECRET unexpected", "unrecognized status"],
  ])("extracts only known Codex login categories: %s", async (status, expected) => {
    const exec = vi.fn().mockResolvedValueOnce(ok()).mockResolvedValueOnce(ok("", status));
    const text = await diagnoseCli(exec, "codex", {});
    expect(text).toContain(expected);
    expect(text).not.toContain("SECRET");
  });

  it.each([
    [{ code: 1, killed: false, stdout: "", stderr: "SECRET" }, "could not start"],
    [{ code: 1, killed: true, stdout: "SECRET", stderr: "" }, "timed out"],
  ])("does not expose failed process output", async (result, expected) => {
    const exec = vi.fn().mockResolvedValue(result);
    expect(await diagnoseCli(exec, "muse", {})).toContain(expected);
    expect(await diagnoseCli(exec, "muse", {})).not.toContain("SECRET");
  });

  it("contains missing-executable errors without leaking them", async () => {
    const exec = vi.fn().mockRejectedValue(Object.assign(new Error("SECRET"), { code: "ENOENT" }));
    expect(await diagnoseCli(exec, "agy", {})).toContain("not found");
  });

  it.each(["agy", "grok", "muse"] as const)("does not invent a login probe for %s", async backend => {
    const exec = vi.fn().mockResolvedValue(ok());
    const text = await diagnoseCli(exec, backend, { META_API_KEY: "SECRET", XAI_API_KEY: "SECRET" });
    expect(exec).toHaveBeenCalledTimes(1);
    expect(text).toContain("not verified");
    expect(text).toContain("Remaining allowance: unavailable");
    expect(text).not.toContain("SECRET");
  });

  it.each([
    [ok('{"loggedIn":false}'), "no login reported"],
    [ok("null"), "unrecognized status"],
    [{ ...ok("SECRET"), killed: true }, "status check timed out"],
    [{ ...ok("SECRET"), code: 1 }, "status check failed"],
  ])("handles unavailable Claude status safely", async (result, expected) => {
    const exec = vi.fn().mockResolvedValueOnce(ok()).mockResolvedValueOnce(result);
    expect(await diagnoseCli(exec, "claude", {})).toContain(expected);
  });
});
