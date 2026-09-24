import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it, expect } from 'vitest';
import { externalRoleAvailability, loadExternalCatalog, resolveExternalProfile } from '../src/profiles.ts';
import { EXTERNAL_HARNESSES } from '../src/types.ts';

it('composes file-free defaults, shared roles and exact overrides without fallback past invalid or disabled entries', () => {
  const root = mkdtempSync(join(tmpdir(), 'external-catalog-'));
  try {
    expect(loadExternalCatalog(root).profiles.size).toBe(30);
    expect(readdirSync(root)).toEqual([]);
    const dir = join(root, 'pi-flow-external');
    mkdirSync(join(dir, 'roles'), { recursive: true });
    mkdirSync(join(dir, 'overrides'));
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ version: 4, disabledProfiles: ['muse-reviewer'], harnesses: { 'pi-check': { model: 'test/model', thinking: 'off' } } }));
    writeFileSync(join(dir, 'roles', 'audit.md'), '---\ndescription: Audit\npermission: readonly\n---\nShared audit');
    writeFileSync(join(dir, 'overrides', 'grok-audit.md'), '---\ndescription: Grok audit\nbackend: grok\n---\nExact audit');
    writeFileSync(join(dir, 'overrides', 'claude-audit.md'), 'broken');
    writeFileSync(join(dir, 'overrides', 'pi-check-reviewer.md'), '---\ndescription: Wrong backend\nbackend: codex\n---\nWrong');
    const catalog = loadExternalCatalog(root);
    expect(() => resolveExternalProfile(catalog.profiles, { role: 'reviewer', harness: 'pi-check' }, 'agy', { configuredHarnessNames: new Set(['pi-check']), harnessConfigs: catalog.harnessConfigs })).toThrow(/does not match/);
    expect(catalog.profiles.get('grok-audit')?.systemPrompt).toBe('Exact audit');
    expect(catalog.profiles.get('muse-audit')?.systemPrompt).toBe('Shared audit');
    expect(() => resolveExternalProfile(catalog.profiles, { role: 'audit', harness: 'claude' }, 'agy')).toThrow(/invalid/i);
    expect(() => resolveExternalProfile(catalog.profiles, { subagentType: 'muse-reviewer' }, 'agy')).toThrow(/disabled/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('disables whole harnesses without deleting definitions, hiding them from discovery and rejecting every selector without fallback', () => {
  const root = mkdtempSync(join(tmpdir(), 'external-catalog-disabled-'));
  try {
    const dir = join(root, 'pi-flow-external');
    mkdirSync(join(dir, 'overrides'), { recursive: true });
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ version: 4, disabledHarnesses: ['codex', 'pi-check', 'opencode'], harnesses: { 'pi-check': { model: 'test/model', thinking: 'off' } } }));
    writeFileSync(join(dir, 'overrides', 'codex-custom.md'), '---\ndescription: Custom\nbackend: codex\n---\nExact');
    const catalog = loadExternalCatalog(root);
    const options = { configuredHarnessNames: new Set([...EXTERNAL_HARNESSES, 'pi-check']), harnessConfigs: catalog.harnessConfigs, disabledHarnesses: catalog.disabledHarnesses };
    expect(catalog.blocked).toBe(false);
    // Definitions stay; discovery hides every identity bound to a disabled harness.
    expect(catalog.profiles.has('codex-custom')).toBe(true);
    expect(externalRoleAvailability(catalog.profiles).get('reviewer')).toEqual(['agy', 'claude', 'grok', 'muse']);
    // Unknown disabled names are preserved with an actionable, non-blocking diagnostic.
    expect(catalog.disabledHarnesses.has('opencode')).toBe(true);
    expect(catalog.diagnostics.join(' ')).toMatch(/"opencode" is not a known harness.*kept/);
    for (const selection of [{ role: 'reviewer', harness: 'codex' }, { role: 'nonexistent', harness: 'codex' }, { subagentType: 'codex-reviewer' }, { subagentType: 'codex-custom' }, { role: 'reviewer', harness: 'pi-check' }, { subagentType: 'pi-check-reviewer' }]) {
      expect(() => resolveExternalProfile(catalog.profiles, selection, 'agy', options)).toThrow(/Harness "(codex|pi-check)" is disabled.*config enable/);
    }
    // A disabled default fails actionably instead of substituting another harness.
    expect(() => resolveExternalProfile(catalog.profiles, { role: 'reviewer' }, 'codex', options)).toThrow(/Default harness "codex" is disabled.*config default/);
    expect(resolveExternalProfile(catalog.profiles, { role: 'reviewer', harness: 'claude' }, 'codex', options).name).toBe('claude-reviewer');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
