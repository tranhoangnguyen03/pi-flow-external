import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compileProfile } from "./profile-creator.ts";
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

/**
 * Bump the suffix when the default roster changes so upgrades re-seed the new
 * set (still never overwriting files the user already has).
 */
const SEED_MARKER_V1 = ".pi-flow-defaults-seeded-v1";
const SEED_MARKER_V2 = ".pi-flow-defaults-seeded-v2";
const SEED_MARKER_V3 = ".pi-flow-defaults-seeded-v3";

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
    permission: definition.permission,
  };
}

export interface SeedResult {
  /** True when this call performed the one-time seeding pass. */
  seeded: boolean;
  /** Profiles written by this call; existing files are never touched. */
  added: string[];
}

/**
 * Best-effort, one-time installation of the default roster into
 * <agentDir>/subagents. A marker file makes seeding a single event: profiles
 * the user deletes or customizes afterwards stay that way. Never overwrites
 * an existing file and never removes anything.
 */
export function seedDefaultProfiles(agentDir: string): SeedResult {
  const dir = join(agentDir, "subagents");
  const markerV3 = join(dir, SEED_MARKER_V3);
  if (existsSync(markerV3)) return { seeded: false, added: [] };
  mkdirSync(dir, { recursive: true });

  // On an upgrade, only the backend(s) newly introduced since the install's
  // last seeding pass are candidates: an already-seeded backend's files must
  // never be reconsidered, or a profile the user deliberately deleted would
  // be silently resurrected the moment the roster grows again.
  const markerV1 = join(dir, SEED_MARKER_V1);
  const markerV2 = join(dir, SEED_MARKER_V2);
  const newBackends = existsSync(markerV2)
    ? ["muse"]
    : existsSync(markerV1)
      ? ["grok", "muse"]
      : DEFAULT_BACKENDS;
  const candidateNames = defaultProfileNames().filter((name) => newBackends.some((backend) => name.startsWith(`${backend}-`)));

  const added: string[] = [];
  for (const name of candidateNames) {
    const path = join(dir, `${name}.md`);
    if (existsSync(path)) continue;
    const profile = buildDefaultProfile(name);
    if (!profile) continue;
    writeFileSync(path, compileProfile(profile), { encoding: "utf8", flag: "wx", mode: 0o600 });
    added.push(name);
  }
  try {
    writeFileSync(markerV3, "", { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
  }
  return { seeded: true, added };
}
