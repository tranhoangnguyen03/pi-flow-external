import type { PermissionTier, SubagentBackend, SubagentProfile } from "../types.ts";

export interface PermissionResolution {
  tier: PermissionTier;
  /** True when the backend enforces the tier with a native mechanism. */
  enforced: boolean;
  /** Short human-readable caveat shown in disclosure labels. */
  caveat: string | undefined;
}

/**
 * Known execution-oriented roles that require command/Bash execution
 * (running tests, build tools, git inspection, etc.).
 */
export const EXECUTION_ROLES: readonly string[] = ["implementer", "debugger", "qa", "worker"];

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
 * `edit` (acceptEdits); execution profiles (such as implementer, debugger, qa,
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
  const baseTier = requestedTier ?? profile?.permission ?? defaultTier;
  if (profile?.backend === "agy") {
    // Get out of the way: agy's only unsandboxed headless mode is
    // --dangerously-skip-permissions, and its default sandbox denies even
    // read-only tools (read_url_content). Every agy run is therefore
    // unsandboxed; any readonly/edit tier is an advisory instruction carried
    // by the profile body, not a harness boundary.
    return "danger";
  }
  if (profile?.backend === "claude" && isExecutionProfile(profile) && baseTier === "edit") {
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
        // plan/acceptEdits auto-deny Bash headlessly; denials are surfaced.
        caveat: tier === "danger" ? undefined : "Bash auto-denied headlessly",
      };
    case "codex":
      return {
        tier,
        enforced: true,
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
        caveat: tier === "danger" ? undefined : "runs unsandboxed; tier advisory only",
      };
    default:
      return { tier, enforced: false, caveat: "advisory, not enforced" };
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
    default:
      return [];
  }
}

/** Disclosure label used in delegation cards and receipts. */
export function permissionLabel(resolution: PermissionResolution): string {
  const { tier, enforced, caveat } = resolution;
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
