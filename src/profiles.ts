import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { PermissionTier, SubagentBackend, SubagentProfile, ThinkingLevel } from "./types.ts";

const EXTERNAL_AGENT_BACKENDS: SubagentBackend[] = ["codex", "claude", "agy"];

const VALID_PROFILE_NAME = /^[a-z0-9][a-z0-9-]*$/;

export function isValidSubagentName(name: string): boolean {
  return VALID_PROFILE_NAME.test(name);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseThinking(value: unknown): ThinkingLevel | undefined {
  if (value === undefined || value === null || value === "inherit") {
    return undefined;
  }
  return optionalString(value);
}

function parseBackend(value: unknown): SubagentBackend | "invalid" {
  if (value === undefined || value === null || value === "inherit") {
    return "pi";
  }
  const backend = optionalString(value);
  if (backend === "pi" || backend === "codex" || backend === "claude" || backend === "agy") {
    return backend;
  }
  return "invalid";
}

function parseModel(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "inherit") {
    return undefined;
  }
  return optionalString(value);
}

function parseToolList(value: unknown): string[] | "invalid" {
  if (typeof value !== "string") {
    return "invalid";
  }
  const tools: string[] = [];
  const seen = new Set<string>();
  for (const rawValue of value.split(",")) {
    const tool = rawValue.trim();
    if (!tool || seen.has(tool)) {
      continue;
    }
    seen.add(tool);
    tools.push(tool);
  }
  return tools.length > 0 ? tools : "invalid";
}

function parsePermission(value: unknown): PermissionTier | "invalid" | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (value === "readonly" || value === "edit" || value === "danger") {
    return value;
  }
  return "invalid";
}

function parseMaxBudgetUsd(value: unknown): number | "invalid" | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value === "number" && value > 0) {
    return value;
  }
  return "invalid";
}

export function parseSubagentProfileContent(
  content: string,
  name: string,
  options: { requireBody: boolean } = { requireBody: false },
): SubagentProfile | undefined {
  let parsed: { frontmatter: Record<string, unknown>; body: string };
  try {
    parsed = parseFrontmatter<Record<string, unknown>>(content);
  } catch {
    return undefined;
  }

  const description = optionalString(parsed.frontmatter.description);
  const body = parsed.body.trim();
  const backend = parseBackend(parsed.frontmatter.backend);
  if (backend === "invalid") {
    return undefined;
  }
  const model = parseModel(parsed.frontmatter.model);
  const thinking = parseThinking(parsed.frontmatter.thinking);
  const tools = Object.prototype.hasOwnProperty.call(parsed.frontmatter, "tools")
    ? parseToolList(parsed.frontmatter.tools)
    : undefined;
  const permission = parsePermission(parsed.frontmatter.permission);
  const maxBudgetUsd = parseMaxBudgetUsd(parsed.frontmatter.max_budget_usd);

  if (
    !description ||
    tools === "invalid" ||
    permission === "invalid" ||
    maxBudgetUsd === "invalid" ||
    (options.requireBody && !body)
  ) {
    return undefined;
  }

  return {
    name,
    description,
    backend,
    model,
    thinking,
    tools,
    systemPrompt: body || undefined,
    permission,
    maxBudgetUsd,
  };
}

function parseProfileFile(filePath: string, name: string, options: { requireBody: boolean }): SubagentProfile | undefined {
  try {
    return parseSubagentProfileContent(readFileSync(filePath, "utf-8"), name, options);
  } catch {
    return undefined;
  }
}

export function loadCustomSubagentProfiles(agentDir = getAgentDir()): Map<string, SubagentProfile> {
  const dir = join(agentDir, "subagents");
  const profiles = new Map<string, SubagentProfile>();
  if (!existsSync(dir)) {
    return profiles;
  }

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return profiles;
  }

  for (const entry of entries) {
    if (!entry.endsWith(".md")) {
      continue;
    }
    const name = basename(entry, ".md");
    if (!isValidSubagentName(name)) {
      continue;
    }
    const profile = parseProfileFile(join(dir, entry), name, { requireBody: false });
    if (profile) {
      profiles.set(name, profile);
    }
  }

  return profiles;
}

export function getSubagentProfiles(agentDir = getAgentDir()): Map<string, SubagentProfile> {
  return loadCustomSubagentProfiles(agentDir);
}

export function isExternalAgentProfile(profile: SubagentProfile): boolean {
  return EXTERNAL_AGENT_BACKENDS.includes(profile.backend);
}

export function filterExternalAgentProfiles(profiles: Map<string, SubagentProfile>): Map<string, SubagentProfile> {
  return new Map([...profiles].filter(([, profile]) => isExternalAgentProfile(profile)));
}

export function formatExternalAgentPolicyError(profile: SubagentProfile): string {
  return `Profile "${profile.name}" uses backend "${profile.backend}". This Agent tool is configured for external delegation only; use Claude/Codex profiles (backend: claude, backend: codex, or backend: agy) here, and use the native subagent system for Pi-backed agents.`;
}
