import type { SubagentBackend } from "../types.ts";

export function getBackendAgentLabel(backend: SubagentBackend | undefined): string {
  if (backend === "pi") {
    return "Pi Agent";
  }
  if (backend === "codex") {
    return "Codex CLI";
  }
  if (backend === "claude") {
    return "Claude Code";
  }
  if (backend === "agy") {
    return "Antigravity";
  }
  return "Agent";
}
