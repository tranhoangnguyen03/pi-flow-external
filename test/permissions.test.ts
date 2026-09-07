import { describe, expect, it } from "vitest";
import {
  buildPermissionArgs,
  isExecutionProfile,
  permissionLabel,
  resolveEffectivePermissionTier,
  resolvePermission,
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

  it("always passes the agy bypass flag so the sandbox never blocks reads", () => {
    expect(buildPermissionArgs("readonly", "agy")).toEqual(["--dangerously-skip-permissions"]);
    expect(buildPermissionArgs("edit", "agy")).toEqual(["--dangerously-skip-permissions"]);
    expect(buildPermissionArgs("danger", "agy")).toEqual(["--dangerously-skip-permissions"]);
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

  it("threads tiers and conversation resume through buildAgyArgs", () => {
    const edit = buildAgyArgs({ profile: profile("agy"), thinkingLevel: undefined, permission: "edit" });
    expect(edit).toContain("--dangerously-skip-permissions");

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
  it("marks agy readonly/edit as advisory — agy runs unsandboxed in every mode", () => {
    const readonly = resolvePermission("readonly", "agy");
    expect(readonly.enforced).toBe(false);
    expect(readonly.caveat).toContain("unsandboxed");

    const edit = resolvePermission("edit", "agy");
    expect(edit.enforced).toBe(false);
    expect(edit.caveat).toContain("unsandboxed");
  });

  it("keeps danger labels unchanged and claude/codex tiers enforced", () => {
    expect(permissionLabel(resolvePermission("danger", "claude"))).toBe("unsandboxed external CLI");
    expect(resolvePermission("readonly", "claude").enforced).toBe(true);
    expect(resolvePermission("edit", "codex").enforced).toBe(true);
    expect(permissionLabel(resolvePermission("readonly", "claude"))).toContain("readonly");
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
  it("identifies execution-oriented profiles by name convention and danger permission", () => {
    expect(isExecutionProfile({ name: "claude-implementer", description: "", backend: "claude" })).toBe(true);
    expect(isExecutionProfile({ name: "claude-debugger", description: "", backend: "claude" })).toBe(true);
    expect(isExecutionProfile({ name: "claude-qa", description: "", backend: "claude" })).toBe(true);
    expect(isExecutionProfile({ name: "claude-worker", description: "", backend: "claude" })).toBe(true);
    expect(isExecutionProfile({ name: "worker", description: "", backend: "claude" })).toBe(true);
    expect(isExecutionProfile({ name: "custom-implementer", description: "", backend: "claude" })).toBe(true);
    expect(isExecutionProfile({ name: "custom-runner", description: "", backend: "claude", permission: "danger" })).toBe(true);
    expect(isExecutionProfile({ name: "claude-explorer", description: "", backend: "claude", permission: "readonly" })).toBe(false);
    expect(isExecutionProfile({ name: "claude-planner", description: "", backend: "claude", permission: "readonly" })).toBe(false);
    expect(isExecutionProfile({ name: "claude-reviewer", description: "", backend: "claude", permission: "readonly" })).toBe(false);
    expect(isExecutionProfile(undefined)).toBe(false);
  });

  it("elevates claude execution profiles to danger floor when edit tier is requested", () => {
    const implementer: SubagentProfile = {
      name: "claude-implementer",
      description: "implement",
      backend: "claude",
      permission: "danger",
    };
    expect(resolveEffectivePermissionTier("edit", implementer)).toBe("danger");
    expect(resolveEffectivePermissionTier("danger", implementer)).toBe("danger");
    expect(resolveEffectivePermissionTier("readonly", implementer)).toBe("readonly");
    expect(resolveEffectivePermissionTier(undefined, implementer)).toBe("danger");

    const debuggerProfile: SubagentProfile = {
      name: "claude-debugger",
      description: "debug",
      backend: "claude",
    };
    expect(resolveEffectivePermissionTier("edit", debuggerProfile)).toBe("danger");
  });

  it("elevates every agy tier to danger — agy runs unsandboxed", () => {
    const explorer: SubagentProfile = {
      name: "agy-explorer",
      description: "explore",
      backend: "agy",
      permission: "readonly",
    };
    expect(resolveEffectivePermissionTier(undefined, explorer)).toBe("danger");
    expect(resolveEffectivePermissionTier("readonly", explorer)).toBe("danger");
    expect(resolveEffectivePermissionTier("edit", explorer)).toBe("danger");
    expect(resolveEffectivePermissionTier("danger", explorer)).toBe("danger");
  });

  it("preserves edit tier for non-claude backends and non-execution profiles", () => {
    const codexImplementer: SubagentProfile = {
      name: "codex-implementer",
      description: "implement",
      backend: "codex",
      permission: "danger",
    };
    expect(resolveEffectivePermissionTier("edit", codexImplementer)).toBe("edit");

    const claudeExplorer: SubagentProfile = {
      name: "claude-explorer",
      description: "explore",
      backend: "claude",
      permission: "readonly",
    };
    expect(resolveEffectivePermissionTier("edit", claudeExplorer)).toBe("edit");
  });
});
