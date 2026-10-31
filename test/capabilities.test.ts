import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  agyUsageToSubagentUsage,
  buildAgyArgs,
  extractAgyTerminalResult,
  isTransientAgyFailure,
} from "../src/core/agy.ts";
import {
  BACKEND_CAPABILITIES,
  buildCapabilityRecord,
  buildCapabilityRecords,
  buildPermissionTierCapabilities,
  buildPiCapabilityResources,
  formatBackendPermissionHelp,
  PERMISSION_TIERS,
} from "../src/core/capabilities.ts";
import {
  buildClaudeArgs,
  claudeUsageToSubagentUsage,
  extractClaudeSessionId,
} from "../src/core/claude.ts";
import {
  buildCodexArgs,
  codexUsageToSubagentUsage,
  extractCodexSessionId,
} from "../src/core/codex.ts";
import {
  buildGrokArgs,
  extractGrokSessionId,
  grokUsageToSubagentUsage,
} from "../src/core/grok.ts";
import {
  buildMuseArgs,
  extractMuseSessionId,
  museHasNestedAgentActivity,
} from "../src/core/muse.ts";
import {
  buildOpencodeArgs,
  checkOpencodeResumable,
  spawnOpencodeSubagent,
  verifyOpencodeTurn,
} from "../src/core/opencode.ts";
import {
  PARENT_CONTEXT_MAX_BYTES,
} from "../src/core/parent-context.ts";
import {
  buildPermissionArgs,
  PI_TIER_ACTIVE_TOOLS,
  resolvePermission,
  unsupportedPermissionReason,
} from "../src/core/permissions.ts";
import { getSubagentUsage } from "../src/core/progress.ts";
import { resolveResume } from "../src/core/resume.ts";
import { createRunRecord } from "../src/core/run-record.ts";
import { hasNestedAgentActivity } from "../src/core/spawn.ts";
import { loadExternalCatalog, resolveExternalProfile } from "../src/profiles.ts";
import type { SubagentBackend, SubagentProfile } from "../src/types.ts";
import { createStructuredOutputTool } from "../src/workflow/structured-output.ts";

const ALL_BACKENDS: readonly SubagentBackend[] = [
  "claude",
  "codex",
  "agy",
  "grok",
  "muse",
  "opencode",
  "pi",
];

function profile(backend: SubagentBackend): SubagentProfile {
  return {
    name: `${backend}/worker`,
    description: "Test profile",
    backend,
    harness: backend === "pi" ? "pi-test" : backend,
  };
}

describe("BACKEND_CAPABILITIES adapter conformance", () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
  });

  function makeTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "pi-flow-cap-test-"));
    tempDirs.push(dir);
    return dir;
  }

  it("keeps structured-output capability claims aligned with each CLI adapter", () => {
    const sampleSchema = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] };
    const flagCases: Array<[SubagentBackend, "cli_flag" | "schema_file", string, (withSchema: boolean) => string[]]> = [
      ["claude", "cli_flag", "--json-schema", (enabled) =>
        buildClaudeArgs({ profile: profile("claude"), thinkingLevel: undefined, ...(enabled ? { outputSchema: sampleSchema } : {}) })],
      ["agy", "cli_flag", "--json-schema", (enabled) =>
        buildAgyArgs({ profile: profile("agy"), thinkingLevel: undefined, ...(enabled ? { outputSchema: sampleSchema } : {}) })],
      ["grok", "cli_flag", "--json-schema", (enabled) =>
        buildGrokArgs({ profile: profile("grok"), ...(enabled ? { outputSchema: sampleSchema } : {}) })],
      ["codex", "schema_file", "--output-schema", (enabled) =>
        buildCodexArgs({ prompt: "p", profile: profile("codex"), thinkingLevel: undefined,
          ...(enabled ? { outputSchemaPath: "/tmp/schema.json" } : {}) })],
      ["muse", "schema_file", "--output-schema", (enabled) =>
        buildMuseArgs({ promptFilePath: "/tmp/p", workspace: "/tmp", profile: profile("muse"), thinkingLevel: "low",
          ...(enabled ? { schemaFilePath: "/tmp/schema.json" } : {}) })],
    ];
    for (const [backend, mechanism, flag, build] of flagCases) {
      expect(BACKEND_CAPABILITIES[backend].workflowChildSchema).toEqual({ support: "supported", mechanism });
      expect(build(true)).toContain(flag);
      expect(build(true)).toContain(mechanism === "cli_flag" ? JSON.stringify(sampleSchema) : "/tmp/schema.json");
      expect(build(false)).not.toContain(flag);
    }
    expect(BACKEND_CAPABILITIES.pi.workflowChildSchema).toEqual({ support: "supported", mechanism: "injected_tool" });
    expect(createStructuredOutputTool(sampleSchema, { value: undefined, called: false, count: 0, duplicateCall: false }).name)
      .toBe("structured_output");
  });

  it("discloses OpenCode structured-output rejection before any provider call", async () => {
    expect(BACKEND_CAPABILITIES.opencode.workflowChildSchema).toEqual({ support: "unsupported", mechanism: "none" });
    const res = await spawnOpencodeSubagent({
      toolCallId: "cap-opencode-schema", description: "Schema check",
      prompt: "Check schema rejection", profile: profile("opencode"), ctx: { cwd: "/tmp" } as never,
      signal: undefined, progressEnabled: false, onProgress: undefined, onUsage: () => {},
      outputSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
    });
    expect(res.details.status).toBe("error");
    expect(res.details.error).toMatch(/structured workflow output is unsupported on opencode/i);
  });

  it.each(ALL_BACKENDS)("matches %s resume claims to persisted sessions and adapter arguments", async (backend) => {
    const cap = BACKEND_CAPABILITIES[backend].resume;
    const runsDir = makeTempDir();
    const record = createRunRecord({
      directory: runsDir,
      metadata: { description: "Completed", backend, profile: profile(backend).name },
    });
    await record.finish({
      backend, profile: profile(backend).name, status: "done", result: "ok",
      ...(backend === "pi" ? {} : { sessionId: "sess-1" }),
    });
    const resolved = await resolveResume(runsDir, record.runId, backend);
    if (backend === "pi") {
      expect(cap.support).toBe("unsupported");
      expect(cap.mechanism).toBeUndefined();
      expect(resolved.session).toBeUndefined();
      expect(resolved.error).toMatch(/no session id to resume/i);
      return;
    }
    expect(cap.support).toBe("supported");
    expect(resolved.error).toBeUndefined();
    expect(resolved.session).toEqual({ runId: record.runId, sessionId: "sess-1", backend });

    // The adapter's exact resume switch and session-ID parser must agree with
    // the published mechanism; backend tests own the full resume lifecycle.
    const launch = {
      claude: () => ["--resume", buildClaudeArgs({ profile: profile("claude"), thinkingLevel: undefined, resumeSessionId: "sess-1" }),
        extractClaudeSessionId({ type: "result", session_id: "sess-1" })],
      codex: () => ["exec resume", buildCodexArgs({ prompt: "p", profile: profile("codex"), thinkingLevel: undefined, resumeSessionId: "sess-1" }),
        extractCodexSessionId({ type: "thread.started", thread_id: "sess-1" })],
      agy: () => ["--conversation", buildAgyArgs({ profile: profile("agy"), thinkingLevel: undefined, resumeConversationId: "sess-1" }),
        extractAgyTerminalResult({ event: "result", result: { conversation_id: "sess-1" } })?.conversationId],
      grok: () => ["--resume", buildGrokArgs({ profile: profile("grok"), resumeSessionId: "sess-1" }),
        extractGrokSessionId({ session_id: "sess-1" })],
      muse: () => ["--session-id", buildMuseArgs({ promptFilePath: "/tmp/p", workspace: "/tmp",
        profile: profile("muse"), thinkingLevel: "low", resumeSessionId: "sess-1" }),
        extractMuseSessionId({ stream: { kind: "session", id: "sess-1" } })],
      opencode: () => ["--session", buildOpencodeArgs({ profile: profile("opencode"), resumeSessionId: "sess-1" }),
        "sess-1"],
    } as const;
    const [mechanism, args, sessionId] = launch[backend]();
    expect(cap.mechanism).toBe(mechanism);
    if (backend === "codex") expect(args).toEqual(expect.arrayContaining(["exec", "resume", "sess-1"]));
    else expect(args).toEqual(expect.arrayContaining([mechanism, "sess-1"]));
    expect(sessionId).toBe("sess-1");
    if (backend === "opencode") {
      expect(() => checkOpencodeResumable(
        { info: { id: "sess-1", permissions: [{ action: "*", effect: "allow" }] }, messages: [] },
        "sess-1", "readonly",
      )).toThrow(/carries its own permission rules/);
      expect(() => checkOpencodeResumable(
        { info: { id: "sess-1", agent: "pi-flow-readonly-0123456789ab" }, messages: [] },
        "sess-1", "danger",
      )).toThrow(/last run at a restricted tier/);
    }
  });

  it.each(ALL_BACKENDS)("matches budget enforcement for %s against CLI arg builders", (backend) => {
    const budget = BACKEND_CAPABILITIES[backend].budget;
    if (backend === "claude") {
      expect(budget).toBe("enforced");
      const withBudget = buildClaudeArgs({ profile: profile("claude"), thinkingLevel: undefined, maxBudgetUsd: 4.25 });
      expect(withBudget).toEqual(expect.arrayContaining(["--max-budget-usd", "4.25"]));
      const zeroBudget = buildClaudeArgs({ profile: profile("claude"), thinkingLevel: undefined, maxBudgetUsd: 0 });
      expect(zeroBudget).not.toContain("--max-budget-usd");
    } else {
      expect(budget).toBe("not_enforced");
      const args =
        backend === "codex"
          ? buildCodexArgs({ prompt: "p", profile: profile("codex"), thinkingLevel: undefined })
          : backend === "agy"
            ? buildAgyArgs({ profile: profile("agy"), thinkingLevel: undefined })
            : backend === "grok"
              ? buildGrokArgs({ profile: profile("grok") })
              : backend === "muse"
                ? buildMuseArgs({ promptFilePath: "/tmp/p", workspace: "/tmp", profile: profile("muse"), thinkingLevel: "low" })
                : backend === "opencode"
                  ? buildOpencodeArgs({ profile: profile("opencode") })
                  : [];
      expect(args.join(" ")).not.toMatch(/budget/i);
    }
  });

  it("advertises accurate native, estimated and unknown costs", () => {
    const kinds: Record<SubagentBackend, string> = {
      claude: "native", grok: "native", pi: "native",
      codex: "estimated", opencode: "partial", agy: "unknown", muse: "unknown",
    };
    for (const backend of ALL_BACKENDS) {
      expect(BACKEND_CAPABILITIES[backend].cost.kind).toBe(kinds[backend]);
    }
    const tokens = { inputTokens: 100, cacheReadInputTokens: 20, cacheCreationInputTokens: 10, outputTokens: 50 };
    for (const converter of [claudeUsageToSubagentUsage, grokUsageToSubagentUsage]) {
      expect(converter(tokens, 0.05)).toMatchObject({ cost: 0.05, costKnown: true, costEstimated: false });
      expect(converter(tokens, undefined)).toMatchObject({ cost: 0, costKnown: false, costEstimated: false });
    }
    const codexTokens = { inputTokens: 1000, cachedInputTokens: 200, outputTokens: 500, reasoningOutputTokens: 100 };
    expect(codexUsageToSubagentUsage("gpt-5.4", codexTokens))
      .toMatchObject({ costKnown: true, costEstimated: true });
    expect(codexUsageToSubagentUsage("unmapped-custom-model", codexTokens))
      .toMatchObject({ cost: 0, costKnown: false, costEstimated: false });
    expect(agyUsageToSubagentUsage({ inputTokens: 100, outputTokens: 50, thinkingTokens: 10,
      cacheReadTokens: 20, totalTokens: 160 })).toMatchObject({ cost: 0, costKnown: false });
    expect(BACKEND_CAPABILITIES.muse.cost.conditions[0]).toMatch(/costKnown is always false/);
    const piUsage = getSubagentUsage({
      getSessionStats: () => ({ tokens: { input: 100, output: 40, cacheRead: 10, cacheWrite: 5 }, cost: 0.025 }),
      messages: [],
    });
    expect(piUsage).toMatchObject({ cost: 0.025, costKnown: true });
    expect(piUsage.costEstimated).not.toBe(true);
  });

  it("discloses OpenCode uncounted nested-subagent costs", () => {
    const exported = {
      info: { id: "s1", outcome: "succeeded" },
      messages: [
        { id: "u1", type: "user", text: "prompt" },
        { id: "a1", type: "assistant", finish: "stop", time: { completed: 1 },
          tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
          cost: 0.01, content: [{ type: "text", text: "done" }] },
        { id: "i1", type: "idle", outcome: "succeeded" },
      ],
    };
    expect(verifyOpencodeTurn(exported, { sessionId: "s1", prompt: "prompt" }).usage)
      .toMatchObject({ cost: 0.01, costKnown: true, costEstimated: false });
    expect(verifyOpencodeTurn({ ...exported, messages: [
      exported.messages[0],
      { ...exported.messages[1], content: [{ type: "tool", name: "subagent" }, { type: "text", text: "done" }] },
      exported.messages[2],
    ] }, { sessionId: "s1", prompt: "prompt" }).usage)
      .toMatchObject({ costKnown: false, costEstimated: false });
  });

  it.each(ALL_BACKENDS)("matches retry policy for %s against the agy-only infrastructure classifier", (backend) => {
    const retries = BACKEND_CAPABILITIES[backend].retries;
    if (backend === "agy") {
      expect(retries).toEqual({ extension: "once_on_infrastructure", native: "unknown" });
      expect(isTransientAgyFailure("authentication failed: token expired")).toBe(true);
      expect(isTransientAgyFailure("eligibility check failed")).toBe(true);
      expect(isTransientAgyFailure("read ECONNRESET")).toBe(true);
      expect(isTransientAgyFailure("Task failed: syntax error in output")).toBe(false);
    } else {
      expect(retries.extension).toBe("none");
      if (backend === "pi") expect(retries.native).toBe("none");
      else if (backend === "muse" || backend === "opencode") expect(retries.native).toBe("internal");
      else expect(retries.native).toBe("unknown");
    }
  });

  it.each([
    [
      "claude",
      true,
      { type: "assistant", message: { content: [{ type: "tool_use", name: "Agent" }] } },
      { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash" }] } },
    ],
    [
      "codex",
      true,
      { type: "item.completed", item: { type: "collab_tool_call" } },
      { type: "item.completed", item: { type: "command_execution" } },
    ],
    [
      "agy",
      true,
      { event: "step_update", step_update: { step_type: "subagent", subagent_info: { id: "sub-1" } } },
      { event: "step_update", step_update: { step_type: "tool", tool_name: "read_file" } },
    ],
    [
      "grok",
      true,
      { type: "assistant", message: { content: [{ type: "tool_use", name: "spawn_subagent" }] } },
      { type: "assistant", message: { content: [{ type: "tool_use", name: "read" }] } },
    ],
    [
      "muse",
      false,
      { payload_type: "task.lifecycle.started", payload: { task_kind: "reminder.agent.skills" } },
      { payload_type: "tool.result", payload: {} },
    ],
    [
      "opencode",
      true,
      { type: "tool_use", sessionID: "s1", part: { sessionID: "s1", tool: "subagent" } },
      { type: "tool_use", sessionID: "s1", part: { sessionID: "s1", tool: "read" } },
    ],
    [
      "pi",
      false,
      { type: "tool_execution_start", toolName: "external_delegate" },
      { type: "tool_execution_start", toolName: "read" },
    ],
  ] as const)(
    "matches nestedAgentDetection for %s (%s) against hasNestedAgentActivity",
    (backend, expected, nestedCandidate, nonNestedEvent) => {
      expect(BACKEND_CAPABILITIES[backend].nestedAgentDetection).toBe(expected);
      expect(hasNestedAgentActivity(nestedCandidate, backend)).toBe(expected);
      expect(hasNestedAgentActivity(nonNestedEvent, backend)).toBe(false);
      if (backend === "muse") {
        expect(museHasNestedAgentActivity(nestedCandidate)).toBe(false);
      }
    },
  );

  it.each([
    { thinking: "high", roles: { worker: { model: "anthropic/claude-sonnet-4-5" } } },
    { model: "anthropic/claude-sonnet-4-5#high", thinking: "high", roles: { worker: { thinking: "native" } } },
  ])("keeps OpenCode enabled when a binding overrides conflicting defaults: %j", (opencode) => {
    const agentDir = makeTempDir();
    mkdirSync(join(agentDir, "pi-flow-external"));
    writeFileSync(join(agentDir, "pi-flow-external", "settings.json"), JSON.stringify({ version: 5, harnesses: { opencode } }));
    const catalog = loadExternalCatalog(agentDir);
    expect(catalog.blocked).toBe(false);
    expect(resolveExternalProfile(catalog.profiles, { harness: "opencode", role: "worker" }, "opencode").configurationError).toBeUndefined();
    expect(() => resolveExternalProfile(catalog.profiles, { harness: "opencode", role: "explorer" }, "opencode")).toThrow(/OpenCode/);
    expect(buildCapabilityRecords({ agentDir, harness: "opencode" })[0]!.configuration).toMatchObject({
      state: "built_in",
      enabled: true,
    });
  });

  it.runIf(typeof process.geteuid === "function").each([0, 501])("matches Claude permission help to launch flags under effective UID %s", (effectiveUid) => {
    const runtime = process as NodeJS.Process & { geteuid: () => number };
    vi.spyOn(runtime, "geteuid").mockReturnValue(effectiveUid);
    for (const override of [undefined, effectiveUid === 0 ? 501 : 0]) {
      const options = override === undefined ? {} : { effectiveUid: override };
      const args = buildClaudeArgs({ profile: profile("claude"), thinkingLevel: undefined, ...options });
      const permissionArgs = buildPermissionArgs("danger", "claude", { effectiveUid: override ?? effectiveUid });
      expect(args).toEqual(expect.arrayContaining(permissionArgs));
      expect(formatBackendPermissionHelp("claude", options)).toContain(`danger uses ${permissionArgs.join(" ")}`);
    }
  });

  it("derives permission, context and Pi resource claims from canonical helpers", () => {
    for (const backend of ALL_BACKENDS) {
      const tiers = buildPermissionTierCapabilities(backend, { effectiveUid: 501, platform: "linux" });
      for (const tier of PERMISSION_TIERS) {
        const unsupported = unsupportedPermissionReason(tier, backend);
        const resolved = resolvePermission(tier, backend);
        expect(tiers[tier].supported).toBe(unsupported === undefined);
        expect(tiers[tier].enforced).toBe(resolved.enforced);
        expect(tiers[tier].caveat).toBe(resolved.caveat);
        if (backend === "pi") {
          expect(tiers[tier].tools).toEqual([...PI_TIER_ACTIVE_TOOLS[tier]]);
        } else {
          expect(tiers[tier].tools).toBeUndefined();
        }
      }
    }

    // Claude effective UID 0 condition matches buildPermissionArgs
    const claudeRootTiers = buildPermissionTierCapabilities("claude", { effectiveUid: 0, platform: "linux" });
    expect(buildPermissionArgs("danger", "claude", { effectiveUid: 0 })).toEqual(["--permission-mode", "auto"]);
    expect(claudeRootTiers.danger.caveat).toContain("--permission-mode auto");
    expect(claudeRootTiers.danger.caveat).toContain("effective UID 0");

    // Grok non-Linux platform condition
    const grokDarwinTiers = buildPermissionTierCapabilities("grok", { effectiveUid: 501, platform: "darwin" });
    expect(grokDarwinTiers.readonly.caveat).toContain("Linux-only (inactive on darwin)");

    // Generated permission help for pi lists per-tier tools from PI_TIER_ACTIVE_TOOLS, not a flat union
    const piHelp = formatBackendPermissionHelp("pi");
    expect(piHelp).toContain(`readonly (${PI_TIER_ACTIVE_TOOLS.readonly.join("/")})`);
    expect(piHelp).toContain(`edit (${PI_TIER_ACTIVE_TOOLS.edit.join("/")})`);
    expect(piHelp).toContain(`danger (${PI_TIER_ACTIVE_TOOLS.danger.join("/")})`);
    expect(piHelp).not.toContain("read/bash/edit/write/grep/find/ls");
    expect(piHelp).not.toContain("external CLI");

    // The real Pi resource loader and trust boundary are exercised in
    // pi-runtime.test.ts. Here we check the advertised capability only.
    for (const [preset, projectTrusted, expectedSkills] of [
      ["minimal", false, "none"], ["minimal", true, "none"],
      ["skills", false, "user"], ["skills", true, "user_and_project"],
    ] as const) {
      expect(buildPiCapabilityResources(preset, projectTrusted)).toEqual({
        skills: expectedSkills, extensions: "none", promptTemplates: "none", themes: "none",
      });
    }

    // Context ceiling is shared with prepareParentContext
    const record = buildCapabilityRecord({
      harness: "claude",
      backend: "claude",
      configuration: { state: "built_in", enabled: true },
    });
    expect(record.context).toEqual({
      modes: ["none", "recent", "full"],
      maxBytes: PARENT_CONTEXT_MAX_BYTES,
      resumeConflict: true,
    });

  });
});
