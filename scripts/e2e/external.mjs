#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const defaults = {
  claude: { model: "claude-sonnet-5", thinking: "high" },
  codex: { model: "gpt-5.6-sol", thinking: "high" },
  agy: { model: "gemini-3.7-flash-high", thinking: "high" },
  // No fixed model/thinking default: a named pi harness pins its own model and
  // thinking in the caller's real harnesses.json; --harness names which one.
  pi: {},
};
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
let cleanupProfilePath;
process.once("exit", () => {
  if (cleanupProfilePath) {
    try { unlinkSync(cleanupProfilePath); } catch {}
  }
});

function parseArgs(argv) {
  const options = {
    backend: "codex",
    rootModel: "openai-codex/gpt-5.6-sol",
    rootThinking: "high",
    agentDir: process.env.PI_CODING_AGENT_DIR,
    runRoot: path.join(tmpdir(), `pi-flow-external-e2e-${Date.now()}`),
    timeoutMs: 180_000,
    workflow: false,
    interrupt: false,
    keep: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const value = () => {
      if (argv[index + 1] === undefined) throw new Error(`${arg} requires a value`);
      return argv[++index];
    };
    if (arg === "--backend") options.backend = value();
    else if (arg === "--harness") options.harness = value();
    else if (arg === "--model") options.model = value();
    else if (arg === "--thinking") options.thinking = value();
    else if (arg === "--root-model") options.rootModel = value();
    else if (arg === "--root-thinking") options.rootThinking = value();
    else if (arg === "--agent-dir") options.agentDir = path.resolve(value());
    else if (arg === "--run-root") options.runRoot = path.resolve(value());
    else if (arg === "--timeout-ms") options.timeoutMs = Number(value());
    else if (arg === "--workflow") options.workflow = true;
    else if (arg === "--interrupt") options.interrupt = true;
    else if (arg === "--keep") options.keep = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!Object.hasOwn(defaults, options.backend)) throw new Error("--backend must be claude, codex, agy, or pi");
  if (options.backend === "pi" && !options.harness) throw new Error("--backend pi requires --harness <name>, a pi-* harness already registered in your own real harnesses.json");
  if (options.backend !== "pi" && options.harness) throw new Error("--harness only applies to --backend pi");
  if (options.workflow && options.interrupt) throw new Error("--workflow and --interrupt are separate checks");
  // Only claude/codex/agy get an isolated, disposable agent dir by default:
  // this script writes their temporary profile file into it itself, so
  // isolation is safe and desirable. A named pi harness is the opposite case
  // — it is never written by this script, only read — so it must default to
  // the caller's REAL Pi agent directory (matching the README's own
  // PI_CODING_AGENT_DIR:-$HOME/.pi/agent convention), or every --backend pi
  // run would silently look at an empty, freshly-created isolated directory
  // that could never contain the harness the caller actually registered.
  options.agentDir ??= options.backend === "pi"
    ? (process.env.PI_CODING_AGENT_DIR || path.join(homedir(), ".pi", "agent"))
    : path.join(options.runRoot, "agent");
  options.model ??= defaults[options.backend].model;
  options.thinking ??= defaults[options.backend].thinking;
  return options;
}

function help() {
  console.log(`Usage: npm run e2e -- [options]\n\n  --backend <claude|codex|agy|pi>  external backend (default: codex)\n  --harness <name>              required with --backend pi: a pi-* harness already registered in your own real harnesses.json\n  --model <id>                  child model (backend default when omitted; ignored for pi, which pins its own)\n  --thinking <level>            child thinking (default: high; ignored for pi, which pins its own)\n  --root-model <provider/model> root Pi model (default: openai-codex/gpt-5.6-sol)\n  --root-thinking <level>       root thinking (default: high)\n  --workflow                    test supervised background workflow\n  --interrupt                   cancel a background Agent and inspect its evidence\n  --agent-dir <dir>             Pi agent directory (default: isolated under run root)\n  --run-root <dir>              temporary output directory\n  --timeout-ms <ms>             process timeout (default: 180000)\n  --keep                        preserve profile and output`);
}

function walk(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory)) {
      const file = path.join(directory, entry);
      if (statSync(file).isDirectory()) visit(file);
      else files.push(file);
    }
  };
  if (existsSync(root)) visit(root);
  return files;
}

function run(command, options) {
  return new Promise((resolve) => {
    const child = spawn(command[0], command.slice(1), { ...options, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const terminateTree = (force) => {
      if (process.platform === "win32") {
        const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", ...(force ? ["/f"] : [])], { stdio: "ignore", windowsHide: true });
        killer.once("error", () => {});
        killer.unref();
      } else {
        try { process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM"); } catch {}
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminateTree(false);
      setTimeout(() => terminateTree(true), 10_000).unref();
    }, options.timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({ code: 1, signal: null, stdout, stderr: `${stderr}\n${error.message}`.trim(), timedOut: false });
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut });
    });
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/**
 * Doctor-style precheck: confirm the named pi harness actually resolves in
 * the real, on-disk harnesses.json before spending time launching the real
 * pi process. Mirrors /external doctor's own pi-aware check (model shape and
 * presence only; it cannot verify live provider auth from a standalone
 * script) rather than letting a missing/misspelled harness surface only as a
 * confusing failure deep inside the spawned pi run.
 */
function preflightPiHarness(agentDir, harnessName) {
  const harnessesPath = path.join(agentDir, "pi-flow-external", "harnesses.json");
  if (!existsSync(harnessesPath)) {
    throw new Error(`No harnesses.json found at ${harnessesPath}. Register "${harnessName}" first via /external profile create.`);
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(harnessesPath, "utf8"));
  } catch (error) {
    throw new Error(`${harnessesPath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const harnesses = parsed && typeof parsed === "object" ? parsed.harnesses : undefined;
  const entry = harnesses && typeof harnesses === "object" ? harnesses[harnessName] : undefined;
  if (!entry || typeof entry.model !== "string" || !entry.model.trim()) {
    const registered = harnesses && typeof harnesses === "object" ? Object.keys(harnesses) : [];
    throw new Error(
      `Harness "${harnessName}" is not registered in ${harnessesPath}. ` +
      `Registered harnesses: ${registered.join(", ") || "none"}.`,
    );
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) return help();

  mkdirSync(options.runRoot, { recursive: true });
  const fixture = path.join(options.runRoot, "fixture");
  const sessionDir = path.join(options.runRoot, "sessions");
  const evidenceDir = path.join(options.runRoot, "evidence");
  const subagentsDir = path.join(options.agentDir, "subagents");
  for (const directory of [fixture, sessionDir, evidenceDir, subagentsDir]) mkdirSync(directory, { recursive: true });

  const isPi = options.backend === "pi";
  // A named pi harness is not a spawned CLI: canonical synthesis already
  // provides all six default roles for any registered harness, so this
  // script targets the "worker" role directly rather than writing a
  // temporary custom profile file the way it does for claude/codex/agy.
  const harnessName = isPi ? options.harness : options.backend;
  if (isPi) preflightPiHarness(options.agentDir, harnessName);
  const okToken = isPi ? `PI_EXTERNAL_OK:${harnessName}` : `${options.backend.toUpperCase()}_EXTERNAL_OK:${options.model}-${options.thinking}`;
  const targetContent = isPi ? `${harnessName}\n` : `${options.model}-${options.thinking}\n`;
  const marker = okToken;
  const targetPath = path.join(fixture, "e2e-target.txt");
  writeFileSync(targetPath, targetContent);
  spawnSync("git", ["init", "-q"], { cwd: fixture });
  spawnSync("git", ["add", "."], { cwd: fixture });
  spawnSync("git", ["-c", "user.name=pi-flow-e2e", "-c", "user.email=e2e@example.invalid", "commit", "-qm", "fixture"], { cwd: fixture });

  const role = isPi ? "worker" : `zz-e2e-${Date.now()}`;
  let profilePath;
  if (!isPi) {
    const profileName = `${options.backend}-${role}`;
    profilePath = path.join(subagentsDir, `${profileName}.md`);
    writeFileSync(profilePath, `---\ndescription: Temporary ${options.backend} E2E profile.\nbackend: ${options.backend}\nmodel: ${options.model}\nthinking: ${options.thinking}\n---\nRead requested files and reply exactly as instructed. Do not edit files.\n`, { flag: "wx" });
    if (!options.keep) cleanupProfilePath = profilePath;
  }

  const childPrompt = options.interrupt
    ? `Read ${JSON.stringify(targetPath)}, report ${marker}, then keep inspecting the read-only fixture until cancelled. Do not edit files.`
    : `Read ${JSON.stringify(targetPath)} and reply with exactly ${okToken}:<trimmed file content>. Do not edit files.`;
  const workflow = `export const meta = { apiVersion: 1, name: "external_e2e", description: "External workflow smoke" };\nconst results = await parallel([\n  () => agent(${JSON.stringify(childPrompt)}, { label: "one", role: ${JSON.stringify(role)}, harness: ${JSON.stringify(harnessName)} }),\n  () => agent(${JSON.stringify(childPrompt)}, { label: "two", role: ${JSON.stringify(role)}, harness: ${JSON.stringify(harnessName)} })\n]);\nreturn results;`;
  const rootPrompt = options.workflow
    ? `Call workflow exactly once with background:true and this exact script:\n\n${workflow}\n\nUse external_runs wait on the returned workflow run ID, then inspect its output and summary. Report the returned token lines and WORKFLOW_SUPERVISION_OK.`
    : options.interrupt
      ? `Call Agent exactly once with background:true, description "External interruption smoke", role ${JSON.stringify(role)}, harness ${JSON.stringify(harnessName)}, and prompt ${JSON.stringify(childPrompt)}. Cancel its returned run ID with external_runs using reason "E2E requested cancellation", wait for that run, then inspect its output and diagnostics. Report E2E_CANCELLED.`
      : `Call Agent exactly once with description "External smoke", role ${JSON.stringify(role)}, harness ${JSON.stringify(harnessName)}, and prompt ${JSON.stringify(childPrompt)}. Report its exact result.`;
  const promptPath = path.join(options.runRoot, "prompt.md");
  writeFileSync(promptPath, rootPrompt);

  const command = [
    "pi", "-p", "--mode", "json", "--model", options.rootModel, "--thinking", options.rootThinking,
    "--session-dir", sessionDir, "--no-extensions", "--extension", path.join(repoRoot, "index.ts"),
    "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
    "--tools", options.workflow ? "workflow,external_runs" : options.interrupt ? "Agent,external_runs" : "Agent", "--approve", `@${promptPath}`,
  ];

  let result;
  try {
    const mode = options.workflow ? " workflow" : options.interrupt ? " interrupted Agent" : " Agent";
    console.log(`Running ${options.backend}${mode} E2E`);
    result = await run(command, {
      cwd: fixture,
      env: { ...process.env, PI_CODING_AGENT_DIR: options.agentDir, PI_FLOW_EXTERNAL_RUNS_DIR: evidenceDir },
      timeoutMs: options.timeoutMs,
    });
    const transcript = `${result.stdout}\n${result.stderr}\n${walk(sessionDir).map((file) => readFileSync(file, "utf8")).join("\n")}`;
    const summaries = walk(evidenceDir).filter((file) => file.endsWith("summary.json"));
    const expectedRuns = options.workflow ? 2 : 1;
    assert(!result.timedOut, `Pi timed out after ${options.timeoutMs}ms`);
    assert(result.code === 0, `Pi exited with ${result.code}${result.signal ? ` (${result.signal})` : ""}\n${result.stderr}`);
    if (options.interrupt) assert(transcript.includes("E2E_CANCELLED"), "Root did not report the requested cancellation");
    else assert(transcript.includes(marker), `Expected marker not found: ${marker}`);
    assert(summaries.length === expectedRuns, `Expected ${expectedRuns} receipt(s), found ${summaries.length}`);
    const receipts = summaries.map((file) => JSON.parse(readFileSync(file, "utf8")).summary);
    const expectedStatus = options.interrupt ? "aborted" : "done";
    assert(receipts.every((summary) => summary?.status === expectedStatus), `A receipt was not ${expectedStatus}`);
    if (options.interrupt) assert(receipts.every((summary) => summary?.outcome === "cancelled" && summary?.error === "E2E requested cancellation"), "Cancellation outcome or reason was not preserved");
    if (options.workflow) assert(transcript.includes("WORKFLOW_SUPERVISION_OK") && transcript.includes("external_runs"), "Workflow supervision was not exercised");
    assert(spawnSync("git", ["status", "--short"], { cwd: fixture, encoding: "utf8" }).stdout.trim() === "", "Fixture was modified");
    console.log(`PASS ${options.backend}${mode} E2E`);
  } finally {
    if (!options.keep) {
      if (profilePath) { try { unlinkSync(profilePath); } catch {} }
      cleanupProfilePath = undefined;
      rmSync(options.runRoot, { recursive: true, force: true });
    } else if (result) {
      writeFileSync(path.join(options.runRoot, "stdout.jsonl"), result.stdout);
      writeFileSync(path.join(options.runRoot, "stderr.log"), result.stderr);
      console.log(`Kept ${options.runRoot}${profilePath ? ` and ${profilePath}` : ""}`);
    }
  }
}

main().catch((error) => {
  console.error(`FAIL external E2E: ${error instanceof Error ? error.stack || error.message : String(error)}`);
  process.exitCode = 1;
});
