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

/**
 * Known execution-oriented roles that require command/Bash execution
 * (running tests, build tools, git inspection, etc.).
 */
export const EXECUTION_ROLES: readonly string[] = ["implementer", "qa", "worker"];

/** Minimal profile shape needed to reason about permission tiers. */
export type PermissionProfileRef = Pick<SubagentProfile, "name" | "backend" | "description" | "permission">;

export function isExecutionProfile(profile?: PermissionProfileRef): boolean {
  if (!profile) return false;
  if (profile.permission === "danger") return true;
  const name = profile.name.toLowerCase();
  return EXECUTION_ROLES.some((role) => name === role || name.endsWith(`-${role}`) || name.startsWith(`${role}-`));
}

/**
 * Resolve effective permission tier for a profile run.
 *
 * Pragmatic execution principle: do not get in the way of external agents
 * doing good work. Claude in headless mode auto-denies all Bash commands at
 * `edit` (acceptEdits); execution profiles (such as implementer, qa,
 * worker) require shell access to inspect repositories, run tests, and validate
 * fixes. An override to `edit` on these lanes would handcuff the model into
 * headless permission denials. We elevate to `danger` so the agent has the
 * necessary authority, and truthfully disclose `unsandboxed external CLI`.
 */
export function resolveEffectivePermissionTier(
  requestedTier: PermissionTier | undefined,
  profile: PermissionProfileRef | undefined,
  defaultTier: PermissionTier = "danger",
): PermissionTier {
  // Profile permissions are a floor: parent requests can grant more, never less.
  const floor = profile?.permission ?? defaultTier;
  const tiers: readonly PermissionTier[] = ["readonly", "edit", "danger"];
  const baseTier = tiers[Math.max(tiers.indexOf(floor), tiers.indexOf(requestedTier ?? floor))]!;
  if (profile?.backend === "agy") {
    // Get out of the way: agy's only unsandboxed headless mode is
    // --dangerously-skip-permissions, and its default sandbox denies even
    // read-only tools (read_url_content). Every agy run is therefore
    // unsandboxed; any readonly/edit tier is an advisory instruction carried
    // by the profile body, not a harness boundary.
    return "danger";
  }
  if ((profile?.backend === "claude" || profile?.backend === "pi") && isExecutionProfile(profile) && baseTier === "edit") {
    // Same floor as claude, for the same reason: §6's curated pi tool table
    // strips `bash` at `edit` tier, so an execution-lane pi profile (implementer,
    // qa, worker) requested at `edit` would otherwise lose shell
    // access entirely. Elevate rather than silently handcuff the agent.
    return "danger";
  }
  return baseTier;
}

/**
 * Resolve a tier for one backend. Trust + disclose: unsupported tiers are
 * advisory (instruction-only), never a launch failure.
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
      // agy has no granular headless permission mode: its default sandbox
      // denies even read-only tools, and --dangerously-skip-permissions is the
      // only unsandboxed mode. resolveEffectivePermissionTier elevates every
      // agy run to danger, so a non-danger tier reaching this branch is
      // advisory metadata only, never a harness boundary.
      return {
        tier,
        enforced: tier === "danger",
        backend,
        caveat: tier === "danger" ? undefined : "runs unsandboxed; tier advisory only",
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
        caveat: tier === "danger" ? undefined : `${PI_TIER_ACTIVE_TOOLS[tier].join("/")} tools only; no project extensions`,
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
      // Get out of the way: agy's default headless sandbox (proceed-in-sandbox)
      // hard-denies read-only tools like read_url_content, so we always pass the
      // bypass flag and treat readonly/edit as advisory profile-body instructions.
      return ["--dangerously-skip-permissions"];
    case "grok":
      if (tier === "readonly") return ["--sandbox", "read-only", "--permission-mode", "bypassPermissions"];
      if (tier === "edit") return ["--sandbox", "workspace", "--permission-mode", "bypassPermissions"];
      return ["--sandbox", "off", "--permission-mode", "bypassPermissions"];
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
