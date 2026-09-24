import { DEFAULT_ROLES } from "./default-roles.ts";
import type { SubagentBackend, SubagentProfile } from "./types.ts";

/**
 * Default profile roster shipped with the extension: five code-oriented roles
 * (explorer, planner, implementer, reviewer, qa) plus the generalist worker.
 * Models and thinking are intentionally unpinned so defaults track the CLI's
 * own model and the current Pi thinking level instead of going stale.
 * Role bodies themselves live in default-roles.ts, the one canonical source
 * also used to synthesize the same six roles for named Pi harness configs.
 */
const DEFAULT_BACKENDS: SubagentBackend[] = ["claude", "codex", "agy", "grok", "muse"];
const BACKEND_LABELS: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex CLI",
  agy: "Antigravity",
  grok: "Grok CLI",
  muse: "Muse Code",
};

export function defaultProfileNames(): string[] {
  return DEFAULT_BACKENDS.flatMap((backend) => Object.keys(DEFAULT_ROLES).map((role) => `${backend}-${role}`));
}

export function buildDefaultProfile(name: string): SubagentProfile | undefined {
  const backend = DEFAULT_BACKENDS.find((candidate) => name.startsWith(`${candidate}-`));
  const role = backend ? Object.keys(DEFAULT_ROLES).find((candidate) => name === `${backend}-${candidate}`) : undefined;
  if (!backend || !role) return undefined;
  const definition = DEFAULT_ROLES[role as keyof typeof DEFAULT_ROLES];
  return {
    name,
    description: definition.description.replaceAll("${backendLabel}", BACKEND_LABELS[backend]),
    backend,
    systemPrompt: definition.body,
  };
}
