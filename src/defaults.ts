import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compileProfile } from "./profile-creator.ts";
import { getSubagentProfiles, isExternalAgentProfile, isValidSubagentName } from "./profiles.ts";
import type { SubagentBackend, SubagentProfile } from "./types.ts";

/**
 * Default profile roster shipped with the extension: five code-oriented roles
 * (explorer, planner, implementer, reviewer, qa) plus the generalist worker.
 * Models and thinking are intentionally unpinned so defaults track the CLI's
 * own model and the current Pi thinking level instead of going stale.
 */
const DEFAULT_ROLES = {
  explorer: {
    permission: "readonly",
    description: "Repository exploration through ${backendLabel}.",
    body: "Explore the repository read-only. Identify architecture, entry points, tests, configuration, risks, and recommended first-read files. Do not modify files or repository state.",
  },
  planner: {
    permission: "readonly",
    description: "Implementation planning through ${backendLabel}.",
    body: "Create a concise implementation plan. Identify affected files, risks, validation steps, and open questions. Do not modify files or repository state.",
  },
  implementer: {
    permission: "danger",
    description: "Code implementation through ${backendLabel}.",
    body: "Implement the requested change carefully. Keep changes minimal, preserve existing style, run relevant validation, and report the results. Avoid unrelated edits.",
  },
  reviewer: {
    permission: "readonly",
    description: "Code review through ${backendLabel}.",
    body: "Review code for correctness, edge cases, regressions, maintainability, security, accessibility when relevant, and missing tests. Prioritize concrete findings by severity with file references. Do not modify files or repository state.",
  },
  qa: {
    permission: "danger",
    description: "Requirements-based test authoring through ${backendLabel}.",
    body: "Write automated tests from the stated requirements, independent of the implementation. Derive cases from the spec first; read implementation only to target the right test layer. Run the tests you write. Do not fix code or implement features. Report requirement-coverage gaps and untestable requirements.",
  },
  worker: {
    permission: "danger",
    description: "General-purpose work through ${backendLabel}.",
    body: "Complete the requested task using your best judgment. Do the work well and completely rather than minimally, and use your own approach. Report what you did and anything you deliberately skipped.",
  },
} as const satisfies Record<string, { permission: "readonly" | "danger"; description: string; body: string }>;

const DEFAULT_BACKENDS: SubagentBackend[] = ["claude", "codex", "agy"];
const BACKEND_LABELS: Record<string, string> = { claude: "Claude Code", codex: "Codex CLI", agy: "Antigravity" };

/**
 * Bump the suffix when the default roster changes so upgrades re-seed the new
 * set (still never overwriting files the user already has).
 */
const SEED_MARKER = ".pi-flow-defaults-seeded-v1";

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
  const marker = join(dir, SEED_MARKER);
  if (existsSync(marker)) return { seeded: false, added: [] };
  mkdirSync(dir, { recursive: true });

  const added: string[] = [];
  for (const name of defaultProfileNames()) {
    const path = join(dir, `${name}.md`);
    if (existsSync(path)) continue;
    const profile = buildDefaultProfile(name);
    if (!profile) continue;
    writeFileSync(path, compileProfile(profile), { encoding: "utf8", flag: "wx", mode: 0o600 });
    added.push(name);
  }
  writeFileSync(marker, "", { encoding: "utf8", flag: "wx", mode: 0o600 });
  return { seeded: true, added };
}

/** Parsed profiles this extension cannot delegate to (backend: pi or none). */
export function findLegacyProfiles(agentDir: string): SubagentProfile[] {
  return [...getSubagentProfiles(agentDir).values()].filter((profile) => !isExternalAgentProfile(profile));
}

export interface ArchiveResult {
  archived: string[];
  /** Names skipped because the archive already holds a file of that name. */
  skipped: string[];
}

/** Move named profiles to <agentDir>/subagents/archive/. Never deletes. */
export function archiveProfiles(agentDir: string, names: string[]): ArchiveResult {
  const dir = join(agentDir, "subagents");
  const archive = join(dir, "archive");
  mkdirSync(archive, { recursive: true });
  const archived: string[] = [];
  const skipped: string[] = [];
  for (const name of names) {
    if (!isValidSubagentName(name)) {
      skipped.push(name);
      continue;
    }
    const source = join(dir, `${name}.md`);
    const destination = join(archive, `${name}.md`);
    if (!existsSync(source) || existsSync(destination)) {
      skipped.push(name);
      continue;
    }
    renameSync(source, destination);
    archived.push(name);
  }
  return { archived, skipped };
}
