import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WORKFLOW_API_VERSION, type WorkflowAgentCall, type WorkflowSubagentDescriptor } from "./types.ts";
import type { PermissionTier } from "../types.ts";

const PI_CODING_AGENT_PACKAGE_NAME = "@earendil-works/pi-coding-agent";

/**
 * Resolve the installed pi-coding-agent SDK's own version without a fragile
 * hardcoded relative path (e.g. "../../node_modules/.../package.json", which
 * breaks under hoisting/workspaces) and without going through Node's module
 * resolver at all: that package's "exports" map only exposes "." as an
 * ESM-only ("import") condition, so a plain `require.resolve` (CJS
 * resolution) or a subpath import of ".../package.json" both fail outright,
 * which would be exactly the fragile-import trap this function exists to
 * avoid. Instead, walk up from this file's own directory checking each
 * ancestor's node_modules/@earendil-works/pi-coding-agent/package.json in
 * turn — the same directory-walk Node's own bare-specifier resolution uses
 * internally, reimplemented here with plain fs so it is immune to that
 * package's exports-map/module-format details entirely. Never throws: an
 * unresolvable version degrades to "unknown" so a packaging change can never
 * break workflow fingerprinting.
 */
export function resolvePiCodingAgentVersion(): string {
  try {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let depth = 0; depth < 12; depth++) {
      const candidate = join(dir, "node_modules", "@earendil-works", "pi-coding-agent", "package.json");
      if (existsSync(candidate)) {
        const pkg = JSON.parse(readFileSync(candidate, "utf8")) as { name?: string; version?: string };
        if (pkg.name === PI_CODING_AGENT_PACKAGE_NAME && typeof pkg.version === "string") {
          return pkg.version;
        }
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // Resolution failure must never break fingerprinting.
  }
  return "unknown";
}

/**
 * A coarse tag for this extension's own tier->tool-exclusion table (see
 * src/core/spawn.ts's pi branch), combined with the pinned SDK's own
 * installed version. Bump the literal suffix whenever *this extension's*
 * policy changes; the SDK version changes on its own whenever the pinned
 * dependency is upgraded. Either change invalidates a stale replay-cache
 * entry instead of silently matching a call whose effective tool grant may
 * have changed underneath it. This is deliberately coarse (a version tag,
 * not a full tool-list hash): the goal is cache invalidation on policy
 * change, not a security boundary.
 */
export const WORKFLOW_FINGERPRINT_POLICY_VERSION = `pi-flow-external:tier-tools-v1+pi-coding-agent@${resolvePiCodingAgentVersion()}`;

export function fingerprintWorkflowAgentCall(
  call: WorkflowAgentCall,
  descriptor?: WorkflowSubagentDescriptor,
  effectivePermission?: PermissionTier,
): string {
  return hashStableValue({
    apiVersion: WORKFLOW_API_VERSION,
    cwd: call.cwd,
    prompt: call.prompt,
    ...(call.context ? { context: call.context } : {}),
    label: call.label,
    phase: call.phase,
    subagentType: call.subagentType,
    schema: call.schema,
    permission: call.permission,
    maxBudgetUsd: call.maxBudgetUsd,
    resumeRunId: call.resumeRunId,
    ...(descriptor
      ? {
        descriptorBackend: descriptor.backend,
        descriptorHarness: descriptor.harness,
        descriptorModel: descriptor.model,
        descriptorThinking: descriptor.thinking,
        descriptorPreset: descriptor.preset,
        descriptorSystemPrompt: descriptor.systemPrompt,
        descriptorTools: descriptor.tools,
        descriptorMaxBudgetUsd: descriptor.maxBudgetUsd,
        policyVersion: WORKFLOW_FINGERPRINT_POLICY_VERSION,
      }
      : {}),
    ...(effectivePermission ? { effectivePermission } : {}),
  });
}

export function hashStableValue(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value: unknown): string {
  return JSON.stringify(normalizeForStableStringify(value));
}

function normalizeForStableStringify(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === undefined) return { $type: "undefined" };
  if (typeof value === "bigint") return { $type: "bigint", value: value.toString() };
  if (typeof value === "function") return { $type: "function" };
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return { $type: "circular" };
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => normalizeForStableStringify(item, seen));
    }
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = normalizeForStableStringify((value as Record<string, unknown>)[key], seen);
    }
    return out;
  } finally {
    seen.delete(value);
  }
}
