#!/usr/bin/env node
// Real-backend E2E for blackboard prototype — claude + agy
// Usage: npx tsx scripts/experiments/blackboard-e2e.mjs [--backend claude|agy|both] [--keep]
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const args = process.argv.slice(2);
let backendFilter = "both";
let keep = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--backend") backendFilter = args[++i];
  if (args[i] === "--keep") keep = true;
}
const backends = backendFilter === "both" ? ["claude", "agy"] : [backendFilter];
const timeoutMs = 180_000;

function walk(root) {
  const files = [];
  const visit = (dir) => {
    for (const e of readdirSync(dir)) {
      const f = path.join(dir, e);
      if (statSync(f).isDirectory()) visit(f);
      else files.push(f);
    }
  };
  if (existsSync(root)) visit(root);
  return files;
}

function run(cmd, opts) {
  return new Promise((resolve) => {
    const child = spawn(cmd[0], cmd.slice(1), { ...opts, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); setTimeout(() => child.kill("SIGKILL"), 3000).unref(); }, opts.timeoutMs);
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", c => stdout += c);
    child.stderr.on("data", c => stderr += c);
    child.once("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr, timedOut }); });
  });
}

async function testDirect(backend) {
  const runRoot = path.join(tmpdir(), `board-e2e-${backend}-${Date.now()}`);
  const fixture = path.join(runRoot, "fixture");
  const sessionDir = path.join(runRoot, "sessions");
  const evidenceDir = path.join(runRoot, "evidence");
  const agentDir = path.join(runRoot, "agent");
  const subagentsDir = path.join(agentDir, "subagents");
  for (const d of [fixture, sessionDir, evidenceDir, subagentsDir]) mkdirSync(d, { recursive: true });

  // Copy real profiles for this backend + models.json (custom 9-router provider)
  const realProfile = path.join(process.env.HOME, ".pi/agent/subagents", `${backend}-explorer.md`);
  const profileContent = readFileSync(realProfile, "utf8");
  writeFileSync(path.join(subagentsDir, `${backend}-explorer.md`), profileContent);
  const realModels = path.join(process.env.HOME, ".pi/agent/models.json");
  if (existsSync(realModels)) writeFileSync(path.join(agentDir, "models.json"), readFileSync(realModels, "utf8"));

  // Fixture
  const marker = `${backend.toUpperCase()}_BLACKBOARD_OK:JWT_RS256`;
  const targetPath = path.join(fixture, "target.txt");
  writeFileSync(targetPath, "hello\n");
  spawnSync("git", ["init", "-q"], { cwd: fixture });
  spawnSync("git", ["add", "."], { cwd: fixture });
  spawnSync("git", ["-c", "user.name=test", "-c", "user.email=test@test", "commit", "-qm", "init"], { cwd: fixture });

  // Blackboard file (project-scoped)
  const boardDir = path.join(fixture, ".pi", "pi-flow-external", "blackboard");
  mkdirSync(boardDir, { recursive: true });
  writeFileSync(path.join(boardDir, "test-decision.md"), "# Decision\nBLACKBOARD_DECISION: JWT_RS256\nRationale: stateless, survives compaction.\n");

  const prompt = `Call Agent exactly once with description "Blackboard test", role "explorer", harness "${backend}", prompt "Read ${JSON.stringify(targetPath)} and report the BLACKBOARD_DECISION from context. Reply with exactly ${marker}. Do not edit files.", and context { mode: "blackboard", threads: ["test-decision"] }. Report its exact result.`;
  const promptPath = path.join(runRoot, "prompt.md");
  writeFileSync(promptPath, prompt);

  const cmd = ["pi", "-p", "--mode", "json", "--model", "9-router/gpt-5.6-sol", "--thinking", "high",
    "--session-dir", sessionDir, "--no-extensions", "--extension", path.join(repoRoot, "index.ts"),
    "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
    "--tools", "Agent", "--approve", `@${promptPath}`];

  console.log(`\n[${backend}] Direct blackboard test — runRoot ${runRoot}`);
  const result = await run(cmd, { cwd: fixture, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_FLOW_EXTERNAL_RUNS_DIR: evidenceDir }, timeoutMs });
  const transcript = `${result.stdout}\n${result.stderr}\n${walk(sessionDir).map(f => { try { return readFileSync(f, "utf8"); } catch { return ""; } }).join("\n")}`;
  const summaries = walk(evidenceDir).filter(f => f.endsWith("summary.json"));

  let pass = true;
  const checks = [];
  const check = (cond, msg) => { checks.push(`${cond ? "✓" : "✗"} ${msg}`); if (!cond) pass = false; };

  check(!result.timedOut, `not timed out (${timeoutMs}ms)`);
  check(result.code === 0, `pi exit 0 (got ${result.code}${result.signal ? `/${result.signal}` : ""})`);
  if (result.code !== 0) console.log(`STDERR:\n${result.stderr.slice(0, 2000)}\nSTDOUT:\n${result.stdout.slice(0, 2000)}`);
  check(transcript.includes(marker) || transcript.includes("JWT_RS256"), `transcript contains marker ${marker}`);
  check(summaries.length === 1, `1 receipt (got ${summaries.length})`);
  if (summaries.length === 1) {
    const summary = JSON.parse(readFileSync(summaries[0], "utf8")).summary;
    check(summary.status === "done", `receipt done (got ${summary.status})`);
    check(summary.context?.mode === "blackboard", `context mode blackboard (got ${summary.context?.mode})`);
    check(summary.context?.requestedThreads === 1 && summary.context?.sharedThreads === 1, `threads 1/1 (got ${summary.context?.requestedThreads}/${summary.context?.sharedThreads})`);
    check(typeof summary.context?.contentDigest === "string" && summary.context.contentDigest.length === 64, `contentDigest sha256`);
    check(summary.context?.bytes > 0, `bytes >0 (got ${summary.context?.bytes})`);
    console.log(`  Receipt: ${JSON.stringify(summary.context)}`);
  }
  check(spawnSync("git", ["status", "--short"], { cwd: fixture, encoding: "utf8" }).stdout.trim() === "" || spawnSync("git", ["status", "--short"], { cwd: fixture, encoding: "utf8" }).stdout.trim().split("\n").every(l => l.includes(".pi/")), "fixture clean (except .pi board)");

  for (const c of checks) console.log(`  ${c}`);
  console.log(`  ${pass ? "PASS" : "FAIL"} [${backend}] direct`);

  if (!keep) rmSync(runRoot, { recursive: true, force: true });
  else console.log(`  Kept ${runRoot}`);
  return pass;
}

async function testWorkflow(backend) {
  const runRoot = path.join(tmpdir(), `board-wf-${backend}-${Date.now()}`);
  const fixture = path.join(runRoot, "fixture");
  const sessionDir = path.join(runRoot, "sessions");
  const evidenceDir = path.join(runRoot, "evidence");
  const agentDir = path.join(runRoot, "agent");
  const subagentsDir = path.join(agentDir, "subagents");
  for (const d of [fixture, sessionDir, evidenceDir, subagentsDir]) mkdirSync(d, { recursive: true });

  const realProfile = path.join(process.env.HOME, ".pi/agent/subagents", `${backend}-explorer.md`);
  writeFileSync(path.join(subagentsDir, `${backend}-explorer.md`), readFileSync(realProfile, "utf8"));
  const realModels = path.join(process.env.HOME, ".pi/agent/models.json");
  if (existsSync(realModels)) writeFileSync(path.join(agentDir, "models.json"), readFileSync(realModels, "utf8"));
  // Also need a second profile for workflow second agent (same backend, different role or same)
  const realProfile2 = path.join(process.env.HOME, ".pi/agent/subagents", `${backend}-reviewer.md`);
  if (existsSync(realProfile2)) writeFileSync(path.join(subagentsDir, `${backend}-reviewer.md`), readFileSync(realProfile2, "utf8"));

  writeFileSync(path.join(fixture, "target.txt"), "hello\n");
  spawnSync("git", ["init", "-q"], { cwd: fixture });
  spawnSync("git", ["add", "."], { cwd: fixture });
  spawnSync("git", ["-c", "user.name=test", "-c", "user.email=test@test", "commit", "-qm", "init"], { cwd: fixture });

  // Workflow: pre-create board file, then two readers via blackboard (per-agent read)
  // Writer-via-agent is tested separately; here we test that blackboard survives workflow and is read per-agent.
  const boardDir = path.join(fixture, ".pi/pi-flow-external/blackboard");
  mkdirSync(boardDir, { recursive: true });
  writeFileSync(path.join(boardDir, "wf-decision.md"), "# WF Decision\nWF_MARKER: WORKFLOW_BOARD_OK\nRationale: durable thread.");
  const workflow = `export const meta = { name: "board_workflow", description: "Board workflow test" };
const a = await agent("Report the WF_MARKER from context. Reply with exactly WF_MARKER: WORKFLOW_BOARD_OK. Do not edit files.", { label: "reader-a", role: "explorer", harness: "${backend}", context: { mode: "blackboard", threads: ["wf-decision"] } });
const b = await agent("Report the WF_MARKER from context. Reply with exactly WF_MARKER: WORKFLOW_BOARD_OK. Do not edit files.", { label: "reader-b", role: "reviewer", harness: "${backend}", context: { mode: "blackboard", threads: ["wf-decision"] } });
return { a, b };
`;
  const prompt = `Call workflow exactly once with this exact script:\n\n${workflow}\n\nReport the returned values.`;
  const promptPath = path.join(runRoot, "prompt.md");
  writeFileSync(promptPath, prompt);

  const cmd = ["pi", "-p", "--mode", "json", "--model", "9-router/gpt-5.6-sol", "--thinking", "high",
    "--session-dir", sessionDir, "--no-extensions", "--extension", path.join(repoRoot, "index.ts"),
    "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
    "--tools", "workflow", "--approve", `@${promptPath}`];

  console.log(`\n[${backend}] Workflow blackboard test — runRoot ${runRoot}`);
  const result = await run(cmd, { cwd: fixture, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_FLOW_EXTERNAL_RUNS_DIR: evidenceDir }, timeoutMs: 240_000 });
  const transcript = `${result.stdout}\n${result.stderr}\n${walk(sessionDir).map(f => { try { return readFileSync(f, "utf8"); } catch { return ""; } }).join("\n")}`;
  const summaries = walk(evidenceDir).filter(f => f.endsWith("summary.json"));

  let pass = true;
  const checks = [];
  const check = (cond, msg) => { checks.push(`${cond ? "✓" : "✗"} ${msg}`); if (!cond) pass = false; };

  check(!result.timedOut, `not timed out`);
  check(result.code === 0, `pi exit 0 (got ${result.code}${result.signal ? `/${result.signal}` : ""})`);
  if (result.code !== 0) console.log(`STDERR:\n${result.stderr.slice(0, 3000)}\nSTDOUT:\n${result.stdout.slice(0, 3000)}`);
  check(transcript.includes("WORKFLOW_BOARD_OK") || transcript.includes("WF_WRITE_OK"), `transcript contains workflow marker`);
  check(summaries.length === 2, `2 receipts (got ${summaries.length})`);
  if (summaries.length >= 2) {
    for (const s of summaries) {
      const summary = JSON.parse(readFileSync(s, "utf8")).summary;
      console.log(`  Receipt: ${summary.description} -> ${JSON.stringify(summary.context)} status=${summary.status}`);
    }
    const readerSummary = summaries.map(f => JSON.parse(readFileSync(f, "utf8")).summary).find(s => s.context?.mode === "blackboard");
    check(!!readerSummary, `reader has blackboard context`);
    if (readerSummary) check(readerSummary.status === "done", `reader done`);
  }

  for (const c of checks) console.log(`  ${c}`);
  console.log(`  ${pass ? "PASS" : "FAIL"} [${backend}] workflow`);

  if (!keep) rmSync(runRoot, { recursive: true, force: true });
  else console.log(`  Kept ${runRoot}`);
  return pass;
}

let allPass = true;
for (const b of backends) {
  const p1 = await testDirect(b);
  allPass &&= p1;
}
for (const b of backends) {
  const p2 = await testWorkflow(b);
  allPass &&= p2;
}
console.log(`\n${allPass ? "ALL PASS" : "SOME FAILED"}`);
process.exitCode = allPass ? 0 : 1;
