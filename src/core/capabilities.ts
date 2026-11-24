import { effectivePiResourcePreset } from "../harnesses.ts";
import { loadExternalCatalog } from "../profiles.ts";
import { loadExternalSettings } from "../settings.ts";
import {
  EXTERNAL_HARNESSES,
  type ExternalHarness,
  type PermissionTier,
  type PiResourcePreset,
  type SubagentBackend,
} from "../types.ts";
import { ExpectedFlowError } from "./errors.ts";
import { PARENT_CONTEXT_MAX_BYTES } from "./parent-context.ts";
import {
  buildPermissionArgs,
  PI_TIER_ACTIVE_TOOLS,
  resolvePermission,
  unsupportedPermissionReason,
} from "./permissions.ts";

export interface BackendCapabilityDescriptor {
  boundary: "external_cli" | "pi_sdk";
  workflowChildSchema: {
    support: "supported" | "unsupported";
    mechanism: "cli_flag" | "schema_file" | "injected_tool" | "none";
  };
  resume: {
    support: "supported" | "unsupported";
    mechanism?: string;
    conditions: readonly string[];
  };
  budget: "enforced" | "not_enforced";
  cost: {
    kind: "native" | "estimated" | "partial" | "unknown";
    conditions: readonly string[];
  };
  retries: {
    extension: "none" | "once_on_infrastructure";
    native: "none" | "internal" | "unknown";
  };
  nestedAgentDetection: boolean;
  /** Backend-level permission caveats that no per-tier helper computes. */
  permissionCaveats: readonly string[];
}

export const PERMISSION_TIERS: readonly PermissionTier[] = ["readonly", "edit", "danger"];

/**
 * Single metadata source for backend capability facts that no existing helper
 * computes. Per-tier support/enforcement/caveats and Pi tool lists are derived
 * from `src/core/permissions.ts`, and the context byte ceiling is imported from
 * `src/core/parent-context.ts`. Conformance tests in `test/capabilities.test.ts`
 * verify every field here against the actual adapter implementations.
 */
export const BACKEND_CAPABILITIES: Readonly<Record<SubagentBackend, BackendCapabilityDescriptor>> = {
  claude: {
    boundary: "external_cli",
    workflowChildSchema: { support: "supported", mechanism: "cli_flag" },
    resume: {
      support: "supported",
      mechanism: "--resume",
      conditions: [
        "Requires a completed claude run record with a sessionId.",
        "Cannot be combined with context sharing (recent/full).",
      ],
    },
    budget: "enforced",
    cost: {
      kind: "native",
      conditions: [
        "Reported natively by Claude Code (total_cost_usd or modelUsage costUSD); costKnown is false when absent.",
      ],
    },
    retries: { extension: "none", native: "unknown" },
    nestedAgentDetection: true,
    permissionCaveats: [
      "danger uses --dangerously-skip-permissions (--permission-mode auto under effective UID 0).",
      "The requested tier is used as-is; role names do not raise it.",
    ],
  },
  codex: {
    boundary: "external_cli",
    workflowChildSchema: { support: "supported", mechanism: "schema_file" },
    resume: {
      support: "supported",
      mechanism: "exec resume",
      conditions: [
        "Requires a completed codex run record with a sessionId.",
        "Cannot be combined with context sharing (recent/full).",
      ],
    },
    budget: "not_enforced",
    cost: {
      kind: "estimated",
      conditions: [
        "Estimated from local price table for mapped models (gpt-5.5, gpt-5.4, gpt-5.4-mini) with costEstimated: true; costKnown is false when the model is unmapped.",
      ],
    },
    retries: { extension: "none", native: "unknown" },
    nestedAgentDetection: true,
    permissionCaveats: [
      "Sandbox flags govern model-generated shell commands, not MCP, plugins, or hooks.",
    ],
  },
  agy: {
    boundary: "external_cli",
    workflowChildSchema: { support: "supported", mechanism: "cli_flag" },
    resume: {
      support: "supported",
      mechanism: "--conversation",
      conditions: [
        "Requires a completed agy run record with a sessionId.",
        "Cannot be combined with context sharing (recent/full).",
      ],
    },
    budget: "not_enforced",
    cost: {
      kind: "unknown",
      conditions: [
        "Antigravity reports token counts only; costKnown is always false.",
      ],
    },
    retries: { extension: "once_on_infrastructure", native: "unknown" },
    nestedAgentDetection: true,
    permissionCaveats: [
      "Autonomous only: every accepted run uses --dangerously-skip-permissions and is unsandboxed.",
      "readonly and edit are rejected instead of being broadened to danger.",
    ],
  },
  muse: {
    boundary: "external_cli",
    workflowChildSchema: { support: "supported", mechanism: "schema_file" },
    resume: {
      support: "supported",
      mechanism: "--session-id",
      conditions: [
        "Requires a completed muse run record with a sessionId.",
        "Cannot be combined with context sharing (recent/full).",
      ],
    },
    budget: "not_enforced",
    cost: {
      kind: "unknown",
      conditions: [
        "Muse has not been observed to report token usage or cost; costKnown is always false.",
      ],
    },
    retries: { extension: "none", native: "internal" },
    nestedAgentDetection: false,
    permissionCaveats: [
      "danger (--yolo) disables approval and the sandbox and additionally trusts this workspace (loads its skills/rules) for this run — a broader grant than an unsandboxed run alone.",
      "Native provider retries (up to 10 attempts) are disclosed via activity narration, not performed by this extension.",
    ],
  },
  pi: {
    boundary: "pi_sdk",
    workflowChildSchema: { support: "supported", mechanism: "injected_tool" },
    resume: {
      support: "unsupported",
      conditions: [
        "Pi children use an in-memory session and store no resumable sessionId.",
      ],
    },
    budget: "not_enforced",
    cost: {
      kind: "native",
      conditions: [
        "Reported from Pi SDK session usage stats.",
      ],
    },
    retries: { extension: "none", native: "none" },
    nestedAgentDetection: false,
    permissionCaveats: [
      "Run in-process via the Pi SDK, not as a CLI.",
      "That curated built-in tool list is not an OS sandbox; danger-tier bash has host access.",
      "Each registration selects preset minimal (the default when the field is absent; skills stay unloaded) or skills (installed skills load; project skills load only when the project is trusted). Extensions, prompt templates, and themes stay unloaded.",
      "Retry is disabled per child regardless of Pi's own settings.",
    ],
  },
};

export interface PermissionTierCapability {
  supported: boolean;
  enforced: boolean;
  caveat?: string;
  tools?: string[];
}

export interface CapabilityConfiguration {
  state: "built_in" | "registered" | "invalid";
  enabled: boolean;
  diagnostics?: string[];
  model?: string;
  thinking?: string;
  preset?: PiResourcePreset;
}

export interface PiCapabilityResources {
  skills: "none" | "user" | "user_and_project";
  extensions: "none";
  promptTemplates: "none";
  themes: "none";
}

export interface CapabilityRecord {
  harness: string;
  backend: SubagentBackend;
  boundary: "external_cli" | "pi_sdk";
  configuration: CapabilityConfiguration;
  readiness: "not_probed";
  workflowChildSchema: {
    support: "supported" | "unsupported";
    mechanism: "cli_flag" | "schema_file" | "injected_tool" | "none";
  };
  resume: {
    support: "supported" | "unsupported";
    mechanism?: string;
    conditions: string[];
  };
  budget: "enforced" | "not_enforced";
  cost: {
    kind: "native" | "estimated" | "partial" | "unknown";
    conditions: string[];
  };
  retries: {
    extension: "none" | "once_on_infrastructure";
    native: "none" | "internal" | "unknown";
  };
  nestedAgentDetection: boolean;
  permissions: {
    default: PermissionTier;
    tiers: Record<PermissionTier, PermissionTierCapability>;
    caveats: string[];
  };
  context: {
    modes: ["none", "recent", "full"];
    maxBytes: number;
    resumeConflict: true;
  };
  resources?: PiCapabilityResources;
}

export interface CapabilityEnvironmentOptions {
  effectiveUid?: number;
  projectTrusted?: boolean;
  defaultPermission?: PermissionTier;
}

export function buildPermissionTierCapabilities(
  backend: SubagentBackend,
  options: Pick<CapabilityEnvironmentOptions, "effectiveUid"> = {},
): Record<PermissionTier, PermissionTierCapability> {
  const effectiveUid = options.effectiveUid ?? process.geteuid?.();
  const buildTier = (tier: PermissionTier): PermissionTierCapability => {
    const unsupported = unsupportedPermissionReason(tier, backend);
    const resolved = resolvePermission(tier, backend);
    let caveat = resolved.caveat;
    if (backend === "claude" && tier === "danger" && effectiveUid === 0) {
      caveat = "uses --permission-mode auto under effective UID 0";
    }
    const tools = backend === "pi" ? [...PI_TIER_ACTIVE_TOOLS[tier]] : undefined;
    return {
      supported: unsupported === undefined,
      enforced: resolved.enforced,
      ...(caveat ? { caveat } : {}),
      ...(tools ? { tools } : {}),
    };
  };
  return {
    readonly: buildTier("readonly"),
    edit: buildTier("edit"),
    danger: buildTier("danger"),
  };
}

export function buildPiCapabilityResources(
  preset: PiResourcePreset | undefined,
  projectTrusted = false,
): PiCapabilityResources {
  const effectivePreset = effectivePiResourcePreset(preset);
  return {
    skills: effectivePreset === "minimal" ? "none" : projectTrusted ? "user_and_project" : "user",
    extensions: "none",
    promptTemplates: "none",
    themes: "none",
  };
}

function harnessLevelDiagnostics(
  harness: string,
  catalogDiagnostics: readonly string[],
): string[] {
  const problems: string[] = [];
  for (const diag of catalogDiagnostics) {
    if (diag.startsWith("Invalid override directory ") && diag.endsWith(`/${harness}`)) {
      problems.push(diag);
    }
  }
  return problems;
}

export function buildCapabilityRecord(params: {
  harness: string;
  backend: SubagentBackend;
  configuration: CapabilityConfiguration;
  options?: CapabilityEnvironmentOptions;
}): CapabilityRecord {
  const { harness, backend, configuration, options = {} } = params;
  const descriptor = BACKEND_CAPABILITIES[backend];
  const defaultPermission = options.defaultPermission ?? "danger";
  const resources =
    backend === "pi"
      ? buildPiCapabilityResources(configuration.preset, options.projectTrusted === true)
      : undefined;
  return {
    harness,
    backend,
    boundary: descriptor.boundary,
    configuration,
    readiness: "not_probed",
    workflowChildSchema: { ...descriptor.workflowChildSchema },
    resume: {
      support: descriptor.resume.support,
      ...(descriptor.resume.mechanism ? { mechanism: descriptor.resume.mechanism } : {}),
      conditions: [...descriptor.resume.conditions],
    },
    budget: descriptor.budget,
    cost: {
      kind: descriptor.cost.kind,
      conditions: [...descriptor.cost.conditions],
    },
    retries: { ...descriptor.retries },
    nestedAgentDetection: descriptor.nestedAgentDetection,
    permissions: {
      default: defaultPermission,
      tiers: buildPermissionTierCapabilities(backend, options),
      caveats: [...descriptor.permissionCaveats],
    },
    context: {
      modes: ["none", "recent", "full"],
      maxBytes: PARENT_CONTEXT_MAX_BYTES,
      resumeConflict: true,
    },
    ...(resources ? { resources } : {}),
  };
}

export interface BuildCapabilitiesOptions extends CapabilityEnvironmentOptions {
  agentDir: string;
  harness?: string;
}

export function buildCapabilityRecords(options: BuildCapabilitiesOptions): CapabilityRecord[] {
  const loadedSettings = loadExternalSettings(options.agentDir);
  const catalog = loadExternalCatalog(options.agentDir);
  const defaultPermission = options.defaultPermission ?? loadedSettings.settings.defaultPermission;
  const envOptions: CapabilityEnvironmentOptions = {
    effectiveUid: options.effectiveUid,
    projectTrusted: options.projectTrusted,
    defaultPermission,
  };

  // When the catalog is blocked, registered pi-* names may be unreadable or
  // untrustworthy, so none are guessed. Only built-in harnesses are selectable.
  const configuredPiHarnesses = catalog.blocked ? new Set<string>() : new Set(catalog.harnessConfigs.keys());
  if (options.harness !== undefined) {
    if (
      !(EXTERNAL_HARNESSES as readonly string[]).includes(options.harness) &&
      !configuredPiHarnesses.has(options.harness)
    ) {
      const configured = [...EXTERNAL_HARNESSES, ...configuredPiHarnesses].sort();
      throw new ExpectedFlowError(
        "selection_invalid",
        `Unknown harness "${options.harness}". Configured harnesses: ${configured.join(", ") || "none"}.`,
      );
    }
  }

  const targetHarnesses = options.harness
    ? [options.harness]
    : [...EXTERNAL_HARNESSES, ...[...configuredPiHarnesses].sort()];

  return targetHarnesses.map((harness) => {
    const isBuiltIn = (EXTERNAL_HARNESSES as readonly string[]).includes(harness);
    const backend: SubagentBackend = isBuiltIn ? (harness as ExternalHarness) : "pi";
    if (catalog.blocked) {
      const diagnostic = catalog.diagnostics.join(" ").trim() || "Configuration is invalid.";
      return buildCapabilityRecord({
        harness,
        backend,
        configuration: {
          state: "invalid",
          enabled: false,
          diagnostics: [diagnostic],
        },
        options: envOptions,
      });
    }

    const hSettings = loadedSettings.settings.harnessSettings?.[harness];
    // Binding overrides can repair defaults; the catalog validates each resolved binding.
    const problems = harnessLevelDiagnostics(harness, catalog.diagnostics);
    if (isBuiltIn) {
      const model = hSettings?.model && hSettings.model !== "native" ? hSettings.model : undefined;
      const thinking = hSettings?.thinking;
      const configuration: CapabilityConfiguration = problems.length
        ? {
            state: "invalid",
            enabled: false,
            diagnostics: [problems.join(" ")],
            ...(model ? { model } : {}),
            ...(thinking ? { thinking } : {}),
          }
        : {
            state: "built_in",
            enabled: !catalog.disabledHarnesses.has(harness),
            ...(model ? { model } : {}),
            ...(thinking ? { thinking } : {}),
          };
      return buildCapabilityRecord({ harness, backend, configuration, options: envOptions });
    }

    const piConfig = catalog.harnessConfigs.get(harness)!;
    const preset = effectivePiResourcePreset(piConfig.preset);
    const thinking = hSettings?.thinking ?? piConfig.thinking;
    const configuration: CapabilityConfiguration = problems.length
      ? {
          state: "invalid",
          enabled: false,
          diagnostics: [problems.join(" ")],
          model: piConfig.model,
          thinking,
          preset,
        }
      : {
          state: "registered",
          enabled: !catalog.disabledHarnesses.has(harness),
          model: piConfig.model,
          thinking,
          preset,
        };
    return buildCapabilityRecord({ harness, backend, configuration, options: envOptions });
  });
}

export function formatCapabilitiesIndex(records: readonly CapabilityRecord[]): string {
  const invalidDiag = records.find((r) => r.configuration.state === "invalid" && r.configuration.diagnostics?.length)
    ?.configuration.diagnostics?.join(" ");
  const rows = records.map((record) => {
    const cfg = record.configuration;
    const stateLabel =
      cfg.state === "invalid"
        ? "invalid (disabled)"
        : `${cfg.state} (${cfg.enabled ? "enabled" : "disabled"})${cfg.model ? `, model=${cfg.model}` : ""}${cfg.preset ? `, preset=${cfg.preset}` : ""}`;
    const supportedTiers = PERMISSION_TIERS.filter((t) => record.permissions.tiers[t].supported).join("/");
    const schemaLabel =
      record.workflowChildSchema.support === "supported"
        ? `supported(${record.workflowChildSchema.mechanism})`
        : "unsupported";
    const resumeLabel =
      record.resume.support === "supported"
        ? `supported(${record.resume.mechanism})`
        : "unsupported";
    return `- ${record.harness} [${record.boundary}, ${stateLabel}]: tiers=${supportedTiers} · childSchema=${schemaLabel} · resume=${resumeLabel} · budget=${record.budget} · cost=${record.cost.kind}`;
  });
  return [
    "Harness capabilities (readiness: not_probed; every harness returns structured PublicRun receipts; pass harness:\"<name>\" for full details):",
    ...(invalidDiag ? [`Configuration diagnostics: ${invalidDiag}`] : []),
    ...rows,
    "",
    "Readiness is not_probed (configuration is not authentication). Run /external config harness test <pi-harness> or /external doctor to check readiness.",
  ].join("\n");
}

export function formatCapabilityDetail(record: CapabilityRecord): string {
  const cfg = record.configuration;
  const cfgParts = [
    `state=${cfg.state}`,
    `enabled=${cfg.enabled}`,
    ...(cfg.model ? [`model=${cfg.model}`] : []),
    ...(cfg.thinking ? [`thinking=${cfg.thinking}`] : []),
    ...(cfg.preset ? [`preset=${cfg.preset}`] : []),
  ];
  const tierLines = PERMISSION_TIERS.map((tier) => {
    const t = record.permissions.tiers[tier];
    const status = !t.supported ? "unsupported" : t.enforced ? "supported (enforced)" : "supported (advisory)";
    const tools = t.tools ? ` · tools: ${t.tools.join("/")}` : "";
    const caveat = t.caveat ? ` · ${t.caveat}` : "";
    return `- ${tier}: ${status}${tools}${caveat}`;
  });
  return [
    `${record.harness} (backend: ${record.backend}, boundary: ${record.boundary})`,
    `Configuration: ${cfgParts.join(", ")}`,
    ...(cfg.diagnostics?.length ? [`Diagnostics: ${cfg.diagnostics.join("; ")}`] : []),
    `Readiness: ${record.readiness} (configuration does not prove CLI installation or authentication; use /external config harness test or /external doctor).`,
    "Operational receipts: PublicRun structuredContent supported on external_delegate, external_workflow, and external_runs.",
    `Workflow child schema (agent({ schema })): ${record.workflowChildSchema.support} (mechanism: ${record.workflowChildSchema.mechanism}).`,
    `Resume: ${record.resume.support}${record.resume.mechanism ? ` (${record.resume.mechanism})` : ""}. ${record.resume.conditions.join(" ")}`,
    `Budget enforcement: ${record.budget}${record.budget === "enforced" ? " (enforced mid-run via --max-budget-usd when > 0)." : " (recorded in receipt with budgetEnforceable: false when set; not enforced mid-run)."}`,
    `Cost reporting: ${record.cost.kind}. ${record.cost.conditions.join(" ")}`,
    `Retries: extension=${record.retries.extension}, native=${record.retries.native}.`,
    `Nested-agent activity detection: ${record.nestedAgentDetection ? "supported" : "disabled"}.`,
    `Permissions (default: ${record.permissions.default}):`,
    ...tierLines,
    "Permission caveats:",
    ...record.permissions.caveats.map((c) => `- ${c}`),
    `Context: modes=${record.context.modes.join(", ")}, maxBytes=${record.context.maxBytes}, resumeConflict=${record.context.resumeConflict}.`,
    ...(record.resources
      ? [
          `Resources (Pi SDK child): skills=${record.resources.skills}, extensions=${record.resources.extensions}, promptTemplates=${record.resources.promptTemplates}, themes=${record.resources.themes}.`,
        ]
      : []),
  ].join("\n");
}

export function formatBackendPermissionHelp(
  backend: SubagentBackend,
  options: Pick<CapabilityEnvironmentOptions, "effectiveUid"> = {},
): string {
  const descriptor = BACKEND_CAPABILITIES[backend];
  const effectiveUid = options.effectiveUid ?? process.geteuid?.();
  const tiers = buildPermissionTierCapabilities(backend, { ...options, effectiveUid });
  if (backend === "pi") {
    const tierTools = PERMISSION_TIERS.map((tier) => `${tier} (${tiers[tier].tools!.join("/")})`).join(", ");
    return `pi-* (named Pi harness configs): Tiers gate a curated built-in tool list per tier: ${tierTools}. ${descriptor.permissionCaveats.join(" ")}`;
  }
  const tierSummaries = PERMISSION_TIERS.map((tier) => {
    const info = tiers[tier];
    if (!info.supported) {
      return `${tier} is unsupported (${info.caveat ?? "rejected before launch"})`;
    }
    const args = buildPermissionArgs(tier, backend, { effectiveUid });
    const flagPart = args.length ? `uses ${args.join(" ")}` : "is enforced";
    const caveatPart = info.caveat ? ` (${info.caveat})` : "";
    return `${tier} ${flagPart}${caveatPart}`;
  });
  return `${backend}: ${tierSummaries.join(", ")}. ${descriptor.permissionCaveats.join(" ")}`;
}

export function formatPermissionHelp(
  harness: string | undefined,
  configuredPiHarnesses: ReadonlySet<string>,
  options: Pick<CapabilityEnvironmentOptions, "effectiveUid"> = {},
): string {
  const resolveBackend = (name: string): SubagentBackend =>
    (EXTERNAL_HARNESSES as readonly string[]).includes(name) ? (name as ExternalHarness) : "pi";
  const backends: SubagentBackend[] = harness
    ? [resolveBackend(harness)]
    : [...EXTERNAL_HARNESSES, ...(configuredPiHarnesses.size ? (["pi"] as const) : [])];
  return [
    "External CLIs and pi-* harnesses run with host access; use them only in trusted repositories. Permission is the call's explicit tier, otherwise the global defaultPermission (danger unless changed). A role describes intent and does not change that tier. Antigravity rejects readonly and edit.",
    ...backends.map((backend) => formatBackendPermissionHelp(backend, options)),
    "Failed or aborted runs are not silently retried. Only agy may retry once for an infrastructure-classified auth, eligibility, or network failure, and the receipt discloses it.",
  ].join("\n\n");
}
