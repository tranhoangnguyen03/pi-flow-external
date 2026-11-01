import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type ExternalMode = "normal" | "orchestrator" | "frontline-worker";
export const EXTERNAL_MODE_ENTRY = "pi-flow-external-mode";
export const EXTERNAL_MODE_STATUS_KEY = "pi-flow-mode";

// Keep reading the two-state entries written by versions before the three-mode cycle.
const LEGACY_ORCHESTRATOR_MODE_ENTRY = "pi-flow-external-orchestrator-mode";

export function getExternalMode(ctx: Pick<ExtensionContext, "sessionManager">): ExternalMode {
  const branch = ctx.sessionManager.getBranch();
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (entry?.type !== "custom") continue;
    if (entry.customType !== EXTERNAL_MODE_ENTRY && entry.customType !== LEGACY_ORCHESTRATOR_MODE_ENTRY) continue;
    if (!entry.data || typeof entry.data !== "object") continue;

    const data = entry.data as { mode?: unknown; enabled?: unknown };
    if (entry.customType === EXTERNAL_MODE_ENTRY) {
      if (data.mode === "normal" || data.mode === "orchestrator" || data.mode === "frontline-worker") {
        return data.mode;
      }
    } else if (data.enabled === true || data.enabled === false) {
      return data.enabled ? "orchestrator" : "normal";
    }
  }
  return "normal";
}

export function nextExternalMode(current: ExternalMode): ExternalMode {
  if (current === "normal") return "orchestrator";
  if (current === "orchestrator") return "frontline-worker";
  return "normal";
}

export function externalModeLabel(mode: ExternalMode): string {
  if (mode === "orchestrator") return "Orchestrator";
  if (mode === "frontline-worker") return "Frontline Worker";
  return "Normal";
}

export function updateExternalModeStatus(
  ctx: Pick<ExtensionContext, "sessionManager" | "hasUI" | "ui">,
): void {
  if (!ctx.hasUI) return;
  const mode = getExternalMode(ctx);
  ctx.ui.setStatus(EXTERNAL_MODE_STATUS_KEY, mode === "normal" ? undefined : `pi-flow: ${mode}`);
}
