#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const defaults = {
  claude: { model: "claude-sonnet-5", thinking: "high" },
  codex: { model: "gpt-5.6-sol", thinking: "high" },
  agy: { model: "gemini-3.7-flash-high", thinking: "high" },
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
    keep: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const value = () => {
      if (argv[index + 1] === undefined) throw new Error(`${arg} requires a value`);
      return argv[++index];
    };
    if (arg === "--backend") options.backend = value();
    else if (arg === "--model") options.model = value();
    else if (arg === "--thinking") options.thinking = value();
    else if (arg === "--root-model") options.rootModel = value();
    else if (arg === "--root-thinking") options.rootThinking = value();
    else if (arg === "--agent-dir") options.agentDir = path.resolve(value());
    else if (arg === "--run-root") options.runRoot = path.resolve(value());
    else if (arg === "--timeout-ms") options.timeoutMs = Number(value());
    else if (arg === "--workflow") options.workflow = true;
    else if (arg === "--keep") options.keep = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!Object.hasOwn(defaults, options.backend)) throw new Error("--backend must be claude, codex, or agy");
  options.agentDir ??= path.join(options.runRoot, "agent");
  options.model ??= defaults[options.backend].model;
  options.thinking ??= defaults[options.backend].thinking;
  return options;
}

function help() {
  console.log(`Usage: npm run e2e -- [options]\n\n  --backend <claude|codex|agy>  external backend (default: codex)\n  --model <id>                  child model (backend default when omitted)\n  --thinking <level>            child thinking (default: high)\n  --root-model <provider/model> root Pi model (default: openai-codex/gpt-5.6-sol)\n  --root-thinking <level>       root thinking (default: high)\n  --workflow                    test workflow instead of direct Agent\n  --agent-dir <dir>             Pi agent directory (default: isolated under run root)\n  --run-root <dir>              temporary output directory\n  --timeout-ms <ms>             process timeout (default: 180000)\n  --keep                        preserve profile and output`);
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
    const child = spawn(command[0], command.slice(1), { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 3000).unref();
    }, options.timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut });
    });
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
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

  const marker = `${options.backend.toUpperCase()}_EXTERNAL_OK:${options.model}-${options.thinking}`;
  const targetPath = path.join(fixture, "e2e-target.txt");
  writeFileSync(targetPath, `${options.model}-${options.thinking}\n`);
  spawnSync("git", ["init", "-q"], { cwd: fixture });
  spawnSync("git", ["add", "."], { cwd: fixture });
  spawnSync("git", ["-c", "user.name=pi-flow-e2e", "-c", "user.email=e2e@example.invalid", "commit", "-qm", "fixture"], { cwd: fixture });

  const profileName = `zz-e2e-${options.backend}-${Date.now()}`;
  const profilePath = path.join(subagentsDir, `${profileName}.md`);
  writeFileSync(profilePath, `---\ndescription: Temporary ${options.backend} E2E profile.\nbackend: ${options.backend}\nmodel: ${options.model}\nthinking: ${options.thinking}\n---\nRead requested files and reply exactly as instructed. Do not edit files.\n`, { flag: "wx" });
  if (!options.keep) cleanupProfilePath = profilePath;

  const childPrompt = `Read ${JSON.stringify(targetPath)} and reply with exactly ${options.backend.toUpperCase()}_EXTERNAL_OK:<trimmed file content>. Do not edit files.`;
  const workflow = `export const meta = { name: "external_e2e", description: "External workflow smoke" };\nconst results = await parallel([\n  () => agent(${JSON.stringify(childPrompt)}, { label: "one", subagent_type: ${JSON.stringify(profileName)} }),\n  () => agent(${JSON.stringify(childPrompt)}, { label: "two", subagent_type: ${JSON.stringify(profileName)} })\n]);\nreturn results;`;
  const rootPrompt = options.workflow
    ? `Call workflow exactly once with this exact script:\n\n${workflow}\n\nReport the returned token lines.`
    : `Call Agent exactly once with description "External smoke", subagent_type "${profileName}", and prompt ${JSON.stringify(childPrompt)}. Report its exact result.`;
  const promptPath = path.join(options.runRoot, "prompt.md");
  writeFileSync(promptPath, rootPrompt);

  const command = [
    "pi", "-p", "--mode", "json", "--model", options.rootModel, "--thinking", options.rootThinking,
    "--session-dir", sessionDir, "--no-extensions", "--extension", path.join(repoRoot, "index.ts"),
    "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
    "--tools", options.workflow ? "workflow" : "Agent", "--approve", `@${promptPath}`,
  ];

  let result;
  try {
    console.log(`Running ${options.backend}${options.workflow ? " workflow" : " Agent"} E2E`);
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
    assert(transcript.includes(marker), `Expected marker not found: ${marker}`);
    assert(summaries.length === expectedRuns, `Expected ${expectedRuns} receipt(s), found ${summaries.length}`);
    assert(summaries.every((file) => JSON.parse(readFileSync(file, "utf8")).summary?.status === "done"), "A receipt was not done");
    assert(spawnSync("git", ["status", "--short"], { cwd: fixture, encoding: "utf8" }).stdout.trim() === "", "Fixture was modified");
    console.log(`PASS ${options.backend}${options.workflow ? " workflow" : " Agent"} E2E`);
  } finally {
    if (!options.keep) {
      try { unlinkSync(profilePath); } catch {}
      cleanupProfilePath = undefined;
      rmSync(options.runRoot, { recursive: true, force: true });
    } else if (result) {
      writeFileSync(path.join(options.runRoot, "stdout.jsonl"), result.stdout);
      writeFileSync(path.join(options.runRoot, "stderr.log"), result.stderr);
      console.log(`Kept ${options.runRoot} and ${profilePath}`);
    }
  }
}

main().catch((error) => {
  console.error(`FAIL external E2E: ${error instanceof Error ? error.stack || error.message : String(error)}`);
  process.exitCode = 1;
});
