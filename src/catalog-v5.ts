import { existsSync, readdirSync, readFileSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { parseFrontmatter } from '@earendil-works/pi-coding-agent';
import { DEFAULT_ROLES } from './default-roles.ts';
import { CONFIG_NAME, cliHarness, type BindingSettings } from './config-v5.ts';
import type { LoadedExternalSettings } from './settings.ts';
import { EXTERNAL_HARNESSES, type SubagentProfile } from './types.ts';
import type { HarnessConfig } from './harnesses.ts';

export function bindingKey(harness:string, role:string):string { return `${harness}/${role}`; }
function instructions(path:string): {description:string;systemPrompt:string} {
 if(!lstatSync(path).isFile())throw new Error('instructions must be a regular file');
 const {frontmatter,body}=parseFrontmatter<Record<string,unknown>>(readFileSync(path,'utf8'));
 if(typeof frontmatter.description!=='string'||!frontmatter.description.trim()||Object.keys(frontmatter).some(k=>k!=='description'))throw new Error('instruction metadata supports description only');
 return {description:frontmatter.description.trim(),systemPrompt:body.trim()};
}
export function loadV5Catalog(agentDir:string, loaded:LoadedExternalSettings) {
 const settings=loaded.settings, diagnostics=[...loaded.diagnostics];
 const profiles=new Map<string,SubagentProfile>();
 const harnessConfigs=new Map<string,HarnessConfig>(Object.entries(settings.harnesses??{}));
 const disabledHarnesses=new Set(settings.disabledHarnesses??[]);
 for(const [name,value] of Object.entries(settings.harnessSettings??{}))if(value.enabled===false)disabledHarnesses.add(name);
 if(loaded.blocked)return {profiles,diagnostics,blocked:true,harnessConfigs,disabledHarnesses};
 const roles=new Map<string,{description:string;systemPrompt?:string;source:string;configurationError?:string}>(Object.entries(DEFAULT_ROLES).map(([role,v])=>[role,{description:v.description,systemPrompt:v.body,source:'built-in'}]));
 const base=join(agentDir,'pi-flow-external');
 const roleDir=join(base,'roles');
 // Validate roots too: checking a leaf cannot detect a linked ancestor.
 for (const directory of [base, roleDir, join(base, 'overrides')]) {
  try {
   if (!lstatSync(directory).isDirectory()) throw new Error(`Invalid configuration directory ${directory}: must be a real directory, not a symbolic link.`);
  } catch (error) {
   if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
   diagnostics.push(String(error));
   return {profiles,diagnostics,blocked:true,harnessConfigs,disabledHarnesses};
  }
 }
 if(existsSync(roleDir))for(const file of readdirSync(roleDir)) {
  const name=file.endsWith('.md')?file.slice(0,-3):'';if(!CONFIG_NAME.test(name))continue;
  const path=join(roleDir,file);
  try{roles.set(name,{...instructions(path),source:path});}catch(e){const message=`Invalid role ${path}: ${String(e)}`;diagnostics.push(message);roles.set(name,{description:name,source:path,configurationError:message});}
 }
 const names=[...EXTERNAL_HARNESSES,...harnessConfigs.keys()];
 const invalidDirectories = new Set<string>();
 const localRoles = new Map<string, Map<string, typeof roles extends Map<string, infer V> ? V : never>>();
 for (const harness of names) {
  const dir = join(base, 'overrides', harness);
  if (!existsSync(dir)) continue;
  if (!lstatSync(dir).isDirectory() || lstatSync(dir).isSymbolicLink()) { diagnostics.push(`Invalid override directory ${dir}`); invalidDirectories.add(harness); continue; }
  const entries = new Map(roles);
  for (const file of readdirSync(dir)) {
   const role = file.endsWith('.md') ? file.slice(0, -3) : '';
   if (CONFIG_NAME.test(role) && !entries.has(role)) entries.set(role, {description:role, source:join(dir,file)});
  }
  localRoles.set(harness, entries);
 }
 // An instruction replacement may define a role on this harness only; a scalar gate cannot.
 for(const harness of names)for(const [role,definition] of localRoles.get(harness) ?? roles){
  const h=settings.harnessSettings?.[harness]??{};
  const patch=h.roles?.[role]??{};
  const origins:Record<string,string>={instructions:definition.source};
  const pick=<K extends keyof BindingSettings>(key:K):BindingSettings[K]=>{origins[key]=patch[key]!==undefined?`role ${role} on ${harness}`:h[key]!==undefined?`harness ${harness}`:'backend default';return patch[key]??h[key];};
  const model=pick('model'); const thinking=pick('thinking')??(cliHarness(harness)?'native':'off');
  const profile:SubagentProfile={...definition,name:bindingKey(harness,role),role,harness,backend:cliHarness(harness)?harness:'pi',configVersion:5,origins,model:model==='native'?undefined:model,thinking,tools:pick('tools'),maxBudgetUsd:pick('max_budget_usd'),...(cliHarness(harness)?{}:{preset:h.preset??'minimal'})};
  const labels: Record<string,string> = { agy:'Antigravity', claude:'Claude Code', codex:'Codex CLI', grok:'Grok CLI', muse:'Muse Code', opencode:'OpenCode' };
  profile.description=profile.description.replaceAll('${backendLabel}',labels[harness]??harness);
  const path=join(base,'overrides',harness,`${role}.md`);
  if(invalidDirectories.has(harness)) profile.configurationError = `Invalid override directory for ${harness}`;
  else if(existsSync(path))try{Object.assign(profile,instructions(path),{source:path});delete profile.configurationError;origins.instructions=path;}catch(e){profile.configurationError=`Invalid override ${path}: ${String(e)}`;diagnostics.push(profile.configurationError);}
  const blocks=[profile.configurationError,disabledHarnesses.has(harness)?`Harness "${harness}" is disabled. Use /external config harness enable ${harness}.`:undefined,settings.roles?.[role]?.enabled===false?`Role "${role}" is disabled. Use /external config role enable ${role}.`:undefined,patch.enabled===false||(!Object.hasOwn(settings.exact??{},`${harness}-${role}`)&&settings.disabledProfiles?.includes(`${harness}-${role}`))?`Binding "${harness}/${role}" is disabled. Use /external config role enable ${role} --harness ${harness}.`:undefined].filter(Boolean);
  if(harness==='opencode'&&thinking!=='native'&&!profile.model)blocks.push('OpenCode effort variant requires a pinned model');
  if(harness==='opencode'&&thinking!=='native'&&profile.model?.includes('#'))blocks.push('OpenCode model already has a #variant; do not also set effort');
  if(!cliHarness(harness)&&!profile.model)blocks.push('Pi requires a resolvable model');
  profile.configurationError=blocks.length?blocks.join('\n'):undefined;
  profiles.set(profile.name,profile);
 }
 for(const [name,entry] of Object.entries(settings.exact??{})){
  const {harness,description,instructions:body,...fields}=entry;
  profiles.set(name,{name,harness,backend:cliHarness(harness)?harness:'pi',configVersion:5,description,systemPrompt:body,model:fields.model==='native'?undefined:fields.model,thinking:fields.thinking??(cliHarness(harness)?'native':'off'),tools:fields.tools,maxBudgetUsd:fields.max_budget_usd,...(!cliHarness(harness)?{preset:settings.harnesses?.[harness]?.preset??'minimal'}:{}),...(fields.enabled===false||disabledHarnesses.has(harness)||settings.disabledProfiles?.includes(name)?{configurationError:`Exact selector ${name} is disabled`}:{}),...(!names.includes(harness as never)?{configurationError:`Harness ${harness} is not registered`}:{})});
 }
 for (const profile of profiles.values()) {
  if (profile.backend === 'pi' && !profile.model) profile.configurationError ??= 'Pi exact selection requires a resolvable model';
  if (profile.backend === 'opencode' && profile.thinking !== 'native' && (!profile.model || profile.model.includes('#'))) profile.configurationError ??= 'OpenCode effort requires a pinned model without an existing #variant';
 }
 return {profiles,diagnostics,blocked:false,harnessConfigs,disabledHarnesses};
}
