import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { loadExternalCatalog, resolveExternalProfile, externalRoleAvailability } from '../src/profiles.ts';
import { parseSettings } from '../src/settings.ts';
import { EXTERNAL_HARNESSES } from '../src/types.ts';
const roots: string[] = [];
function fixture(settings: object, files: Record<string,string> = {}) {
 const root=mkdtempSync(join(tmpdir(),'external-v5-')); roots.push(root);
 const base=join(root,'pi-flow-external'); mkdirSync(base);
 writeFileSync(join(base,'settings.json'),JSON.stringify({version:5,...settings}));
 for(const [path,body] of Object.entries(files)){const target=join(base,path);mkdirSync(join(target,'..'),{recursive:true});writeFileSync(target,body);}
 return loadExternalCatalog(root);
}
function select(c:ReturnType<typeof loadExternalCatalog>,role:string,harness:string) {return resolveExternalProfile(c.profiles,{role,harness},'agy',{configuredHarnessNames:new Set([...EXTERNAL_HARNESSES,...c.harnessConfigs.keys()]),harnessConfigs:c.harnessConfigs,disabledHarnesses:c.disabledHarnesses});}
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
it('blocks v4 runtime until explicit conversion without rewriting it',()=>{
 const c=fixture({version:4});
 expect(c.blocked).toBe(true);
 expect(c.diagnostics.join(' ')).toMatch(/convert/);
});
it('inherits CLI defaults for present and future roles without copying instructions and allows sparse Pi exceptions',()=>{
 const c=fixture({harnesses:{codex:{model:'gpt-example',thinking:'high',roles:{reviewer:{thinking:'xhigh'}}},'pi-check':{model:'p/base',thinking:'low',roles:{reviewer:{model:'p/review',thinking:'high'}}}}},{'roles/audit.md':'---\ndescription: Audit\n---\nAudit now'});
 expect(c.blocked).toBe(false);
 expect(select(c,'audit','codex')).toMatchObject({backend:'codex',model:'gpt-example',thinking:'high',systemPrompt:'Audit now'});
 expect(select(c,'reviewer','codex')).toMatchObject({thinking:'xhigh'});
 expect(select(c,'reviewer','pi-check')).toMatchObject({backend:'pi',model:'p/review',thinking:'high'});
});
it('combines harness role and binding gates and filters all blocked selections from discovery',()=>{
 const c=fixture({roles:{reviewer:{enabled:false}},harnesses:{codex:{enabled:false},muse:{roles:{worker:{enabled:false}}}}});
 expect(()=>select(c,'worker','codex')).toThrow(/disabled/i);
 expect(()=>select(c,'reviewer','claude')).toThrow(/role.*disabled/i);
 expect(()=>select(c,'worker','muse')).toThrow(/disabled/i);
 expect(externalRoleAvailability(c.profiles).has('reviewer')).toBe(false);
});
it('keeps hyphenated binding pairs distinct and rejects ambiguous legacy selectors',()=>{
 const c=fixture({harnesses:{'pi-deep':{model:'p/one'},'pi-deep-seek':{model:'p/two'}}},{'roles/seek-reviewer.md':'---\ndescription: Alternate\n---\nAlternate','overrides/pi-deep/seek-reviewer.md':'---\ndescription: Specific\n---\nSpecific'});
 expect(select(c,'seek-reviewer','pi-deep')).toMatchObject({model:'p/one',systemPrompt:'Specific'});
 expect(select(c,'reviewer','pi-deep-seek')).toMatchObject({model:'p/two'});
 expect(()=>resolveExternalProfile(c.profiles,{subagentType:'pi-deep-seek-reviewer'},'agy',{harnessConfigs:c.harnessConfigs})).toThrow(/ambiguous/i);
});
it('preserves explicit exact selection and exclusions while keeping structured bindings independent',()=>{
 const c=fixture({disabledProfiles:['codex-reviewer'],exact:{'codex-reviewer':{harness:'claude',description:'Legacy',instructions:'legacy'}}});
 expect(c.profiles.get('codex-reviewer')?.configurationError).toMatch(/disabled/);
 expect(c.profiles.get('codex/reviewer')?.configurationError).toBeUndefined();
 expect(()=>resolveExternalProfile(c.profiles,{subagentType:'codex-reviewer'},'agy')).toThrow(/disabled/);
 expect(select(c,'reviewer','codex').backend).toBe('codex');
});
it('uses identical validity gates for exact records and rejects invalid OpenCode variants',()=>{
 const c=fixture({disabledProfiles:['special'],exact:{special:{harness:'codex',description:'Exact',instructions:'x'},bad:{harness:'opencode',description:'Bad',instructions:'x',thinking:'high'}}});
 expect(c.profiles.get('special')?.configurationError).toMatch(/disabled/);
 expect(c.profiles.get('bad')?.configurationError).toMatch(/model/);
 const broken=fixture({harnesses:{opencode:{model:'a/b#x',thinking:'high'}}});
 expect(broken.profiles.get('opencode/reviewer')?.configurationError).toMatch(/variant|#/);
});
it('lets a valid instruction replacement supersede invalid shared instructions and rejects linked directories',()=>{
 const c=fixture({}, {'roles/reviewer.md':'bad','overrides/codex/reviewer.md':'---\ndescription: Valid\n---\n'});
 expect(select(c,'reviewer','codex').systemPrompt).toBe('');
 const root=roots[roots.length-1]!;const base=join(root,'pi-flow-external');
 symlinkSync(join(base,'overrides','codex'),join(base,'overrides','claude'));
 const linked=loadExternalCatalog(root);
 expect(linked.profiles.get('claude/reviewer')?.configurationError).toMatch(/directory/);
});
it('fails closed on linked instruction roots without reading their contents',()=>{
 for(const directory of ['roles','overrides','pi-flow-external']) {
  fixture({}); const root=roots.at(-1)!; const outside=join(root,'outside');mkdirSync(outside);
  const target=directory==='pi-flow-external'?join(root,directory):join(root,'pi-flow-external',directory);
  if(directory==='pi-flow-external')rmSync(target,{recursive:true});
  mkdirSync(join(outside,'codex'));writeFileSync(join(outside,'injected.md'),'---\ndescription: Injected\n---\nOutside');
  writeFileSync(join(outside,'codex','reviewer.md'),'---\ndescription: Injected\n---\nOutside');
  writeFileSync(join(outside,'settings.json'),'{"version":5}');
  symlinkSync(outside,target);
  const c=loadExternalCatalog(root);
  expect(c.blocked,directory).toBe(true);expect(c.profiles.size).toBe(0);expect(c.diagnostics.join(' ')).toMatch(/directory|symbolic link/);
 }
});
it('rejects malformed execution fields instead of falling back',()=>{
 expect(parseSettings({version:5,harnesses:{codex:{model:'valid',thinking:'high'}}}).diagnostics).toEqual([]);
 for(const patch of [{model:123},{thinking:false},{thinking:'hgh'},{enabled:'false'},{tools:['read']},{max_budget_usd:4}]) {
  expect(parseSettings({version:5,harnesses:{codex:patch}}).diagnostics.length).toBeGreaterThan(0);
 }
});
