import { existsSync, linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, join, sep } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { CONFIG_NAME, cliHarness, objectRecord } from "./config-v5.ts";
import { defaultRoleNames } from "./default-roles.ts";
import { DEFAULT_EXTERNAL_SETTINGS, externalSettingsPath, loadExternalSettings, updateExternalSettings, type ExternalSettings } from "./settings.ts";
import { EXTERNAL_HARNESSES } from "./types.ts";

/**
 * Deterministic v5 configuration lifecycle. Settings changes go through the
 * canonical validated read-modify-write writer; Markdown instructions are
 * written privately and atomically. Nothing here launches a backend.
 *
 * Destructive operations are two-phase: a plan fingerprints every owned
 * settings value and file it will touch, and apply re-plans, refuses on any
 * difference, and re-checks each file immediately before unlinking it.
 * Managed directories and files are never followed through symbolic links.
 */
export class LifecycleError extends Error {}

type Raw = Record<string, unknown>;
export type HarnessField = "model" | "effort" | "preset";
export type BindingField = "model" | "effort" | "budget" | "tools";
export type RoleResetField = BindingField | "instructions";
const SETTINGS_KEY: Record<HarnessField | BindingField, string> = { model: "model", effort: "thinking", preset: "preset", budget: "max_budget_usd", tools: "tools" };
const SCALARS = ["model", "thinking", "preset", "tools", "max_budget_usd"];
/** Names that would alias Object.prototype members when used as record keys. */
const RESERVED_NAMES: ReadonlySet<string> = new Set([...Object.getOwnPropertyNames(Object.prototype), "prototype"]);
const CHANGED = "Configuration changed since the preview; nothing was changed. Rerun the command to review the current state.";

export const BUILT_IN_ROLES: readonly string[] = defaultRoleNames();
export function isBuiltInRole(role: string): boolean { return BUILT_IN_ROLES.includes(role); }
export function configBase(agentDir: string): string { return join(agentDir, "pi-flow-external"); }
export function roleFile(agentDir: string, role: string): string { return join(configBase(agentDir), "roles", `${role}.md`); }
export function overrideFile(agentDir: string, harness: string, role: string): string { return join(configBase(agentDir), "overrides", harness, `${role}.md`); }

function assertRoleName(role: string): void {
  if (RESERVED_NAMES.has(role)) throw new LifecycleError(`Role name ${JSON.stringify(role)} is reserved; choose another name.`);
  if (!CONFIG_NAME.test(role)) throw new LifecycleError(`Invalid role name ${JSON.stringify(role)}: use lowercase letters, numbers, and hyphens.`);
}
function usableName(name: string): boolean { return CONFIG_NAME.test(name) && !RESERVED_NAMES.has(name); }

// ---- Own-property-safe record access ---------------------------------------

function own(parent: unknown, key: string): unknown {
  return objectRecord(parent) && Object.hasOwn(parent, key) ? parent[key] : undefined;
}
function define(parent: Raw, key: string, value: unknown): void {
  Object.defineProperty(parent, key, { value, enumerable: true, writable: true, configurable: true });
}
function obj(parent: Raw, key: string): Raw {
  const value = own(parent, key);
  if (objectRecord(value)) return value;
  const created: Raw = {};
  define(parent, key, created);
  return created;
}
function prune(parent: unknown, key: string): void {
  const value = own(parent, key);
  if (objectRecord(value) && !Object.keys(value).length) delete (parent as Raw)[key];
}
function pruneHarness(raw: Raw, harness: string): void {
  const harnesses = own(raw, "harnesses");
  const entry = own(harnesses, harness);
  if (!objectRecord(entry)) return;
  prune(entry, "roles");
  if (cliHarness(harness)) prune(harnesses, harness);
  prune(raw, "harnesses");
}
function withoutNames(list: unknown, names: readonly string[]): string[] | undefined {
  return Array.isArray(list) ? list.filter((item) => !names.includes(item)) : undefined;
}
function stable(value: unknown): string {
  return JSON.stringify(value, (_key, item) => objectRecord(item) ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item) ?? "undefined";
}
function hash(text: string | Buffer): string { return createHash("sha256").update(text).digest("hex"); }
/** A copy without the enabled gate; an entry that held only the gate compares as absent. */
function withoutGate(value: unknown): unknown {
  if (!objectRecord(value)) return value;
  const { enabled: _gate, ...rest } = value;
  return Object.keys(rest).length ? rest : undefined;
}

// ---- Managed filesystem namespace -----------------------------------------

/** True when the directory exists. Symbolic links and non-directories are refused, never followed. */
function managedDir(path: string): boolean {
  let stat;
  try { stat = lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  if (stat.isSymbolicLink()) throw new LifecycleError(`${path} is a symbolic link; managed configuration paths are never followed.`);
  if (!stat.isDirectory()) throw new LifecycleError(`${path} is not a directory.`);
  return true;
}
/** "absent" or a content hash. Symbolic links and non-regular files are refused. */
function fileState(path: string): string {
  const marker = `${sep}pi-flow-external${sep}`;
  const boundary = path.lastIndexOf(marker);
  if (boundary !== -1) managedParents(path.slice(0, boundary), path);
  let stat;
  try { stat = lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent"; throw error; }
  if (stat.isSymbolicLink()) throw new LifecycleError(`${path} is a symbolic link; managed configuration files are never followed or deleted through links.`);
  if (!stat.isFile()) throw new LifecycleError(`${path} is not a regular file.`);
  return hash(readFileSync(path));
}
/** Validate every managed ancestor between the config home and `path`. */
function managedParents(agentDir: string, path: string): void {
  const base = configBase(agentDir);
  const chain: string[] = [base];
  for (let dir = dirname(path); dir.startsWith(`${base}/`) || dir === base; dir = dirname(dir)) {
    if (dir === base) break;
    chain.unshift(dir);
  }
  for (const dir of chain) managedDir(dir);
}
function safeList(dir: string): string[] {
  try { return managedDir(dir) ? readdirSync(dir) : []; } catch { return []; }
}

// ---- Settings access -------------------------------------------------------

/** Current v5 settings for lifecycle reads and mutations. v4 and blocked files are refused. */
export function readV5Settings(agentDir: string): ExternalSettings {
  const loaded = loadExternalSettings(agentDir);
  if (loaded.blocked) throw new LifecycleError(`Settings were not changed: ${loaded.diagnostics.join(" ")}`);
  if (loaded.settings.version !== 5) throw new LifecycleError("Settings are version 4. Run /external config convert to preview and apply the v5 conversion before changing harness or role configuration.");
  return loaded.settings;
}
function readRaw(agentDir: string): Raw {
  readV5Settings(agentDir);
  const path = externalSettingsPath(agentDir);
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as Raw : { ...DEFAULT_EXTERNAL_SETTINGS };
}

/** One validated write: v5 only, unrelated fields preserved, invalid results refused before replacement. */
export function mutateV5(agentDir: string, mutate: (raw: Raw) => void): string {
  readV5Settings(agentDir);
  try {
    return updateExternalSettings(agentDir, (record) => {
      const next = structuredClone(record);
      next.version ??= DEFAULT_EXTERNAL_SETTINGS.version;
      if (next.version !== 5) throw new LifecycleError("Settings are not version 5. Run /external config convert.");
      mutate(next);
      return next;
    });
  } catch (error) {
    if (error instanceof LifecycleError) throw error;
    throw new LifecycleError(`Settings were not changed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// ---- Harnesses ------------------------------------------------------------

export function registeredHarnesses(settings: ExternalSettings): string[] {
  return [...EXTERNAL_HARNESSES, ...Object.keys(settings.harnessSettings ?? {}).filter((name) => !cliHarness(name)).sort()];
}
export function harnessDisabled(settings: ExternalSettings, harness: string): boolean {
  return (own(settings.harnessSettings, harness) as Raw | undefined)?.enabled === false || (settings.disabledHarnesses ?? []).includes(harness);
}
function requireHarness(settings: ExternalSettings, harness: string): void {
  if (!registeredHarnesses(settings).includes(harness)) {
    throw new LifecycleError(`Unknown harness "${harness}". Choose one of: ${registeredHarnesses(settings).join(", ")}. Register a named Pi harness with /external config harness create pi-<name> --model provider/model.`);
  }
}
function rolePatch(settings: ExternalSettings, harness: string, role: string): Raw | undefined {
  const value = own(own(own(settings.harnessSettings, harness), "roles"), role);
  return objectRecord(value) ? value : undefined;
}
function roleGate(settings: ExternalSettings, role: string): boolean {
  return (own(settings.roles, role) as Raw | undefined)?.enabled === false;
}

/** Gates other than the one just changed that still block a selection. */
export function remainingGates(settings: ExternalSettings, scope: { harness?: string; role?: string }): string[] {
  const gates: string[] = [];
  const { harness, role } = scope;
  if (harness && harnessDisabled(settings, harness)) gates.push(`harness "${harness}" is disabled (/external config harness enable ${harness})`);
  if (role && roleGate(settings, role)) gates.push(`role "${role}" is disabled on every harness (/external config role enable ${role})`);
  if (harness && role && (rolePatch(settings, harness, role)?.enabled === false || (!Object.hasOwn(settings.exact ?? {}, `${harness}-${role}`) && (settings.disabledProfiles ?? []).includes(`${harness}-${role}`)))) {
    gates.push(`binding ${harness}/${role} is disabled (/external config role enable ${role} --harness ${harness})`);
  }
  if (harness && !role) {
    const roles = Object.entries(settings.roles ?? {}).filter(([, value]) => value.enabled === false).map(([name]) => name);
    const bindings = Object.entries(settings.harnessSettings?.[harness]?.roles ?? {}).filter(([, value]) => value.enabled === false).map(([name]) => name);
    if (roles.length) gates.push(`roles disabled everywhere: ${roles.sort().join(", ")}`);
    if (bindings.length) gates.push(`bindings disabled on ${harness}: ${bindings.sort().join(", ")}`);
    const legacy = (settings.disabledProfiles ?? []).filter(name => settings.exact?.[name]?.harness === harness || (!settings.exact?.[name] && name.startsWith(`${harness}-`)));
    const exact = Object.entries(settings.exact ?? {}).filter(([, entry]) => entry.harness === harness && entry.enabled === false).map(([name]) => name);
    if (legacy.length || exact.length) gates.push(`compatibility selectors disabled: ${[...new Set([...legacy, ...exact])].join(', ')}`);
  }
  return gates;
}

export function createPiHarness(agentDir: string, name: string, fields: { model: string; thinking?: string; preset?: string }): string {
  const settings = readV5Settings(agentDir);
  if (cliHarness(name)) throw new LifecycleError(`"${name}" is a built-in CLI harness and needs no creation. Change its defaults with /external config harness set ${name} --model VALUE --effort VALUE.`);
  if (!/^pi-[a-z0-9][a-z0-9-]*$/.test(name)) throw new LifecycleError(`Invalid harness name "${name}": named Pi harnesses use pi-<lowercase-letters-numbers-hyphens>.`);
  if (own(settings.harnessSettings, name)) throw new LifecycleError(`Harness "${name}" already exists. Use /external config harness set ${name} or edit ${name}.`);
  return mutateV5(agentDir, (raw) => {
    define(obj(raw, "harnesses"), name, { model: fields.model, thinking: fields.thinking ?? "off", preset: fields.preset ?? "minimal", owner: "user" });
  });
}

/** Replace one harness entry from the editor; the result is validated by the canonical writer. */
export function replaceHarnessEntry(agentDir: string, name: string, entry: unknown, effectiveDefault?: EffectiveDefault): string {
  const settings = readV5Settings(agentDir);
  requireHarness(settings, name);
  if (!objectRecord(entry)) throw new LifecycleError("Harness entry must be a JSON object.");
  if (entry.enabled === false && (settings.defaultHarness === name || effectiveDefault?.harness === name)) throw new LifecycleError('Cannot disable the global or effective project default through the editor. Choose another default first.');
  return mutateV5(agentDir, (raw) => {
    define(obj(raw, "harnesses"), name, entry);
    pruneHarness(raw, name);
  });
}

export function setHarnessFields(agentDir: string, name: string, fields: Partial<Record<HarnessField, string>>): string {
  const settings = readV5Settings(agentDir);
  requireHarness(settings, name);
  if (!Object.keys(fields).length) throw new LifecycleError(`Nothing to set. Use --model VALUE, --effort VALUE${cliHarness(name) ? "" : ", or --preset minimal|skills"}.`);
  return mutateV5(agentDir, (raw) => {
    const entry = obj(obj(raw, "harnesses"), name);
    for (const [field, value] of Object.entries(fields)) entry[SETTINGS_KEY[field as HarnessField]] = value;
  });
}

/** Delete only the named scalar properties. Gates and role exceptions stay; nothing is enabled. */
export function resetHarnessFields(agentDir: string, name: string, fields: HarnessField[]): string {
  const settings = readV5Settings(agentDir);
  requireHarness(settings, name);
  if (!cliHarness(name) && fields.includes("model")) throw new LifecycleError(`A named Pi harness requires a model; change it with /external config harness set ${name} --model provider/model.`);
  return mutateV5(agentDir, (raw) => {
    const entry = own(own(raw, "harnesses"), name);
    if (!objectRecord(entry)) return;
    for (const field of fields) delete entry[SETTINGS_KEY[field]];
    pruneHarness(raw, name);
  });
}

export function setHarnessEnabled(agentDir: string, name: string, enabled: boolean, effectiveDefault?: EffectiveDefault): { path: string; alreadyInState: boolean } {
  const settings = readV5Settings(agentDir);
  const unknownDisabled = (settings.disabledHarnesses ?? []).includes(name);
  if (!enabled || !unknownDisabled) requireHarness(settings, name);
  if (enabled === !harnessDisabled(settings, name)) return { path: "", alreadyInState: true };
  if (!enabled) {
    if (name === settings.defaultHarness) throw new LifecycleError(`Cannot disable "${name}": it is the global default. Choose another default first with /external config harness default <harness>.`);
    if (effectiveDefault && name === effectiveDefault.harness && effectiveDefault.source === "project") throw new LifecycleError(`Cannot disable "${name}": it is the project default (${effectiveDefault.projectPath}). Choose another default in that project file first.`);
  }
  const path = mutateV5(agentDir, (raw) => {
    if (enabled) {
      const entry = own(own(raw, "harnesses"), name);
      if (objectRecord(entry)) delete entry.enabled;
      const list = withoutNames(raw.disabledHarnesses, [name]);
      if (list) raw.disabledHarnesses = list;
      pruneHarness(raw, name);
    } else {
      obj(obj(raw, "harnesses"), name).enabled = false;
    }
  });
  return { path, alreadyInState: false };
}

export function setDefaultHarness(agentDir: string, name: string): string {
  const settings = readV5Settings(agentDir);
  requireHarness(settings, name);
  if (harnessDisabled(settings, name)) throw new LifecycleError(`Cannot make "${name}" the default: it is disabled. Enable it first with /external config harness enable ${name}.`);
  return mutateV5(agentDir, (raw) => { raw.defaultHarness = name; });
}

export type EffectiveDefault = { harness: string; source: string; projectPath?: string };

/** Everything a destructive plan owns, for preview and revalidation. */
interface Fingerprinted { fingerprint: string; fileStates: Record<string, string> }
export interface ResetPlan extends Fingerprinted { kind: "harness" | "role"; name: string; harness?: string; fields: RoleResetField[]; settingsFields: string[]; files: string[]; kept: string[] }
export interface DeletePlan extends Fingerprinted { kind: "harness" | "role"; name: string; files: string[]; settingsFields: string[]; blockers: string[]; kept: string[]; legacyIdentities: string[] }
export interface DeleteResult { complete: boolean; deleted: string[]; failed: Array<{ path: string; reason: string }>; message: string }

function statesOf(files: string[], blockers?: string[]): Record<string, string> {
  const states: Record<string, string> = {};
  for (const path of files) {
    try { states[path] = fileState(path); } catch (error) {
      if (!blockers || !(error instanceof LifecycleError)) throw error;
      blockers.push(error.message);
    }
  }
  return states;
}

function ownedHarness(raw: Raw, name: string, ignoreGate = false): string {
  const entry = own(own(raw, "harnesses"), name);
  const copy = ignoreGate ? withoutGate(entry) : entry;
  const disabled = Array.isArray(raw.disabledHarnesses) && raw.disabledHarnesses.includes(name);
  return stable({ entry: copy, disabled, defaultHarness: raw.defaultHarness === name });
}

function listOverrides(agentDir: string, harness: string): string[] {
  const overrides = join(configBase(agentDir), "overrides");
  if (!managedDir(overrides)) return [];
  const dir = join(overrides, harness);
  if (!managedDir(dir)) return [];
  return readdirSync(dir).filter((file) => file.endsWith(".md")).sort().map((file) => join(dir, file));
}

/** Broad harness reset: execution fields on the harness and its role exceptions. Gates and instruction overrides are kept. */
export function planHarnessReset(agentDir: string, name: string): ResetPlan {
  const settings = readV5Settings(agentDir);
  requireHarness(settings, name);
  const raw = readRaw(agentDir);
  const entry = (own(settings.harnessSettings, name) ?? {}) as Raw;
  const settingsFields = SCALARS.filter((key) => entry[key] !== undefined && !(key === "model" && !cliHarness(name))).map((key) => `harnesses.${name}.${key}`);
  for (const [role, patch] of Object.entries((entry.roles ?? {}) as Record<string, Raw>)) {
    for (const key of SCALARS) if (patch[key] !== undefined) settingsFields.push(`harnesses.${name}.roles.${role}.${key}`);
  }
  let overrides: string[] = [];
  try { overrides = listOverrides(agentDir, name); } catch { /* Reset never touches override files. */ }
  const kept = ["enabled gates", ...(cliHarness(name) ? [] : ["model (required on Pi)"]), ...overrides.map((path) => `instruction override ${path}`)];
  return { kind: "harness", name, fields: [], settingsFields, files: [], kept, fileStates: {}, fingerprint: hash(ownedHarness(raw, name)) };
}

export function applyHarnessReset(agentDir: string, plan: ResetPlan): string {
  const name = plan.name;
  if (planHarnessReset(agentDir, name).fingerprint !== plan.fingerprint) throw new LifecycleError(CHANGED);
  return mutateV5(agentDir, (raw) => {
    if (hash(ownedHarness(raw, name)) !== plan.fingerprint) throw new LifecycleError(CHANGED);
    const entry = own(own(raw, "harnesses"), name);
    if (!objectRecord(entry)) return;
    for (const key of SCALARS) if (!(key === "model" && !cliHarness(name))) delete entry[key];
    const roles = own(entry, "roles");
    if (objectRecord(roles)) {
      for (const role of Object.keys(roles)) {
        const patch = roles[role];
        if (!objectRecord(patch)) continue;
        for (const key of SCALARS) delete patch[key];
        prune(roles, role);
      }
    }
    pruneHarness(raw, name);
  });
}

export function planHarnessDelete(agentDir: string, name: string, effectiveDefault?: EffectiveDefault): DeletePlan {
  const empty = { kind: "harness" as const, name, files: [], settingsFields: [], kept: [], legacyIdentities: [], fileStates: {}, fingerprint: "" };
  if (cliHarness(name)) return { ...empty, blockers: [`"${name}" is a built-in CLI harness and cannot be deleted. Use /external config harness reset ${name} or disable ${name} instead.`] };
  const settings = readV5Settings(agentDir);
  requireHarness(settings, name);
  const blockers: string[] = [];
  if (settings.defaultHarness === name) blockers.push(`"${name}" is the global default. Choose another default first with /external config harness default <harness>.`);
  if (effectiveDefault?.source === "project" && effectiveDefault.harness === name) blockers.push(`"${name}" is the project default (${effectiveDefault.projectPath}). Change that project file first.`);
  const exact = Object.entries(settings.exact ?? {}).filter(([, entry]) => entry.harness === name).map(([key]) => key);
  if (exact.length) blockers.push(`Exact compatibility selectors still use "${name}": ${exact.join(", ")}. Remove them with /external config edit first.`);
  let files: string[] = [];
  try { files = listOverrides(agentDir, name); } catch (error) { if (!(error instanceof LifecycleError)) throw error; blockers.push(error.message); }
  const fileStates = statesOf(files, blockers);
  const settingsFields = [`harnesses.${name}`, ...((settings.disabledHarnesses ?? []).includes(name) ? [`disabledHarnesses: ${name}`] : [])];
  const fingerprint = hash(stable({ owned: ownedHarness(readRaw(agentDir), name), fileStates }));
  return { ...empty, files, settingsFields, blockers, fileStates, fingerprint };
}

/** Remove planned files, re-checking each immediately before unlinking. */
function removeFiles(plan: Fingerprinted & { files: string[] }): { deleted: string[]; failed: Array<{ path: string; reason: string }> } {
  const deleted: string[] = [];
  const failed: Array<{ path: string; reason: string }> = [];
  for (const path of plan.files) {
    let state: string;
    try { state = fileState(path); } catch (error) { failed.push({ path, reason: error instanceof Error ? error.message : String(error) }); continue; }
    if (state === "absent") continue;
    if (state !== plan.fileStates[path]) { failed.push({ path, reason: "changed since the preview; not deleted" }); continue; }
    try {
      unlinkSync(path);
      deleted.push(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      failed.push({ path, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return { deleted, failed };
}

/** Revalidate, persist the disable gate, remove owned files, then remove settings. A cleanup failure leaves the harness disabled. */
export function applyHarnessDelete(agentDir: string, plan: DeletePlan, effectiveDefault?: EffectiveDefault): DeleteResult {
  const name = plan.name;
  const current = planHarnessDelete(agentDir, name, effectiveDefault);
  if (current.blockers.length) throw new LifecycleError(current.blockers.join(" "));
  if (plan.blockers.length || current.fingerprint !== plan.fingerprint) throw new LifecycleError(CHANGED);
  const planned = ownedHarness(readRaw(agentDir), name, true);
  const unchanged = (raw: Raw) => { if (ownedHarness(raw, name, true) !== planned) throw new LifecycleError(CHANGED); };
  if (plan.files.length) mutateV5(agentDir, (raw) => { unchanged(raw); obj(obj(raw, "harnesses"), name).enabled = false; });
  const { deleted, failed } = removeFiles(plan);
  if (failed.length) {
    return { complete: false, deleted, failed, message: `Harness "${name}" was not fully deleted and stays disabled. Fix the files below, then rerun /external config harness delete ${name}.` };
  }
  try { if (managedDir(join(configBase(agentDir), "overrides", name))) rmdirSync(join(configBase(agentDir), "overrides", name)); } catch { /* A non-empty or unsafe directory is left alone. */ }
  mutateV5(agentDir, (raw) => {
    unchanged(raw);
    const harnesses = own(raw, "harnesses");
    if (objectRecord(harnesses)) delete harnesses[name];
    prune(raw, "harnesses");
    const list = withoutNames(raw.disabledHarnesses, [name]);
    if (list) raw.disabledHarnesses = list;
  });
  return { complete: true, deleted, failed, message: `Harness "${name}" deleted. Run receipts and native CLI configuration were not touched.` };
}

// ---- Roles ----------------------------------------------------------------

export interface RoleInventoryEntry {
  name: string;
  builtIn: boolean;
  file?: string;
  overrides: string[];
  /** Harnesses with a settings exception for this role. */
  exceptions: string[];
  /** No definition at all: referenced only from settings. */
  settingsOnly: boolean;
  /** Entries that are symbolic links or non-regular files; destructive operations refuse them. */
  unsafe: string[];
}

export function roleInventory(agentDir: string, settings: ExternalSettings): Map<string, RoleInventoryEntry> {
  const roles = new Map<string, RoleInventoryEntry>();
  const entry = (name: string) => {
    let value = roles.get(name);
    if (!value) roles.set(name, value = { name, builtIn: isBuiltInRole(name), overrides: [], exceptions: [], settingsOnly: false, unsafe: [] });
    return value;
  };
  const note = (value: RoleInventoryEntry, path: string) => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) value.unsafe.push(path);
  };
  for (const name of BUILT_IN_ROLES) entry(name);
  const roleDir = join(configBase(agentDir), "roles");
  for (const file of safeList(roleDir)) {
    const name = file.endsWith(".md") ? file.slice(0, -3) : "";
    if (!usableName(name)) continue;
    const value = entry(name);
    value.file = join(roleDir, file);
    note(value, value.file);
  }
  const overridesDir = join(configBase(agentDir), "overrides");
  for (const harness of safeList(overridesDir)) {
    const dir = join(overridesDir, harness);
    const stat = lstatSync(dir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) continue;
    for (const file of readdirSync(dir)) {
      const name = file.endsWith(".md") ? file.slice(0, -3) : "";
      if (!usableName(name)) continue;
      const value = entry(name);
      value.overrides.push(join(dir, file));
      note(value, join(dir, file));
    }
  }
  for (const name of Object.keys(settings.roles ?? {})) if (usableName(name)) entry(name);
  for (const [harness, value] of Object.entries(settings.harnessSettings ?? {})) {
    for (const name of Object.keys(value.roles ?? {})) if (usableName(name)) entry(name).exceptions.push(harness);
  }
  for (const value of roles.values()) value.settingsOnly = !value.builtIn && !value.file && !value.overrides.length;
  return roles;
}

function requireRole(agentDir: string, settings: ExternalSettings, role: string): RoleInventoryEntry {
  assertRoleName(role);
  const entry = roleInventory(agentDir, settings).get(role);
  if (!entry || entry.settingsOnly) throw new LifecycleError(`Unknown role "${role}". See /external config role list, or author one with /external config role create ${role}.`);
  return entry;
}

/** Harnesses on which an override-only role actually exists. */
function overrideHarnesses(entry: RoleInventoryEntry): string[] {
  return entry.overrides.map((path) => basename(dirname(path))).sort();
}
/** A shared or built-in role binds everywhere; an override-only role binds only where its override exists. */
function requireBinding(entry: RoleInventoryEntry, harness: string): void {
  if (entry.builtIn || entry.file || overrideHarnesses(entry).includes(harness)) return;
  throw new LifecycleError(`Role "${entry.name}" has no binding on ${harness}; it is defined only by overrides on ${overrideHarnesses(entry).join(", ")}. Create a shared definition with /external config role create ${entry.name} to use it on other harnesses.`);
}

/** Registered-harness readings of a legacy `harness-role` identity. More than one means it is ambiguous. */
function legacyReadings(settings: ExternalSettings, known: ReadonlySet<string>, identity: string): string[] {
  return registeredHarnesses(settings)
    .filter((harness) => identity.startsWith(`${harness}-`) && known.has(identity.slice(harness.length + 1)))
    .map((harness) => `${harness}/${identity.slice(harness.length + 1)}`);
}

/** Parse role/override Markdown: description-only frontmatter; an empty body is explicit empty instructions. */
export function parseInstructionMarkdown(text: string): { description: string; body: string } {
  let parsed: { frontmatter: Record<string, unknown>; body: string };
  try { parsed = parseFrontmatter<Record<string, unknown>>(text); } catch (error) { throw new LifecycleError(`Instructions could not be parsed: ${error instanceof Error ? error.message : String(error)}`); }
  const extra = Object.keys(parsed.frontmatter).filter((key) => key !== "description");
  if (extra.length) throw new LifecycleError(`Instruction metadata supports description only; remove ${extra.join(", ")}. Model, effort, tools, and budget belong in /external config role set.`);
  if (typeof parsed.frontmatter.description !== "string" || !parsed.frontmatter.description.trim()) throw new LifecycleError("A nonempty description is required in the frontmatter.");
  return { description: parsed.frontmatter.description.trim(), body: parsed.body.trim() };
}
export function compileInstructionMarkdown(description: string, body: string): string {
  return `---\ndescription: ${JSON.stringify(description)}\n---\n${body.trim() ? `${body.trim()}\n` : ""}`;
}

function writePrivate(agentDir: string, path: string, content: string, exclusive: boolean): void {
  managedParents(agentDir, path);
  fileState(path);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  managedParents(agentDir, path);
  const staged = `${path}.${randomUUID()}.staged`;
  try {
    writeFileSync(staged, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    if (exclusive) linkSync(staged, path);
    else renameSync(staged, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new LifecycleError(`${path} already exists and was not changed.`);
    throw error;
  } finally {
    try { unlinkSync(staged); } catch { /* Renamed or never created. */ }
  }
}

export function createRole(agentDir: string, role: string, markdown: string): string {
  const settings = readV5Settings(agentDir);
  assertRoleName(role);
  if (isBuiltInRole(role)) throw new LifecycleError(`"${role}" is a built-in role. Customize it with /external config role edit ${role}.`);
  const existing = roleInventory(agentDir, settings).get(role);
  if (existing?.file) throw new LifecycleError(`Role "${role}" already exists at ${existing.file}. Use /external config role edit ${role}.`);
  const { description, body } = parseInstructionMarkdown(markdown);
  const path = roleFile(agentDir, role);
  writePrivate(agentDir, path, compileInstructionMarkdown(description, body), true);
  return path;
}

/** Write shared (no harness) or one harness's replacement instructions. */
export function writeInstructions(agentDir: string, role: string, markdown: string, harness?: string): string {
  const settings = readV5Settings(agentDir);
  const entry = requireRole(agentDir, settings, role);
  if (harness) {
    requireHarness(settings, harness);
    requireBinding(entry, harness);
  } else if (!entry.builtIn && !entry.file) {
    throw new LifecycleError(`Role "${role}" has no shared definition; it exists only as overrides on ${overrideHarnesses(entry).join(", ")}. Edit one with --harness, or create a shared definition with /external config role create ${role}.`);
  }
  const { description, body } = parseInstructionMarkdown(markdown);
  const path = harness ? overrideFile(agentDir, harness, role) : roleFile(agentDir, role);
  writePrivate(agentDir, path, compileInstructionMarkdown(description, body), false);
  return path;
}

/** Instruction text for the editor; refuses links and non-regular files. */
export function readInstructionText(path: string): string | undefined {
  return fileState(path) === "absent" ? undefined : readFileSync(path, "utf8");
}

export function setRoleEnabled(agentDir: string, role: string, enabled: boolean, harness?: string): { path: string; alreadyInState: boolean } {
  const settings = readV5Settings(agentDir);
  const entry = requireRole(agentDir, settings, role);
  if (harness) {
    requireHarness(settings, harness);
    requireBinding(entry, harness);
  }
  const legacy = harness ? `${harness}-${role}` : undefined;
  const legacyDisabled = legacy !== undefined && !Object.hasOwn(settings.exact ?? {}, legacy) && (settings.disabledProfiles ?? []).includes(legacy);
  const current = harness ? rolePatch(settings, harness, role)?.enabled !== false && !legacyDisabled : !roleGate(settings, role);
  if (current === enabled) return { path: "", alreadyInState: true };
  if (enabled && legacyDisabled) {
    const readings = legacyReadings(settings, new Set(roleInventory(agentDir, settings).keys()), legacy!);
    if (readings.length > 1) throw new LifecycleError(`The legacy disabledProfiles entry is ambiguous: ${legacy} names ${readings.join(" and ")}. Nothing was changed; remove it with /external config edit if you intend to enable all of them.`);
  }
  const path = mutateV5(agentDir, (raw) => {
    if (harness) {
      if (enabled) {
        const patches = own(own(own(raw, "harnesses"), harness), "roles");
        const patch = own(patches, role);
        if (objectRecord(patch)) { delete patch.enabled; prune(patches, role); }
        const list = withoutNames(raw.disabledProfiles, Object.hasOwn(settings.exact ?? {}, legacy!) ? [] : [legacy!]);
        if (list) raw.disabledProfiles = list;
        pruneHarness(raw, harness);
      } else {
        obj(obj(obj(obj(raw, "harnesses"), harness), "roles"), role).enabled = false;
      }
    } else if (enabled) {
      const roles = own(raw, "roles");
      const patch = own(roles, role);
      if (objectRecord(patch)) { delete patch.enabled; prune(roles, role); prune(raw, "roles"); }
    } else {
      obj(obj(raw, "roles"), role).enabled = false;
    }
  });
  return { path, alreadyInState: false };
}

export function setBindingFields(agentDir: string, role: string, harness: string, fields: Partial<Record<BindingField, string | number | string[]>>): string {
  const settings = readV5Settings(agentDir);
  const entry = requireRole(agentDir, settings, role);
  requireHarness(settings, harness);
  requireBinding(entry, harness);
  if (!Object.keys(fields).length) throw new LifecycleError("Nothing to set. Use --model VALUE, --effort VALUE, --budget USD, or --tools a,b (Pi only).");
  return mutateV5(agentDir, (raw) => {
    const patch = obj(obj(obj(obj(raw, "harnesses"), harness), "roles"), role);
    for (const [field, value] of Object.entries(fields)) patch[SETTINGS_KEY[field as BindingField]] = value;
  });
}

/** Every settings value a role owns: its root gate, each harness exception, and its legacy identities. */
function ownedRole(raw: Raw, role: string, identities: readonly string[], ignoreGate = false): string {
  const root = own(own(raw, "roles"), role);
  const rootCopy = ignoreGate ? withoutGate(root) : root;
  const harnesses = own(raw, "harnesses");
  const patches = objectRecord(harnesses)
    ? Object.fromEntries(Object.keys(harnesses).map((name) => [name, own(own(harnesses[name], "roles"), role)]).filter(([, value]) => value !== undefined))
    : {};
  const disabled = Array.isArray(raw.disabledProfiles) ? identities.filter((id) => (raw.disabledProfiles as unknown[]).includes(id)) : [];
  return stable({ root: rootCopy, patches, disabled });
}

/** Plan a role reset. Fields empty means the confirmed broad reset. Enabled gates are always kept. */
export function planRoleReset(agentDir: string, role: string, harness: string | undefined, fields: RoleResetField[]): ResetPlan {
  const settings = readV5Settings(agentDir);
  const entry = requireRole(agentDir, settings, role);
  if (harness) {
    requireHarness(settings, harness);
    requireBinding(entry, harness);
  }
  if (!harness && fields.some((field) => field !== "instructions")) throw new LifecycleError("model, effort, budget, and tools are per-harness binding settings; add --harness NAME.");
  if (!harness && fields.includes("instructions") && !entry.builtIn) throw new LifecycleError(`"${role}" is a custom role; its shared file is its definition. Edit it with /external config role edit ${role} or delete it with /external config role delete ${role}.`);
  const broad = !fields.length;
  const want = (field: RoleResetField) => broad || fields.includes(field);
  const settingsFields: string[] = [];
  const files: string[] = [];
  for (const target of harness ? [harness] : entry.exceptions) {
    const patch = rolePatch(settings, target, role);
    if (!patch || (!harness && !broad)) continue;
    for (const field of ["model", "effort", "budget", "tools"] as BindingField[]) {
      if (want(field) && patch[SETTINGS_KEY[field]] !== undefined) settingsFields.push(`harnesses.${target}.roles.${role}.${SETTINGS_KEY[field]}`);
    }
  }
  if (want("instructions")) {
    if (harness) {
      if (fileState(overrideFile(agentDir, harness, role)) !== "absent") files.push(overrideFile(agentDir, harness, role));
    } else {
      if (entry.builtIn && entry.file) files.push(entry.file);
      if (broad) files.push(...entry.overrides);
    }
  }
  const fileStates = statesOf(files);
  const kept = ["enabled gates", ...(!harness && !entry.builtIn && entry.file ? [`custom role definition ${entry.file}`] : [])];
  const fingerprint = hash(stable({ owned: ownedRole(readRaw(agentDir), role, []), fileStates }));
  return { kind: "role", name: role, harness, fields: [...fields], settingsFields, files, kept, fileStates, fingerprint };
}

export function applyRoleReset(agentDir: string, plan: ResetPlan): { failed: Array<{ path: string; reason: string }> } {
  const role = plan.name;
  if (planRoleReset(agentDir, role, plan.harness, plan.fields).fingerprint !== plan.fingerprint) throw new LifecycleError(CHANGED);
  const planned = ownedRole(readRaw(agentDir), role, []);
  const removed = removeFiles(plan);
  if (removed.failed.length) return { failed: removed.failed };
  if (plan.settingsFields.length) {
    try {
      mutateV5(agentDir, (raw) => {
        if (ownedRole(raw, role, []) !== planned) throw new LifecycleError(CHANGED);
        for (const field of plan.settingsFields) {
          const [, harness, , , key] = field.split(".");
          const patches = own(own(own(raw, "harnesses"), harness!), "roles");
          const patch = own(patches, role);
          if (!objectRecord(patch)) continue;
          delete patch[key!];
          prune(patches, role);
          pruneHarness(raw, harness!);
        }
      });
    } catch (error) {
      if (!removed.deleted.length) throw error;
      throw new LifecycleError(`Instruction files removed: ${removed.deleted.join(', ')}. Scalar settings unchanged. Preview again to finish the reset. ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { failed: [] };
}

export function planRoleDelete(agentDir: string, role: string): DeletePlan {
  assertRoleName(role);
  const settings = readV5Settings(agentDir);
  const inventory = roleInventory(agentDir, settings);
  const entry = inventory.get(role);
  if (!entry) throw new LifecycleError(`Unknown role "${role}". See /external config role list.`);
  const empty = { kind: "role" as const, name: role, files: [], settingsFields: [], kept: [], legacyIdentities: [], fileStates: {}, fingerprint: "" };
  if (entry.builtIn) return { ...empty, blockers: [`"${role}" is a built-in role and cannot be deleted. Use /external config role reset ${role} or disable ${role} instead.`] };
  const blockers = entry.unsafe.map((path) => `${path} is a symbolic link or not a regular file; managed configuration files are never followed or deleted through links.`);
  const files = [...entry.overrides, ...(entry.file ? [entry.file] : [])];
  const fileStates = statesOf(files.filter((path) => !entry.unsafe.includes(path)), []);
  const known = new Set(inventory.keys());
  const legacyIdentities: string[] = [];
  const kept: string[] = [];
  for (const harness of registeredHarnesses(settings)) {
    const identity = `${harness}-${role}`;
    if (!(settings.disabledProfiles ?? []).includes(identity)) continue;
    const readings = legacyReadings(settings, known, identity);
    if (readings.length > 1) kept.push(`disabledProfiles entry ${identity} (ambiguous: also names ${readings.filter((item) => item !== `${harness}/${role}`).join(", ")})`);
    else if (Object.hasOwn(settings.exact ?? {}, identity)) kept.push(`independent exact selector exclusion ${identity}`);
    else legacyIdentities.push(identity);
  }
  const settingsFields = [
    ...(own(settings.roles, role) ? [`roles.${role}`] : []),
    ...entry.exceptions.map((harness) => `harnesses.${harness}.roles.${role}`),
    ...legacyIdentities.map((identity) => `disabledProfiles: ${identity}`),
  ];
  const fingerprint = hash(stable({ owned: ownedRole(readRaw(agentDir), role, legacyIdentities), fileStates }));
  return { ...empty, files, settingsFields, blockers, kept, legacyIdentities, fileStates, fingerprint };
}

/** Revalidate, persist a role-wide disable gate, remove owned files, then remove settings. Failure leaves the role blocked. */
export function applyRoleDelete(agentDir: string, plan: DeletePlan): DeleteResult {
  const role = plan.name;
  const current = planRoleDelete(agentDir, role);
  if (current.blockers.length) throw new LifecycleError(current.blockers.join(" "));
  if (plan.blockers.length || current.fingerprint !== plan.fingerprint) throw new LifecycleError(CHANGED);
  const planned = ownedRole(readRaw(agentDir), role, plan.legacyIdentities, true);
  const unchanged = (raw: Raw) => { if (ownedRole(raw, role, plan.legacyIdentities, true) !== planned) throw new LifecycleError(CHANGED); };
  if (plan.files.length) mutateV5(agentDir, (raw) => { unchanged(raw); obj(obj(raw, "roles"), role).enabled = false; });
  const { deleted, failed } = removeFiles(plan);
  if (failed.length) {
    return { complete: false, deleted, failed, message: `Role "${role}" was not fully deleted and stays disabled on every harness. Fix the files below, then rerun /external config role delete ${role}.` };
  }
  mutateV5(agentDir, (raw) => {
    unchanged(raw);
    const roles = own(raw, "roles");
    if (objectRecord(roles)) { delete roles[role]; prune(raw, "roles"); }
    const harnesses = own(raw, "harnesses");
    for (const harness of objectRecord(harnesses) ? Object.keys(harnesses) : []) {
      const patches = own(own(harnesses, harness), "roles");
      if (objectRecord(patches) && Object.hasOwn(patches, role)) { delete patches[role]; pruneHarness(raw, harness); }
    }
    const list = withoutNames(raw.disabledProfiles, plan.legacyIdentities);
    if (list) raw.disabledProfiles = list;
  });
  return { complete: true, deleted, failed, message: `Role "${role}" deleted. Run receipts and native CLI configuration were not touched.` };
}
