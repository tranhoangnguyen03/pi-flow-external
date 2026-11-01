import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

// Custom entries follow the session's active branch, including resumes and tree navigation.
export const ORCHESTRATOR_MODE_ENTRY = "pi-flow-external-orchestrator-mode";
export const ORCHESTRATOR_MODE_STATUS_KEY = "pi-flow-mode";

export function isOrchestratorMode(ctx: Pick<ExtensionContext, "sessionManager">): boolean {
  const branch = ctx.sessionManager.getBranch();
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (entry?.type === "custom" && entry.customType === ORCHESTRATOR_MODE_ENTRY) {
      return (entry.data as { enabled?: boolean } | undefined)?.enabled === true;
    }
  }
  return false;
}

export function updateOrchestratorModeStatus(
  ctx: Pick<ExtensionContext, "sessionManager" | "hasUI" | "ui">,
): void {
  if (!ctx.hasUI) return;
  ctx.ui.setStatus(ORCHESTRATOR_MODE_STATUS_KEY, isOrchestratorMode(ctx) ? "pi-flow: orchestrator" : undefined);
}
