import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as settingsWriter from '../src/settings.ts';
import {
  applyHarnessDelete, applyHarnessReset, applyRoleDelete, applyRoleReset, createPiHarness, createRole, planHarnessDelete,
  planHarnessReset, planRoleDelete, planRoleReset, remainingGates, resetHarnessFields, setBindingFields, setDefaultHarness,
  setHarnessEnabled, setHarnessFields, setRoleEnabled, writeInstructions, readV5Settings, replaceHarnessEntry,
} from "../src/config-lifecycle.ts";
import { loadExternalCatalog, resolveExternalProfile } from "../src/profiles.ts";
import { EXTERNAL_HARNESSES } from "../src/types.ts";

const roots: string[] = [];
function fixture(settings: object | undefined, files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "external-lifecycle-"));
  roots.push(root);
  const base = join(root, "pi-flow-external");
  mkdirSync(base, { recursive: true });
  if (settings) writeFileSync(join(base, "settings.json"), JSON.stringify(settings));
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(base, path, ".."), { recursive: true });
    writeFileSync(join(base, path), body);
  }
  return root;
}
const saved = (root: string) => JSON.parse(readFileSync(join(root, "pi-flow-external", "settings.json"), "utf8"));
function select(root: string, role: string, harness: string) {
  const c = loadExternalCatalog(root);
  return resolveExternalProfile(c.profiles, { role, harness }, "agy", { configuredHarnessNames: new Set([...EXTERNAL_HARNESSES, ...c.harnessConfigs.keys()]), harnessConfigs: c.harnessConfigs, disabledHarnesses: c.disabledHarnesses });
}
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) { try { chmodSync(join(root, "pi-flow-external", "overrides", "pi-x"), 0o700); } catch { /* absent */ } rmSync(root, { recursive: true, force: true }); } });

describe("config lifecycle", () => {
  it('refuses linked ancestors on reset planning and on apply after preview', () => {
    const root = fixture({ version: 5 }, { 'overrides/codex/worker.md': 'original' });
    const plan = planRoleReset(root, 'worker', 'codex', ['instructions']);
    const outside = fixture(undefined, { 'worker.md': 'outside' });
    const directory = join(root, 'pi-flow-external/overrides/codex');
    rmSync(directory, { recursive: true });
    symlinkSync(join(outside, 'pi-flow-external'), directory);
    expect(() => planRoleReset(root, 'worker', 'codex', ['instructions'])).toThrow(/symbolic link/);
    expect(() => applyRoleReset(root, plan)).toThrow();
    expect(readFileSync(join(outside, 'pi-flow-external/worker.md'), 'utf8')).toBe('outside');
  });
  it('keeps exact-selector exclusions independent and refuses editing defaults disabled', () => {
    const root = fixture({ version: 5, defaultHarness: 'codex', disabledProfiles: ['codex-audit'], exact: { 'codex-audit': { harness: 'claude', instructions: '', description: 'exact' } } }, { 'roles/audit.md': 'audit' });
    setRoleEnabled(root, 'audit', true, 'codex');
    expect(saved(root).disabledProfiles).toEqual(['codex-audit']);
    expect(remainingGates(readV5Settings(root), { harness: 'codex', role: 'audit' })).toEqual([]);
    expect(() => replaceHarnessEntry(root, 'codex', { enabled: false })).toThrow(/default/);
    expect(() => replaceHarnessEntry(root, 'claude', { enabled: false }, { harness: 'claude', source: 'project' })).toThrow(/default/);
    applyRoleDelete(root, planRoleDelete(root, 'audit'));
    expect(saved(root).disabledProfiles).toEqual(['codex-audit']);
    expect(remainingGates(readV5Settings(root), { harness: 'claude' }).join(' ')).toContain('codex-audit');
  });
  it("refuses v4 settings and instructs conversion without writing", () => {
    const root = fixture({ version: 4, defaultHarness: "agy" });
    expect(() => setHarnessFields(root, "codex", { model: "gpt-x" })).toThrow(/version 4.*\/external config convert/);
    expect(saved(root)).toEqual({ version: 4, defaultHarness: "agy" });
  });

  it("sets sparse harness and binding values that the catalog resolves, and field reset keeps gates and other values", () => {
    const root = fixture({ version: 5, futureKey: 1 });
    setHarnessFields(root, "codex", { model: "gpt-x", effort: "high" });
    setBindingFields(root, "reviewer", "codex", { effort: "xhigh", budget: 2 });
    setRoleEnabled(root, "worker", false, "codex");
    expect(select(root, "reviewer", "codex")).toMatchObject({ model: "gpt-x", thinking: "xhigh", maxBudgetUsd: 2, origins: { thinking: "role reviewer on codex", model: "harness codex" } });
    expect(() => setBindingFields(root, "reviewer", "codex", { tools: ["read"] })).toThrow(/Settings were not changed: .*tools/);

    resetHarnessFields(root, "codex", ["effort"]);
    applyRoleReset(root, planRoleReset(root, "reviewer", "codex", ["effort"]));
    expect(saved(root)).toEqual({ version: 5, futureKey: 1, harnesses: { codex: { model: "gpt-x", roles: { reviewer: { max_budget_usd: 2 }, worker: { enabled: false } } } } });

    const plan = planHarnessReset(root, "codex");
    expect(plan.settingsFields).toEqual(["harnesses.codex.model", "harnesses.codex.roles.reviewer.max_budget_usd"]);
    applyHarnessReset(root, plan);
    expect(saved(root).harnesses).toEqual({ codex: { roles: { worker: { enabled: false } } } });
    expect(() => select(root, "worker", "codex")).toThrow(/disabled/);
  });

  it("enable removes only its own gate and reports remaining gates; default and delete are guarded", () => {
    const root = fixture({ version: 5, defaultHarness: "claude", disabledHarnesses: ["codex"], roles: { reviewer: { enabled: false } } });
    expect(() => setHarnessEnabled(root, "claude", false)).toThrow(/global default/);
    expect(() => setDefaultHarness(root, "codex")).toThrow(/disabled.*harness enable codex/);
    expect(() => setHarnessEnabled(root, "muse", false, { harness: "muse", source: "project", projectPath: "/p" })).toThrow(/project default/);

    setHarnessEnabled(root, "codex", true);
    expect(saved(root).disabledHarnesses).toEqual([]);
    expect(remainingGates(readV5Settings(root), { harness: "codex", role: "reviewer" })).toEqual([expect.stringMatching(/role "reviewer" is disabled/)]);
    setDefaultHarness(root, "codex");
    expect(saved(root).defaultHarness).toBe("codex");

    expect(planHarnessDelete(root, "codex").blockers[0]).toMatch(/built-in CLI harness cannot be deleted|cannot be deleted/);
    expect(planRoleDelete(root, "reviewer").blockers[0]).toMatch(/built-in role and cannot be deleted/);
  });

  it("creates a Pi harness explicitly and deletes it with its nested overrides, refusing while it is the default", () => {
    const root = fixture({ version: 5 });
    createPiHarness(root, "pi-deep", { model: "p/one" });
    createPiHarness(root, "pi-deep-seek", { model: "p/two", thinking: "low", preset: "skills" });
    expect(saved(root).harnesses["pi-deep"]).toEqual({ model: "p/one", thinking: "off", preset: "minimal", owner: "user" });
    expect(() => createPiHarness(root, "pi-deep", { model: "p/x" })).toThrow(/already exists/);
    createRole(root, "seek-reviewer", "---\ndescription: Alternate\n---\nAlternate");
    writeInstructions(root, "seek-reviewer", "---\ndescription: Specific\n---\n", "pi-deep");
    expect(select(root, "seek-reviewer", "pi-deep")).toMatchObject({ model: "p/one", systemPrompt: "" });
    expect(select(root, "reviewer", "pi-deep-seek")).toMatchObject({ model: "p/two", preset: "skills" });

    setDefaultHarness(root, "pi-deep");
    expect(planHarnessDelete(root, "pi-deep").blockers).toEqual([expect.stringMatching(/global default/)]);
    setDefaultHarness(root, "agy");
    const plan = planHarnessDelete(root, "pi-deep");
    expect(plan.files).toEqual([join(root, "pi-flow-external", "overrides", "pi-deep", "seek-reviewer.md")]);
    expect(applyHarnessDelete(root, plan).complete).toBe(true);
    expect(saved(root).harnesses["pi-deep"]).toBeUndefined();
    expect(saved(root).harnesses["pi-deep-seek"]).toBeDefined();
    expect(existsSync(join(root, "pi-flow-external", "overrides", "pi-deep"))).toBe(false);
  });

  it("persists a disable gate before multi-file cleanup and leaves the entity blocked when cleanup fails", () => {
    const root = fixture({ version: 5, harnesses: { "pi-x": { model: "p/m" } } }, { "overrides/pi-x/worker.md": "---\ndescription: W\n---\nW" });
    const dir = join(root, "pi-flow-external", "overrides", "pi-x");
    chmodSync(dir, 0o500);
    const result = applyHarnessDelete(root, planHarnessDelete(root, "pi-x"));
    expect(result.complete).toBe(false);
    expect(result.failed.map((item) => item.path)).toEqual([join(dir, "worker.md")]);
    expect(saved(root).harnesses["pi-x"]).toMatchObject({ enabled: false, model: "p/m" });
    expect(() => select(root, "worker", "pi-x")).toThrow(/disabled/);
    chmodSync(dir, 0o700);
    expect(applyHarnessDelete(root, planHarnessDelete(root, "pi-x")).complete).toBe(true);
    expect(saved(root).harnesses).toBeUndefined();
  });

  it("keeps scalar customizations and gates when broad reset cannot remove instructions", () => {
    const root = fixture({ version: 5, harnesses: { 'pi-x': { model: 'p/m', roles: { worker: { model: 'p/custom', thinking: 'high', enabled: false } } } } }, {
      'overrides/pi-x/worker.md': '---\ndescription: Custom\n---\nCustom instructions',
    });
    const directory = join(root, 'pi-flow-external/overrides/pi-x');
    const before = readFileSync(join(root, 'pi-flow-external/settings.json'), 'utf8');
    chmodSync(directory, 0o500);
    const result = applyRoleReset(root, planRoleReset(root, 'worker', 'pi-x', []));
    expect(result.failed).toHaveLength(1);
    expect(readFileSync(join(root, 'pi-flow-external/settings.json'), 'utf8')).toBe(before);
    expect(readFileSync(join(directory, 'worker.md'), 'utf8')).toContain('Custom instructions');
    chmodSync(directory, 0o700);
    expect(applyRoleReset(root, planRoleReset(root, 'worker', 'pi-x', [])).failed).toEqual([]);
    expect(saved(root).harnesses['pi-x'].roles.worker).toEqual({ enabled: false });

    // File removal can succeed before an atomic settings write fails; report that partial state.
    const failedWrite = fixture({ version: 5, harnesses: { codex: { roles: { worker: { model: 'custom' } } } } }, {
      'overrides/codex/worker.md': '---\ndescription: Custom\n---\nCustom',
    });
    const plan = planRoleReset(failedWrite, 'worker', 'codex', []);
    vi.spyOn(settingsWriter, 'updateExternalSettings').mockImplementationOnce(() => { throw new Error('disk full'); });
    expect(() => applyRoleReset(failedWrite, plan)).toThrow(/instruction.*removed.*settings.*unchanged/i);
    expect(saved(failedWrite).harnesses.codex.roles.worker.model).toBe('custom');
    expect(existsSync(join(failedWrite, 'pi-flow-external/overrides/codex/worker.md'))).toBe(false);
    expect(applyRoleReset(failedWrite, planRoleReset(failedWrite, 'worker', 'codex', [])).failed).toEqual([]);
  });

  it("creates, customizes, resets, and deletes custom and built-in role definitions", () => {
    const root = fixture({ version: 5 });
    expect(() => createRole(root, "reviewer", "---\ndescription: X\n---\n")).toThrow(/built-in role/);
    expect(() => createRole(root, "audit", "---\ndescription: A\nmodel: x\n---\n")).toThrow(/description only/);
    createRole(root, "audit", "---\ndescription: \"Audit: deep\"\n---\nAudit now");
    expect(() => createRole(root, "audit", "---\ndescription: A\n---\n")).toThrow(/already exists/);
    writeInstructions(root, "audit", "---\ndescription: Codex audit\n---\nCodex only", "codex");
    setBindingFields(root, "audit", "codex", { model: "gpt-x" });
    expect(select(root, "audit", "claude")).toMatchObject({ description: "Audit: deep", systemPrompt: "Audit now" });
    expect(select(root, "audit", "codex")).toMatchObject({ systemPrompt: "Codex only", model: "gpt-x" });
    expect(() => planRoleReset(root, "audit", undefined, ["model"])).toThrow(/--harness/);
    expect(() => planRoleReset(root, "audit", undefined, ["instructions"])).toThrow(/custom role/);

    // Built-in shared customization resets to the built-in; the gate survives.
    writeInstructions(root, "reviewer", "---\ndescription: Mine\n---\nMine");
    setRoleEnabled(root, "reviewer", false);
    const reset = planRoleReset(root, "reviewer", undefined, []);
    expect(reset.files).toEqual([join(root, "pi-flow-external", "roles", "reviewer.md")]);
    applyRoleReset(root, reset);
    expect(saved(root).roles).toEqual({ reviewer: { enabled: false } });
    setRoleEnabled(root, "reviewer", true);
    expect(select(root, "reviewer", "claude").systemPrompt).toMatch(/^Review code/);

    const plan = planRoleDelete(root, "audit");
    expect(plan.settingsFields).toEqual(["harnesses.codex.roles.audit"]);
    expect(plan.files).toHaveLength(2);
    expect(applyRoleDelete(root, plan).complete).toBe(true);
    expect(saved(root)).toEqual({ version: 5 });
    expect(() => select(root, "audit", "claude")).toThrow();
  });

  it("revalidates destructive previews before any write or unlink", () => {
    const override = "overrides/pi-x/worker.md";
    const root = fixture({ version: 5, harnesses: { "pi-x": { model: "p/m" }, "pi-y": { model: "p/n" } } }, { [override]: "---\ndescription: W\n---\nW" });
    const path = join(root, "pi-flow-external", override);

    // A file replaced after preview is never deleted, and nothing is gated.
    const plan = planHarnessDelete(root, "pi-x");
    writeFileSync(path, "---\ndescription: Replacement\n---\nNew");
    expect(() => applyHarnessDelete(root, plan)).toThrow(/changed since the preview/);
    expect(readFileSync(path, "utf8")).toContain("Replacement");
    expect(saved(root).harnesses["pi-x"]).toEqual({ model: "p/m" });

    // An owned settings entry changed after preview is refused.
    const second = planHarnessDelete(root, "pi-x");
    setHarnessFields(root, "pi-x", { effort: "high" });
    expect(() => applyHarnessDelete(root, second)).toThrow(/changed since the preview/);
    expect(existsSync(path)).toBe(true);

    // A default chosen after preview (global or trusted project) blocks apply.
    const third = planHarnessDelete(root, "pi-x");
    setDefaultHarness(root, "pi-x");
    expect(() => applyHarnessDelete(root, third)).toThrow(/global default/);
    setDefaultHarness(root, "agy");
    const fourth = planHarnessDelete(root, "pi-x");
    expect(() => applyHarnessDelete(root, fourth, { harness: "pi-x", source: "project", projectPath: "/p" })).toThrow(/project default/);
    expect(existsSync(path)).toBe(true);

    // Role delete and resets carry the same guard.
    createRole(root, "audit", "---\ndescription: A\n---\nA");
    const rolePlan = planRoleDelete(root, "audit");
    writeFileSync(join(root, "pi-flow-external", "roles", "audit.md"), "---\ndescription: B\n---\nB");
    expect(() => applyRoleDelete(root, rolePlan)).toThrow(/changed since the preview/);
    expect(existsSync(join(root, "pi-flow-external", "roles", "audit.md"))).toBe(true);
    const resetPlan = planRoleReset(root, "worker", "pi-x", []);
    writeFileSync(path, "---\ndescription: Again\n---\nAgain");
    expect(() => applyRoleReset(root, resetPlan)).toThrow(/changed since the preview/);
    expect(readFileSync(path, "utf8")).toContain("Again");
    setBindingFields(root, "reviewer", "pi-y", { effort: "low" });
    const harnessPlan = planHarnessReset(root, "pi-y");
    setBindingFields(root, "reviewer", "pi-y", { effort: "high" });
    expect(() => applyHarnessReset(root, harnessPlan)).toThrow(/changed since the preview/);
    expect(saved(root).harnesses["pi-y"].roles.reviewer.thinking).toBe("high");
  });

  it("treats a migrated override-only role as real only on its own bindings", () => {
    const root = fixture({ version: 5 }, { "overrides/codex/legacy-audit.md": "---\ndescription: Legacy\n---\nLegacy" });
    setBindingFields(root, "legacy-audit", "codex", { effort: "high" });
    writeInstructions(root, "legacy-audit", "---\ndescription: Legacy 2\n---\nLegacy 2", "codex");
    expect(saved(root).harnesses.codex.roles["legacy-audit"]).toEqual({ thinking: "high" });
    setRoleEnabled(root, "legacy-audit", false, "codex");
    expect(() => setBindingFields(root, "legacy-audit", "claude", { model: "x" })).toThrow(/no binding on claude/);
    expect(() => writeInstructions(root, "legacy-audit", "---\ndescription: X\n---\nX", "claude")).toThrow(/no binding on claude/);
    expect(() => writeInstructions(root, "legacy-audit", "---\ndescription: X\n---\nX")).toThrow(/no shared definition/);
    expect(() => setRoleEnabled(root, "legacy-audit", false, "claude")).toThrow(/no binding on claude/);
    expect(existsSync(join(root, "pi-flow-external", "overrides", "claude"))).toBe(false);
    expect(existsSync(join(root, "pi-flow-external", "roles", "legacy-audit.md"))).toBe(false);
    expect(planRoleDelete(root, "legacy-audit").files).toEqual([join(root, "pi-flow-external", "overrides", "codex", "legacy-audit.md")]);
  });

  it("rejects names that collide with object prototype properties", () => {
    const root = fixture({ version: 5 });
    for (const name of ["constructor", "__proto__", "prototype"]) {
      expect(() => createRole(root, name, "---\ndescription: X\n---\nX")).toThrow(/reserved|Invalid role name/);
      expect(() => setRoleEnabled(root, name, false)).toThrow(/reserved|Unknown role|Invalid role name/);
    }
    expect(() => setBindingFields(root, "constructor", "codex", { model: "x" })).toThrow(/reserved/);
    expect(({} as Record<string, unknown>).enabled).toBeUndefined();
    expect(saved(root)).toEqual({ version: 5 });
    expect(existsSync(join(root, "pi-flow-external", "roles", "constructor.md"))).toBe(false);
  });

  it("removes only unambiguous legacy disabledProfiles identities for a role", () => {
    const root = fixture({ version: 5, harnesses: { "pi-deep": { model: "p/one" }, "pi-deep-seek": { model: "p/two" } }, disabledProfiles: ["codex-seek-reviewer", "pi-deep-seek-reviewer", "claude-worker"] });
    createRole(root, "seek-reviewer", "---\ndescription: S\n---\nS");
    expect(() => setRoleEnabled(root, "seek-reviewer", true, "pi-deep")).toThrow(/ambiguous.*pi-deep-seek-reviewer/);
    const plan = planRoleDelete(root, "seek-reviewer");
    expect(plan.settingsFields).toContain("disabledProfiles: codex-seek-reviewer");
    expect(plan.kept).toEqual([expect.stringMatching(/pi-deep-seek-reviewer.*ambiguous/)]);
    applyRoleDelete(root, plan);
    expect(saved(root).disabledProfiles).toEqual(["pi-deep-seek-reviewer", "claude-worker"]);
  });

  it("never follows symlinks or non-regular entries inside the managed namespace", () => {
    const outside = mkdtempSync(join(tmpdir(), "external-outside-"));
    roots.push(outside);
    writeFileSync(join(outside, "worker.md"), "---\ndescription: Outside\n---\nOutside");
    writeFileSync(join(outside, "audit.md"), "---\ndescription: Outside\n---\nOutside");
    const root = fixture({ version: 5, harnesses: { "pi-x": { model: "p/m" } } });
    const base = join(root, "pi-flow-external");
    mkdirSync(join(base, "overrides"), { recursive: true });
    symlinkSync(outside, join(base, "overrides", "pi-x"));
    expect(planHarnessDelete(root, "pi-x").blockers).toEqual([expect.stringMatching(/symbolic link/)]);
    expect(() => writeInstructions(root, "worker", "---\ndescription: W\n---\nW", "pi-x")).toThrow(/symbolic link/);
    expect(existsSync(join(outside, "worker.md"))).toBe(true);
    expect(readFileSync(join(outside, "worker.md"), "utf8")).toContain("Outside");

    mkdirSync(join(base, "roles"));
    symlinkSync(join(outside, "audit.md"), join(base, "roles", "audit.md"));
    expect(planRoleDelete(root, "audit").blockers).toEqual([expect.stringMatching(/symbolic link/)]);
    expect(() => writeInstructions(root, "audit", "---\ndescription: A\n---\nA")).toThrow(/symbolic link/);
    expect(readFileSync(join(outside, "audit.md"), "utf8")).toContain("Outside");
    rmSync(join(base, "roles"), { recursive: true });
    symlinkSync(outside, join(base, "roles"));
    expect(() => createRole(root, "fresh", "---\ndescription: F\n---\nF")).toThrow(/symbolic link/);
    expect(existsSync(join(outside, "fresh.md"))).toBe(false);
  });
});
