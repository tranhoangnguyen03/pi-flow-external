import { describe, expect, it } from "vitest";
import { buildPermissionArgs, permissionLabel, resolvePermission } from "../src/core/permissions.ts";
import { buildClaudeArgs } from "../src/core/claude.ts";
import { buildCodexArgs } from "../src/core/codex.ts";
import { buildAgyArgs } from "../src/core/agy.ts";
import type { SubagentProfile } from "../src/types.ts";

const profile = (backend: SubagentProfile["backend"]): SubagentProfile => ({
  name: `${backend}-agent`,
  description: "test",
  backend,
});

describe("permission tier argv mapping", () => {
  it("maps every tier onto native claude permission modes", () => {
    expect(buildPermissionArgs("readonly", "claude")).toEqual(["--permission-mode", "plan"]);
    expect(buildPermissionArgs("edit", "claude")).toEqual(["--permission-mode", "acceptEdits"]);
    expect(buildPermissionArgs("danger", "claude", { effectiveUid: 501 })).toEqual(["--dangerously-skip-permissions"]);
    // root keeps the auto fallback
    expect(buildPermissionArgs("danger", "claude", { effectiveUid: 0 })).toEqual(["--permission-mode", "auto"]);
  });

  it("uses a single sandbox axis for codex and never the bypass flag", () => {
    expect(buildPermissionArgs("readonly", "codex")).toEqual(["--sandbox", "read-only"]);
    expect(buildPermissionArgs("edit", "codex")).toEqual(["--sandbox", "workspace-write"]);
    expect(buildPermissionArgs("danger", "codex")).toEqual(["--sandbox", "danger-full-access"]);
  });

  it("omits the agy bypass flag for safer tiers and keeps it for danger", () => {
    expect(buildPermissionArgs("readonly", "agy")).toEqual([]);
    expect(buildPermissionArgs("edit", "agy")).toEqual([]);
    expect(buildPermissionArgs("danger", "agy")).toEqual(["--dangerously-skip-permissions"]);
  });

  it("threads tiers and budget through buildClaudeArgs", () => {
    const base = buildClaudeArgs({ profile: profile("claude"), thinkingLevel: undefined, permission: "edit" });
    expect(base).toContain("--permission-mode");
    expect(base).toContain("acceptEdits");
    expect(base).toContain("--no-session-persistence");
    expect(base).not.toContain("--max-budget-usd");

    const withBudget = buildClaudeArgs({
      profile: profile("claude"),
      thinkingLevel: undefined,
      permission: "danger",
      maxBudgetUsd: 3.5,
      effectiveUid: 501,
    });
    expect(withBudget).toContain("--max-budget-usd");
    expect(withBudget).toContain("3.5");

    const resumed = buildClaudeArgs({
      profile: profile("claude"),
      thinkingLevel: undefined,
      permission: "danger",
      resumeSessionId: "sess-123",
      effectiveUid: 501,
    });
    expect(resumed).toContain("--resume");
    expect(resumed).toContain("sess-123");
    expect(resumed).not.toContain("--no-session-persistence");
  });

  it("threads tiers and resume through buildCodexArgs", () => {
    const readonly = buildCodexArgs({ prompt: "p", profile: profile("codex"), thinkingLevel: undefined, permission: "readonly" });
    expect(readonly).toContain("read-only");
    expect(readonly).not.toContain("--dangerously-bypass-approvals-and-sandbox");

    const resumed = buildCodexArgs({
      prompt: "p",
      profile: profile("codex"),
      thinkingLevel: undefined,
      permission: "danger",
      resumeSessionId: "thread-9",
    });
    expect(resumed.slice(0, 4)).toEqual(["exec", "resume", "thread-9", "--json"]);
    expect(resumed).toContain("danger-full-access");
  });

  it("threads tiers and conversation resume through buildAgyArgs", () => {
    const edit = buildAgyArgs({ profile: profile("agy"), thinkingLevel: undefined, permission: "edit" });
    expect(edit).not.toContain("--dangerously-skip-permissions");

    const resumed = buildAgyArgs({
      profile: profile("agy"),
      thinkingLevel: undefined,
      permission: "danger",
      resumeConversationId: "conv-1",
    });
    expect(resumed).toContain("--conversation");
    expect(resumed).toContain("conv-1");
    expect(resumed).toContain("--dangerously-skip-permissions");
  });
});

describe("tier enforcement resolution", () => {
  it("marks unsupported agy readonly as advisory, never a launch failure", () => {
    const readonly = resolvePermission("readonly", "agy");
    expect(readonly.enforced).toBe(false);
    expect(permissionLabel(readonly)).toContain("advisory, not enforced");

    const edit = resolvePermission("edit", "agy");
    expect(edit.enforced).toBe(true);
  });

  it("keeps danger labels unchanged and claude/codex tiers enforced", () => {
    expect(permissionLabel(resolvePermission("danger", "claude"))).toBe("unsandboxed external CLI");
    expect(resolvePermission("readonly", "claude").enforced).toBe(true);
    expect(resolvePermission("edit", "codex").enforced).toBe(true);
    expect(permissionLabel(resolvePermission("readonly", "claude"))).toContain("readonly");
  });
});
