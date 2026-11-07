#!/usr/bin/env node
/**
 * Real installed PiG + genuine Flow + synthetic parent provider + fake child CLIs.
 * This is an integration fixture, not a human TUI or authenticated subscription test.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:http";

const bundle = path.resolve(process.argv[2] || "_pig_agent/dist/shell/bundle");
const release = JSON.parse(await fs.readFile(path.join(bundle, "release.json"), "utf8"));
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pig-flow-installed "));
const reportPath = path.resolve(process.argv[3] || "pig-flow-fixture-report.json");
const report = {
  schema: 1, platform: process.platform, node: process.version, released: release.buildId,
  flowCommit: release.extensions.find(e => e.id === "external")?.sourceCommit,
  scope: "Actual installed PiG executes Flow model tools; synthetic root model and fake CLI auth/results.",
  checks: [],
};
const work = path.join(dir, "workspace");
const home = path.join(dir, "agent home");
const fixtureBin = path.join(dir, "fixture bins");
const eventLog = path.join(dir, "child-events.jsonl");
await fs.mkdir(work, { recursive: true });
await fs.mkdir(fixtureBin, { recursive: true });

const fake = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const name = path.basename(process.argv[1]);
const argv = process.argv.slice(2).join(" ");
if (argv === "--version") { console.log(name + " 2.0.0"); process.exit(0); }
if (argv === "auth status --json" && name === "claude") {
  console.log(JSON.stringify({ loggedIn:true, authMethod:"oauth_token", email:"fixture@example.test" }));
  process.exit(0);
}
if (argv === "login status" && name === "codex") {
  console.error("Logged in using ChatGPT");
  process.exit(0);
}
let body = "";
process.stdin.on("data", chunk => body += chunk);
process.stdin.on("end", () => {
  const selected = name === "claude" ? process.env.CLAUDE_CONFIG_DIR : process.env.CODEX_HOME;
  const hasKey = name === "claude"
    ? Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN)
    : Boolean(process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY);
  fs.appendFileSync(process.env.FLOW_FIXTURE_EVENT_LOG,
    JSON.stringify({ name, selected, hasKey, argv, gotPrompt:body.length > 0 }) + "\n");
  if (hasKey || !selected) { console.error("auth scope failure"); process.exit(17); }
  if (name === "claude") {
    console.log(JSON.stringify({ type:"assistant", message:{id:"fixture", content:[{type:"text", text:"fixture streaming activity"}]} }));
    console.log(JSON.stringify({ type:"result", subtype:"success", is_error:false,
      session_id:"fixture-claude-session", result:"SHELL_CLAUDE_DONE" }));
  } else {
    console.log(JSON.stringify({ type:"thread.started", thread_id:"fixture-codex-session" }));
    console.log(JSON.stringify({ type:"item.completed", item:{type:"agent_message", text:"SHELL_CODEX_DONE"} }));
    console.log(JSON.stringify({ type:"turn.completed" }));
  }
});
`;
for (const name of ["claude", "codex"]) {
  await fs.writeFile(path.join(fixtureBin, name), fake, { mode: 0o755 });
}
const env = {
  ...process.env,
  PATH: fixtureBin + path.delimiter + (process.env.PATH || ""),
  PIG_AGENT_HOME: home,
  PI_COMMS_BROKER_DIR: path.join(dir, "broker"),
  PIG_OFFLINE: "1", PI_OFFLINE: "1",
  FLOW_FIXTURE_EVENT_LOG: eventLog,
  CLAUDE_CONFIG_DIR: path.join(home, "auth-cld"),
  CODEX_HOME: path.join(home, "auth-cdx"),
  ANTHROPIC_API_KEY: "fixture-parent-anthropic-key",
  CODEX_API_KEY: "fixture-parent-codex-key",
  PI_EXTERNAL_CLAUDE_AUTH_SOURCE: "subscription",
  PI_EXTERNAL_CODEX_AUTH_SOURCE: "subscription",
  PI_EXTERNAL_CLAUDE_EXPECTED_EMAIL: "fixture@example.test",
};
const bundleCli = path.join(bundle, release.id);
let server;
let serverError;
async function command(exe, args, timeoutMs = 120000) {
  const proc = spawn(exe, args, { cwd: work, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "", stderr = "";
  proc.stdout.on("data", bytes => output += bytes.toString());
  proc.stderr.on("data", bytes => stderr += bytes.toString());
  const timeout = setTimeout(() => proc.kill("SIGKILL"), timeoutMs);
  try {
    const code = await new Promise((resolve, reject) => { proc.once("error", reject); proc.once("close", resolve); });
    assert.equal(code, 0, "PiG child exit " + code + ": " + stderr.slice(-3500));
    if (serverError) throw serverError;
    return output;
  } finally { clearTimeout(timeout); }
}
const script = [
  "export const meta = { apiVersion:1, name:'pig_flow_fixture', description:'native installed Flow workflow' };",
  "const output = await agent('Return SHELL_CLAUDE_DONE', { role:'worker', harness:'claude', permission:'readonly' });",
  "return output;",
].join("\n");
const checks = [
  { marker:"FLOW_NATIVE_HELP", tool:"external_help", params:{topic:"contracts"}, stage:"final" },
  { marker:"FLOW_NATIVE_RUNS_LIST", tool:"external_runs", params:{action:"list"}, stage:"final" },
  { marker:"FLOW_NATIVE_CLAUDE", tool:"external_delegate", params:{description:"Fixture Claude execution",prompt:"Return SHELL_CLAUDE_DONE",role:"worker",harness:"claude",permission:"readonly"}, expect:"SHELL_CLAUDE_DONE", stage:"inspect" },
  { marker:"FLOW_NATIVE_CODEX", tool:"external_delegate", params:{description:"Fixture Codex execution",prompt:"Return SHELL_CODEX_DONE",role:"worker",harness:"codex",permission:"readonly"}, expect:"SHELL_CODEX_DONE", stage:"inspect" },
  { marker:"FLOW_NATIVE_PI_CHILD", tool:"external_delegate", params:{description:"Fixture private Pi model",prompt:"Return SHELL_PI_MODEL_DONE",role:"worker",harness:"pi-local",permission:"readonly"}, expect:"SHELL_PI_MODEL_DONE", stage:"inspect" },
  { marker:"FLOW_NATIVE_BACKGROUND", tool:"external_delegate", params:{description:"Fixture background execution",prompt:"Return SHELL_CLAUDE_DONE",role:"worker",harness:"claude",permission:"readonly",background:true}, expect:"SHELL_CLAUDE_DONE", stage:"wait" },
  { marker:"FLOW_NATIVE_WORKFLOW", tool:"external_workflow", params:{script, background:false}, expect:"SHELL_CLAUDE_DONE", stage:"final" },
];
const served = new Map(checks.map(check => [check.marker, []]));
let piChildModelCalls = 0;
function chunk(delta, done) {
  return "data: " + JSON.stringify({ id:"fixture", model:"probe", object:"chat.completion.chunk", choices:[{index:0,delta,finish_reason:done}]}) + "\n\n";
}
function answer(res, toolCall, text = "FLOW_NATIVE_FIXTURE_ACCEPTED") {
  res.writeHead(200, {"Content-Type":"text/event-stream"});
  if (toolCall) {
    res.write(chunk({role:"assistant",tool_calls:[{index:0,id:"flow-tool-" + served.size,type:"function",
      function:{name:toolCall.tool,arguments:JSON.stringify(toolCall.params)}}]},null));
    res.write(chunk({},"tool_calls"));
  } else {
    res.write(chunk({role:"assistant",content:text},null));
    res.write(chunk({},"stop"));
  }
  res.end("data: [DONE]\n\n");
}
function parseRunId(receipt) {
  const m = receipt.match(/run_[A-Za-z0-9_-]+/);
  assert.ok(m, "Tool response did not expose a run ID: " + receipt.slice(0,700));
  return m[0];
}
try {
  await command(bundleCli, ["install","--home",home], 240000);
  const stable = path.join(home, "bin", release.id);
  server = createServer(async (req,res) => {
    try {
      const chunks = [];
      for await (const data of req) chunks.push(data);
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const user = payload.messages.filter(m => m.role === "user").at(-1);
      const text = typeof user?.content === "string" ? user.content : JSON.stringify(user?.content || "");
      const check = checks.find(c => text.includes(c.marker));
      if (!check && text.includes("SHELL_PI_MODEL_DONE")) {
        // The second request is from the real Pi SDK child, not the root
        // model. It must resolve the private study/probe provider itself.
        piChildModelCalls++;
        answer(res,null,"SHELL_PI_MODEL_DONE");
        return;
      }
      assert.ok(check, "Unexpected fixture prompt");
      const tools = (payload.tools || []).map(t => t.function?.name || t.name);
      assert.ok(tools.includes(check.tool), "PiG did not expose tool " + check.tool);
      const results = payload.messages.filter(m => m.role === "tool");
      if (results.length === 0) {
        answer(res,check);
      } else if (results.length === 1 && (check.stage === "inspect" || check.stage === "wait")) {
        const receipt = JSON.stringify(results[0]);
        if (check.stage === "inspect") assert.ok(receipt.includes(check.expect), "Foreground call did not settle with child result");
        const id = parseRunId(receipt);
        answer(res,{tool:"external_runs",params:check.stage === "inspect"
          ? {action:"inspect",runIds:[id],view:"final"}
          : {action:"wait",runIds:[id],mode:"all"}});
      } else {
        const finalReceipt = JSON.stringify(results.at(-1));
        if (check.expect) assert.ok(finalReceipt.includes(check.expect), "Missing actual child result: " + finalReceipt.slice(0,1300));
        served.get(check.marker).push({ tool:check.tool, checks:results.length });
        answer(res,null);
      }
    } catch (error) {
      serverError ||= error;
      if (!res.headersSent) res.writeHead(500,{"Content-Type":"application/json"});
      res.end(JSON.stringify({error:{message:String(error)}}));
    }
  });
  await new Promise(resolve => server.listen(0,"127.0.0.1",resolve));
  const port = server.address().port;
  await fs.mkdir(path.join(home, ".pi"), { recursive:true });
  await fs.writeFile(path.join(home, ".pi/models.json"), JSON.stringify({ providers: { study:{
    api:"openai-completions", baseUrl:"http://127.0.0.1:" + port + "/v1", apiKey:"fixture-only",
    models:[{id:"probe",name:"Fixture",reasoning:false,input:["text"],
      cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:128000,maxTokens:4096}]
  }}}));
  const flowSettings = path.join(home, ".pi/pi-flow-external/settings.json");
  await fs.mkdir(path.dirname(flowSettings), { recursive:true });
  await fs.writeFile(flowSettings,JSON.stringify({
    version:5, harnesses:{"pi-local":{model:"study/probe",thinking:"off",preset:"minimal"}}
  }));
  for (const check of checks) {
    const started = Date.now();
    try {
      const output = await command(stable, ["print",check.marker,"--home",home,"--cwd",work,"--provider","study","--model","probe","--thinking","off"],120000);
      assert.match(output,/FLOW_NATIVE_FIXTURE_ACCEPTED/);
      assert.ok(served.get(check.marker).length >= 1, "Model tool was never completed");
      report.checks.push({name:check.marker,status:"PASS",ms:Date.now()-started});
    } catch (error) {
      report.checks.push({name:check.marker,status:"FAIL",ms:Date.now()-started,error:String(error)});
      throw error;
    }
  }
  const children = (await fs.readFile(eventLog,"utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.ok(children.some(c => c.name === "claude"), "Claude CLI was never invoked");
  assert.ok(children.some(c => c.name === "codex"), "Codex CLI was never invoked");
  for (const child of children) {
    assert.equal(child.hasKey,false,"Child inherited API credentials despite subscription choice");
    assert.equal(child.gotPrompt,true,"Child prompt missing");
    assert.equal(child.selected, child.name === "claude" ? env.CLAUDE_CONFIG_DIR : env.CODEX_HOME);
  }
  assert.ok(piChildModelCalls > 0, "Private models.json was not used by a real Pi SDK child");
  report.piChildModelCalls = piChildModelCalls;
  report.childCount = children.length;
  report.checks.push({name:"child-scoped-subscription-auth-and-models-json",status:"PASS"});
  report.status = "PASS";
} catch (error) {
  report.status = "FAIL";
  report.error = String(error?.stack || error);
  console.error(error);
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  await fs.writeFile(reportPath,JSON.stringify(report,null,2) + "\n");
  if (server) await new Promise(resolve => server.close(resolve));
  await fs.rm(dir,{recursive:true,force:true});
}
