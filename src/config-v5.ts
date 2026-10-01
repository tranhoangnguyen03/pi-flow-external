import { EXTERNAL_HARNESSES, type ExternalHarness, type PiResourcePreset } from './types.ts';

export interface BindingSettings {
  enabled?: boolean;
  model?: string;
  thinking?: string;
  tools?: string[];
  max_budget_usd?: number;
}
export interface HarnessSettings extends BindingSettings {
  preset?: PiResourcePreset;
  owner?: string;
  roles?: Record<string, BindingSettings>;
}
export interface RoleSettings { enabled?: boolean }
/** Exact-only converted definitions retain their historical selector without guessing a pair. */
export interface ExactSettings extends BindingSettings { harness: string; instructions: string; description: string }
export const CONFIG_NAME = /^(?!(?:constructor|prototype|tostring|valueof|hasownproperty|isprototypeof|propertyisenumerable|tolocalestring)$)[a-z0-9][a-z0-9-]*$/;
export function cliHarness(name: string): name is ExternalHarness { return (EXTERNAL_HARNESSES as readonly string[]).includes(name); }
export function knownHarnessShape(name: string): boolean { return cliHarness(name) || /^pi-[a-z0-9][a-z0-9-]*$/.test(name); }
export function objectRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }

export function reasoningLevels(harness: string): string[] {
  return harness==='claude'?['low','medium','high','xhigh','max']:harness==='codex'?['minimal','low','medium','high','xhigh']:harness==='agy'?['off','minimal','low','medium','high','xhigh','max']:harness==='muse'?['minimal','low','medium','high','xhigh']:['off','minimal','low','medium','high','xhigh'];
}

export function executionProblems(value: unknown, harness: string, scope: 'harness' | 'binding' = 'binding'): string[] {
  if (!objectRecord(value)) return ['must be an object'];
  const errors: string[]=[];
  const allowed = ['enabled','model','thinking','tools','max_budget_usd', ...(scope==='harness'?['preset','owner','roles']:[])];
  for(const key of Object.keys(value)) if(!allowed.includes(key)) errors.push(`unknown field ${key}`);
  if(value.enabled!==undefined && typeof value.enabled!=='boolean')errors.push('enabled must be boolean');
  if(value.model!==undefined && (typeof value.model!=='string'||!value.model.trim()))errors.push('model must be a nonempty string');
  if(typeof value.model==='string' && !cliHarness(harness) && !/^[^/\s]+\/\S+$/.test(value.model))errors.push('Pi model must be provider/model');
  if(typeof value.model==='string' && harness==='opencode' && value.model!=='native' && !/^[^/\s]+\/\S+$/.test(value.model))errors.push('OpenCode model must be provider/model');
  if(value.thinking!==undefined) {
    const levels=reasoningLevels(harness);
    if(typeof value.thinking!=='string' || !value.thinking.trim() || (harness!=='opencode'&&!['native','parent',...levels].includes(value.thinking)))errors.push('unsupported reasoning effort');
    if(harness==='opencode'&&value.thinking==='parent')errors.push('OpenCode does not support parent effort; choose native or a model variant');
    if(!cliHarness(harness)&&value.thinking==='native')errors.push('Pi effort must be an explicit level or parent');
  }
  if(value.tools!==undefined && (cliHarness(harness)||!Array.isArray(value.tools)||!value.tools.length||value.tools.some(v=>typeof v!=='string'||!v.trim())))errors.push('tools must be a nonempty string array on a Pi harness');
  if(value.max_budget_usd!==undefined && (typeof value.max_budget_usd!=='number'||!Number.isFinite(value.max_budget_usd)||value.max_budget_usd<=0))errors.push('max_budget_usd must be a positive finite number');
  if(scope==='harness') {
    if(value.tools!==undefined || value.max_budget_usd!==undefined) errors.push('tools and budget belong on a role-on-harness binding');
    if(!cliHarness(harness) && (typeof value.model!=='string'||!value.model.trim()))errors.push('Pi harness requires a model');
    if(value.preset!==undefined&&(cliHarness(harness)||!['minimal','skills'].includes(String(value.preset))))errors.push('preset is minimal or skills, on Pi only');
    if(value.owner!==undefined&&typeof value.owner!=='string')errors.push('owner must be a string');
    if(value.roles!==undefined) {
      if(!objectRecord(value.roles))errors.push('roles must be an object');
      else for(const [role,patch] of Object.entries(value.roles)) {
        if(!CONFIG_NAME.test(role))errors.push(`invalid role name ${role}`);
        errors.push(...executionProblems(patch,harness).map(e=>`role ${role}: ${e}`));
      }
    }
  }
  return errors;
}
