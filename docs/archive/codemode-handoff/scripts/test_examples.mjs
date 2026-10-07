#!/usr/bin/env node
/** Mock execution of handoff examples. NOT a Flow/Pi integration test. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = JSON.parse(await readFile(resolve(root, 'contracts/fixtures.json'), 'utf8'));
const fixture = name => structuredClone(fixtures.find(x => x.name === name).receipt);
const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
const compile = async name => new AsyncFunction('tools', 'load', 'text', await readFile(resolve(root, 'examples', name), 'utf8'));
const inspect = await compile('01_inspect_batch.js');
const handoff = await compile('02_explicit_handoff.js');
let passed = 0;
async function test(name, body) { await body(); passed++; console.log(`PASS ${name}`); }
await test('batch pages collected with stable selectors', async () => {
  const output=[];const calls=[];
  const first=fixture('inspect-batch-continuation');
  const second=fixture('inspect-failed-target-is-success');
  await inspect({external_runs:async args=>{calls.push(args);return calls.length===1?first:second;}},
    ()=>['run_demo_success','run_demo_failed'], x=>output.push(x));
  assert.equal(calls.length,2);assert.equal(calls[1].cursor,first.data.nextCursor);
  assert.equal(output[0].complete,true);assert.equal(output[0].runs.length,2);
  assert.equal(output[0].runs[1].outcome,'failed');
});
await test('typed inspection failure stays failure', async () => {
  const output=[];
  await inspect({external_runs:async()=>fixture('inspect-unavailable-scope-safe')},
    ()=>['run_a','run_b'],x=>output.push(x));
  assert.equal(output[0].inspectionFailed,true);assert.equal(output[0].error.code,'RUN_UNAVAILABLE');
});
await test('nonadvancing batch cursor rejected', async () => {
  await assert.rejects(()=>inspect({external_runs:async()=>fixture('inspect-batch-continuation')},
    ()=>['run_a','run_b'],()=>{}), /Non-advancing/);
});
await test('single ID rejected by deliberately batch-only example', async () => {
  await assert.rejects(()=>inspect({},()=>['run_a'],()=>{}), /2–20/);
});
const input = {sourceRunId:'wf_demo_null',task:'Assess the supplied canonical evidence. Do not edit files.',harness:'fixture-reader'};
await test('explicit handoff preserves JSON null and context none', async () => {
  const output=[];let assignment;
  await handoff({external_runs:async()=>fixture('inspect-final-json-null'),Agent:async a=>{assignment=a;return fixture('agent-success-text');}},
    ()=>input,x=>output.push(x));
  assert.match(assignment.prompt,/"evidence":null/);assert.deepEqual(assignment.context,{mode:'none'});
  assert.equal(assignment.permission,'readonly');assert.equal(output[0].invocationOk,true);
});
await test('unavailable final never launches next child', async () => {
  const output=[];let launched=false;
  const unavailable=fixture('inspect-final-unavailable'); unavailable.data.runId=input.sourceRunId;
  await handoff({external_runs:async()=>unavailable,Agent:async()=>{launched=true;}},
    ()=>input,x=>output.push(x));
  assert.equal(launched,false);assert.equal(output[0].ready,false);
});
await test('malformed final JSON stops before delegation', async () => {
  const r=fixture('inspect-final-json-null');r.data.page.text='{broken';let launched=false;
  await assert.rejects(()=>handoff({external_runs:async()=>r,Agent:async()=>{launched=true;}},()=>input,()=>{}),SyntaxError);
  assert.equal(launched,false);
});
await test('large evidence requires selection instead of blind forwarding', async () => {
  const r=fixture('inspect-final-json-null');r.data.page.encoding='text';r.data.page.text='x'.repeat(12001);
  const output=[];let launched=false;
  await handoff({external_runs:async()=>r,Agent:async()=>{launched=true;}},()=>input,x=>output.push(x));
  assert.equal(launched,false);assert.equal(output[0].needsSelection,true);
});
await test('dependent child failure is reported as invocation failure', async () => {
  const output=[];
  await handoff({external_runs:async()=>fixture('inspect-final-json-null'),Agent:async()=>fixture('agent-failure-with-evidence')},
    ()=>input,x=>output.push(x));
  assert.equal(output[0].invocationOk,false);assert.equal(output[0].error.code,'RUN_FAILED');
});
await test('paged JSON reconstructed before parsing', async () => {
  const full=fixture('inspect-final-json-null');const first=fixture('inspect-json-fragment');
  const second=structuredClone(full);second.data.page.text=full.data.page.text.slice(first.data.page.text.length);
  const calls=[];let assignment;
  await handoff({external_runs:async args=>{calls.push(args);return calls.length===1?first:second;},
    Agent:async a=>{assignment=a;return fixture('agent-success-text');}},()=>input,()=>{});
  assert.equal(calls.length,2);assert.equal(calls[1].cursor,first.data.page.nextCursor);
  assert.match(assignment.prompt,/"evidence":null/);
});
await test('mismatched source identity rejected before handoff', async () => {
  const r=fixture('inspect-final-json-null');r.data.runId='wf_wrong_source';let launched=false;
  await assert.rejects(()=>handoff({external_runs:async()=>r,Agent:async()=>{launched=true;}},()=>input,()=>{}),/requested single-run/);
  assert.equal(launched,false);
});
console.log(`PASS: ${passed} mock example checks. No Flow, Pi runtime, external CLI, or provider invoked.`);
