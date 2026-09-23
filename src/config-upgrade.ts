/**
 * One-time configuration conversion and the separate legacy-file purge.
 *
 * planConfigUpgrade / applyConfigUpgrade read pre-v4 settings, the legacy
 * harness registry, and subagent profiles. Customized external profiles are
 * raw-copied into pi-flow-external/overrides, deleted seeded identities are
 * recorded on settings version 4, and the original subagent files, seed
 * markers, and harnesses.json stay in place. Override copies land first.
 * Replacing settings.json with version 4 is the activation write.
 *
 * planLegacyPurge / purgeLegacyFiles run only after that version 4 file is
 * present. purgeLegacyFiles deletes a previewed regular file when its bytes
 * still match the preview fingerprint.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  type Dirent,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { buildDefaultProfile } from "./defaults.ts";
import { HARNESS_NAME_PATTERN, parseHarnessEntry, type HarnessConfig } from "./harnesses.ts";
import { isValidSubagentName, parseSubagentProfileContent } from "./profiles.ts";
import { externalSettingsPath, parseSettings, type ExternalSettings } from "./settings.ts";

export const CONFIG_VERSION = 4;
export const CONFIG_DIR = "pi-flow-external";
export const SETTINGS_FILE = "settings.json";
export const OVERRIDES_DIR = "overrides";
export const LEGACY_SUBAGENTS_DIR = "subagents";
export const LEGACY_HARNESSES_FILE = "harnesses.json";
export const LEGACY_SEED_MARKERS = [
  ".pi-flow-defaults-seeded-v1",
  ".pi-flow-defaults-seeded-v2",
  ".pi-flow-defaults-seeded-v3",
] as const;
export const LEGACY_CLI_HARNESSES = ["agy", "claude", "codex", "grok", "muse"] as const;
export const LEGACY_DEFAULT_ROLES = ["explorer", "planner", "implementer", "reviewer", "qa", "worker"] as const;
export const ROLES_DIR = "roles";
const SHARED_PI_HARNESS_MARKER = "pi-*";
const OBSOLETE_PROFILE_KEYS = new Set(["permission", "capabilitySet"]);
/** Permission values the historical seeder wrote. Live roles no longer declare them. */
const HISTORICAL_SEED_PERMISSION: Record<(typeof LEGACY_DEFAULT_ROLES)[number], "readonly" | "danger"> = {
  explorer: "readonly",
  planner: "readonly",
  implementer: "danger",
  reviewer: "readonly",
  qa: "danger",
  worker: "danger",
};

const PROFILE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const LEGACY_FIELD_KEYS = [
  "defaultHarness",
  "maxConcurrentSubagents",
  "subagentTimeoutMs",
  "defaultPermission",
  "defaultMaxBudgetUsd",
  "maxRunRecords",
] as const;
const V1_COHORT = ["agy", "claude", "codex"] as const;
const V2_COHORT = ["agy", "claude", "codex", "grok"] as const;
const DEFAULT_NAMES = new Set(LEGACY_CLI_HARNESSES.flatMap((harness) => LEGACY_DEFAULT_ROLES.map((role) => `${harness}-${role}`)));

type CliHarness = (typeof LEGACY_CLI_HARNESSES)[number];

/** Canonical harness entry from parseHarnessEntry. */
export type ConfigUpgradeHarness = HarnessConfig;

/** Canonical version 4 settings from parseSettings. */
export type ConfigUpgradeSettings = ExternalSettings;

export type ConfigUpgradeOverrideReason = "modified-default" | "custom-cli" | "named-pi" | "nonstandard";

export interface ConfigUpgradeOverride {
  name: string;
  sourcePath: string;
  destinationPath: string;
  /** SHA-256 hex of the raw source bytes. */
  fingerprint: string;
  /** File body to install. Obsolete permission/capabilitySet metadata is already removed. */
  contents: string;
  reason: ConfigUpgradeOverrideReason;
}

export interface ConfigUpgradeRole {
  name: string;
  sourcePath: string;
  destinationPath: string;
  /** SHA-256 hex of the raw source bytes. */
  fingerprint: string;
  /** Ordinary cross-harness role markdown. */
  contents: string;
}

export interface ConfigUpgradePlan {
  status: "ready" | "current" | "empty" | "blocked";
  diagnostics: string[];
  settingsPath: string;
  /** Present when status is "ready". */
  settings?: ConfigUpgradeSettings;
  /** Legacy settings keys with no v4 meaning, retained on the written file. */
  preservedFields: Record<string, unknown>;
  overrides: ConfigUpgradeOverride[];
  roles: ConfigUpgradeRole[];
  /** Explicit obsolete-metadata notes. These do not block conversion. */
  notes: string[];
  disabledProfiles: string[];
  unchangedDefaults: string[];
  /** Native Pi profiles and seeded names whose metadata contradicts an external profile. */
  excludedProfiles: string[];
  /** SHA-256 of the legacy inputs. applyConfigUpgrade refuses activation when it changes. */
  sourceDigest?: string;
}

export interface ConfigUpgradeApplyResult {
  status: "applied" | "current" | "empty" | "blocked";
  diagnostics: string[];
  settingsPath: string;
  /** Override paths that match the conversion set. Includes copies installed before a failed activation. */
  overridesInstalled: string[];
  rolesInstalled: string[];
  notes: string[];
  disabledProfiles: string[];
  settings?: ConfigUpgradeSettings;
  preservedFields: Record<string, unknown>;
}

export type LegacyPurgeKind =
  | "seeded-profile"
  | "custom-cli-profile"
  | "named-pi-profile"
  | "shared-pi-template"
  | "nonstandard-profile"
  | "seed-marker"
  | "harness-registry";

export interface LegacyPurgeCandidate {
  path: string;
  /** Path relative to the agent directory. */
  relativePath: string;
  kind: LegacyPurgeKind;
  name: string;
  /** True when pi-flow-external/overrides holds an identical raw copy. */
  copied: boolean;
  /** False for nonstandard exact-only names, which stay out of the default inventory. */
  inventory: boolean;
  /** SHA-256 hex of the file bytes at preview time. */
  fingerprint: string;
}

export interface LegacyPurgePlan {
  status: "ready" | "blocked";
  diagnostics: string[];
  candidates: LegacyPurgeCandidate[];
}

export interface LegacyPurgeSelection {
  path: string;
  fingerprint: string;
}

export type LegacyPurgeSkipReason =
  | "already-absent"
  | "changed-since-preview"
  | "not-regular"
  | "outside-inventory"
  | "settings-v4-required";

export interface LegacyPurgeReport {
  status: "purged" | "blocked";
  diagnostics: string[];
  deleted: string[];
  skipped: Array<{ path: string; reason: LegacyPurgeSkipReason }>;
  failed: Array<{ path: string; reason: string }>;
}

type ReadResult =
  | { kind: "missing" }
  | { kind: "other" }
  | { kind: "error"; message: string }
  | { kind: "file"; bytes: Buffer };

type ProfileUpgrade = "ignore" | "copy" | "role" | "unchanged" | "exclude" | "block";

interface ClassifiedProfile {
  name: string;
  path: string;
  bytes?: Buffer;
  /** Bytes that conversion installs, when different from the legacy source. */
  writtenBytes?: Buffer;
  roleName?: string;
  notes?: string[];
  upgrade: ProfileUpgrade;
  reason?: ConfigUpgradeOverrideReason;
  purge?: { kind: LegacyPurgeKind; inventory: boolean };
  diagnostic?: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function settingsPath(root: string): string {
  return externalSettingsPath(root);
}

function overridesDir(root: string): string {
  return join(root, CONFIG_DIR, OVERRIDES_DIR);
}

function overridePath(root: string, name: string): string {
  return join(overridesDir(root), `${name}.md`);
}

function harnessesPath(root: string): string {
  return join(root, CONFIG_DIR, LEGACY_HARNESSES_FILE);
}

function subagentsDir(root: string): string {
  return join(root, LEGACY_SUBAGENTS_DIR);
}

function isInside(root: string, target: string): boolean {
  const base = resolve(root);
  const prefix = base.endsWith(sep) ? base : `${base}${sep}`;
  return resolve(target).startsWith(prefix);
}

function readRegular(path: string): ReadResult {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile()) return { kind: "other" };
    return { kind: "file", bytes: readFileSync(path) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    return { kind: "error", message: errorMessage(error) };
  }
}

function ensureDir(path: string): void {
  try {
    if (lstatSync(path).isDirectory()) return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  mkdirSync(path, { recursive: true });
}

function sameFileBytes(path: string, bytes: Buffer): boolean {
  const read = readRegular(path);
  return read.kind === "file" && read.bytes.equals(bytes);
}

/**
 * Byte-for-byte shape compileProfile() writes for a seeded default: description,
 * backend, permission, and body. Any other bytes stay an exact override.
 */
function canonicalSeededBytes(name: string): Buffer | undefined {
  const profile = buildDefaultProfile(name);
  const role = LEGACY_DEFAULT_ROLES.find((candidate) => name.endsWith(`-${candidate}`));
  const permission = role ? HISTORICAL_SEED_PERMISSION[role] : undefined;
  if (!profile?.systemPrompt || !permission) return undefined;
  const frontmatter = [
    `description: ${JSON.stringify(profile.description.trim())}`,
    `backend: ${profile.backend}`,
    `permission: ${JSON.stringify(permission)}`,
  ];
  return Buffer.from(`---\n${frontmatter.join("\n")}\n---\n\n${profile.systemPrompt.trim()}\n`, "utf8");
}

function rolePath(root: string, name: string): string {
  return join(root, CONFIG_DIR, ROLES_DIR, `${name}.md`);
}

function installedProfileBytes(bytes: Buffer): { bytes: Buffer; removed: string[] } {
  let parsed: { frontmatter: Record<string, unknown>; body: string };
  try {
    parsed = parseFrontmatter<Record<string, unknown>>(bytes.toString("utf8"));
  } catch {
    return { bytes, removed: [] };
  }
  const removed = Object.keys(parsed.frontmatter).filter((key) => OBSOLETE_PROFILE_KEYS.has(key));
  if (removed.length === 0) return { bytes, removed };
  const lines = Object.entries(parsed.frontmatter)
    .filter(([key]) => !OBSOLETE_PROFILE_KEYS.has(key))
    .map(([key, value]) => `${key}: ${typeof value === "string" ? JSON.stringify(value) : Array.isArray(value) ? value.join(", ") : String(value)}`);
  return {
    bytes: Buffer.from(`---\n${lines.join("\n")}\n---\n\n${parsed.body.trim()}\n`, "utf8"),
    removed,
  };
}

function classifySharedTemplate(name: string, path: string, bytes: Buffer, parsed: NonNullable<ReturnType<typeof parseSubagentProfileContent>>): ClassifiedProfile {
  const role = name.startsWith("pi-") ? name.slice(3) : "";
  let dropped: string[] = [];
  try {
    dropped = Object.keys(parseFrontmatter<Record<string, unknown>>(bytes.toString("utf8")).frontmatter).filter((key) => key !== "description");
  } catch {
    dropped = [];
  }
  if (!isValidSubagentName(role) || !parsed.description.trim() || !parsed.systemPrompt?.trim()) {
    return {
      name,
      path,
      bytes,
      upgrade: "block",
      purge: { kind: "shared-pi-template", inventory: true },
      diagnostic: `${path} declares harness "${SHARED_PI_HARNESS_MARKER}" but cannot be converted to a shared role. It needs a pi-<role>.md name, a description, and instructions.`,
    };
  }
  const writtenBytes = Buffer.from(`---\ndescription: ${JSON.stringify(parsed.description.trim())}\n---\n\n${parsed.systemPrompt.trim()}\n`, "utf8");
  return {
    name,
    path,
    bytes,
    writtenBytes,
    roleName: role,
    upgrade: "role",
    notes: [`${path} converts to roles/${role}.md as a cross-harness role. Dropped metadata: ${dropped.join(", ") || "none"}. Review the instructions; they now apply to every harness.`],
    purge: { kind: "shared-pi-template", inventory: true },
  };
}

function cliPrefix(name: string): CliHarness | undefined {
  return LEGACY_CLI_HARNESSES.find((harness) => name.startsWith(`${harness}-`) && name.length > harness.length + 1);
}

function looksLikeLegacyProfileName(name: string): boolean {
  if (!PROFILE_NAME_PATTERN.test(name)) return false;
  if (DEFAULT_NAMES.has(name) || cliPrefix(name)) return true;
  return name.startsWith("pi-") && name.split("-").length >= 3;
}

function namedPiHarness(backend: string, harness: string | undefined, name: string): string | undefined {
  if (backend !== "pi" || !harness || !HARNESS_NAME_PATTERN.test(harness)) return undefined;
  const prefix = `${harness}-`;
  return name.startsWith(prefix) && name.length > prefix.length ? harness : undefined;
}

function classifyRegular(name: string, path: string, bytes: Buffer): ClassifiedProfile {
  const parsed = parseSubagentProfileContent(bytes.toString("utf8"), name, { requireBody: false });
  if (!parsed) {
    if (!looksLikeLegacyProfileName(name)) return { name, path, upgrade: "ignore" };
    const purge = DEFAULT_NAMES.has(name)
      ? { kind: "seeded-profile" as const, inventory: true }
      : undefined;
    return {
      name,
      path,
      bytes,
      upgrade: "block",
      purge,
      diagnostic: `${path} could not be parsed, so conversion will not drop it.`,
    };
  }

  if (parsed.backend === "pi" && parsed.harness === SHARED_PI_HARNESS_MARKER) {
    return classifySharedTemplate(name, path, bytes, parsed);
  }
  if (namedPiHarness(parsed.backend, parsed.harness, name)) {
    return { name, path, bytes, upgrade: "copy", reason: "named-pi", purge: { kind: "named-pi-profile", inventory: true } };
  }
  if (parsed.backend === "pi") {
    return { name, path, bytes, upgrade: "exclude" };
  }

  const prefix = cliPrefix(name);
  if (DEFAULT_NAMES.has(name)) {
    const canonical = canonicalSeededBytes(name);
    if (canonical && bytes.equals(canonical)) {
      return { name, path, bytes, upgrade: "unchanged", purge: { kind: "seeded-profile", inventory: true } };
    }
    // A seeded filename that declares a different CLI is not that identity.
    if (prefix !== parsed.backend) {
      return { name, path, bytes, upgrade: "copy", reason: "nonstandard", purge: { kind: "nonstandard-profile", inventory: false } };
    }
    return { name, path, bytes, upgrade: "copy", reason: "modified-default", purge: { kind: "seeded-profile", inventory: true } };
  }
  if (prefix && prefix === parsed.backend) {
    return { name, path, bytes, upgrade: "copy", reason: "custom-cli", purge: { kind: "custom-cli-profile", inventory: true } };
  }
  return { name, path, bytes, upgrade: "copy", reason: "nonstandard", purge: { kind: "nonstandard-profile", inventory: false } };
}

function emptyPlan(root: string, status: ConfigUpgradePlan["status"], diagnostics: string[] = []): ConfigUpgradePlan {
  return {
    status,
    diagnostics,
    settingsPath: settingsPath(root),
    preservedFields: {},
    overrides: [],
    roles: [],
    notes: [],
    disabledProfiles: [],
    unchangedDefaults: [],
    excludedProfiles: [],
  };
}

function inactiveResult(plan: ConfigUpgradePlan, diagnostics = plan.diagnostics): ConfigUpgradeApplyResult {
  return {
    status: plan.status === "ready" ? "blocked" : plan.status,
    diagnostics,
    settingsPath: plan.settingsPath,
    overridesInstalled: [],
    rolesInstalled: [],
    notes: plan.notes ?? [],
    disabledProfiles: [],
    preservedFields: {},
  };
}

function preservedLegacyFields(path: string, record: Record<string, unknown> | undefined): {
  diagnostics: string[];
  notes: string[];
  preserved: Record<string, unknown>;
} {
  if (!record) return { diagnostics: [], notes: [], preserved: {} };
  const diagnostics: string[] = [];
  const notes: string[] = [];
  if ("harnesses" in record) {
    diagnostics.push(`Settings at ${path} already contain "harnesses". Conversion leaves that file unchanged.`);
  }
  if ("disabledProfiles" in record) {
    diagnostics.push(`Settings at ${path} already contain "disabledProfiles". Conversion leaves that file unchanged.`);
  }
  const preserved: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort((a, b) => a.localeCompare(b))) {
    if (key === "piCapabilitySets") {
      notes.push(`Obsolete setting "piCapabilitySets" in ${path} was not copied. Pi children load installed skills through the SDK.`);
      continue;
    }
    if (key !== "version" && !LEGACY_FIELD_KEYS.includes(key as (typeof LEGACY_FIELD_KEYS)[number]) && key !== "harnesses" && key !== "disabledProfiles") {
      preserved[key] = record[key];
    }
  }
  return { diagnostics, notes, preserved };
}

function parseLegacyHarnesses(path: string, value: unknown): {
  diagnostics: string[];
  harnesses: Record<string, HarnessConfig>;
} {
  const diagnostics: string[] = [];
  const harnesses: Record<string, HarnessConfig> = {};
  if (!isRecord(value)) return { diagnostics: [`${path} must be a JSON object.`], harnesses };
  if (value.version !== 1) diagnostics.push(`${path} is version ${JSON.stringify(value.version)}; expected version 1.`);
  for (const key of Object.keys(value)) {
    if (key !== "version" && key !== "harnesses") diagnostics.push(`${path} has unsupported field "${key}".`);
  }
  if (value.harnesses === undefined) return { diagnostics, harnesses };
  if (!isRecord(value.harnesses)) {
    diagnostics.push(`${path} field "harnesses" must be a JSON object.`);
    return { diagnostics, harnesses };
  }
  for (const name of Object.keys(value.harnesses).sort((a, b) => a.localeCompare(b))) {
    const entry = value.harnesses[name];
    if (isRecord(entry)) {
      for (const key of Object.keys(entry)) {
        if (key !== "model" && key !== "thinking" && key !== "owner") {
          diagnostics.push(`Harness "${name}" in ${path} has unsupported field "${key}".`);
        }
      }
    }
    const config = parseHarnessEntry(name, entry);
    if (!config) {
      diagnostics.push(`Harness "${name}" in ${path} must be a pi-* name with model "<provider>/<id>".`);
      continue;
    }
    harnesses[name] = config;
  }
  return { diagnostics, harnesses };
}

function blockingSettingsDiagnostics(value: unknown): string[] {
  return parseSettings(value).diagnostics.filter((line) => !line.startsWith("Unknown setting"));
}

function serializeSettings(settings: ConfigUpgradeSettings, preserved: Record<string, unknown>): string {
  const document: Record<string, unknown> = {
    version: 4,
    defaultHarness: settings.defaultHarness,
    maxConcurrentSubagents: settings.maxConcurrentSubagents,
    subagentTimeoutMs: settings.subagentTimeoutMs,
    defaultPermission: settings.defaultPermission,
    defaultMaxBudgetUsd: settings.defaultMaxBudgetUsd,
    maxRunRecords: settings.maxRunRecords,
  };
  if (settings.harnesses && Object.keys(settings.harnesses).length > 0) {
    const harnesses: Record<string, ConfigUpgradeHarness> = {};
    for (const name of Object.keys(settings.harnesses).sort((a, b) => a.localeCompare(b))) {
      const entry = settings.harnesses[name];
      harnesses[name] = entry.owner ? { model: entry.model, thinking: entry.thinking, owner: entry.owner } : { model: entry.model, thinking: entry.thinking };
    }
    document.harnesses = harnesses;
  }
  if (settings.disabledProfiles && settings.disabledProfiles.length > 0) {
    document.disabledProfiles = [...settings.disabledProfiles];
  }
  for (const key of Object.keys(preserved).sort((a, b) => a.localeCompare(b))) {
    document[key] = preserved[key];
  }
  return `${JSON.stringify(document, null, 2)}\n`;
}

/**
 * Activation write for version 4. saveExternalSettings refuses while the
 * current file is still a blocked pre-v4 installation, so conversion performs
 * this one replacement after override copies are in place.
 */
function atomicWrite(directory: string, finalPath: string, contents: string): void {
  ensureDir(directory);
  const stagedPath = join(directory, `.settings.${process.pid}.${randomUUID()}.staged`);
  try {
    writeFileSync(stagedPath, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameSync(stagedPath, finalPath);
  } catch (error) {
    try {
      unlinkSync(stagedPath);
    } catch (unlinkError) {
      if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") throw unlinkError;
    }
    throw error;
  }
}

function cohortHarnesses(markers: { v1: boolean; v2: boolean; v3: boolean }): readonly string[] {
  if (markers.v3) return LEGACY_CLI_HARNESSES;
  if (markers.v2) return V2_COHORT;
  if (markers.v1) return V1_COHORT;
  return [];
}

interface LegacySnapshot {
  diagnostics: string[];
  evidence: boolean;
  settingsRecord: Record<string, unknown> | undefined;
  preserved: Record<string, unknown>;
  harnesses: Record<string, HarnessConfig>;
  profiles: ClassifiedProfile[];
  markers: { v1: boolean; v2: boolean; v3: boolean };
  digestLines: string[];
  notes: string[];
}

function snapshotLegacy(root: string, settingsRecord: Record<string, unknown> | undefined, settingsBytes: Buffer | undefined): LegacySnapshot {
  const diagnostics: string[] = [];
  const digestLines: string[] = [`settings ${settingsBytes ? sha256(settingsBytes) : "missing"}`];
  let evidence = settingsRecord !== undefined;
  const preservedFields = preservedLegacyFields(settingsPath(root), settingsRecord);
  diagnostics.push(...preservedFields.diagnostics);
  const notes = [...preservedFields.notes];
  const preserved = preservedFields.preserved;

  const harnessFile = harnessesPath(root);
  const harnessRead = readRegular(harnessFile);
  let harnesses: Record<string, ConfigUpgradeHarness> = {};
  if (harnessRead.kind === "error") {
    diagnostics.push(`Could not read ${harnessFile}: ${harnessRead.message}`);
    digestLines.push("harnesses error");
    evidence = true;
  } else if (harnessRead.kind === "other") {
    diagnostics.push(`${harnessFile} must be a regular file.`);
    digestLines.push("harnesses other");
    evidence = true;
  } else if (harnessRead.kind === "missing") {
    digestLines.push("harnesses missing");
  } else {
    evidence = true;
    digestLines.push(`harnesses ${sha256(harnessRead.bytes)}`);
    try {
      const parsed = parseLegacyHarnesses(harnessFile, JSON.parse(harnessRead.bytes.toString("utf8")));
      diagnostics.push(...parsed.diagnostics);
      harnesses = parsed.harnesses;
    } catch {
      diagnostics.push(`${harnessFile} is not valid JSON.`);
    }
  }

  const markers = { v1: false, v2: false, v3: false };
  const directory = subagentsDir(root);
  let entries: Dirent[] = [];
  try {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      diagnostics.push(`${directory} must be a directory.`);
      evidence = true;
    } else {
      entries = readdirSync(directory, { withFileTypes: true });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      diagnostics.push(`Could not read ${directory}: ${errorMessage(error)}`);
      evidence = true;
    }
  }

  for (const marker of LEGACY_SEED_MARKERS) {
    const path = join(directory, marker);
    const read = readRegular(path);
    const id = marker.endsWith("v1") ? "v1" : marker.endsWith("v2") ? "v2" : "v3";
    if (read.kind === "file") {
      markers[id] = true;
      evidence = true;
      digestLines.push(`marker ${marker} ${sha256(read.bytes)}`);
    } else if (read.kind === "missing") {
      digestLines.push(`marker ${marker} missing`);
    } else if (read.kind === "other") {
      diagnostics.push(`${path} must be a regular file.`);
      evidence = true;
      digestLines.push(`marker ${marker} other`);
    } else {
      diagnostics.push(`Could not read ${path}: ${read.message}`);
      evidence = true;
      digestLines.push(`marker ${marker} error`);
    }
  }

  const profiles: ClassifiedProfile[] = [];
  const listing = [...entries].sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of listing) {
    const type = entry.isSymbolicLink() ? "symlink" : entry.isFile() ? "file" : entry.isDirectory() ? "dir" : "other";
    digestLines.push(`entry ${type} ${entry.name}`);
    if (!entry.name.endsWith(".md")) continue;
    const name = entry.name.slice(0, -3);
    const path = join(directory, entry.name);
    if (!entry.isFile() || entry.isSymbolicLink()) {
      if (PROFILE_NAME_PATTERN.test(name) && looksLikeLegacyProfileName(name)) {
        diagnostics.push(`${path} must be a regular file before it can be converted.`);
        profiles.push({ name, path, upgrade: "block", diagnostic: `${path} must be a regular file before it can be converted.` });
        evidence = true;
      }
      continue;
    }
    if (!PROFILE_NAME_PATTERN.test(name)) continue;
    const read = readRegular(path);
    if (read.kind !== "file") {
      const message = read.kind === "error" ? read.message : "unreadable";
      if (looksLikeLegacyProfileName(name)) {
        diagnostics.push(`Could not read ${path}: ${message}`);
        profiles.push({ name, path, upgrade: "block", diagnostic: `Could not read ${path}: ${message}` });
        evidence = true;
      }
      continue;
    }
    digestLines.push(`profile ${name} ${sha256(read.bytes)}`);
    const classified = classifyRegular(name, path, read.bytes);
    if (classified.diagnostic) diagnostics.push(classified.diagnostic);
    if (classified.notes) notes.push(...classified.notes);
    if (classified.upgrade !== "ignore") profiles.push(classified);
    if (classified.upgrade === "copy" || classified.upgrade === "role" || classified.upgrade === "unchanged" || classified.upgrade === "block") evidence = true;
    if (classified.upgrade === "exclude" && DEFAULT_NAMES.has(name)) evidence = true;
  }

  return { diagnostics, evidence, settingsRecord, preserved, harnesses, profiles, markers, digestLines, notes };
}

function conversionDocument(snap: LegacySnapshot, disabledProfiles: string[]): Record<string, unknown> {
  const document: Record<string, unknown> = { version: 4 };
  for (const key of LEGACY_FIELD_KEYS) {
    const value = snap.settingsRecord?.[key];
    if (value !== undefined) document[key] = value;
  }
  if (Object.keys(snap.harnesses).length > 0) document.harnesses = snap.harnesses;
  if (disabledProfiles.length > 0) document.disabledProfiles = disabledProfiles;
  return document;
}

function buildReadyPlan(root: string, snap: LegacySnapshot): ConfigUpgradePlan {
  const present = new Set(
    snap.profiles.filter((profile) => profile.upgrade === "copy" || profile.upgrade === "unchanged").map((profile) => profile.name),
  );
  const disabledProfiles: string[] = [];
  for (const harness of cohortHarnesses(snap.markers)) {
    for (const role of LEGACY_DEFAULT_ROLES) {
      const name = `${harness}-${role}`;
      if (!present.has(name)) disabledProfiles.push(name);
    }
  }
  disabledProfiles.sort((a, b) => a.localeCompare(b));

  const overrides: ConfigUpgradeOverride[] = [];
  const roles: ConfigUpgradeRole[] = [];
  const notes = [...snap.notes];
  const unchangedDefaults: string[] = [];
  const excludedProfiles: string[] = [];
  const collisions: string[] = [];
  const roleNames = new Set<string>();
  for (const profile of [...snap.profiles].sort((a, b) => a.name.localeCompare(b.name))) {
    if (profile.upgrade === "unchanged") unchangedDefaults.push(profile.name);
    if (profile.upgrade === "exclude") excludedProfiles.push(profile.name);
    if (profile.upgrade === "role" && profile.bytes && profile.writtenBytes && profile.roleName) {
      if (roleNames.has(profile.roleName)) collisions.push(`Two legacy templates convert to role "${profile.roleName}".`);
      roleNames.add(profile.roleName);
      const destinationPath = rolePath(root, profile.roleName);
      const destination = readRegular(destinationPath);
      if (destination.kind === "file" && !destination.bytes.equals(profile.writtenBytes)) {
        collisions.push(`Role ${destinationPath} already exists and differs from the converted ${profile.path}.`);
      } else if (destination.kind === "other" || destination.kind === "error") {
        collisions.push(`Role ${destinationPath} must be a regular file before conversion can install ${profile.path}.`);
      }
      roles.push({
        name: profile.roleName,
        sourcePath: profile.path,
        destinationPath,
        fingerprint: sha256(profile.bytes),
        contents: profile.writtenBytes.toString("utf8"),
      });
      continue;
    }
    if (profile.upgrade !== "copy" || !profile.bytes || !profile.reason) continue;
    const installed = installedProfileBytes(profile.bytes);
    if (installed.removed.length) {
      notes.push(`${profile.path}: removed obsolete metadata ${installed.removed.join(", ")} from the override copy.`);
    }
    const destinationPath = overridePath(root, profile.name);
    const destination = readRegular(destinationPath);
    if (destination.kind === "file" && !destination.bytes.equals(installed.bytes)) {
      collisions.push(`Override ${destinationPath} already exists and differs from ${profile.path}.`);
    } else if (destination.kind === "other" || destination.kind === "error") {
      collisions.push(`Override ${destinationPath} must be a regular file before conversion can install ${profile.path}.`);
    }
    overrides.push({
      name: profile.name,
      sourcePath: profile.path,
      destinationPath,
      fingerprint: sha256(profile.bytes),
      contents: installed.bytes.toString("utf8"),
      reason: profile.reason,
    });
  }

  const document = conversionDocument(snap, disabledProfiles);
  const settingsDiagnostics = blockingSettingsDiagnostics(document);
  if (collisions.length > 0 || snap.diagnostics.length > 0 || settingsDiagnostics.length > 0) {
    return emptyPlan(root, "blocked", [...snap.diagnostics, ...settingsDiagnostics, ...collisions]);
  }
  const settings = parseSettings(document).settings;
  return {
    status: "ready",
    diagnostics: [],
    settingsPath: settingsPath(root),
    settings,
    preservedFields: snap.preserved,
    overrides,
    roles,
    notes,
    disabledProfiles,
    unchangedDefaults,
    excludedProfiles,
    sourceDigest: sha256(Buffer.from(snap.digestLines.join("\n"), "utf8")),
  };
}

function planInner(root: string): ConfigUpgradePlan {
  const path = settingsPath(root);
  const read = readRegular(path);
  if (read.kind === "error") return emptyPlan(root, "blocked", [`Could not read ${path}: ${read.message}`]);
  if (read.kind === "other") return emptyPlan(root, "blocked", [`${path} must be a regular file.`]);

  let record: Record<string, unknown> | undefined;
  if (read.kind === "file") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(read.bytes.toString("utf8"));
    } catch {
      return emptyPlan(root, "blocked", [`${path} is not valid JSON.`]);
    }
    if (!isRecord(parsed)) return emptyPlan(root, "blocked", [`${path} must be a JSON object.`]);
    if (parsed.version === 4) return emptyPlan(root, "current");
    if (parsed.version !== 1 && parsed.version !== 2 && parsed.version !== 3) {
      return emptyPlan(root, "blocked", [`${path} is version ${JSON.stringify(parsed.version)}. Conversion leaves that file in place.`]);
    }
    record = parsed;
  }

  const snap = snapshotLegacy(root, record, read.kind === "file" ? read.bytes : undefined);
  if (!snap.evidence && snap.diagnostics.length === 0 && !record) return emptyPlan(root, "empty");
  return buildReadyPlan(root, snap);
}

/** Read a pre-v4 installation and describe the version 4 conversion. */
export function planConfigUpgrade(agentDir: string): ConfigUpgradePlan {
  try {
    return planInner(resolve(agentDir));
  } catch (error) {
    const root = resolve(agentDir);
    return emptyPlan(root, "blocked", [`Configuration upgrade stopped: ${errorMessage(error)}`]);
  }
}

function installAuthoredFiles(
  files: readonly { sourcePath: string; destinationPath: string; fingerprint: string; contents: string }[],
  label: string,
): { ok: true; paths: string[] } | { ok: false; diagnostics: string[]; paths: string[] } {
  const paths: string[] = [];
  for (const file of files) {
    const read = readRegular(file.sourcePath);
    if (read.kind !== "file" || sha256(read.bytes) !== file.fingerprint) {
      return { ok: false, paths, diagnostics: [`Legacy profile ${file.sourcePath} changed before its ${label.toLowerCase()} was installed.`] };
    }
    const contents = Buffer.from(file.contents, "utf8");
    const destination = readRegular(file.destinationPath);
    if (destination.kind === "file" && destination.bytes.equals(contents)) {
      paths.push(file.destinationPath);
      continue;
    }
    if (destination.kind !== "missing") {
      return {
        ok: false,
        paths,
        diagnostics: [`${label} ${file.destinationPath} already exists and differs from ${file.sourcePath}.`],
      };
    }
    ensureDir(dirname(file.destinationPath));
    try {
      writeFileSync(file.destinationPath, contents, { mode: 0o600, flag: "wx" });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST" && sameFileBytes(file.destinationPath, contents)) {
        paths.push(file.destinationPath);
        continue;
      }
      if (code !== "EEXIST") {
        try {
          if (!sameFileBytes(file.destinationPath, contents)) unlinkSync(file.destinationPath);
        } catch (unlinkError) {
          if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") throw unlinkError;
        }
      }
      return {
        ok: false,
        paths,
        diagnostics: [code === "EEXIST"
          ? `${label} ${file.destinationPath} already exists and differs from ${file.sourcePath}.`
          : `${label} ${file.destinationPath} was not installed: ${errorMessage(error)}`],
      };
    }
    paths.push(file.destinationPath);
  }
  return { ok: true, paths };
}

function applyInner(root: string): ConfigUpgradeApplyResult {
  const first = planInner(root);
  if (first.status !== "ready" || !first.settings || !first.sourceDigest) return inactiveResult(first);
  const second = planInner(root);
  if (second.status !== "ready" || second.sourceDigest !== first.sourceDigest || !second.settings) {
    return inactiveResult(second, ["Legacy sources changed before any upgrade files were written.", ...second.diagnostics]);
  }

  const installed = installAuthoredFiles(second.overrides, "Override");
  if (!installed.ok) {
    return {
      status: "blocked",
      diagnostics: installed.diagnostics,
      settingsPath: second.settingsPath,
      overridesInstalled: installed.paths,
      rolesInstalled: [],
      notes: second.notes,
      disabledProfiles: [],
      preservedFields: {},
    };
  }
  const installedRoles = installAuthoredFiles(second.roles, "Role");
  if (!installedRoles.ok) {
    return {
      status: "blocked",
      diagnostics: installedRoles.diagnostics,
      settingsPath: second.settingsPath,
      overridesInstalled: installed.paths,
      rolesInstalled: installedRoles.paths,
      notes: second.notes,
      disabledProfiles: [],
      preservedFields: {},
    };
  }

  const verified = planInner(root);
  if (verified.status !== "ready" || verified.sourceDigest !== second.sourceDigest || !verified.settings) {
    return {
      status: "blocked",
      diagnostics: ["Legacy sources changed after override copies were installed. Settings version 4 was not activated.", ...verified.diagnostics],
      settingsPath: second.settingsPath,
      overridesInstalled: installed.paths,
      rolesInstalled: installedRoles.paths,
      notes: second.notes,
      disabledProfiles: [],
      preservedFields: {},
    };
  }

  const contents = serializeSettings(verified.settings, verified.preservedFields);
  let gate: string[];
  try {
    gate = blockingSettingsDiagnostics(JSON.parse(contents));
  } catch {
    gate = ["Converted settings are not valid JSON."];
  }
  if (gate.length > 0) {
    return {
      status: "blocked",
      diagnostics: gate,
      settingsPath: verified.settingsPath,
      overridesInstalled: installed.paths,
      rolesInstalled: installedRoles.paths,
      notes: verified.notes,
      disabledProfiles: [],
      preservedFields: {},
    };
  }

  try {
    atomicWrite(join(root, CONFIG_DIR), verified.settingsPath, contents);
  } catch (error) {
    return {
      status: "blocked",
      diagnostics: [`Settings version 4 was not activated: ${errorMessage(error)}`],
      settingsPath: verified.settingsPath,
      overridesInstalled: installed.paths,
      rolesInstalled: installedRoles.paths,
      notes: verified.notes,
      disabledProfiles: [],
      preservedFields: {},
    };
  }

  return {
    status: "applied",
    diagnostics: [],
    settingsPath: verified.settingsPath,
    overridesInstalled: installed.paths,
    rolesInstalled: installedRoles.paths,
    notes: verified.notes,
    disabledProfiles: verified.disabledProfiles,
    settings: verified.settings,
    preservedFields: verified.preservedFields,
  };
}

/**
 * Install raw override copies, then activate settings version 4.
 * Identical override bytes from an interrupted attempt are kept.
 * A differing destination blocks activation and leaves the previous settings file in place.
 */
export function applyConfigUpgrade(agentDir: string): ConfigUpgradeApplyResult {
  try {
    return applyInner(resolve(agentDir));
  } catch (error) {
    const root = resolve(agentDir);
    return {
      status: "blocked",
      diagnostics: [`Configuration upgrade stopped: ${errorMessage(error)}`],
      settingsPath: settingsPath(root),
      overridesInstalled: [],
      rolesInstalled: [],
      notes: [],
      disabledProfiles: [],
      preservedFields: {},
    };
  }
}

function version4Active(root: string): { ok: true } | { ok: false; diagnostic: string } {
  const path = settingsPath(root);
  const read = readRegular(path);
  if (read.kind !== "file") {
    return { ok: false, diagnostic: `Purge requires settings version 4 at ${path}. Run /external settings convert to upgrade this installation.` };
  }
  try {
    const parsed = JSON.parse(read.bytes.toString("utf8"));
    if (isRecord(parsed) && parsed.version === 4) return { ok: true };
  } catch {
    // The version is unreadable, so the conversion is not active.
  }
  return { ok: false, diagnostic: `Purge requires settings version 4 at ${path}. Run /external settings convert to upgrade this installation.` };
}

function purgeCandidates(root: string): { diagnostics: string[]; candidates: LegacyPurgeCandidate[] } {
  const diagnostics: string[] = [];
  const candidates: LegacyPurgeCandidate[] = [];
  const directory = subagentsDir(root);
  let entries: Dirent[] = [];
  try {
    const stat = lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      diagnostics.push(`${directory} must be a directory to list legacy profiles.`);
    } else {
      entries = readdirSync(directory, { withFileTypes: true });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      diagnostics.push(`Could not read ${directory}: ${errorMessage(error)}`);
    }
  }

  for (const entry of entries) {
    if (entry.isSymbolicLink() || !entry.isFile()) continue;
    const path = join(directory, entry.name);
    if (LEGACY_SEED_MARKERS.includes(entry.name as (typeof LEGACY_SEED_MARKERS)[number])) {
      const read = readRegular(path);
      if (read.kind !== "file") continue;
      candidates.push({
        path,
        relativePath: relative(root, path),
        kind: "seed-marker",
        name: entry.name,
        copied: false,
        inventory: true,
        fingerprint: sha256(read.bytes),
      });
      continue;
    }
    if (!entry.name.endsWith(".md")) continue;
    const name = entry.name.slice(0, -3);
    if (!PROFILE_NAME_PATTERN.test(name)) continue;
    const read = readRegular(path);
    if (read.kind !== "file") {
      diagnostics.push(`Could not read ${path}.`);
      continue;
    }
    const classified = classifyRegular(name, path, read.bytes);
    if (!classified.purge || !classified.bytes) continue;
    candidates.push({
      path,
      relativePath: relative(root, path),
      kind: classified.purge.kind,
      name,
      copied: overrideCopied(root, classified),
      inventory: classified.purge.inventory,
      fingerprint: sha256(classified.bytes),
    });
  }

  const registry = harnessesPath(root);
  const registryRead = readRegular(registry);
  if (registryRead.kind === "file") {
    candidates.push({
      path: registry,
      relativePath: relative(root, registry),
      kind: "harness-registry",
      name: LEGACY_HARNESSES_FILE,
      copied: false,
      inventory: true,
      fingerprint: sha256(registryRead.bytes),
    });
  }

  candidates.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return { diagnostics, candidates };
}

function overrideCopied(root: string, classified: ClassifiedProfile): boolean {
  if (classified.upgrade === "role" && classified.roleName && classified.writtenBytes) {
    return sameFileBytes(rolePath(root, classified.roleName), classified.writtenBytes);
  }
  if (!classified.bytes) return false;
  return sameFileBytes(overridePath(root, classified.name), installedProfileBytes(classified.bytes).bytes);
}

/** List legacy files that a confirmed purge may delete. Requires settings version 4. */
export function planLegacyPurge(agentDir: string): LegacyPurgePlan {
  try {
    const root = resolve(agentDir);
    const active = version4Active(root);
    if (!active.ok) return { status: "blocked", diagnostics: [active.diagnostic], candidates: [] };
    const scanned = purgeCandidates(root);
    return { status: "ready", diagnostics: scanned.diagnostics, candidates: scanned.candidates };
  } catch (error) {
    return { status: "blocked", diagnostics: [`Legacy purge stopped: ${errorMessage(error)}`], candidates: [] };
  }
}

/**
 * Delete the selected regular files whose current bytes still match `fingerprint`.
 * Paths outside the live legacy inventory are skipped. A second call reports
 * files that are already absent.
 */
export function purgeLegacyFiles(agentDir: string, candidates: readonly LegacyPurgeSelection[]): LegacyPurgeReport {
  const skipped: LegacyPurgeReport["skipped"] = [];
  const deleted: string[] = [];
  const failed: LegacyPurgeReport["failed"] = [];
  try {
    const root = resolve(agentDir);
    const active = version4Active(root);
    if (!active.ok) {
      return {
        status: "blocked",
        diagnostics: [active.diagnostic],
        deleted,
        skipped: candidates.map((candidate) => ({ path: candidate.path, reason: "settings-v4-required" as const })),
        failed,
      };
    }
    const live = new Map(purgeCandidates(root).candidates.map((candidate) => [candidate.path, candidate]));
    for (const candidate of candidates) {
      const target = resolve(root, candidate.path);
      if (!isInside(root, target)) {
        skipped.push({ path: candidate.path, reason: "outside-inventory" });
        continue;
      }
      let stat: ReturnType<typeof lstatSync>;
      try {
        stat = lstatSync(target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          skipped.push({ path: target, reason: "already-absent" });
          continue;
        }
        failed.push({ path: target, reason: errorMessage(error) });
        continue;
      }
      if (stat.isSymbolicLink() || !stat.isFile()) {
        skipped.push({ path: target, reason: "not-regular" });
        continue;
      }
      let bytes: Buffer;
      try {
        bytes = readFileSync(target);
      } catch (error) {
        failed.push({ path: target, reason: errorMessage(error) });
        continue;
      }
      if (sha256(bytes) !== candidate.fingerprint) {
        skipped.push({ path: target, reason: "changed-since-preview" });
        continue;
      }
      const allowed = live.get(target);
      if (!allowed || allowed.fingerprint !== candidate.fingerprint) {
        skipped.push({ path: target, reason: "outside-inventory" });
        continue;
      }
      try {
        unlinkSync(target);
        deleted.push(target);
      } catch (error) {
        failed.push({ path: target, reason: errorMessage(error) });
      }
    }
    return { status: "purged", diagnostics: [], deleted, skipped, failed };
  } catch (error) {
    return {
      status: "blocked",
      diagnostics: [`Legacy purge stopped: ${errorMessage(error)}`],
      deleted,
      skipped,
      failed,
    };
  }
}
