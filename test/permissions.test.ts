import { describe, expect, it } from "vitest";
import {
  buildPermissionArgs,
  permissionLabel,
  resolveEffectivePermissionTier,
  resolvePermission,
  unsupportedPermissionReason,
} from "../src/core/permissions.ts";
import { buildClaudeArgs } from "../src/core/claude.ts";
import { buildCodexArgs } from "../src/core/codex.ts";
import { buildAgyArgs } from "../src/core/agy.ts";
import { renderCompactSubagentNode } from "../src/core/subagent-render.ts";
import { normalizeAgentOptions } from "../src/workflow/runtime-values.ts";
import { Theme } from "@earendil-works/pi-coding-agent";
import type { SubagentProfile } from "../src/types.ts";

function fakeTheme() {
  const theme = new Theme({} as never, {} as never, "truecolor");
  (theme as unknown as { fg: (color: string, text: string) => string }).fg = (_color, text) => text;
  (theme as unknown as { bold: (text: string) => string }).bold = (text) => text;
  return theme;
}

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

  it("passes the agy bypass flag only for danger and rejects narrower tiers", () => {
    expect(buildPermissionArgs("danger", "agy")).toEqual(["--dangerously-skip-permissions"]);
    expect(() => buildPermissionArgs("readonly", "agy")).toThrow(/autonomous/);
    expect(() => buildPermissionArgs("edit", "agy")).toThrow(/autonomous/);
  });

  it("maps every tier onto native grok sandbox flags plus the bypass permission mode", () => {
    expect(buildPermissionArgs("readonly", "grok")).toEqual(["--sandbox", "read-only", "--permission-mode", "bypassPermissions"]);
    expect(buildPermissionArgs("edit", "grok")).toEqual(["--sandbox", "workspace", "--permission-mode", "bypassPermissions"]);
    expect(buildPermissionArgs("danger", "grok")).toEqual(["--sandbox", "off", "--permission-mode", "bypassPermissions"]);
  });

  it("maps every tier onto native muse approval/sandbox flags", () => {
    expect(buildPermissionArgs("readonly", "muse")).toEqual(["--disable-approval", "--disable-write", "--disable-shell"]);
    expect(buildPermissionArgs("edit", "muse")).toEqual(["--disable-approval"]);
    expect(buildPermissionArgs("danger", "muse")).toEqual(["--yolo"]);
  });

  it("threads tiers and budget through buildClaudeArgs", () => {
    const base = buildClaudeArgs({ profile: profile("claude"), thinkingLevel: undefined, permission: "edit" });
    expect(base).toContain("--permission-mode");
    expect(base).toContain("acceptEdits");
    // Sessions persist by default so recorded session ids stay resumable.
    expect(base).not.toContain("--no-session-persistence");
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
    // Non-resume runs also persist now: --no-session-persistence is gone entirely.
    expect(base).not.toContain("--no-session-persistence");
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
    // Sandbox flags must precede the resume subcommand (codex-cli rejects them after it).
    expect(resumed.slice(0, 5)).toEqual(["exec", "--sandbox", "danger-full-access", "resume", "thread-9"]);
    expect(resumed).toContain("--json");
    const resumedReadonly = buildCodexArgs({
      prompt: "p",
      profile: profile("codex"),
      thinkingLevel: undefined,
      permission: "readonly",
      resumeSessionId: "thread-9",
    });
    expect(resumedReadonly.slice(0, 3)).toEqual(["exec", "--sandbox", "read-only"]);
  });

  it("threads danger and conversation resume through buildAgyArgs", () => {
    expect(() => buildAgyArgs({ profile: profile("agy"), thinkingLevel: undefined, permission: "edit" })).toThrow(/autonomous/);

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

  it("locks exact codex argv for every tier in normal and resume forms", () => {
    const base = (permission: "readonly" | "edit" | "danger") =>
      buildCodexArgs({ prompt: "p", profile: profile("codex"), thinkingLevel: undefined, permission });
    expect(base("readonly")).toEqual([
      "exec", "--json", "--skip-git-repo-check", "--sandbox", "read-only", "--", "-",
    ]);
    expect(base("edit")).toEqual([
      "exec", "--json", "--skip-git-repo-check", "--sandbox", "workspace-write", "--", "-",
    ]);
    expect(base("danger")).toEqual([
      "exec", "--json", "--skip-git-repo-check", "--sandbox", "danger-full-access", "--", "-",
    ]);
    const resumed = (permission: "readonly" | "edit" | "danger") =>
      buildCodexArgs({
        prompt: "p",
        profile: profile("codex"),
        thinkingLevel: undefined,
        permission,
        resumeSessionId: "thread-9",
      });
    expect(resumed("readonly")).toEqual([
      "exec", "--sandbox", "read-only", "resume", "thread-9", "--json", "--skip-git-repo-check", "--", "-",
    ]);
    expect(resumed("edit")).toEqual([
      "exec", "--sandbox", "workspace-write", "resume", "thread-9", "--json", "--skip-git-repo-check", "--", "-",
    ]);
    expect(resumed("danger")).toEqual([
      "exec", "--sandbox", "danger-full-access", "resume", "thread-9", "--json", "--skip-git-repo-check", "--", "-",
    ]);
  });

  it("rejects non-finite workflow budget options", () => {
    for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => normalizeAgentOptions({ max_budget_usd: invalid })).toThrow(/finite/);
    }
    expect(normalizeAgentOptions({ max_budget_usd: 1.5 }).maxBudgetUsd).toBe(1.5);
  });

  it("accepts workflow agent() description as a compatible alias for label", () => {
    expect(normalizeAgentOptions({ description: "review the diff" }).label).toBe("review the diff");
    expect(normalizeAgentOptions({ label: "review" }).label).toBe("review");
    // Same value on both is fine (not a conflict).
    expect(normalizeAgentOptions({ label: "review", description: "review" }).label).toBe("review");
    // Conflicting values are rejected rather than silently preferring one.
    expect(() => normalizeAgentOptions({ label: "review", description: "map" })).toThrow(/both label and description/);
  });

  it("renders tier, denial, and budget disclosure tags on receipts", () => {
    const toText = (component: { render: (width: number) => string[] }) => (component.render(100) ?? []).join("\n");
    // Synthetic advisory-tier node: exercises the renderer's generic capability.
    // Real agy runs always resolve to danger, so this shape is not a live agy state.
    const node = {
      backend: "agy" as const,
      status: "done" as const,
      subagentType: "agy-reviewer",
      description: "task",
      permission: "readonly" as const,
      permissionEnforced: false,
      permissionDenials: 2,
      maxBudgetUsd: 4,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, costKnown: true },
      startedAt: Date.now() - 1000,
      endedAt: Date.now(),
    };
    const text = toText(renderCompactSubagentNode(node, fakeTheme(), 0, "", 0, false));
    expect(text).toContain("readonly (advisory)");
    expect(text).toContain("2 permission denials");
    expect(text).toContain("budget unenforceable");
    const claudeNode = { ...node, backend: "claude" as const, permission: "danger" as const };
    delete (claudeNode as Record<string, unknown>).permissionEnforced;
    delete (claudeNode as Record<string, unknown>).permissionDenials;
    const claudeText = toText(renderCompactSubagentNode(claudeNode, fakeTheme(), 0, "", 0, false));
    expect(claudeText).not.toContain("advisory");
    expect(claudeText).not.toContain("budget unenforceable");
  });
});

describe("tier enforcement resolution", () => {
  it("marks agy readonly/edit as unsupported rather than an unsandboxed success", () => {
    const readonly = resolvePermission("readonly", "agy");
    expect(readonly.enforced).toBe(false);
    expect(readonly.caveat).toContain("unsupported");
    const agyReadonly = unsupportedPermissionReason("readonly", "agy");
    expect(agyReadonly).toMatch(/permission "danger"/);
    expect(agyReadonly).toMatch(/defaultPermission/);
    expect(agyReadonly).not.toMatch(/omit/i);
    expect(unsupportedPermissionReason("danger", "agy")).toBeUndefined();
    expect(unsupportedPermissionReason("readonly", "claude")).toBeUndefined();
  });

  it("keeps danger labels unchanged and claude/codex tiers enforced", () => {
    expect(permissionLabel(resolvePermission("danger", "claude"))).toBe("unsandboxed external CLI");
    expect(resolvePermission("readonly", "claude").enforced).toBe(true);
    expect(resolvePermission("edit", "codex").enforced).toBe(true);
    expect(permissionLabel(resolvePermission("readonly", "claude"))).toContain("readonly");
  });

  it("resolves grok as enforced at every tier with an accurate sandbox caveat", () => {
    const readonly = resolvePermission("readonly", "grok");
    expect(readonly.enforced).toBe(true);
    expect(readonly.caveat).toContain("kernel sandbox");
    expect(readonly.caveat).toContain("Linux-only");

    const edit = resolvePermission("edit", "grok");
    expect(edit.enforced).toBe(true);
    expect(edit.caveat).toContain("workspace");

    const danger = resolvePermission("danger", "grok");
    expect(danger.enforced).toBe(true);
    expect(danger.caveat).toBeUndefined();
    expect(permissionLabel(danger)).toBe("unsandboxed external CLI");
  });

  it("resolves muse as enforced at every tier with an accurate approval/sandbox caveat", () => {
    const readonly = resolvePermission("readonly", "muse");
    expect(readonly.enforced).toBe(true);
    expect(readonly.caveat).toContain("disables approval");
    expect(readonly.caveat).toContain("shell execution");

    const edit = resolvePermission("edit", "muse");
    expect(edit.enforced).toBe(true);
    expect(edit.caveat).toContain("sandbox stays enabled");

    const danger = resolvePermission("danger", "muse");
    expect(danger.enforced).toBe(true);
    expect(danger.caveat).toBeUndefined();
    expect(permissionLabel(danger)).toBe("unsandboxed external CLI");
  });

  it("discloses opencode restricted tiers as application rules, not an OS sandbox", () => {
    for (const tier of ["readonly", "edit"] as const) {
      const resolution = resolvePermission(tier, "opencode");
      expect(resolution.enforced).toBe(true);
      expect(permissionLabel(resolution)).toContain("not an OS sandbox");
    }
    expect(permissionLabel(resolvePermission("danger", "opencode"))).toBe("unsandboxed external CLI");
  });

  it("drops non-finite budgets instead of emitting them as CLI flags", () => {
    const args = buildClaudeArgs({
      profile: profile("claude"),
      thinkingLevel: undefined,
      permission: "danger",
      maxBudgetUsd: Number.POSITIVE_INFINITY,
      effectiveUid: 501,
    });
    expect(args).not.toContain("--max-budget-usd");
  });
});

describe("effective permission tier resolution", () => {
  it("uses the explicit call tier, otherwise the supplied default, and ignores the profile", () => {
    const reviewer: SubagentProfile = { name: "claude-reviewer", description: "review", backend: "claude" };
    const worker: SubagentProfile = { name: "claude-worker", description: "work", backend: "claude" };
    expect(resolveEffectivePermissionTier("readonly", reviewer)).toBe("readonly");
    expect(resolveEffectivePermissionTier("edit", worker)).toBe("edit");
    expect(resolveEffectivePermissionTier("danger", worker, "readonly")).toBe("danger");
    expect(resolveEffectivePermissionTier(undefined, reviewer, "edit")).toBe("edit");
    expect(resolveEffectivePermissionTier(undefined, undefined)).toBe("danger");
    expect(resolveEffectivePermissionTier("readonly", { name: "agy-explorer", description: "explore", backend: "agy" })).toBe("readonly");
  });
});

describe("pi backend permission disclosure", () => {
  it("resolves pi as enforced with a curated-tools caveat below danger", () => {
    const readonly = resolvePermission("readonly", "pi");
    expect(readonly.enforced).toBe(true);
    expect(readonly.backend).toBe("pi");
    expect(readonly.caveat).toContain("tools only");

    const danger = resolvePermission("danger", "pi");
    expect(danger.caveat).toBeUndefined();
  });

  it("names exactly the tools active at each pi tier, never overstating it as the full builtin set", () => {
    // readonly/edit must never claim bash is available (it is excluded at
    // both tiers); the caveat is the single disclosure surface a parent
    // agent reads to know what a delegated pi child can actually do, so an
    // inaccurate caveat is a real trust/UX bug, not cosmetic prose.
    const readonly = resolvePermission("readonly", "pi");
    expect(readonly.caveat).toContain("read/grep/find/ls");
    expect(readonly.caveat).not.toContain("bash");
    expect(readonly.caveat).not.toContain("write");

    const edit = resolvePermission("edit", "pi");
    expect(edit.caveat).toContain("read/grep/find/ls/edit/write");
    expect(edit.caveat).not.toContain("bash");

    // danger carries no caveat (nothing to disclose beyond what any other
    // backend's danger tier already means: full host access).
    expect(resolvePermission("danger", "pi").caveat).toBeUndefined();
  });

  it("never describes a pi child as an external CLI", () => {
    const dangerLabel = permissionLabel(resolvePermission("danger", "pi"));
    expect(dangerLabel).not.toContain("external CLI");
    expect(dangerLabel).toContain("Pi SDK child");

    const readonlyLabel = permissionLabel(resolvePermission("readonly", "pi"));
    expect(readonlyLabel).not.toContain("external CLI");
    expect(readonlyLabel).toContain("Pi SDK child");
    expect(readonlyLabel).toContain("readonly");
  });
});
