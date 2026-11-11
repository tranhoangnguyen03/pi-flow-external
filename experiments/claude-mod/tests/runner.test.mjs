import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
const CLI = new URL("../runner/cli.mjs",import.meta.url).pathname;
function call(action,data,env) {
  const out=spawnSync(process.execPath,[CLI,action],{input:JSON.stringify(data),encoding:"utf8",env,timeout:5000});
  const obj=JSON.parse(out.stdout.trim());
  if(!obj.ok)throw new Error(obj.error);
  return obj.data;
}
async function wait(id,sid,env) {
  const until=Date.now()+7000;
  while(Date.now()<until) {
    const row=call('inspect',{runId:id,sessionId:sid},env);
    if(['succeeded','failed','cancelled'].includes(row.state))return row;
    await new Promise(resolve=>setTimeout(resolve,80));
  }
  throw new Error('Timed out waiting for fake worker');
}
test("fake Codex produces verified final, scoped receipt and collection",async()=>{
  const base=await mkdtemp(join(tmpdir(),'flow-claude-test-'));
  try{
    const bin=join(base,'codex-fake');
    await writeFile(bin,'#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"Repository map"}})+"\\n")\n',{mode:0o755});
    const env={...process.env,FLOW_CLAUDE_RUNS_DIR:join(base,'runs'),FLOW_CLAUDE_CODEX_BIN:bin};
    const sid='test-session';
    const run=call('launch',{sessionId:sid,cwd:base,task:'Map repository'},env);
    assert.match(run.runId,/^run_/);
    assert.equal(run.permission,'readonly');
    const settled=await wait(run.runId,sid,env);
    assert.equal(settled.state,'succeeded');
    assert.equal(settled.finalAvailable,true);
    assert.throws(()=>call('collect',{runId:run.runId,sessionId:'other'},env),/not owned/);
    const final=call('collect',{runId:run.runId,sessionId:sid},env);
    assert.equal(final.text,'Repository map');
    assert.equal(call('inspect',{runId:run.runId,sessionId:sid},env).collected,true);
  }finally{await rm(base,{recursive:true,force:true});}
});
test("cancel marks a live run as cancelled and hides final collection",async()=>{
  const base=await mkdtemp(join(tmpdir(),'flow-claude-cancel-'));
  try {
    const bin=join(base,'codex-slow');
    await writeFile(bin,'#!/usr/bin/env node\nsetTimeout(()=>process.stdout.write("late"),15000)\n',{mode:0o755});
    const env={...process.env,FLOW_CLAUDE_RUNS_DIR:join(base,'runs'),FLOW_CLAUDE_CODEX_BIN:bin};
    const sid='cancel-session';
    const r=call('launch',{sessionId:sid,cwd:base,task:'Read only'},env);
    assert.equal(call('cancel',{runId:r.runId,sessionId:sid},env).state,'cancelled');
    const record=call('inspect',{runId:r.runId,sessionId:sid},env);
    assert.equal(record.state,'cancelled');
    assert.equal(record.finalAvailable,false);
    assert.equal(call('collect',{runId:r.runId,sessionId:sid},env).finalAvailable,false);
  }finally{await rm(base,{recursive:true,force:true});}
});

test("bad input fails before launch",async()=>{
  const base=await mkdtemp(join(tmpdir(),'flow-claude-bad-'));
  try{
    const env={...process.env,FLOW_CLAUDE_RUNS_DIR:join(base,'runs')};
    assert.throws(()=>call('launch',{sessionId:'s',cwd:base,task:''},env),/Task/);
    assert.throws(()=>call('inspect',{sessionId:'s',runId:'../../x'},env),/Invalid/);
  }finally{await rm(base,{recursive:true,force:true});}
});
