import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it, expect } from 'vitest';
import { loadExternalCatalog, resolveExternalProfile } from '../src/profiles.ts';

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
