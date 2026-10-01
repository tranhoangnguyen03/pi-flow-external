import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

export type ModelChoice = { id:string; name:string };
function readable(id:string):string {
  return id.split('/').pop()!.replace(/[-_]/g,' ').replace(/\b\w/g,s=>s.toUpperCase()).replace(/\bGpt\b/g,'GPT');
}
/** Parse only known listing shapes; error/progress lines are never selectable models. */
export function parseCliModels(backend:string,text:string):ModelChoice[] {
  if(backend==='codex'){
    try {
      const data=JSON.parse(text);
      return Array.isArray(data.models)?data.models.filter((m:any)=>typeof m.slug==='string'&&m.visibility==='list').map((m:any)=>({id:m.slug,name:typeof m.display_name==='string'?m.display_name:readable(m.slug)})):[];
    }catch{return [];}
  }
  const choices:ModelChoice[]=[];
  for(const line of text.split('\n')){
    if(backend==='agy'){
      const match=/^([\w.-]+)\t(.+)$/.exec(line);if(match)choices.push({id:match[1]!,name:match[2]!.trim()});
    }else if(backend==='grok'){
      const match=/^\s*\*?\s*(grok-[\w.-]+)(?:\s+\(default\))?\s*$/.exec(line);if(match)choices.push({id:match[1]!,name:readable(match[1]!)});
    }else if(backend==='opencode'&&/^[\w.-]+\/[^\s]+$/.test(line.trim()))choices.push({id:line.trim(),name:readable(line.trim())});
  }
  return [...new Map(choices.map(m=>[m.id,m])).values()];
}
export async function cliModelChoices(pi:Pick<ExtensionAPI,'exec'>,backend:string,signal?:AbortSignal):Promise<{models:ModelChoice[];note:string}> {
  if(backend==='claude')return {models:[{id:'sonnet',name:'Claude Sonnet (latest alias)'},{id:'opus',name:'Claude Opus (latest alias)'},{id:'fable',name:'Claude Fable (latest alias)'}],note:'Claude aliases; the CLI resolves the version and checks account access when you run.'};
  if(backend==='codex'){
    try {return {models:parseCliModels(backend,readFileSync(join(process.env.CODEX_HOME??join(homedir(),'.codex'),'models_cache.json'),'utf8')),note:'From Codex’s local model catalog; it may be stale. No request was sent.'};}
    catch{return {models:[],note:'Codex has no readable local model catalog yet. Open Codex once to populate it, or use a custom ID.'};}
  }
  if(!['agy','grok','opencode'].includes(backend))return {models:[],note:'This CLI does not expose a model listing. Your current and previously configured IDs are offered below.'};
  try {
    const result=await pi.exec(backend,['models',...(backend==='opencode'?['--standalone']:[])],{timeout:10000,signal});
    return {models:result.code===0&&!result.killed?parseCliModels(backend,result.stdout):[],note:result.code===0&&!result.killed?'Listed by the CLI; no prompt was sent. Model access is checked on the next run.':`Could not list models: ${(result.stderr||result.stdout||'CLI unavailable').trim()}. No prompt was sent.`};
  }catch(error){return {models:[],note:`Could not list models: ${String(error)}. No prompt was sent.`};}
}
