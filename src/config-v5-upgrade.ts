import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, mkdirSync, writeFileSync, linkSync, unlinkSync } from "node:fs";
import { dirname, join, resolve, relative, sep } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { CONFIG_NAME, cliHarness, objectRecord, executionProblems, reasoningLevels, type HarnessSettings, type ExactSettings, type BindingSettings } from "./config-v5.ts";
import { planConfigUpgrade } from "./config-upgrade.ts";
import { parseSubagentProfileContent, computeReconciledPiProfile, opencodeProfileProblem } from "./profiles.ts";
import { externalSettingsPath, parseSettings, saveExternalSettings } from "./settings.ts";
import { EXTERNAL_HARNESSES } from "./types.ts";

export interface V5UpgradeFile {
  sourcePath: string;
  destinationPath: string;
  fingerprint: string;
  contents: string;
}
/** Raw JSON document, not ExternalSettings' Pi-only harness projection. */
export interface V5UpgradeSettings extends Record<string, unknown> {
  version: 5;
  harnesses: Record<string, HarnessSettings>;
  exact?: Record<string, ExactSettings>;
}
export interface V5UpgradePlan {
  status: "ready" | "current" | "blocked" | "empty";
  diagnostics: string[];
  notes: string[];
  settingsPath: string;
  settings?: V5UpgradeSettings;
  copies: V5UpgradeFile[];
  backups: V5UpgradeFile[];
  sourceDigest?: string;
  impact: { bindings: string[]; exactSelectors: string[]; sharedRoles: string[]; disabledProfiles: string[]; disabledHarnesses: string[] };
}
export interface V5UpgradeApplyResult extends Omit<V5UpgradePlan, "status"> {
  status: "applied" | "current" | "blocked" | "empty";
  installedPaths: string[];
}

function digest(bytes: string | Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
function directories(root: string, directory: string): void {
  const rel = relative(root, directory);
  if (rel.startsWith(`..${sep}`) || rel === "..") throw new Error(`Path ${directory} is outside ${root}.`);
  let path = root;
  for (const part of ["", ...rel.split(sep).filter(Boolean)]) {
    if (part) path = join(path, part);
    try { if (!lstatSync(path).isDirectory()) throw new Error(`${path} must be a real directory, not a symlink.`); }
    catch (error) { if (!missing(error)) throw error; }
  }
}
function read(root: string, path: string): Buffer | undefined {
  directories(root, dirname(path));
  try {
    if (!lstatSync(path).isFile()) throw new Error(`${path} must be a regular file, not a symlink.`);
    return readFileSync(path);
  } catch (error) { if (missing(error)) return undefined; throw error; }
}
function entries(root: string, directory: string): string[] {
  directories(root, directory);
  try { return readdirSync(directory).sort(); }
  catch (error) { if (missing(error)) return []; throw error; }
}
function validateSettings(record: unknown): void {
  const errors = parseSettings(record).diagnostics.filter(d => !d.startsWith("Unknown setting"));
  if (errors.length) throw new Error(errors.join(" "));
}
function destination(root: string, file: V5UpgradeFile): void {
  const bytes = read(root, file.destinationPath);
  if (bytes !== undefined && !bytes.equals(Buffer.from(file.contents))) {
    throw new Error(`Destination ${file.destinationPath} differs from ${file.sourcePath}; originals and settings were not changed.`);
  }
}
function instructionText(description: string, body: string): string {
  return `---\ndescription: ${JSON.stringify(description)}\n---\n\n${body}${body ? "\n" : ""}`;
}
function inactive(root: string, status: V5UpgradePlan["status"], diagnostics: string[] = []): V5UpgradePlan {
  return { status, diagnostics, notes: [], settingsPath: externalSettingsPath(root), copies: [], backups: [],
    impact: { bindings: [], exactSelectors: [], sharedRoles: [], disabledProfiles: [], disabledHarnesses: [] } };
}

function plan(root: string): V5UpgradePlan {
  const settingsPath = externalSettingsPath(root);
  const bytes = read(root, settingsPath);
  if (bytes === undefined) {
    const legacy = planConfigUpgrade(root);
    if (legacy.status === "ready" || legacy.status === "blocked") {
      return inactive(root, "blocked", ["Pre-v4 configuration must first be converted to v4; v5 conversion is a separate step.", ...legacy.diagnostics]);
    }
    if (entries(root, join(root, "pi-flow-external", "overrides")).some(name => name.endsWith(".md"))) {
      return inactive(root, "blocked", [`Legacy overrides exist without a version 4 settings file at ${settingsPath}.`]);
    }
    return inactive(root, "empty");
  }
  if (!Buffer.from(bytes.toString("utf8")).equals(bytes)) throw new Error(`${settingsPath} must be valid UTF-8; conversion will not change original snapshot bytes.`);
  const raw: unknown = JSON.parse(bytes.toString("utf8"));
  if (!objectRecord(raw)) throw new Error(`${settingsPath} must be a JSON object.`);
  if (raw.version !== 4 && raw.version !== 5) {
    throw new Error(`Settings version ${JSON.stringify(raw.version)} cannot be converted by the v4 to v5 step. Pre-v4 settings must first use the existing v4 conversion; future versions are refused.`);
  }
  validateSettings(raw);
  if (raw.version === 5) return inactive(root, "current");
  if (raw.roles !== undefined || raw.exact !== undefined) throw new Error("v4 settings contain v5-only roles or exact fields; resolve these before conversion.");
  for (const [name, entry] of Object.entries(raw.harnesses ?? {})) {
    if (!objectRecord(entry) || Object.keys(entry).some(key => !["model", "thinking", "preset", "owner"].includes(key))
      || (entry.owner !== undefined && typeof entry.owner !== "string")) {
      throw new Error(`Invalid v4 harness metadata for ${name}; conversion will not silently discard fields.`);
    }
  }
  const legacy = parseSettings(raw).settings;
  const piConfigs = new Map(Object.entries(legacy.harnesses ?? {}));
  if (!cliHarness(legacy.defaultHarness) && !piConfigs.has(legacy.defaultHarness)) throw new Error(`Default Pi harness ${legacy.defaultHarness} is not registered.`);
  const harnesses: Record<string, HarnessSettings> = {};
  for (const harness of EXTERNAL_HARNESSES) harnesses[harness] = { thinking: harness === "opencode" ? "native" : "parent" };
  for (const [harness, config] of piConfigs) harnesses[harness] = { ...config };
  const settings: V5UpgradeSettings = { ...raw, version: 5, harnesses };
  const result: V5UpgradePlan = { ...inactive(root, "ready"), settings };
  result.impact.disabledProfiles = [...legacy.disabledProfiles ?? []];
  result.impact.disabledHarnesses = [...legacy.disabledHarnesses ?? []];
  result.notes.push("CLI harness effort defaults retain parent inheritance (OpenCode retains native effort), including future shared roles. No full overrides are consolidated.");
  const sources: [string, string][] = [[settingsPath, digest(bytes)]];
  const base = join(root, "pi-flow-external");
  result.backups.push({ sourcePath: settingsPath, destinationPath: join(base, "settings.v4.backup.json"), fingerprint: digest(bytes), contents: bytes.toString("utf8") });
  for (const file of entries(root, join(base, "roles"))) {
    if (!file.endsWith(".md")) continue;
    const name = file.slice(0, -3), path = join(base, "roles", file);
    if (!CONFIG_NAME.test(name)) throw new Error(`Invalid legacy role name ${path}.`);
    const contents = read(root, path);
    if (!contents) throw new Error(`Could not read ${path}.`);
    const { frontmatter } = parseFrontmatter<Record<string, unknown>>(contents.toString("utf8"));
    if (typeof frontmatter.description !== "string" || !frontmatter.description.trim() || Object.keys(frontmatter).some(k => k !== "description")) {
      throw new Error(`Invalid shared role ${path}: only description metadata is supported.`);
    }
    sources.push([path, digest(contents)]);
    result.impact.sharedRoles.push(name);
  }
  const harnessNames = Object.keys(harnesses);
  for (const file of entries(root, join(base, "overrides"))) {
    if (!file.endsWith(".md")) continue;
    const name = file.slice(0, -3), sourcePath = join(base, "overrides", file);
    if (!CONFIG_NAME.test(name)) throw new Error(`Invalid legacy override name ${sourcePath}.`);
    const contents = read(root, sourcePath);
    if (!contents) throw new Error(`Could not read ${sourcePath}.`);
    const text = contents.toString("utf8");
    const profile = parseSubagentProfileContent(text, name);
    const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(text);
    const allowed = ["description", "backend", "harness", "model", "thinking", "tools", "max_budget_usd", "owner"];
    if (!profile || Object.keys(frontmatter).some(key => !allowed.includes(key))) throw new Error(`Invalid legacy override ${sourcePath}: unsupported profile or metadata.`);
    const harness = profile.backend === "pi" ? profile.harness : profile.backend;
    if (!harness || !harnesses[harness]) throw new Error(`Pi harness ${harness ?? "(missing)"} in ${sourcePath} is not registered.`);
    if (cliHarness(harness) && profile.harness !== undefined && profile.harness !== harness) throw new Error(`Override ${sourcePath} declares a mismatched execution harness ${profile.harness}.`);
    const reconciled = computeReconciledPiProfile(profile, piConfigs);
    if (reconciled.conflict) throw new Error(`${sourcePath}: ${reconciled.conflict}`);
    const opencodeProblem = opencodeProfileProblem(profile);
    if (opencodeProblem) throw new Error(opencodeProblem);
    const fields: BindingSettings = {};
    if (cliHarness(harness)) {
      fields.model = profile.model ?? "native";
      fields.thinking = profile.thinking ?? (harness === "opencode" ? "native" : "parent");
      if (profile.thinking && ["native", "parent"].includes(profile.thinking)) throw new Error(`${sourcePath}: legacy effort ${profile.thinking} conflicts with a v5 policy keyword.`);
      if (["agy", "grok", "muse"].includes(harness) && profile.thinking) fields.thinking = profile.thinking.toLowerCase();
    } else {
      // Omitted Pi fields keep inheriting their registration; matching legacy pins remain explicit.
      if (profile.model !== undefined) fields.model = profile.model;
      if (profile.thinking !== undefined) fields.thinking = profile.thinking;
    }
    if (profile.tools !== undefined) {
      if (cliHarness(harness)) result.notes.push(`${sourcePath}: tools omitted — CLI harnesses never enforced this metadata; v4 only recorded it.`);
      else fields.tools = profile.tools;
    }
    if (profile.maxBudgetUsd !== undefined) fields.max_budget_usd = profile.maxBudgetUsd;
    const problems = executionProblems(fields, harness);
    if (problems.length) throw new Error(`${sourcePath}: ${problems.join('; ')}. Supported effort for ${harness}: ${reasoningLevels(harness).join(', ')}${cliHarness(harness) && harness !== 'opencode' ? ', or remove thinking to retain parent inheritance' : ''}. Edit the original override, then preview again. Originals were not changed.`);
    if (legacy.disabledProfiles?.includes(name)) fields.enabled = false;
    const prefixes = harnessNames.filter(h => name.startsWith(`${h}-`) && CONFIG_NAME.test(name.slice(h.length + 1)));
    const role = name.startsWith(`${harness}-`) ? name.slice(harness.length + 1) : undefined;
    const canonicalRole = role && CONFIG_NAME.test(role) ? role : undefined;
    if (canonicalRole) {
      (harnesses[harness].roles ??= {})[canonicalRole] = fields;
      result.copies.push({ sourcePath, destinationPath: join(base, "overrides", harness, `${canonicalRole}.md`), fingerprint: digest(contents), contents: instructionText(profile.description, body.trim()) });
      result.impact.bindings.push(`${harness}/${canonicalRole}`);
    }
    if (!canonicalRole || prefixes.length > 1) {
      (settings.exact ??= {})[name] = { harness, description: profile.description, instructions: body.trim(), ...fields,
        ...(!cliHarness(harness) ? { model: reconciled.profile.model, thinking: reconciled.profile.thinking } : {}) };
      result.impact.exactSelectors.push(name);
      if (!cliHarness(harness)) result.notes.push(`${sourcePath}: exact Pi selector ${name} pins its current effective model/effort for compatibility; later harness-default changes do not update these pins.`);
    }
    for (const prefix of prefixes) {
      if (prefix === harness && canonicalRole) continue;
      const shadowedRole = name.slice(prefix.length + 1);
      ((harnesses[prefix].roles ??= {})[shadowedRole] ??= {}).enabled = false;
      result.notes.push(`Binding ${prefix}/${shadowedRole} stays blocked: legacy ${name} executes on ${harness}, and remains an exact selector.`);
    }
    sources.push([sourcePath, digest(contents)]);
  }
  // Translate known exclusions once; keeping their raw aliases would also disable unrelated ambiguous pairs.
  const unresolvedDisabled: string[] = [];
  delete settings.disabledProfiles;
  for (const name of legacy.disabledProfiles ?? []) {
    if (settings.exact?.[name]) continue;
    const matches = harnessNames.filter(h => name.startsWith(`${h}-`) && CONFIG_NAME.test(name.slice(h.length + 1)));
    if (matches.length === 1) {
      const harness = matches[0]!, role = name.slice(harness.length + 1);
      ((harnesses[harness].roles ??= {})[role] ??= {}).enabled = false;
    } else {
      unresolvedDisabled.push(name);
      result.diagnostics.push(`Retained unresolved disabled identity ${name}; no harness-wide gate was inferred.`);
    }
  }
  if (unresolvedDisabled.length) settings.disabledProfiles = unresolvedDisabled;
  const known = new Set(harnessNames);
  for (const name of legacy.disabledHarnesses ?? []) if (!known.has(name)) result.diagnostics.push(`Retained unknown disabled harness ${name}; its gate is not broadened.`);
  validateSettings(settings);
  for (const file of [...result.backups, ...result.copies]) destination(root, file);
  // Reject unrelated nested files that v4 ignored but v5 would newly activate.
  const expected = new Set(result.copies.map(file => file.destinationPath));
  for (const name of entries(root, join(base, "overrides"))) {
    const directory = join(base, "overrides", name);
    if (name.endsWith(".md")) continue;
    const stat = lstatSync(directory);
    if (!stat.isDirectory()) { if (stat.isSymbolicLink()) throw new Error(`${directory} must not be a symlink.`); continue; }
    for (const file of entries(root, directory)) if (file.endsWith(".md") && !expected.has(join(directory, file))) throw new Error(`Unrelated nested override ${join(directory, file)} would become active in v5; resolve it before conversion.`);
  }
  result.sourceDigest = digest(JSON.stringify(sources));
  return result;
}

/** Read-only concrete preview. Does not seed roles, rewrite originals, or contact providers. */
export function planV5Upgrade(agentDir: string): V5UpgradePlan {
  const root = resolve(agentDir);
  try { return plan(root); }
  catch (error) { return inactive(root, "blocked", [message(error)]); }
}

function install(root: string, file: V5UpgradeFile): void {
  const source = read(root, file.sourcePath);
  if (source === undefined || digest(source) !== file.fingerprint) throw new Error(`Source ${file.sourcePath} changed before installation.`);
  destination(root, file);
  if (read(root, file.destinationPath) !== undefined) return;
  const directory = dirname(file.destinationPath);
  directories(root, directory);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const staged = join(directory, `.${randomUUID()}.staged`);
  try {
    writeFileSync(staged, file.contents, { mode: 0o600, flag: "wx" });
    try { linkSync(staged, file.destinationPath); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; destination(root, file); }
  } finally { try { unlinkSync(staged); } catch (error) { if (!missing(error)) throw error; } }
}

/** Install private immutable snapshots/copies first, revalidate originals, then activate via the canonical writer. */
export function applyV5Upgrade(agentDir: string, expectedSourceDigest?: string): V5UpgradeApplyResult {
  const root = resolve(agentDir), first = planV5Upgrade(root), installedPaths: string[] = [];
  if (first.status !== "ready") return { ...first, status: first.status, installedPaths };
  if (expectedSourceDigest !== undefined && expectedSourceDigest !== first.sourceDigest) {
    return { ...first, status: "blocked", diagnostics: ["Sources changed since the v5 conversion preview. Preview again before applying."], installedPaths };
  }
  try {
    for (const file of [...first.backups, ...first.copies]) { install(root, file); installedPaths.push(file.destinationPath); }
    const verified = planV5Upgrade(root);
    if (verified.status !== "ready" || verified.sourceDigest !== first.sourceDigest) throw new Error(`Sources changed before v5 activation. ${verified.diagnostics.join(" ")}`);
    saveExternalSettings(root, verified.settings!, { activateV5: true });
    return { ...verified, status: "applied", installedPaths };
  } catch (error) { return { ...first, status: "blocked", diagnostics: [message(error)], installedPaths }; }
}
