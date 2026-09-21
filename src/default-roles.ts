/**
 * Canonical role bodies shared by every backend that ships the default
 * roster: the five external CLIs (claude/codex/agy/grok/muse, one file per role) and
 * any registered named Pi harness config (synthesized in-memory per role,
 * see src/profiles.ts). This module is a dependency-free leaf: it must not
 * import from profiles.ts or defaults.ts, so both can import from here
 * without a cycle.
 */
export interface RoleDefinition {
  permission: "readonly" | "danger";
  description: string;
  body: string;
}

export const DEFAULT_ROLES = {
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
} as const satisfies Record<string, RoleDefinition>;

export type DefaultRoleName = keyof typeof DEFAULT_ROLES;

export function roleDefinition(role: string): RoleDefinition | undefined {
  return Object.prototype.hasOwnProperty.call(DEFAULT_ROLES, role)
    ? DEFAULT_ROLES[role as DefaultRoleName]
    : undefined;
}

export function defaultRoleNames(): DefaultRoleName[] {
  return Object.keys(DEFAULT_ROLES) as DefaultRoleName[];
}
