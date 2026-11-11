#!/usr/bin/env node
// Experimental Claude Mod adapter. No shell interpolation, no inherited dialogue.
// Independent of the Pi extension runtime. Receipts contain prompts and model output.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile, rename, stat, appendFile } from 'node:fs/promises';

const here = fileURLToPath(import.meta.url);
const ROOT = process.env.FLOW_CLAUDE_RUNS_DIR || join(homedir(), '.pi', 'agent', 'pi-flow-external', 'claude-mod', 'runs');
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'interrupted_or_uncertain']);
const ID = /^run_[a-f0-9-]{36}$/;
const now = () => new Date().toISOString();
const fail = (s) => { throw new Error(s); };
const dir = id => {
  if (!ID.test(id || '')) fail('Invalid run ID');
  return join(ROOT, id);
};
const statePath = id => join(dir(id), 'summary.json');
const safeRead = async id => JSON.parse(await readFile(statePath(id), 'utf8'));
async function writeState(row) {
  const p = statePath(row.runId);
  const temp = p + '.' + process.pid + '.tmp';
  await writeFile(temp, JSON.stringify(row, null, 2), {mode:0o600});
  await rename(temp, p);
}
async function appendEvent(id, obj) {
  await appendFile(join(dir(id), 'events.ndjson'), JSON.stringify({at:now(), ...obj}) + '\n', {mode:0o600});
}
async function change(id, patch) {
  const row = await safeRead(id);
  if (TERMINAL.has(row.state) && patch.state !== undefined && patch.state !== row.state) return row;
  const update = {...row, ...patch, updatedAt:now()};
  await writeState(update); return update;
}
const within = (text, limit=12000) => String(text||'').slice(0,limit);

async function input() {
  let raw = '';
  for await (const chunk of process.stdin) {
    raw += chunk; if (raw.length > 65536) fail('Input exceeds 64 KiB');
  }
  return raw ? JSON.parse(raw) : {};
}
async function checkedRun(id, sessionId) {
  const row = await safeRead(id);
  if (!sessionId || row.sessionId !== sessionId) fail('Run not owned by this session');
  return row;
}
async function launch(input) {
  const {sessionId, cwd, task} = input;
  if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 200) fail('Missing session ID');
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) fail('Workspace must be absolute');
  if (!(await stat(cwd)).isDirectory()) fail('Workspace is not a directory');
  if (typeof task !== 'string' || !task.trim() || task.length > 12000) fail('Task must be 1–12000 chars');
  await mkdir(ROOT, {recursive:true,mode:0o700});
  const runId = 'run_' + randomUUID();
  await mkdir(dir(runId), {mode:0o700});
  const row = {runId,sessionId,cwd:resolve(cwd),task,role:'explorer',harness:'codex',permission:'readonly',
    context:'none',state:'queued',startedAt:now(),updatedAt:now(),finalAvailable:false,collected:false};
  await writeState(row);
  // Detached wrapper owns Codex and settles a disk receipt. Termination is session-scoped.
  const worker = spawn(process.execPath,[here,'worker',runId],{detached:true,stdio:'ignore',env:process.env});
  worker.unref();
  await change(runId,{workerPid:worker.pid});
  return {runId,state:'queued',permission:'readonly',harness:'codex',cwd:row.cwd};
}
async function worker(id) {
  let row = await safeRead(id);
  if (row.state !== 'queued') return;
  row = await change(id,{state:'running',processStartedAt:now(),workerPid:process.pid});
  await appendEvent(id,{type:'start',permission:'readonly'});
  let child;
  let finished = false, final = '', diagnostic = '', partial = '', lines=0, terminated=false;
  const stop = async () => {
    if (finished) return;
    terminated = true;
    try { if (child?.pid) process.kill(-child.pid,'SIGTERM'); } catch {}
    await change(id,{state:'cancelled',finalAvailable:false,completedAt:now()}).catch(()=>{});
  };
  process.on('SIGTERM',()=>{ void stop(); });
  process.on('SIGINT',()=>{ void stop(); });
  try {
    const bin = process.env.FLOW_CLAUDE_CODEX_BIN || 'codex';
    const args = ['exec','--json','--skip-git-repo-check','--sandbox','read-only','--','-'];
    child = spawn(bin,args,{cwd:row.cwd,detached:true,stdio:['pipe','pipe','pipe']});
    child.stdin.on('error',()=>{}); child.stdin.end(row.task);
    // Record only bounded event data; malformed JSON never becomes a final answer.
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    let carry = '';
    child.stdout.on('data',chunk=>{
      carry += chunk;
      if (carry.length > 1048576) { diagnostic='Codex emitted an oversized event'; try {process.kill(-child.pid,'SIGTERM')} catch{}; return; }
      let index;
      while ((index = carry.indexOf('\n')) !== -1) {
        const text = carry.slice(0,index).trim(); carry = carry.slice(index+1);
        if (!text) continue;
        lines++;
        let event; try {event=JSON.parse(text);}catch{diagnostic='Malformed Codex JSON event';continue;}
        const type=String(event?.type||'unknown');
        if (type==='item.completed' && event.item?.type==='agent_message' && typeof event.item.text==='string') final=event.item.text;
        if (type==='turn.failed' || type==='error') diagnostic=within(JSON.stringify(event),3000);
        partial=within(type + (event?.item?.type ? ' · '+event.item.type : ''),300);
        void appendEvent(id,{type,preview:partial}).catch(()=>{});
      }
      if (lines%5===0) void change(id,{eventCount:lines,activity:partial}).catch(()=>{});
    });
    child.stderr.on('data',chunk=>{diagnostic=within(diagnostic + chunk,4000);});
    const outcome=await new Promise(resolve=>{
      child.on('error',e=>resolve({code:1,error:String(e)}));
      child.on('close',(code,signal)=>resolve({code,signal}));
    });
    finished=true;
    const current=await safeRead(id);
    if (current.state==='cancelled' || terminated) return;
    if (outcome.code===0 && final.trim()) {
      await writeFile(join(dir(id),'final.txt'),final,{mode:0o600});
      await change(id,{state:'succeeded',finalAvailable:true,completedAt:now(),eventCount:lines,finalPreview:within(final,3000)});
    } else {
      await change(id,{state:'failed',finalAvailable:false,completedAt:now(),eventCount:lines,
        error:diagnostic || outcome.error || (outcome.code===0 ? 'No canonical agent message found' : 'Codex exit '+outcome.code)});
    }
  } catch(e) {
    finished=true;
    const current=await safeRead(id);
    if (current.state!=='cancelled') await change(id,{state:'failed',error:within(e,1500),completedAt:now()});
  }
  await appendEvent(id,{type:'settled',state:(await safeRead(id)).state});
}
async function inspect(input) {
  const row=await checkedRun(input.runId,input.sessionId);
  // Full task text is not needed for the Mod card; it remains only in the receipt.
  const {task, ...publicRow}=row;
  return publicRow;
}
async function list(input) {
  const { readdir } = await import('node:fs/promises');
  let ids=[]; try{ids=await readdir(ROOT)}catch(e){if(e.code==='ENOENT')return [] ;throw e;}
  const results=[];
  for(const id of ids) {
    if (!ID.test(id)) continue;
    try { const row=await checkedRun(id,input.sessionId);const {task,...view}=row;results.push(view); } catch {}
  }
  return results.sort((a,b)=>b.startedAt.localeCompare(a.startedAt)).slice(0,30);
}
async function cancel(input) {
  const row=await checkedRun(input.runId,input.sessionId);
  if(TERMINAL.has(row.state))return {runId:row.runId,state:row.state};
  await change(row.runId,{state:'cancelled',cancelRequestedAt:now(),completedAt:now(),finalAvailable:false});
  await appendEvent(row.runId,{type:'cancel_requested'});
  if(row.workerPid){ try{process.kill(-row.workerPid,'SIGTERM')}catch{} }
  return {runId:row.runId,state:'cancelled'};
}
async function collect(input) {
  const row=await checkedRun(input.runId,input.sessionId);
  if(row.state!=='succeeded'||!row.finalAvailable) return {runId:row.runId,state:row.state,finalAvailable:false};
  const text=await readFile(join(dir(row.runId),'final.txt'),'utf8');
  await change(row.runId,{collected:true});
  return {runId:row.runId,state:row.state,finalAvailable:true,text};
}
async function stopSession(input) {
  const jobs=await list(input);
  const active=jobs.filter(x=>!TERMINAL.has(x.state));
  for(const row of active)await cancel({runId:row.runId,sessionId:input.sessionId});
  return {stopped:active.length};
}
export async function main(action, args) {
  switch(action){
    case 'launch': return launch(args);
    case 'worker': return worker(args.runId);
    case 'inspect': return inspect(args);
    case 'list': return list(args);
    case 'cancel': return cancel(args);
    case 'collect': return collect(args);
    case 'stop-session': return stopSession(args);
    default: fail('Unknown action');
  }
}
if(process.argv[1]===here){
  const action=process.argv[2];
  try {
    const args=action==='worker'?{runId:process.argv[3]}:await input();
    const out=await main(action,args);
    if(action!=='worker')process.stdout.write(JSON.stringify({ok:true,data:out})+'\n');
  }catch(e){
    process.stdout.write(JSON.stringify({ok:false,error:within(e,2000)})+'\n');
    process.exitCode=1;
  }
}
