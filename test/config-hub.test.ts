import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { openConfigHub } from '../src/config-hub.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, {recursive:true,force:true}); });
function fixture(record: unknown = {version:5}) {
 const dir = mkdtempSync(join(tmpdir(),'config-hub-')); roots.push(dir); mkdirSync(join(dir,'pi-flow-external'));
 const path=join(dir,'pi-flow-external/settings.json'); writeFileSync(path,JSON.stringify(record));
 return {dir,path};
}
function harness(dir:string, actions:(string|undefined)[], inputs:(string|undefined)[]=[], confirmations:boolean[]=[]) {
 const exec=vi.fn(); const paid=vi.fn(); const screens:{title:string;options:string[]}[]=[];
 const ui={ select:async(title:string,options:string[])=>{screens.push({title,options});const value=actions.shift(); if(value===undefined)return undefined; const match=options.find(o=>o===value || o.startsWith(value+' ·')); if(!match) throw new Error(`No ${value} in ${title}: ${options}`);return match;},input:async()=>inputs.shift(),editor:async()=>inputs.shift(),confirm:vi.fn(async()=>confirmations.shift()??false),notify:vi.fn() };
 const ctx={cwd:dir,hasUI:true,mode:'rpc',isProjectTrusted:()=>false,ui,modelRegistry:{getAll:vi.fn(()=>[]),find:vi.fn(),hasConfiguredAuth:vi.fn()}};
 return {exec,paid,screens,ctx,options:{agentDir:dir,getThinkingLevel:()=> 'high',testHarness:paid,runCommand:vi.fn()}};
}
it('opens and closes without probing, writing, or listing models', async()=>{
 const {dir,path}=fixture();const before=readFileSync(path,'utf8'); const h=harness(dir,[undefined]);
 await openConfigHub({exec:h.exec} as never,h.ctx as never,h.options);
 expect(readFileSync(path,'utf8')).toBe(before);expect(h.exec).not.toHaveBeenCalled();expect(h.paid).not.toHaveBeenCalled();expect(h.ctx.modelRegistry.getAll).not.toHaveBeenCalled();
 expect(h.screens[0]!.options.some(o=>o.startsWith('Codex CLI'))).toBe(true);
});
it('changes reasoning and returns one role to inheritance without clearing its off gate', async()=>{
 const {dir,path}=fixture({version:5,harnesses:{codex:{thinking:'high',roles:{reviewer:{thinking:'low',enabled:false}}}}});
 const h=harness(dir,['Codex CLI','Reasoning','Medium','Role customizations…','reviewer','Reasoning','Same as Codex CLI','Back','Back','Back','Close']);
 await openConfigHub({exec:h.exec} as never,h.ctx as never,h.options);
 expect(JSON.parse(readFileSync(path,'utf8')).harnesses.codex).toEqual({thinking:'medium',roles:{reviewer:{enabled:false}}});
});
it('saves a scoped instruction replacement without changing shared text and cancellation preserves it',async()=>{
 const {dir}=fixture(); const base=join(dir,'pi-flow-external');mkdirSync(join(base,'roles'));writeFileSync(join(base,'roles/audit.md'),'---\ndescription: Audit\n---\nShared body');
 const h=harness(dir,['Codex CLI','Role customizations…','audit','Instructions','Customize for this agent…','Instructions','Use shared instructions','Back','Back','Back','Close'],['','Scoped body'],[false]);
 await openConfigHub({exec:h.exec} as never,h.ctx as never,h.options);
 expect(readFileSync(join(base,'roles/audit.md'),'utf8')).toContain('Shared body');expect(readFileSync(join(base,'overrides/codex/audit.md'),'utf8')).toContain('Scoped body');expect(h.ctx.ui.confirm).toHaveBeenCalledOnce();
});
it('registers a Pi agent only on Create and setup checking never invokes its paid handler',async()=>{
 const {dir,path}=fixture();const h=harness(dir,['Add a Pi agent…','test','model','Create agent','Check model and credentials…','Back','Close'],['manual']);
 h.ctx.modelRegistry.getAll.mockReturnValue([{provider:'test',id:'model'}] as never);h.ctx.modelRegistry.find.mockReturnValue({provider:'test',id:'model'} as never);h.ctx.modelRegistry.hasConfiguredAuth.mockReturnValue(true as never);
 await openConfigHub({exec:h.exec} as never,h.ctx as never,h.options);
 expect(JSON.parse(readFileSync(path,'utf8')).harnesses['pi-manual']).toEqual({model:'test/model',thinking:'off',preset:'minimal',owner:'user'});expect(h.paid).not.toHaveBeenCalled();expect(h.exec).not.toHaveBeenCalled();
});
it('restores broken instructions through a raw-text preview and labels parent reasoning as a policy',async()=>{
 const {dir}=fixture({version:5,harnesses:{codex:{roles:{reviewer:{thinking:'parent'}}}}});const base=join(dir,'pi-flow-external');mkdirSync(join(base,'roles'));const file=join(base,'roles/reviewer.md');writeFileSync(file,'---\nmodel: bad\n---\nBroken body');
 const h=harness(dir,['Roles…','reviewer','Restore original instructions…','Back','Back','Codex CLI','Role customizations…','reviewer','Back','Back','Back','Close'],[],[true]);
 await openConfigHub({exec:h.exec} as never,h.ctx as never,h.options);
 expect(existsSync(file)).toBe(false);expect(h.screens.some(s=>s.options.some(o=>o==='Reasoning · Match my Pi session (high)'))).toBe(true);
});
it('does not offer conversion for future settings or execute under fallback values',async()=>{
 const {dir,path}=fixture({version:6});const h=harness(dir,['Close']);await openConfigHub({exec:h.exec} as never,h.ctx as never,h.options);
 expect(h.screens[0]!.options).not.toContain('Preview format update…');expect(JSON.parse(readFileSync(path,'utf8')).version).toBe(6);expect(h.exec).not.toHaveBeenCalled();
});
it('offers named CLI models and stores the backend identifier, with current value visible',async()=>{
 const {dir,path}=fixture({version:5,harnesses:{claude:{model:'sonnet'}}});const h=harness(dir,['Claude Code','Model','Claude Opus (latest alias)','Back','Close']);
 // Match the full row after loading its backend-specific named list.
 const select=h.ctx.ui.select;
 h.ctx.ui.select=async(title,choices)=>{const normalized=choices.map(c=>c.startsWith('Claude Opus (latest alias) ·')?'Claude Opus (latest alias)':c);const choice=await select(title,normalized);return choice==='Claude Opus (latest alias)'?choices.find(c=>c.startsWith(choice+' ·')):choice;};
 await openConfigHub({exec:h.exec} as never,h.ctx as never,h.options);
 expect(JSON.parse(readFileSync(path,'utf8')).harnesses.claude.model).toBe('opus');expect(h.screens.some(s=>s.title.includes('Current: Claude Sonnet (latest alias) (sonnet)'))).toBe(true);expect(h.exec).not.toHaveBeenCalled();
});
it('cancels Pi creation without writes or requests and refuses fallback screens for invalid settings',async()=>{
 const {dir,path}=fixture();const h=harness(dir,['Add a Pi agent…',undefined,'Close']);
 await openConfigHub({exec:h.exec} as never,h.ctx as never,h.options);
 expect(JSON.parse(readFileSync(path,'utf8'))).toEqual({version:5});expect(h.paid).not.toHaveBeenCalled();
 writeFileSync(path,'{broken');const broken=harness(dir,['Close']);
 await openConfigHub({exec:broken.exec} as never,broken.ctx as never,broken.options);
 expect(broken.screens[0]!.options).not.toContain('Codex CLI');expect(readFileSync(path,'utf8')).toBe('{broken');
});
