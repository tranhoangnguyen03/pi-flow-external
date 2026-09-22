import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  fauxAssistantMessage,
  fauxToolCall,
  registerFauxProvider,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/index.js";
import { describe, expect, it, vi } from "vitest";
import { createSubagentExtension } from "../src/pi-subagent.ts";
import {
  extractSharedPiRoleProfiles,
  externalRoleAvailability,
  filterExternalAgentProfiles,
  getSubagentProfiles,
  isExternalAgentProfile,
  isSharedPiRoleTemplate,
  materializeSharedPiRoleProfile,
  mergeSynthesizedPiProfiles,
  parseSubagentProfileContent,
  resolveExternalProfile,
  SHARED_PI_HARNESS_MARKER,
} from "../src/profiles.ts";
import type { HarnessConfig } from "../src/harnesses.ts";
import type { SubagentProfile } from "../src/types.ts";
import { buildClaudeArgs, claudeUsageToSubagentUsage, extractClaudeCostUsd, extractClaudeError, extractClaudeFinalText, extractClaudeUsage, spawnClaudeSubagent } from "../src/core/claude.ts";
import { buildCodexArgs, codexUsageToSubagentUsage, estimateCodexCostUsd, extractCodexFinalText, spawnCodexSubagent } from "../src/core/codex.ts";
import { setupPiSubagentTestHarness } from "./helpers/pi-subagent-harness.ts";

describe("pi-subagent profiles", () => {
  let tempDir = "";
  let cwd = "";
  let agentDir = "";
  let originalPathEnv: string | undefined;
  let registrations: Array<{ unregister: () => void }> = [];

  const {
    trackSession,
    disposeSession,
    createSession,
    delegateOnce,
    makeMockTheme,
    stripAnsi,
    renderToText,
    formatTestTokens,
    makeExecutionContext,
    getToolNames,
  } = setupPiSubagentTestHarness((state) => {
    tempDir = state.tempDir;
    cwd = state.cwd;
    agentDir = state.agentDir;
    originalPathEnv = state.originalPathEnv;
    registrations = state.registrations;
  });
  it("loads custom subagent profiles from filename-derived names", () => {
    const subagentsDir = join(agentDir, "subagents");
    mkdirSync(subagentsDir, { recursive: true });
    writeFileSync(join(subagentsDir, "code-reviewer.md"), `---
description: Reviews code changes for correctness.
tools: read, bash
model: inherit
thinking: low
---

You are a careful code reviewer.`);
    writeFileSync(join(subagentsDir, "Bad Name.md"), `---
description: Invalid filename.
---

Ignored.`);
    writeFileSync(join(subagentsDir, "missing-description.md"), "No frontmatter.");
    writeFileSync(join(subagentsDir, "bad-thinking.md"), `---
description: Invalid thinking.
thinking: enormous
---

Ignored.`);
    writeFileSync(join(subagentsDir, "bad-model.md"), `---
description: Invalid model.
model: not-a-provider-model
---

Ignored.`);
    writeFileSync(join(subagentsDir, "unknown-tools.md"), `---
description: Keeps unknown tool names for pi to handle.
tools: read, greb
---

Unknown tools are passed through.`);
    writeFileSync(join(subagentsDir, "blank-tools.md"), `---
description: Blank tools is invalid.
tools:
---

Ignored.`);
    writeFileSync(join(subagentsDir, "null-tools.md"), `---
description: Null tools is invalid.
tools: null
---

Ignored.`);
    writeFileSync(join(subagentsDir, "empty-string-tools.md"), `---
description: Empty string tools is invalid.
tools: ""
---

Ignored.`);
    writeFileSync(join(subagentsDir, "list-tools.md"), `---
description: YAML list tools are invalid.
tools: [read, bash]
---

Ignored.`);
    writeFileSync(join(subagentsDir, "empty-list-tools.md"), `---
description: Empty list tools are invalid.
tools: []
---

Ignored.`);
    // Unparseable YAML frontmatter: parseFrontmatter throws and the profile is dropped.
    writeFileSync(join(subagentsDir, "malformed-yaml.md"), `---
description: : : oops
  bad: [unclosed
---

Ignored.`);
    // Valid frontmatter with an empty body: custom profiles may omit an extra system prompt.
    writeFileSync(join(subagentsDir, "empty-body.md"), `---
description: Valid frontmatter but empty body.
---
`);

    const profiles = getSubagentProfiles(agentDir);

    expect(profiles.get("code-reviewer")).toMatchObject({
      name: "code-reviewer",
      description: "Reviews code changes for correctness.",
      tools: ["read", "bash"],
      thinking: "low",
      systemPrompt: "You are a careful code reviewer.",
    });
    expect(profiles.get("unknown-tools")).toMatchObject({
      name: "unknown-tools",
      tools: ["read", "greb"],
      systemPrompt: "Unknown tools are passed through.",
    });
    expect(profiles.get("bad-thinking")).toMatchObject({
      name: "bad-thinking",
      thinking: "enormous",
      systemPrompt: "Ignored.",
    });
    expect(profiles.get("bad-model")).toMatchObject({
      name: "bad-model",
      model: "not-a-provider-model",
      systemPrompt: "Ignored.",
    });
    expect(profiles.get("empty-body")).toMatchObject({
      name: "empty-body",
      description: "Valid frontmatter but empty body.",
      systemPrompt: undefined,
    });
    expect(profiles.has("Bad Name")).toBe(false);
    expect(profiles.has("missing-description")).toBe(false);
    expect(profiles.has("blank-tools")).toBe(false);
    expect(profiles.has("null-tools")).toBe(false);
    expect(profiles.has("empty-string-tools")).toBe(false);
    expect(profiles.has("list-tools")).toBe(false);
    expect(profiles.has("empty-list-tools")).toBe(false);
    expect(profiles.has("malformed-yaml")).toBe(false);
  });

  it("loads codex-backed custom profiles with bare model names", () => {
    const subagentsDir = join(agentDir, "subagents");
    mkdirSync(subagentsDir, { recursive: true });
    writeFileSync(join(subagentsDir, "codex-reviewer.md"), `---
description: Reviews through Codex CLI.
backend: codex
model: gpt-5.4-mini
thinking: low
---

Codex reviewer prompt.`);
    writeFileSync(join(subagentsDir, "bad-backend.md"), `---
description: Invalid backend.
backend: other
---

Ignored.`);
    writeFileSync(join(subagentsDir, "custom-codex-model.md"), `---
description: Arbitrary Codex model.
backend: codex
model: "gpt 5.4"
---

Arbitrary Codex model prompt.`);

    const profiles = getSubagentProfiles(agentDir);

    expect(profiles.get("codex-reviewer")).toMatchObject({
      name: "codex-reviewer",
      description: "Reviews through Codex CLI.",
      backend: "codex",
      model: "gpt-5.4-mini",
      thinking: "low",
      systemPrompt: "Codex reviewer prompt.",
    });
    expect(profiles.get("custom-codex-model")).toMatchObject({
      name: "custom-codex-model",
      description: "Arbitrary Codex model.",
      backend: "codex",
      model: "gpt 5.4",
      systemPrompt: "Arbitrary Codex model prompt.",
    });
    expect(profiles.has("bad-backend")).toBe(false);
  });


  it("loads claude-backed custom profiles with bare model names", () => {
    const subagentsDir = join(agentDir, "subagents");
    mkdirSync(subagentsDir, { recursive: true });
    writeFileSync(join(subagentsDir, "claude-reviewer.md"), `---
description: Reviews through Claude Code.
backend: claude
model: sonnet
thinking: xhigh
---

Claude reviewer prompt.`);
    writeFileSync(join(subagentsDir, "custom-claude-model.md"), `---
description: Arbitrary Claude model.
backend: claude
model: "not a model"
thinking: max
---

Arbitrary Claude model prompt.`);

    const profiles = getSubagentProfiles(agentDir);

    expect(profiles.get("claude-reviewer")).toMatchObject({
      name: "claude-reviewer",
      description: "Reviews through Claude Code.",
      backend: "claude",
      model: "sonnet",
      thinking: "xhigh",
      systemPrompt: "Claude reviewer prompt.",
    });
    expect(profiles.get("custom-claude-model")).toMatchObject({
      name: "custom-claude-model",
      description: "Arbitrary Claude model.",
      backend: "claude",
      model: "not a model",
      thinking: "max",
      systemPrompt: "Arbitrary Claude model prompt.",
    });
  });

  it("loads grok-backed custom profiles with bare model names", () => {
    const subagentsDir = join(agentDir, "subagents");
    mkdirSync(subagentsDir, { recursive: true });
    writeFileSync(join(subagentsDir, "grok-reviewer.md"), `---
description: Reviews through Grok CLI.
backend: grok
model: grok-4.6
thinking: high
---

Grok reviewer prompt.`);

    const profiles = getSubagentProfiles(agentDir);

    expect(profiles.get("grok-reviewer")).toMatchObject({
      name: "grok-reviewer",
      description: "Reviews through Grok CLI.",
      backend: "grok",
      model: "grok-4.6",
      thinking: "high",
      systemPrompt: "Grok reviewer prompt.",
    });
  });

  it("loads muse-backed custom profiles with bare model names", () => {
    const subagentsDir = join(agentDir, "subagents");
    mkdirSync(subagentsDir, { recursive: true });
    writeFileSync(join(subagentsDir, "muse-reviewer.md"), `---
description: Reviews through Muse Code.
backend: muse
model: muse-spark-1.3-contributor
thinking: high
---

Muse reviewer prompt.`);

    const profiles = getSubagentProfiles(agentDir);

    expect(profiles.get("muse-reviewer")).toMatchObject({
      name: "muse-reviewer",
      description: "Reviews through Muse Code.",
      backend: "muse",
      model: "muse-spark-1.3-contributor",
      thinking: "high",
      systemPrompt: "Muse reviewer prompt.",
    });
  });
});

describe("role-first profile resolution", () => {
  const profile = (name: string, backend: "agy" | "claude" | "codex"): SubagentProfile => ({
    name,
    backend,
    description: `${name} profile`,
  });
  const profiles = new Map([
    ["agy-reviewer", profile("agy-reviewer", "agy")],
    ["codex-reviewer", profile("codex-reviewer", "codex")],
    ["claude-security", profile("claude-security", "claude")],
    ["specialist", profile("specialist", "codex")],
  ]);

  it("resolves built-in and custom roles through the default or explicit harness", () => {
    expect(resolveExternalProfile(profiles, { role: "reviewer" }, "agy").name).toBe("agy-reviewer");
    expect(resolveExternalProfile(profiles, { role: "reviewer" }, "codex").name).toBe("codex-reviewer");
    expect(resolveExternalProfile(profiles, { role: "reviewer", harness: "codex" }, "agy").name).toBe("codex-reviewer");
    expect(resolveExternalProfile(profiles, { role: "security", harness: "claude" }, "agy").name).toBe("claude-security");
  });

  it("never falls back to a harness where the role happens to exist", () => {
    expect(() => resolveExternalProfile(profiles, { role: "security" }, "agy"))
      .toThrow(/unavailable for harness "agy".*Supported harnesses for this role: claude/);
  });

  it("keeps nonstandard names exact-only and rejects ambiguous selectors", () => {
    expect(resolveExternalProfile(profiles, { subagentType: "specialist" }, "agy").name).toBe("specialist");
    expect(() => resolveExternalProfile(profiles, { role: "specialist" }, "agy"))
      .toThrow(/Unknown external role.*Nonstandard profile names.*legacy subagent_type/);
    expect(() => resolveExternalProfile(profiles, { role: "reviewer", subagentType: "agy-reviewer" }, "agy"))
      .toThrow(/do not combine/);
    expect(() => resolveExternalProfile(profiles, { harness: "claude" }, "agy"))
      .toThrow(/role is required when harness is provided/);
  });
});

describe("pi harness legitimacy", () => {
  const bareLocalPi: SubagentProfile = { name: "local-reviewer", backend: "pi", description: "Local reviewer." };
  const registeredHarnessProfile: SubagentProfile = {
    name: "pi-deepseek-reviewer",
    backend: "pi",
    harness: "pi-deepseek",
    description: "Reviewer.",
  };

  it("excludes a bare backend:pi profile with no harness field", () => {
    expect(isExternalAgentProfile(bareLocalPi)).toBe(false);
    expect(isExternalAgentProfile(bareLocalPi, new Set(["pi-deepseek"]))).toBe(false);
  });

  it("excludes backend:pi profile naming an unregistered harness", () => {
    expect(isExternalAgentProfile(registeredHarnessProfile, new Set(["pi-other"]))).toBe(false);
    expect(isExternalAgentProfile(registeredHarnessProfile)).toBe(false);
  });

  it("includes backend:pi profile naming a registered harness", () => {
    expect(isExternalAgentProfile(registeredHarnessProfile, new Set(["pi-deepseek"]))).toBe(true);
  });

  it("filterExternalAgentProfiles threads the configured harness set", () => {
    const profiles = new Map([
      ["local-reviewer", bareLocalPi],
      ["pi-deepseek-reviewer", registeredHarnessProfile],
    ]);
    expect([...filterExternalAgentProfiles(profiles).keys()]).toEqual([]);
    expect([...filterExternalAgentProfiles(profiles, new Set(["pi-deepseek"])).keys()]).toEqual(["pi-deepseek-reviewer"]);
  });
});

describe("named pi harness resolution", () => {
  const harnessConfigs = new Map<string, HarnessConfig>([
    ["pi-deepseek", { model: "deepseek/deepseek-chat", thinking: "high" }],
  ]);
  const configuredHarnessNames = new Set<string>(["agy", "claude", "codex", "pi-deepseek"]);

  it("synthesizes a canonical role profile for a registered pi harness with no on-disk file", () => {
    const profile = resolveExternalProfile(new Map(), { role: "reviewer", harness: "pi-deepseek" }, "agy", {
      configuredHarnessNames,
      harnessConfigs,
    });
    expect(profile.name).toBe("pi-deepseek-reviewer");
    expect(profile.backend).toBe("pi");
    expect(profile.harness).toBe("pi-deepseek");
    expect(profile.model).toBe("deepseek/deepseek-chat");
    expect(profile.thinking).toBe("high");
    expect(profile.permission).toBe("readonly");
  });

  it("prefers an on-disk override for body/permission while still inheriting model/thinking from the registry", () => {
    const onDisk: SubagentProfile = {
      name: "pi-deepseek-reviewer",
      backend: "pi",
      harness: "pi-deepseek",
      description: "Custom reviewer.",
      systemPrompt: "Custom body.",
      permission: "danger",
    };
    const profiles = new Map([["pi-deepseek-reviewer", onDisk]]);
    const profile = resolveExternalProfile(profiles, { role: "reviewer", harness: "pi-deepseek" }, "agy", {
      configuredHarnessNames,
      harnessConfigs,
    });
    expect(profile.systemPrompt).toBe("Custom body.");
    expect(profile.permission).toBe("danger");
    expect(profile.model).toBe("deepseek/deepseek-chat");
    expect(profile.thinking).toBe("high");
  });

  it("rejects an on-disk override that pins a conflicting model", () => {
    const onDisk: SubagentProfile = {
      name: "pi-deepseek-reviewer",
      backend: "pi",
      harness: "pi-deepseek",
      description: "Custom reviewer.",
      model: "openai/gpt-5",
    };
    const profiles = new Map([["pi-deepseek-reviewer", onDisk]]);
    expect(() => resolveExternalProfile(profiles, { role: "reviewer", harness: "pi-deepseek" }, "agy", {
      configuredHarnessNames,
      harnessConfigs,
    })).toThrow(/conflicts with "pi-deepseek"'s registered model/);
  });

  it("rejects a capabilitySet declared on a non-pi-backend profile", () => {
    const profiles = new Map<string, SubagentProfile>([
      ["claude-security", { name: "claude-security", backend: "claude", description: "x", capabilitySet: "sec-tools" }],
    ]);
    expect(() => resolveExternalProfile(profiles, { role: "security", harness: "claude" }, "agy"))
      .toThrow(/capabilitySet only applies to backend "pi"/);
  });

  it("does not synthesize a non-canonical role", () => {
    expect(() => resolveExternalProfile(new Map(), { role: "security-reviewer", harness: "pi-deepseek" }, "agy", {
      configuredHarnessNames,
      harnessConfigs,
    })).toThrow(/Unknown external role/);
  });

  it("externalRoleAvailability sort order is unchanged with no pi harnesses configured", () => {
    const profiles = new Map([
      ["agy-reviewer", { name: "agy-reviewer", backend: "agy", description: "x" } as SubagentProfile],
      ["codex-reviewer", { name: "codex-reviewer", backend: "codex", description: "x" } as SubagentProfile],
      ["claude-reviewer", { name: "claude-reviewer", backend: "claude", description: "x" } as SubagentProfile],
    ]);
    const availability = externalRoleAvailability(profiles);
    expect(availability.get("reviewer")).toEqual(["agy", "claude", "codex"]);
  });
});

describe("mergeSynthesizedPiProfiles reconciles existing on-disk pi profiles", () => {
  const harnessConfigs = new Map<string, HarnessConfig>([
    ["pi-deepseek", { model: "deepseek/deepseek-chat", thinking: "high" }],
  ]);

  it("inherits model/thinking for an on-disk custom-role file that declares neither (the common branch-3 case)", () => {
    const custom: SubagentProfile = {
      name: "pi-deepseek-security-reviewer",
      backend: "pi",
      harness: "pi-deepseek",
      description: "Security review.",
      systemPrompt: "Review for security defects.",
    };
    const merged = mergeSynthesizedPiProfiles(new Map([[custom.name, custom]]), harnessConfigs);
    const result = merged.get("pi-deepseek-security-reviewer");
    expect(result?.model).toBe("deepseek/deepseek-chat");
    expect(result?.thinking).toBe("high");
  });

  it("leaves a genuinely conflicting on-disk profile unreconciled rather than throwing at merge time", () => {
    const conflicting: SubagentProfile = {
      name: "pi-deepseek-security-reviewer",
      backend: "pi",
      harness: "pi-deepseek",
      description: "Security review.",
      systemPrompt: "Review for security defects.",
      model: "openai/gpt-5",
    };
    // Must not throw: this runs on every turn/workflow for the whole roster,
    // not just the profile a caller is about to use.
    const merged = mergeSynthesizedPiProfiles(new Map([[conflicting.name, conflicting]]), harnessConfigs);
    const result = merged.get("pi-deepseek-security-reviewer");
    expect(result?.model).toBe("openai/gpt-5");
    // The conflict is still caught authoritatively the moment this exact
    // profile is actually selected for execution.
    expect(() => resolveExternalProfile(merged, { subagentType: "pi-deepseek-security-reviewer" }, "agy", {
      configuredHarnessNames: new Set(["agy", "claude", "codex", "pi-deepseek"]),
      harnessConfigs,
    })).toThrow(/conflicts with "pi-deepseek"'s registered model/);
  });

  it("leaves non-pi and already-consistent profiles unchanged", () => {
    const claudeProfile: SubagentProfile = { name: "claude-reviewer", backend: "claude", description: "x" };
    const consistent: SubagentProfile = {
      name: "pi-deepseek-security-reviewer",
      backend: "pi",
      harness: "pi-deepseek",
      description: "Security review.",
      model: "deepseek/deepseek-chat",
      thinking: "high",
    };
    const merged = mergeSynthesizedPiProfiles(new Map([
      [claudeProfile.name, claudeProfile],
      [consistent.name, consistent],
    ]), harnessConfigs);
    expect(merged.get("claude-reviewer")).toEqual(claudeProfile);
    expect(merged.get("pi-deepseek-security-reviewer")).toEqual(consistent);
  });
});

describe("shared pi role templates (issue #43 first slice)", () => {
  const harnessConfigs = new Map<string, HarnessConfig>([
    ["pi-deepseek", { model: "deepseek/deepseek-chat", thinking: "high" }],
    ["pi-astra", { model: "openai/gpt-5", thinking: "off" }],
  ]);

  const sharedAudit: SubagentProfile = {
    name: "pi-security-audit",
    backend: "pi",
    harness: SHARED_PI_HARNESS_MARKER,
    description: "Shared security audit role.",
    systemPrompt: "Audit for security defects.",
    permission: "readonly",
  };

  it("is never externally selectable on its own against any real registered-harness set", () => {
    expect(isSharedPiRoleTemplate(sharedAudit)).toBe(true);
    expect(isExternalAgentProfile(sharedAudit)).toBe(false);
    expect(isExternalAgentProfile(sharedAudit, new Set(harnessConfigs.keys()))).toBe(false);
    expect([...filterExternalAgentProfiles(new Map([[sharedAudit.name, sharedAudit]]), new Set(harnessConfigs.keys())).keys()]).toEqual([]);
  });

  it("extracts a valid shared template keyed by its role suffix", () => {
    const { templates, diagnostics } = extractSharedPiRoleProfiles(new Map([[sharedAudit.name, sharedAudit]]));
    expect(diagnostics).toEqual([]);
    expect(templates.get("security-audit")).toEqual(sharedAudit);
  });

  it("drops a marker profile whose file name does not match pi-<role> with a diagnostic", () => {
    const misnamed: SubagentProfile = { ...sharedAudit, name: "security-audit" };
    const { templates, diagnostics } = extractSharedPiRoleProfiles(new Map([[misnamed.name, misnamed]]));
    expect(templates.size).toBe(0);
    expect(diagnostics[0]).toMatch(/must be named "pi-<role>\.md"/);
  });

  it("drops a marker profile that pins model or thinking, since the registry must stay authoritative", () => {
    const pinnedModel: SubagentProfile = { ...sharedAudit, model: "openai/gpt-5" };
    const pinnedThinking: SubagentProfile = { ...sharedAudit, name: "pi-other-role", thinking: "high" };
    const { templates, diagnostics } = extractSharedPiRoleProfiles(new Map([
      [pinnedModel.name, pinnedModel],
      [pinnedThinking.name, pinnedThinking],
    ]));
    expect(templates.size).toBe(0);
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics[0]).toMatch(/must not pin model or thinking/);
  });

  it("materializes a shared template into a concrete per-harness profile pinned to that harness's model/thinking", () => {
    const materialized = materializeSharedPiRoleProfile("security-audit", "pi-deepseek", harnessConfigs.get("pi-deepseek")!, sharedAudit);
    expect(materialized).toEqual({
      name: "pi-deepseek-security-audit",
      description: sharedAudit.description,
      backend: "pi",
      harness: "pi-deepseek",
      model: "deepseek/deepseek-chat",
      thinking: "high",
      tools: undefined,
      systemPrompt: sharedAudit.systemPrompt,
      permission: "readonly",
      maxBudgetUsd: undefined,
      owner: undefined,
    });
  });

  it("mergeSynthesizedPiProfiles applies precedence: harness-specific file > shared template > synthesized canonical", () => {
    const { templates } = extractSharedPiRoleProfiles(new Map([[sharedAudit.name, sharedAudit]]));

    // No on-disk override anywhere: the shared template materializes onto every registered harness.
    const noOverride = mergeSynthesizedPiProfiles(new Map(), harnessConfigs, templates);
    expect(noOverride.get("pi-deepseek-security-audit")?.systemPrompt).toBe("Audit for security defects.");
    expect(noOverride.get("pi-astra-security-audit")?.systemPrompt).toBe("Audit for security defects.");
    expect(noOverride.get("pi-astra-security-audit")?.model).toBe("openai/gpt-5");

    // A per-harness on-disk file for the same role wins over the shared template for that harness only.
    const override: SubagentProfile = {
      name: "pi-deepseek-security-audit",
      backend: "pi",
      harness: "pi-deepseek",
      description: "Harness-specific override.",
      systemPrompt: "Custom deepseek-only body.",
    };
    const withOverride = mergeSynthesizedPiProfiles(new Map([[override.name, override]]), harnessConfigs, templates);
    expect(withOverride.get("pi-deepseek-security-audit")?.systemPrompt).toBe("Custom deepseek-only body.");
    expect(withOverride.get("pi-astra-security-audit")?.systemPrompt).toBe("Audit for security defects.");

    // A shared template also overrides a canonical role name for every harness lacking its own file.
    const sharedExplorer: SubagentProfile = { ...sharedAudit, name: "pi-explorer", systemPrompt: "Custom shared explorer." };
    const { templates: withCanonicalOverride } = extractSharedPiRoleProfiles(new Map([[sharedExplorer.name, sharedExplorer]]));
    const canonicalMerge = mergeSynthesizedPiProfiles(new Map(), harnessConfigs, withCanonicalOverride);
    expect(canonicalMerge.get("pi-deepseek-explorer")?.systemPrompt).toBe("Custom shared explorer.");
    // Other canonical roles with no shared template still synthesize from the built-in default.
    expect(canonicalMerge.get("pi-deepseek-planner")?.systemPrompt).toContain("Create a concise implementation plan");
  });

  it("resolveExternalProfile selects a role materialized from a shared template", () => {
    const { templates } = extractSharedPiRoleProfiles(new Map([[sharedAudit.name, sharedAudit]]));
    const profiles = mergeSynthesizedPiProfiles(new Map(), harnessConfigs, templates);
    const profile = resolveExternalProfile(profiles, { role: "security-audit", harness: "pi-astra" }, "agy", {
      configuredHarnessNames: new Set(["agy", "claude", "codex", ...harnessConfigs.keys()]),
      harnessConfigs,
    });
    expect(profile.name).toBe("pi-astra-security-audit");
    expect(profile.model).toBe("openai/gpt-5");
    expect(profile.systemPrompt).toBe("Audit for security defects.");
  });
});

describe("capabilitySet frontmatter (issue #43 second slice)", () => {
  it("parses an optional capabilitySet field and omits it entirely when absent", () => {
    const withSet = parseSubagentProfileContent(
      `---
description: Docs writer.
backend: claude
capabilitySet: docs
---

Write docs.`,
      "claude-docs-writer",
    );
    expect(withSet?.capabilitySet).toBe("docs");

    const withoutSet = parseSubagentProfileContent(
      `---
description: Docs writer.
backend: claude
---

Write docs.`,
      "claude-docs-writer",
    );
    expect(withoutSet?.capabilitySet).toBeUndefined();
    expect("capabilitySet" in (withoutSet ?? {})).toBe(false);
  });

  it("keeps the profile when capabilitySet is explicitly supplied but not a nonempty string, recording capabilitySetError instead of silently dropping the whole file", () => {
    const malformed = parseSubagentProfileContent(
      `---
description: Docs writer.
backend: claude
capabilitySet: true
---

Write docs.`,
      "claude-docs-writer",
    );
    expect(malformed).toBeDefined();
    expect(malformed?.capabilitySet).toBeUndefined();
    expect(malformed?.capabilitySetError).toMatch(/non-empty string/);

    const emptyString = parseSubagentProfileContent(
      `---
description: Docs writer.
backend: claude
capabilitySet: ""
---

Write docs.`,
      "claude-docs-writer",
    );
    expect(emptyString).toBeDefined();
    expect(emptyString?.capabilitySet).toBeUndefined();
    expect(emptyString?.capabilitySetError).toMatch(/non-empty string/);
  });

  it("propagates capabilitySet from a shared pi role template onto every materialized per-harness profile", () => {
    const harnessConfigs = new Map<string, HarnessConfig>([
      ["pi-deepseek", { model: "deepseek/deepseek-chat", thinking: "high" }],
    ]);
    const sharedDocs: SubagentProfile = {
      name: "pi-docs-writer",
      backend: "pi",
      harness: SHARED_PI_HARNESS_MARKER,
      description: "Shared docs role.",
      systemPrompt: "Write docs.",
      capabilitySet: "docs",
    };
    const materialized = materializeSharedPiRoleProfile("docs-writer", "pi-deepseek", harnessConfigs.get("pi-deepseek")!, sharedDocs);
    expect(materialized.capabilitySet).toBe("docs");
  });

  it("a canonical on-disk override with a malformed capabilitySet blocks fallback to the built-in role at merge time, but only fails once actually selected", () => {
    const harnessConfigs = new Map<string, HarnessConfig>([
      ["pi-deepseek", { model: "deepseek/deepseek-chat", thinking: "high" }],
    ]);
    const broken: SubagentProfile = {
      name: "pi-deepseek-explorer",
      backend: "pi",
      harness: "pi-deepseek",
      description: "Custom explorer.",
      systemPrompt: "Custom explorer body that must never silently vanish.",
      capabilitySetError: 'capabilitySet must be a non-empty string naming a piCapabilitySets entry (got true).',
    };

    // Merge time: the broken file is neither dropped nor thrown on (merge runs
    // for the whole roster on every turn/workflow), but it still occupies its
    // key, so canonical synthesis never silently fills the role in behind it.
    const merged = mergeSynthesizedPiProfiles(new Map([[broken.name, broken]]), harnessConfigs);
    const result = merged.get("pi-deepseek-explorer");
    expect(result?.systemPrompt).toBe("Custom explorer body that must never silently vanish.");
    expect(result?.capabilitySetError).toBeDefined();

    // Selection time: choosing this exact role/harness is rejected loudly.
    expect(() => resolveExternalProfile(merged, { role: "explorer", harness: "pi-deepseek" }, "agy", {
      configuredHarnessNames: new Set(["agy", "claude", "codex", "pi-deepseek"]),
      harnessConfigs,
    })).toThrow(/declares an invalid capabilitySet/);
  });

  it("a shared role template with a malformed capabilitySet survives extraction and materialization, and only the selected harness/role is rejected", () => {
    const harnessConfigs = new Map<string, HarnessConfig>([
      ["pi-deepseek", { model: "deepseek/deepseek-chat", thinking: "high" }],
      ["pi-astra", { model: "openai/gpt-5", thinking: "off" }],
    ]);
    const brokenShared: SubagentProfile = {
      name: "pi-docs-writer",
      backend: "pi",
      harness: SHARED_PI_HARNESS_MARKER,
      description: "Shared docs role.",
      systemPrompt: "Write docs.",
      capabilitySetError: "capabilitySet must be a non-empty string naming a piCapabilitySets entry (got 42).",
    };

    // Extraction never drops it with a diagnostic (unlike a bad filename or a
    // pinned model/thinking): those are structural issues extractSharedPiRoleProfiles
    // can only detect by discarding the file, while a bad capabilitySet is
    // deferred to selection time instead.
    const { templates, diagnostics } = extractSharedPiRoleProfiles(new Map([[brokenShared.name, brokenShared]]));
    expect(diagnostics).toEqual([]);
    expect(templates.get("docs-writer")).toBe(brokenShared);

    const merged = mergeSynthesizedPiProfiles(new Map(), harnessConfigs, templates);
    expect(merged.get("pi-deepseek-docs-writer")?.capabilitySetError).toBeDefined();
    expect(merged.get("pi-astra-docs-writer")?.capabilitySetError).toBeDefined();

    // An unrelated role on the same harnesses is entirely unaffected.
    const unrelated = resolveExternalProfile(merged, { role: "explorer", harness: "pi-astra" }, "agy", {
      configuredHarnessNames: new Set(["agy", "claude", "codex", ...harnessConfigs.keys()]),
      harnessConfigs,
    });
    expect(unrelated.name).toBe("pi-astra-explorer");

    // Selecting the broken role on either harness is rejected loudly.
    expect(() => resolveExternalProfile(merged, { role: "docs-writer", harness: "pi-deepseek" }, "agy", {
      configuredHarnessNames: new Set(["agy", "claude", "codex", ...harnessConfigs.keys()]),
      harnessConfigs,
    })).toThrow(/declares an invalid capabilitySet/);
    expect(() => resolveExternalProfile(merged, { role: "docs-writer", harness: "pi-astra" }, "agy", {
      configuredHarnessNames: new Set(["agy", "claude", "codex", ...harnessConfigs.keys()]),
      harnessConfigs,
    })).toThrow(/declares an invalid capabilitySet/);
  });
});
