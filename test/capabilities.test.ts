import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildAgyArgs,
  isTransientAgyFailure,
} from "../src/core/agy.ts";
import {
  BACKEND_CAPABILITIES,
  buildCapabilityRecord,
  buildPermissionTierCapabilities,
  buildPiCapabilityResources,
  formatBackendPermissionHelp,
  PERMISSION_TIERS,
} from "../src/core/capabilities.ts";
import {
  buildClaudeArgs,
} from "../src/core/claude.ts";
import {
  buildCodexArgs,
} from "../src/core/codex.ts";
import {
  buildGrokArgs,
} from "../src/core/grok.ts";
import {
  buildMuseArgs,
} from "../src/core/muse.ts";
import {
  buildOpencodeArgs,
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
import { hasNestedAgentActivity } from "../src/core/spawn.ts";
import type { SubagentBackend, SubagentProfile } from "../src/types.ts";

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
  afterEach(() => vi.restoreAllMocks());

  // One check per published claim. Each backend's own test file owns the full
  // behavior (resume lifecycle, cost conversion, retries, refusal paths).
  it("matches every static per-backend claim to the adapter that implements it", () => {
    const schema = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] };
    const args = {
      claude: (extra: object) => buildClaudeArgs({ profile: profile("claude"), thinkingLevel: undefined, ...extra }),
      codex: (extra: object) => buildCodexArgs({ prompt: "p", profile: profile("codex"), thinkingLevel: undefined, ...extra }),
      agy: (extra: object) => buildAgyArgs({ profile: profile("agy"), thinkingLevel: undefined, ...extra }),
      grok: (extra: object) => buildGrokArgs({ profile: profile("grok"), ...extra }),
      muse: (extra: object) => buildMuseArgs({ promptFilePath: "/tmp/p", workspace: "/tmp", profile: profile("muse"), thinkingLevel: "low", ...extra }),
      opencode: (extra: object) => buildOpencodeArgs({ profile: profile("opencode"), ...extra }),
    };
    const schemaOption = { claude: { outputSchema: schema }, agy: { outputSchema: schema }, grok: { outputSchema: schema },
      codex: { outputSchemaPath: "/tmp/schema.json" }, muse: { schemaFilePath: "/tmp/schema.json" } } as const;
    const resumeOption = { claude: { resumeSessionId: "sess-1" }, codex: { resumeSessionId: "sess-1" }, agy: { resumeConversationId: "sess-1" },
      grok: { resumeSessionId: "sess-1" }, muse: { resumeSessionId: "sess-1" }, opencode: { resumeSessionId: "sess-1" } } as const;
    const nested = {
      claude: { type: "assistant", message: { content: [{ type: "tool_use", name: "Agent" }] } },
      codex: { type: "item.completed", item: { type: "collab_tool_call" } },
      agy: { event: "step_update", step_update: { step_type: "subagent", subagent_info: { id: "sub-1" } } },
      grok: { type: "assistant", message: { content: [{ type: "tool_use", name: "spawn_subagent" }] } },
      muse: { payload_type: "task.lifecycle.started", payload: { task_kind: "reminder.agent.skills" } },
      opencode: { type: "tool_use", sessionID: "s1", part: { sessionID: "s1", tool: "subagent" } },
      pi: { type: "tool_execution_start", toolName: "external_delegate" },
    } as const;
    const costKind = { claude: "native", grok: "native", pi: "native", codex: "estimated", opencode: "partial", agy: "unknown", muse: "unknown" };
    for (const backend of ALL_BACKENDS) {
      const cap = BACKEND_CAPABILITIES[backend];
      const build = backend === "pi" ? undefined : args[backend];
      // Structured output: the advertised flag appears only when a schema is requested.
      if (backend === "pi") expect(cap.workflowChildSchema).toEqual({ support: "supported", mechanism: "injected_tool" });
      else if (backend === "opencode") expect(cap.workflowChildSchema.support).toBe("unsupported");
      else {
        const flag = backend === "codex" || backend === "muse" ? "--output-schema" : "--json-schema";
        expect(build!(schemaOption[backend]), backend).toContain(flag);
        expect(build!({}), backend).not.toContain(flag);
      }
      // Resume: the advertised mechanism is the switch the adapter emits.
      if (backend === "pi") expect(cap.resume.support).toBe("unsupported");
      else {
        const resumed = build!(resumeOption[backend]).join(" ");
        expect(resumed, backend).toContain("sess-1");
        for (const word of cap.resume.mechanism!.split(" ")) expect(resumed, backend).toContain(word);
      }
      // Budget: only Claude passes a cap to its CLI.
      expect(cap.budget, backend).toBe(backend === "claude" ? "enforced" : "not_enforced");
      if (build) expect(build({ maxBudgetUsd: 4.25 }).join(" ").includes("--max-budget-usd 4.25"), backend).toBe(backend === "claude");
      // Retries: only agy retries, and only infrastructure failures.
      expect(cap.retries.extension, backend).toBe(backend === "agy" ? "once_on_infrastructure" : "none");
      // Nested activity detection drives the one-time deadline extension.
      expect(hasNestedAgentActivity(nested[backend], backend), backend).toBe(cap.nestedAgentDetection);
      expect(cap.cost.kind, backend).toBe(costKind[backend]);
    }
    expect(isTransientAgyFailure("read ECONNRESET")).toBe(true);
    expect(isTransientAgyFailure("Task failed: syntax error in output")).toBe(false);
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
