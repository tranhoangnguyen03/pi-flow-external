import type { PermissionTier, SubagentBackend, SubagentProfile } from "../types.ts";

/**
 * Single source of truth for which pi-child SDK builtin tools are active at
 * each permission tier (design §6's curated tier table). Both the runtime
 * (src/core/spawn.ts, which derives its actual excludeTools/tools allow-list
 * from this) and this module's disclosure caveat read from here, so the
 * caveat text can never drift out of sync with what actually executes.
 */
export const PI_TIER_ACTIVE_TOOLS: Readonly<Record<PermissionTier, readonly string[]>> = {
  readonly: ["read", "grep", "find", "ls"],
  edit: ["read", "grep", "find", "ls", "edit", "write"],
  danger: ["read", "bash", "edit", "write"],
};

export interface PermissionResolution {
  tier: PermissionTier;
  /** True when the backend enforces the tier with a native mechanism. */
  enforced: boolean;
  /** Short human-readable caveat shown in disclosure labels. */
  caveat: string | undefined;
  /** Backend this resolution was computed for; lets permissionLabel branch on it. */
  backend?: SubagentBackend;
}

/** Minimal profile shape kept so callers can pass the resolved profile without granting it authority. */
export type PermissionProfileRef = Pick<SubagentProfile, "name" | "backend" | "description">;

/**
 * Effective tier is the caller's explicit permission, otherwise the global
 * default (`danger` unless settings say otherwise). A role name or a profile
 * file cannot raise or lower it.
 */
export function resolveEffectivePermissionTier(
  requestedTier: PermissionTier | undefined,
  _profile?: PermissionProfileRef,
  defaultTier: PermissionTier = "danger",
): PermissionTier {
  return requestedTier ?? defaultTier;
}

/**
 * Backends that cannot enforce a requested restriction refuse it.
 * Antigravity's only headless mode is unsandboxed autonomous execution.
 */
export function unsupportedPermissionReason(tier: PermissionTier, backend: SubagentBackend): string | undefined {
  if (backend === "agy" && tier !== "danger") {
    return `Antigravity supports only autonomous danger mode (--dangerously-skip-permissions). It cannot enforce ${tier}. Pass permission "danger" or omit it to use the global default.`;
  }
  return undefined;
}

/**
 * Describe how one backend maps a tier it supports. Antigravity's non-danger
 * tiers are unsupported and are rejected before launch.
 */
export function resolvePermission(tier: PermissionTier, backend: SubagentBackend): PermissionResolution {
  switch (backend) {
    case "claude":
      return {
        tier,
        enforced: true,
        backend,
        // plan/acceptEdits auto-deny Bash headlessly; denials are surfaced.
        caveat: tier === "danger" ? undefined : "Bash auto-denied headlessly",
      };
    case "codex":
      return {
        tier,
        enforced: true,
        backend,
        // --sandbox governs model-generated shell commands, not MCP/plugins/hooks.
        caveat: tier === "danger" ? undefined : "shell commands only",
      };
    case "agy":
      // Only danger is launchable. A non-danger tier here was not mapped onto
      // the bypass flag; spawn rejects it before process start.
      return {
        tier,
        enforced: tier === "danger",
        backend,
        caveat: tier === "danger" ? undefined : "unsupported; Antigravity is autonomous only",
      };
    case "grok":
      // --sandbox is a real kernel-level sandbox on the grok CLI, enforced at
      // every tier; its network-blocking guarantee is Linux-only, so the
      // readonly caveat discloses that rather than overstating cross-platform
      // enforcement. edit's --sandbox workspace limits writes to the cwd.
      return {
        tier,
        enforced: true,
        backend,
        caveat:
          tier === "readonly"
            ? "kernel sandbox; network blocking is Linux-only"
            : tier === "edit"
              ? "writes limited to workspace"
              : undefined,
      };
    case "muse":
      // --disable-approval/--disable-write/--disable-shell and --yolo are real,
      // enforced flags (verified against real muse exec runs), not advisory
      // instructions. danger's --yolo grants a broader trust than an
      // unsandboxed run alone: it also trusts the workspace for this run
      // (loads its skills/rules), disclosed in the full permission-help text
      // rather than this terse caveat (matching permissionLabel's universal
      // "unsandboxed external CLI" wording for every danger tier).
      return {
        tier,
        enforced: true,
        backend,
        caveat:
          tier === "readonly"
            ? "disables approval, non-shell writes, and shell execution"
            : tier === "edit"
              ? "sandbox stays enabled; only approval is bypassed"
              : undefined,
      };
    case "pi":
      // A curated builtins-only tool surface bounds which tool *names* exist
      // (see spawn.ts's pi branch); it is a real, truthful tool-level
      // restriction and not an OS sandbox. It never makes `bash` at `danger`
      // tier meaningfully less exposed than any other backend's `danger` tier.
      // The caveat names exactly the tools active *at this tier* (from the
      // same PI_TIER_ACTIVE_TOOLS table spawn.ts's runtime derives its actual
      // allow-list from) — never the full builtin universe regardless of
      // tier, which would misrepresent readonly/edit as having bash/write
      // available when the tier table excludes them.
      return {
        tier,
        enforced: true,
        backend,
        caveat: tier === "danger" ? undefined : `${PI_TIER_ACTIVE_TOOLS[tier].join("/")} tools only; curated tool names, not an OS sandbox`,
      };
    default:
      return { tier, enforced: false, backend, caveat: "advisory, not enforced" };
  }
}

/** Native argv fragments implementing each tier. */
export function buildPermissionArgs(
  tier: PermissionTier,
  backend: SubagentBackend,
  options: { effectiveUid?: number } = {},
): string[] {
  switch (backend) {
    case "claude":
      if (tier === "readonly") return ["--permission-mode", "plan"];
      if (tier === "edit") return ["--permission-mode", "acceptEdits"];
      return options.effectiveUid === 0 ? ["--permission-mode", "auto"] : ["--dangerously-skip-permissions"];
    case "codex":
      if (tier === "readonly") return ["--sandbox", "read-only"];
      if (tier === "edit") return ["--sandbox", "workspace-write"];
      return ["--sandbox", "danger-full-access"];
    case "agy":
      if (tier !== "danger") {
        throw new Error(unsupportedPermissionReason(tier, "agy"));
      }
      return ["--dangerously-skip-permissions"];
    case "grok":
      if (tier === "readonly") return ["--sandbox", "read-only", "--permission-mode", "bypassPermissions"];
      if (tier === "edit") return ["--sandbox", "workspace", "--permission-mode", "bypassPermissions"];
      return ["--sandbox", "off", "--permission-mode", "bypassPermissions"];
    case "muse":
      // Approval must always be bypassed headlessly, or exec would hang on an
      // interactive prompt. readonly additionally strips non-shell writes and
      // shell; edit leaves the (on-by-default) sandbox enabled with only
      // approval bypassed; danger's --yolo disables approval and the sandbox
      // and additionally trusts the workspace for this run.
      if (tier === "readonly") return ["--disable-approval", "--disable-write", "--disable-shell"];
      if (tier === "edit") return ["--disable-approval"];
      return ["--yolo"];
    default:
      return [];
  }
}

/** Disclosure label used in delegation cards and receipts. */
export function permissionLabel(resolution: PermissionResolution): string {
  const { tier, enforced, caveat, backend } = resolution;
  if (backend === "pi") {
    // A pi child is an in-process SDK session, not an external CLI process:
    // never describe it as "external CLI" (design §9, "Delegation transparency
    // invariants" in AGENTS.md). "host access" discloses the real boundary —
    // the curated tool table restricts which tool *names* exist, not what an
    // admitted bash tool can do.
    if (tier === "danger") {
      return "Pi SDK child · host access · curated tools";
    }
    const parts = [`Pi SDK child · ${tier} · curated tools`];
    if (!enforced) {
      parts.push("advisory, not enforced");
    }
    if (caveat && caveat !== "advisory, not enforced") {
      parts.push(caveat);
    }
    return parts.join(" · ");
  }
  if (tier === "danger") {
    return "unsandboxed external CLI";
  }
  const parts = [`external CLI · ${tier}`];
  if (!enforced) {
    parts.push("advisory, not enforced");
  }
  if (caveat && caveat !== "advisory, not enforced") {
    parts.push(caveat);
  }
  return parts.join(" · ");
}
