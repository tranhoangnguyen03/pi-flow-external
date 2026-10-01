import { getAgentDir, type ExtensionAPI, type ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { bindingKey } from './catalog-v5.ts';
import { CONFIG_NAME, cliHarness, reasoningLevels } from './config-v5.ts';
import { loadExternalCatalog } from './profiles.ts';
import { loadExternalSettings, resolveCtxDefaultHarness } from './settings.ts';
import { roleDefinition } from './default-roles.ts';
import { BACKEND_LABELS } from './defaults.ts';
import { planV5Upgrade } from './config-v5-upgrade.ts';
import { planConfigUpgrade } from './config-upgrade.ts';
import { diagnoseCli } from './doctor.ts';
import {
  applyRoleReset, compileInstructionMarkdown, createPiHarness, createRole,
  harnessDisabled, mutateV5, overrideFile, parseInstructionMarkdown, planRoleReset,
  readInstructionText, registeredHarnesses, remainingGates, resetHarnessFields,
  roleFile, roleInventory, setBindingFields, setDefaultHarness, setHarnessEnabled,
  setHarnessFields, setRoleEnabled, writeInstructions,
} from './config-lifecycle.ts';
import type { ExternalSettings } from './settings.ts';
import type { BindingField, HarnessField } from './config-lifecycle.ts';
import { cliModelChoices } from './config-models.ts';
import { withConfigModal } from './config-modal.ts';

export type ConfigHubOptions = {
  agentDir?: string;
  getThinkingLevel?: () => string | undefined;
  testHarness?: (ctx:ExtensionCommandContext,name:string,signal?:AbortSignal)=>Promise<{ok:true;detail?:string}|{ok:false;error:string}>;
  runCommand: (args:string,ctx:ExtensionCommandContext)=>Promise<void>;
};
export function agentLabel(name:string):string {return BACKEND_LABELS[name]??`Pi · ${name.replace(/^pi-/,'')}`;}
function valueLabel(value:string|undefined,agent:string,session?:string):string {
  return value===undefined||value==='native'?`Uses ${agentLabel(agent)} settings`:value==='parent'?`Match my Pi session (${session??'unknown'})`:value.charAt(0).toUpperCase()+value.slice(1);
}
const BACK='Back';
const quote=(s:string)=>JSON.stringify(s);

/** Menus are native dialogs in RPC, and share one focused overlay in the TUI. */
export async function openConfigHub(pi:Pick<ExtensionAPI,'exec'>,ctx:ExtensionCommandContext,options:ConfigHubOptions):Promise<void> {
  if(!ctx.hasUI){ctx.ui.notify('Use /external help for configuration commands.','info');return;}
  await withConfigModal(ctx,async(ctx,show,busy)=>{
    const dir=options.agentDir??getAgentDir();
    const settings=()=>loadExternalSettings(dir).settings;
    const snapshot=()=>loadExternalCatalog(dir);
    const effectiveDefault=()=>resolveCtxDefaultHarness(settings().defaultHarness,ctx);
    const command=async(args:string)=>{
      const messages:string[]=[];
      await options.runCommand(args,Object.create(ctx,{ui:{value:Object.create(ctx.ui,{notify:{value:(text:string)=>{messages.push(text);},enumerable:true}}),enumerable:true}}));
      if(messages.length)await show('Result',messages.join('\n\n'));
    };
    const select=async(title:string,choices:string[])=>{
      const loaded=loadExternalSettings(dir);
      if(loaded.blocked||loaded.settings.version!==5){await show('Settings changed','The settings file now needs attention. Returning to the recovery screen.');return undefined;}
      const chosen=await ctx.ui.select(title,[...choices,BACK]);return chosen===BACK?undefined:chosen;
    };
    const saved=(message='Saved · applies to future calls.')=>ctx.ui.notify(message,'info');
    const attempt=async(action:()=>void|Promise<void>)=>{
      try{await action();}catch(error){await show('Could not complete this change',`${error instanceof Error?error.message:String(error)}`);}
    };
    const modelNames=new Map<string,string>();
    const profile=(name:string,role:string)=>snapshot().profiles.get(bindingKey(name,role));
    const inherited=(name:string,field:'model'|'effort')=>{
      const entry=settings().harnessSettings?.[name];
      return field==='model'?(entry?.model&&entry.model!=='native'?(modelNames.get(`${name}/${entry.model}`)??entry.model):`Agent default`):valueLabel(entry?.thinking??(cliHarness(name)?'native':'off'),name,options.getThinkingLevel?.());
    };
    const resetRoleField=async(role:string,name:string|undefined,field:BindingField|'instructions')=>{
      const plan=planRoleReset(dir,role,name,[field]);
      if(plan.files.length){
        const current=readInstructionText(plan.files[0]!);
        let preview=current??'';
        try{if(current)preview=parseInstructionMarkdown(current).body;}catch{/* Raw malformed text is still removable after a safe preview. */}
        if(!await ctx.ui.confirm('Remove customized instructions?',`${preview}\n\nUses ${name?'shared role':'original built-in'} instructions afterwards. Enabled state stays unchanged.`))return;
      }
      if(!plan.files.length&&!plan.settingsFields.length){ctx.ui.notify('Already uses the inherited values.','info');return;}
      const result=applyRoleReset(dir,plan);
      if(result.failed.length)throw new Error(result.failed.map(f=>`${f.path}: ${f.reason}`).join('\n'));
      saved();
    };
    const modelName=(id:string|undefined,name:string)=>{
      if(!id||id==='native')return `Use ${agentLabel(name)} settings`;
      if(!cliHarness(name)){const split=id.indexOf('/');const model=ctx.modelRegistry.find(id.slice(0,split),id.slice(split+1));return model?.name?`${model.name} (${id})`:id;}
      const label=modelNames.get(`${name}/${id}`);return label?`${label} (${id})`:id;
    };
    const pickModel=async(current?:string):Promise<string|undefined>=>{
      const models=ctx.modelRegistry.getAll();
      const available=models.filter(m=>ctx.modelRegistry.hasConfiguredAuth(m));
      let visible=available.length?available:models;
      let providers=[...new Set(visible.map(m=>m.provider))].sort();
      if(!providers.length){await show('No Pi models available','Configure a model/provider in Pi first, then reopen this picker. No provider request was made.');return;}
      let provider=await select('Choose a model provider\nModels from configured accounts are shown first.',[...providers,...(available.length&&available.length<models.length?['Show all providers…']:[])]);if(!provider)return;
      if(provider==='Show all providers…'){visible=models;providers=[...new Set(models.map(m=>m.provider))].sort();provider=await select('All model providers',providers);if(!provider)return;}
      const candidates=visible.filter(m=>m.provider===provider);
      const choices=candidates.map(m=>`${m.name||m.id} · ${m.id}${`${m.provider}/${m.id}`===current?' · Current':''} · ${ctx.modelRegistry.hasConfiguredAuth(m)?'Account configured':'Account not configured'}`);
      const choice=await select(`Models › ${provider}`,choices);if(!choice)return;
      return `${provider}/${candidates[choices.indexOf(choice)]!.id}`;
    };
    const changeField=async(name:string,field:'model'|'effort',role?:string)=>{
      const scope=role?`${role} on ${agentLabel(name)}`:agentLabel(name);
      const inherit=`Same as ${agentLabel(name)}`;
      const native=`Use ${agentLabel(name)} settings`;
      const local=role?settings().harnessSettings?.[name]?.roles?.[role]:settings().harnessSettings?.[name];
      const current=field==='model'?(role?profile(name,role)?.model:local?.model):(role?profile(name,role)?.thinking:local?.thinking??(cliHarness(name)?'native':'off'));
      let summary=field==='model'?modelName(current,name):valueLabel(current,name,options.getThinkingLevel?.());
      const choices=[...(role?[`${inherit} · ${inherited(name,field)}${local?.[field==='model'?'model':'thinking']===undefined?' · Current':''}`]:[]),...(cliHarness(name)?[`${native}${current===undefined||current==='native'?' · Current':''}`]:[])];
      const listed=new Map<string,string>();
      let note='';
      if(field==='model'&&cliHarness(name)){
        const catalog=await busy(`Loading ${agentLabel(name)} models — Esc cancels`,signal=>cliModelChoices(pi,name,signal));note=catalog.note;
        for(const model of catalog.models)modelNames.set(`${name}/${model.id}`,model.name);
        summary=modelName(current,name);
        const models=new Map(catalog.models.map(m=>[m.id,m.name]));
        if(current&&current!=='native'&&!models.has(current))models.set(current,current);
        for(const patch of [settings().harnessSettings?.[name],...Object.values(settings().harnessSettings?.[name]?.roles??{})])if(patch?.model&&patch.model!=='native'&&!models.has(patch.model))models.set(patch.model,patch.model);
        for(const [id,label] of models){const row=`${label} · ${id}${id===current?' · Current':''}`;choices.push(row);listed.set(row,id);}
        choices.push('Enter a custom model ID…','About this model list');
      }else if(field==='model')choices.push('Choose a Pi model…');
      else choices.push(...(name==='opencode'?['Enter model variant…']:[`Match my Pi session (currently ${options.getThinkingLevel?.()??'unknown'})${current==='parent'?' · Current':''}`,...reasoningLevels(name).filter(v=>name==='agy'?['low','medium','high'].includes(v):name==='grok'?['low','medium','high','xhigh'].includes(v):true).map(v=>`${v==='xhigh'?'Extra high':valueLabel(v,name)}${v===current?' · Current':''}`)]));
      const chosen=await select(`${scope} › ${field==='model'?'Model':'Reasoning'}\nCurrent: ${summary}${field==='model'&&cliHarness(name)?'\nListed names are not a guarantee of account access. / searches the list.':''}`,choices);if(!chosen)return;
      if(chosen==='About this model list'){await show('Model list',note);return changeField(name,field,role);}
      if(chosen.startsWith(inherit+' ·')){await resetRoleField(role!,name,field);return;}
      let value:string|undefined;
      if(listed.has(chosen))value=listed.get(chosen);
      else if(chosen.startsWith(native))value='native';
      else if(chosen==='Choose a Pi model…')value=await pickModel(current);
      else if(chosen.startsWith('Match my Pi session'))value='parent';
      else if(chosen==='Enter a custom model ID…'||chosen==='Enter model variant…')value=(await ctx.ui.input(field==='model'?'Model ID — checked by the CLI on the next run':'OpenCode variant — requires a pinned model',field==='model'&&name==='opencode'?'provider/model':'Exact identifier'))?.trim();
      else {const level=chosen.split(' · ')[0]!;value=level==='Extra high'?'xhigh':level.toLowerCase();}
      if(!value)return;
      if(role)setBindingFields(dir,role,name,{[field]:value});
      else if(value==='native')resetHarnessFields(dir,name,[field]);
      else setHarnessFields(dir,name,{[field]:value});
      const exceptions=Object.values(settings().harnessSettings?.[name]?.roles??{}).filter(p=>p[field==='model'?'model':'thinking']!==undefined).length;
      saved(role?`Saved ${field==='model'?'model':'reasoning'} for ${role} on ${agentLabel(name)} only.`:`Saved ${field==='model'?'model':'reasoning'} for ${agentLabel(name)}. Used by roles without their own setting${exceptions?` (${exceptions} exceptions)`:''}.`);
    };
    const editInstructions=async(role:string,name?:string)=>{
      const path=name?overrideFile(dir,name,role):roleFile(dir,role);
      const text=readInstructionText(path);
      const original=roleDefinition(role);
      const p=name?profile(name,role):undefined;
      let parsed: ReturnType<typeof parseInstructionMarkdown> | undefined;
      if(text!==undefined){
        try { parsed=parseInstructionMarkdown(text); }
        catch {
          const repaired=await ctx.ui.editor('Repair instruction file — description metadata required',text);
          if(repaired!==undefined){writeInstructions(dir,role,repaired,name);saved();}
          return;
        }
      }
      const current=parsed??{description:p?.description??original?.description??role,body:p?.systemPrompt??original?.body??''};
      const description=await ctx.ui.input(`${role} › Description (current: ${current.description})`,'Leave blank to keep current description');
      if(description===undefined)return;
      const body=await ctx.ui.editor(`${role}${name?` on ${agentLabel(name)} — replaces shared instructions`:''} › Instructions`,current.body);
      if(body===undefined)return;
      if(!body.trim()&&!await ctx.ui.confirm('Save empty instructions?','No role instructions will be sent for this scope.'))return;
      writeInstructions(dir,role,compileInstructionMarkdown(description.trim()||current.description,body),name);saved();
    };
    const createRoleFlow=async()=>{
      const name=(await ctx.ui.input('New role name','lowercase-letters-and-hyphens'))?.trim();if(!name)return;
      if(!CONFIG_NAME.test(name))throw new Error('Use lowercase letters, numbers and hyphens for the role name.');
      if(roleInventory(dir,settings()).has(name))throw new Error(`The role ${name} already exists. Select it under Roles to customize it.`);
      const description=(await ctx.ui.input('Short description','When should this role be selected?'))?.trim();if(!description)return;
      const body=await ctx.ui.editor('Role instructions','');if(body===undefined)return;
      if(!body.trim()&&!await ctx.ui.confirm('Create with empty instructions?','This role sends no role instructions.'))return;
      createRole(dir,name,compileInstructionMarkdown(description,body));saved();
    };
    const createPiFlow=async()=>{
      let model=await pickModel();if(!model)return;
      const label=(await ctx.ui.input('Name this Pi agent','e.g. fast or review (lowercase letters, numbers, hyphens)'))?.trim();if(!label)return;
      const name=label.startsWith('pi-')?label:`pi-${label}`;
      if(!CONFIG_NAME.test(name)||!/^pi-[a-z0-9][a-z0-9-]*$/.test(name))throw new Error('Use lowercase letters, numbers and hyphens for the agent name.');
      if(registeredHarnesses(settings()).includes(name))throw new Error(`An agent named ${label} already exists.`);
      let effort='off',preset='minimal';
      while(true){
        const choice=await select(`Review new agent › ${agentLabel(name)}\nModel: ${modelName(model,name)}\nUses your Pi provider account. Curated tools, not an OS sandbox. Nothing is saved until Create agent.`,['Create agent',`Model · ${model}`,`Reasoning · ${valueLabel(effort,name,options.getThinkingLevel?.())}`,`Skills · ${preset==='minimal'?'Not loaded':'Installed skills'}`]);
        if(!choice)return;
        if(choice.startsWith('Model ·')){const selected=await pickModel(model);if(selected)model=selected;}
        else if(choice.startsWith('Reasoning ·')){const value=await select('Reasoning',[...reasoningLevels(name).map(v=>v==='xhigh'?'Extra high':valueLabel(v,name)),'Match my Pi session']);if(value)effort=value==='Match my Pi session'?'parent':value==='Extra high'?'xhigh':value.toLowerCase();}
        else if(choice.startsWith('Skills ·')){const value=await select('Skills',['No skills (recommended)','Installed skills (project skills only when trusted)']);if(value)preset=value.startsWith('No')?'minimal':'skills';}
        else {
          createPiHarness(dir,name,{model,thinking:effort,preset});saved();
          await agentMenu(name);return;
        }
      }
    };
    const checkSetup=async(name:string)=>{
      if(cliHarness(name)){await show(`${agentLabel(name)} › Setup check`,`${await diagnoseCli(pi.exec.bind(pi),name)}\n\nNo model request. Installation and reported sign-in do not prove model access.`);return;}
      const id=settings().harnessSettings?.[name]?.model??'';const separator=id.indexOf('/');
      const model=ctx.modelRegistry.find(id.slice(0,separator),id.slice(separator+1));
      await show(`${agentLabel(name)} › Setup check`,model?`${id}\n${ctx.modelRegistry.hasConfiguredAuth(model)?'Credentials configured':'No credentials configured'}\n\nNo model request; account access was not tested.`:`Model ${id} is not available in Pi's registry. Configure it in Pi or choose another model. No request made.`);
    };
    const blockers=async(name:string,role:string)=>{
      while(true){
        const s=settings();const p=profile(name,role);const gates=remainingGates(s,{harness:name,role});
        const fixes=[...(harnessDisabled(s,name)?[`Turn on ${agentLabel(name)}`]:[]),...(s.roles?.[role]?.enabled===false?[`Turn on ${role} everywhere`]:[]),...(s.harnessSettings?.[name]?.roles?.[role]?.enabled===false||(!s.exact?.[`${name}-${role}`]&&s.disabledProfiles?.includes(`${name}-${role}`))?[`Turn on ${role} for ${agentLabel(name)} only`]:[])];
        const choice=await select(`${role} on ${agentLabel(name)} · ${p?.configurationError?'Unavailable':'Available'}`,['Show all reasons',...fixes]);
        if(!choice)return;
        await attempt(async()=>{
          if(choice==='Show all reasons')await show('Reasons',p?.configurationError??(gates.join('\n')||'Available'));
          else {
            if(choice===`Turn on ${agentLabel(name)}`)setHarnessEnabled(dir,name,true,effectiveDefault());
            else setRoleEnabled(dir,role,true,choice.endsWith(' only')?name:undefined);
            const remaining=profile(name,role)?.configurationError;
            await show('Availability updated',remaining?`Still unavailable:\n${remaining}`:'Available');
          }
        });
      }
    };
    const bindingAdvanced=async(name:string,role:string)=>{
      while(true){const p=profile(name,role);const cap=p?.maxBudgetUsd??settings().defaultMaxBudgetUsd;
      const choice=await select(`${role} on ${agentLabel(name)} › Advanced`,[`Spending cap · ${cap==null?'Unlimited':`$${cap}`}`, ...(!cliHarness(name)?[`Allowed tools · ${p?.tools?.join(', ')??'Determined by call access'}`]:[]),'Details','Restore these role customizations…']);if(!choice)return;
        await attempt(async()=>{
          if(choice==='Details')await command(`config role inspect ${quote(role)} --harness ${quote(name)}`);
          else if(choice==='Restore these role customizations…')await command(`config role reset ${quote(role)} --harness ${quote(name)}`);
          else {
            const field=choice.startsWith('Spending cap ·')?'budget':'tools';
            const defaultValue=field==='budget'?(settings().defaultMaxBudgetUsd==null?'Unlimited':`$${settings().defaultMaxBudgetUsd}`):'Determined by call access';
            const action=await select(choice,[`Use default · ${defaultValue}`,'Set custom value…']);if(!action)return;
            if(action.startsWith('Use default ·')){await resetRoleField(role,name,field);return;}
            const text=(await ctx.ui.input(choice,field==='budget'?'Positive USD amount (enforced only by Claude; recorded on other agents)':'read,grep,find,ls — restricted further by call permission'))?.trim();if(!text)return;
            setBindingFields(dir,role,name,field==='budget'?{budget:Number(text)}:{tools:text.split(',').map(s=>s.trim()).filter(Boolean)});saved();
          }
        });
      }
    };
    const bindingMenu=async(name:string,role:string)=>{
      while(true){
        const p=profile(name,role);if(!p){await show('Role not available',`${role} has no definition on ${agentLabel(name)}. Create shared instructions to use it here.`);return;}
        const patch=settings().harnessSettings?.[name]?.roles?.[role];
        const model=patch?.model===undefined?`Same as ${agentLabel(name)} (${inherited(name,'model')})`:(p.model??`Uses ${agentLabel(name)} settings`);
        const effort=patch?.thinking===undefined?`Same as ${agentLabel(name)} (${inherited(name,'effort')})`:valueLabel(p.thinking,name,options.getThinkingLevel?.());
        const scoped=p.source===overrideFile(dir,name,role);
        const localOff=patch?.enabled===false||(!settings().exact?.[`${name}-${role}`]&&settings().disabledProfiles?.includes(`${name}-${role}`));
        const choice=await select(`${role} on ${agentLabel(name)}\n${p.configurationError?'Unavailable — open Reasons and fixes':'Available'} · Changes here affect this agent only.`,[`Model · ${model}`,`Reasoning · ${effort}`,`Instructions · ${scoped?'Customized for this agent':'Shared'}`, ...(p.configurationError?['Reasons and fixes…']:[]),localOff?'Turn on for this agent only':'Turn off for this agent only','Advanced…']);if(!choice)return;
        await attempt(async()=>{
          if(choice.startsWith('Model ·'))await changeField(name,'model',role);
          else if(choice.startsWith('Reasoning ·'))await changeField(name,'effort',role);
          else if(choice.startsWith('Instructions ·')){const action=await select('Role instructions',[`Customize for this agent…${scoped?' · Current':''}`,`Use shared instructions${!scoped?' · Current':''}`, 'View effective instructions']);if(action?.startsWith('Customize for this agent…'))await editInstructions(role,name);else if(action?.startsWith('Use shared instructions'))await resetRoleField(role,name,'instructions');else if(action)await show('Effective instructions',p.systemPrompt||'(Empty instructions)');}
          else if(choice==='Reasons and fixes…')await blockers(name,role);
          else if(choice==='Advanced…')await bindingAdvanced(name,role);
          else {setRoleEnabled(dir,role,!!localOff,name);saved();}
        });
      }
    };
    const agentRoles=async(name:string)=>{
      while(true){const roles=[...roleInventory(dir,settings()).keys()].filter(r=>!!profile(name,r)).sort();const choice=await select(`${agentLabel(name)} › Role customizations`,roles.map(r=>{const p=profile(name,r);const patch=settings().harnessSettings?.[name]?.roles?.[r];const custom=[...(patch?.model!==undefined?['model']:[]),...(patch?.thinking!==undefined?['reasoning']:[]),...(p?.source===overrideFile(dir,name,r)?['instructions']:[])];return `${r} · ${p?.configurationError?'Unavailable':custom.length?`Custom ${custom.join(', ')}`:'Same as agent'}`;}));if(!choice)return;await bindingMenu(name,choice.split(' · ')[0]!);}
    };
    const roleMenu=async(role:string)=>{
      while(true){const entry=roleInventory(dir,settings()).get(role);if(!entry)return;const off=settings().roles?.[role]?.enabled===false;
        const choices=['Edit shared instructions…','Customize for an agent…',off?'Turn on everywhere':'Turn off everywhere','Details',entry.builtIn?'Restore original instructions…':'Remove role…'];
        const choice=await select(`Role › ${role}${off?' · Off everywhere':''}`,choices);if(!choice)return;
        await attempt(async()=>{
          if(choice==='Edit shared instructions…')await editInstructions(role);
          else if(choice==='Customize for an agent…'){const names=registeredHarnesses(settings()).filter(n=>!!profile(n,role));const labels=names.map(agentLabel);const selected=await select(`Customize ${role} for`,labels);if(selected)await bindingMenu(names[labels.indexOf(selected)]!,role);}
          else if(choice==='Restore original instructions…')await resetRoleField(role,undefined,'instructions');
          else if(choice==='Remove role…')await command(`config role delete ${quote(role)}`);
          else if(choice==='Details')await command(`config role inspect ${quote(role)}`);
          else {setRoleEnabled(dir,role,off);saved();}
        });
      }
    };
    const rolesMenu=async()=>{
      while(true){const entries=[...roleInventory(dir,settings()).values()].sort((a,b)=>a.name.localeCompare(b.name));
        const choices=entries.map(e=>`${e.name} · ${e.builtIn?'Built-in':'Custom'}${settings().roles?.[e.name]?.enabled===false?' · Off everywhere':''}${new Set([...e.exceptions,...e.overrides]).size?` · ${e.exceptions.length+e.overrides.length} customizations`:''}`);
        const choice=await select('External › Roles',[...choices,'Create a role…']);if(!choice)return;
        if(choice==='Create a role…')await attempt(createRoleFlow);else await roleMenu(entries[choices.indexOf(choice)]!.name);
      }
    };
    const defaultMenu=async()=>{
      while(true){const names=registeredHarnesses(settings());const labels=names.map(n=>`${agentLabel(n)}${n===settings().defaultHarness?' · Current global default':''}${harnessDisabled(settings(),n)?' · Off':''}${n==='agy'?' · Requires full access':''}`);const chosen=await select(`Choose the global default agent\nCurrent: ${agentLabel(settings().defaultHarness)}${effectiveDefault().source==='project'?`\nThis project uses ${agentLabel(effectiveDefault().harness)}; changing the global default will not change it.`:''}`,labels);if(!chosen)return;const name=names[labels.indexOf(chosen)]!;
        if(harnessDisabled(settings(),name)){const action=await select('This agent is off',['Turn it on first']);if(action)await attempt(async()=>{setHarnessEnabled(dir,name,true);saved();});continue;}
        await attempt(async()=>{if(name==='agy'&&settings().defaultPermission!=='danger'){await show('Antigravity requires full access','Choose another agent or change access under Advanced. No default was changed.');return;}setDefaultHarness(dir,name);const current=effectiveDefault();if(current.source==='project')await show('Global default saved',`This project still uses ${agentLabel(current.harness)} from ${current.projectPath}. Project files were not changed.`);else saved();});return;
      }
    };
    const agentAdvanced=async(name:string)=>{
      while(true){const choice=await select(`${agentLabel(name)} › Advanced`,[...(!cliHarness(name)?[`Skills · ${settings().harnessSettings?.[name]?.preset==='skills'?'Installed skills':'Not loaded'}`]:[]),'Details','Restore execution defaults…',...(!cliHarness(name)?['Remove agent…']:[])]);if(!choice)return;
        await attempt(async()=>{
          if(choice.startsWith('Skills ·')){const value=await select('Skills',['No skills (recommended)','Installed skills (project skills only when trusted)']);if(value){setHarnessFields(dir,name,{preset:value.startsWith('No')?'minimal':'skills'});saved();}}
          else await command(`config harness ${choice==='Details'?'inspect':choice==='Remove agent…'?'delete':'reset'} ${quote(name)}`);
        });if(!registeredHarnesses(settings()).includes(name))return;
      }
    };
    const agentMenu=async(name:string)=>{
      while(true){if(!registeredHarnesses(settings()).includes(name))return;const off=harnessDisabled(settings(),name);const def=effectiveDefault();
        const access=settings().defaultPermission;
        const accessName={readonly:'Read-only',edit:'Can edit files',danger:'Full access'}[access];
        const boundary=name==='agy'?'Full access only':!cliHarness(name)?`${accessName} · curated tools, not an OS sandbox`:`${accessName} via agent permissions`;
        const choices=[`Model · ${inherited(name,'model')}`,`Reasoning · ${inherited(name,'effort')}`,'Make default','Role customizations…',cliHarness(name)?'Check installation and sign-in…':'Check model and credentials…',...(!cliHarness(name)?['Send a test message… (may incur cost)']:[]),off?'Turn on':'Turn off','Advanced…'];
        const choice=await select(`External › ${agentLabel(name)}\n${off?'Off':'On'}${def.harness===name?' · Default':''}\nAccess: ${boundary} (a call can override the default)`,choices);if(!choice)return;
        await attempt(async()=>{
          if(choice.startsWith('Model ·'))await changeField(name,'model');
          else if(choice.startsWith('Reasoning ·'))await changeField(name,'effort');
          else if(choice==='Make default'){if(name==='agy'&&settings().defaultPermission!=='danger'){await show('Antigravity requires full access','Choose another agent or change access under Advanced. No default was changed.');return;}if(off){await show('Agent is off','Turn it on first, then select Make default.');return;}setDefaultHarness(dir,name);const current=effectiveDefault();if(current.source==='project')await show('Global default saved',`This project uses ${agentLabel(current.harness)} from ${current.projectPath}.`);else saved();}
          else if(choice==='Role customizations…')await agentRoles(name);
          else if(choice.startsWith('Check '))await checkSetup(name);
          else if(choice.startsWith('Send a test')){if(!options.testHarness){await show('Test unavailable','No model test handler is available in this session.');return;}const result=await busy('Testing · Esc cancels',signal=>options.testHarness!(ctx,name,signal));await show('Test message result',result.ok?`Passed${result.detail?': '+result.detail:''}`:result.error);}
          else if(choice==='Advanced…')await agentAdvanced(name);
          else if(!off&&(settings().defaultHarness===name||def.harness===name)){
            const projectBlocking=def.source==='project'&&def.harness===name;
            const action=await select('Choose another default first',projectBlocking?['Show project default']:['Choose global default…']);if(action==='Choose global default…')await defaultMenu();else if(action)await show('Project default',def.projectPath??'No project override.');
          }else{setHarnessEnabled(dir,name,off,def);saved();}
        });
      }
    };
    const globalField=async(field:keyof ExternalSettings,title:string)=>{
      const current=settings()[field];
      if(field==='defaultPermission'){
        const labels={readonly:'Read-only',edit:'Can edit files',danger:'Full access'};
        const choices=Object.entries(labels).map(([id,label])=>`${label}${id===current?' · Current':''}`);
        const selected=await select('Default access\nCalls may override this setting. Agents enforce access differently.',choices);if(!selected)return;
        const value=Object.keys(labels)[choices.indexOf(selected)]!;
        if(!await ctx.ui.confirm('Change default access?',`${value==='danger'?'Danger allows unsandboxed host access on CLI agents; native restrictions differ.':value==='edit'?'Edit enables writes using each agent’s permission mechanism.':'Readonly limits each agent using its own mechanism, not a universal OS sandbox.'}\nAntigravity supports danger only. Pi uses curated tools, not an OS sandbox. Calls can override this default.`))return;
        mutateV5(dir,raw=>{raw.defaultPermission=value;});saved();return;
      }
      if(field==='defaultMaxBudgetUsd'){
        const choice=await select(`Default spending cap\nCurrent: ${current==null?'No cap':`$${current}`}\nEnforced by Claude; recorded, not enforced, by other agents.`,['No cap','Set a cap…']);if(!choice)return;
        if(choice==='No cap'){mutateV5(dir,raw=>{raw.defaultMaxBudgetUsd=null;});saved();return;}
      }
      if(field==='subagentTimeoutMs'){
        const presets=[['5 minutes',300000],['15 minutes',900000],['30 minutes',1800000],['1 hour',3600000],['2 hours',7200000],['No limit',0]] as const;
        const choice=await select(`Run timeout\nCurrent: ${current===0?'No limit':`${Number(current)/60000} minutes`}`,[...presets.map(([label])=>label),'Custom minutes…']);if(!choice)return;
        const preset=presets.find(([label])=>label===choice);
        const minutes=preset?undefined:(await ctx.ui.input('Timeout in minutes','Positive number; queue waiting is not counted'))?.trim();
        if(!preset&&!minutes)return;const value=preset?preset[1]:Number(minutes)*60000;
        if(!Number.isFinite(value)||value<0)throw new Error('Enter a positive number of minutes.');
        mutateV5(dir,raw=>{raw.subagentTimeoutMs=value;});saved();return;
      }
      const text=(await ctx.ui.input(`${title}\nCurrent: ${current??'No cap'}`,field==='defaultMaxBudgetUsd'?'Positive USD amount':'Whole number'))?.trim();if(!text)return;
      const value=field==='defaultMaxBudgetUsd'&&text==='unlimited'?null:Number(text);
      if(value!==null&&(!Number.isFinite(value)||(field!=='defaultMaxBudgetUsd'&&!Number.isInteger(value))))throw new Error('Enter a valid whole number (or a positive USD amount for a spending cap).');
      mutateV5(dir,raw=>{raw[field]=value;});saved();
    };
    const advanced=async()=>{
      const fields:[keyof ExternalSettings,string][]=[['defaultPermission','Default access'],['defaultMaxBudgetUsd','Default spending cap (USD)'],['maxConcurrentSubagents','Concurrent runs'],['subagentTimeoutMs','Run timeout (milliseconds; 0 disables)'],['maxRunRecords','Retained completed runs (0 keeps all)']];
      while(true){const choice=await select('External › Advanced',['Global default…',...fields.map(([key,label])=>`${label} · ${key==='defaultPermission'?({readonly:'Read-only',edit:'Can edit files',danger:'Full access'}[settings().defaultPermission]):settings()[key]??'No cap'}`),'Configuration details','Edit settings file…','Diagnostics (checks installation/sign-in)…','Legacy selectors…','Purge old files…']);if(!choice)return;
        await attempt(async()=>{
          const field=fields.find(([,label])=>choice.startsWith(label+' ·'));if(field){await globalField(...field);return;}
          if(choice==='Global default…')await defaultMenu();
          else if(choice==='Legacy selectors…'){const exact=settings().exact??{};const name=await select('Legacy selectors — edit/remove through settings file',Object.keys(exact));if(name)await show(name,JSON.stringify(exact[name],null,2));}
          else await command(choice==='Configuration details'?'config text':choice==='Edit settings file…'?'config edit':choice.startsWith('Diagnostics')?'doctor':'[danger]purge-old-files');
        });
      }
    };
    while(true){
      const loaded=loadExternalSettings(dir);const catalog=snapshot();
      if(loaded.blocked||loaded.settings.version!==5||catalog.blocked){
        const convertible=planV5Upgrade(dir).status==='ready'||planConfigUpgrade(dir).status==='ready';
        const choice=await ctx.ui.select('External › Settings need attention',[...(convertible?['Preview format update…']:[]),'Edit settings file…','Show problem and file location','Close']);if(!choice||choice==='Close')return;
        if(choice==='Show problem and file location'){await show('Settings problem',`${loaded.path}\n${[...loaded.diagnostics,...catalog.diagnostics].join('\n')}\nDelegation is paused. No fallback settings are used here. Future-format files need a compatible extension version; they are never downgraded here.`);continue;}
        await attempt(async()=>{if(choice==='Edit settings file…')await command('config edit');else{
          const before=loadExternalSettings(dir);await command('config convert');
          if(before.settings.version!==4 && loadExternalSettings(dir).settings.version===4)await command('config convert');
        }});continue;
      }
      const s=loaded.settings;const def=effectiveDefault();const names=registeredHarnesses(s);
      const rows=names.map(n=>`${agentLabel(n)}${n===def.harness?' · Default':''}${harnessDisabled(s,n)?' · Off':''} · ${inherited(n,'model')}${s.harnessSettings?.[n]?.thinking?` · ${inherited(n,'effort')}`:''}`);
      const defaultProblem=!names.includes(def.harness)||harnessDisabled(s,def.harness)||(def.harness==='agy'&&s.defaultPermission!=='danger');
      const title=`External agents\nDefault: ${agentLabel(def.harness)}${def.source==='project'?' (this project)':''}${defaultProblem?' · Needs attention':''}\nSelect an agent to change its settings. / searches the list.`;
      const choice=await ctx.ui.select(title,[...rows,...(defaultProblem?['Fix default agent…']:[]),'Add a Pi agent…','Roles…','Recent runs…','Advanced…','Close']);if(!choice||choice==='Close')return;
      await attempt(async()=>{
        const index=rows.indexOf(choice);if(index>=0)await agentMenu(names[index]!);
        else if(choice==='Fix default agent…')await defaultMenu();
        else if(choice==='Add a Pi agent…')await createPiFlow();
        else if(choice==='Roles…')await rolesMenu();
        else if(choice==='Recent runs…')await command('runs');
        else await advanced();
      });
    }
  });
}
