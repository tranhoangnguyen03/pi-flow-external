#!/usr/bin/env -S node --experimental-transform-types
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const defaults = {
  claude: { model: "claude-sonnet-5", thinking: "high" },
  codex: { model: "gpt-5.6-sol", thinking: "high" },
  agy: { model: "gemini-3.7-flash-high", thinking: "high" },
  grok: { model: "grok-4.6", thinking: "high" },
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
    routingSmoke: false,
    rootModel: "openai-codex/gpt-5.6-sol",
    rootThinking: "high",
    runRoot: path.join(tmpdir(), `pi-flow-external-e2e-${randomUUID()}`),
    timeoutMs: 180_000,
    workflow: false,
    interrupt: false,
    keep: false,
  };
  let rootModelProvided = false;
  let rootThinkingProvided = false;
  let agentDirProvided = false;
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
    else if (arg === "--root-model") { options.rootModel = value(); rootModelProvided = true; }
    else if (arg === "--root-thinking") { options.rootThinking = value(); rootThinkingProvided = true; }
    else if (arg === "--agent-dir") { options.agentDir = path.resolve(value()); agentDirProvided = true; }
    else if (arg === "--run-root") options.runRoot = path.resolve(value());
    else if (arg === "--timeout-ms") options.timeoutMs = Number(value());
    else if (arg === "--workflow") options.workflow = true;
    else if (arg === "--interrupt") options.interrupt = true;
    else if (arg === "--routing-smoke") options.routingSmoke = true;
    else if (arg === "--keep") options.keep = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!Object.hasOwn(defaults, options.backend)) throw new Error("--backend must be claude, codex, agy, grok, or pi");
  if (options.backend === "pi" && !options.harness) throw new Error("--backend pi requires --harness <name>, a pi-* harness already registered in your own real harnesses.json");
  if (options.backend !== "pi" && options.harness) throw new Error("--harness only applies to --backend pi");
  if (options.workflow && options.interrupt) throw new Error("--workflow and --interrupt are separate checks");
  // --root-model/--root-thinking only mean anything when a real root Pi LLM is
  // actually prompted to choose the tool call, which only happens in the
  // --routing-smoke lane. The default deterministic lane below never prompts
  // a root model at all (it calls Agent/workflow/external_runs directly), so
  // accepting these flags there would silently do nothing and mislead callers
  // into thinking they changed root behavior.
  if (!options.routingSmoke && (rootModelProvided || rootThinkingProvided)) {
    throw new Error("--root-model and --root-thinking only apply to --routing-smoke");
  }
  // Only claude/codex/agy/grok get an isolated, disposable agent dir by
  // default: this script writes their temporary profile file into it itself,
  // so isolation is safe and desirable. This default is unconditional — an
  // inherited PI_CODING_AGENT_DIR from the caller's shell is deliberately
  // ignored unless --agent-dir was passed explicitly, otherwise a real
  // agent dir left set in the environment (as docs/field-testing.md itself
  // tells callers to export) would silently defeat isolation. A named pi
  // harness is the opposite case — it is never written by this script, only
  // read — so it must default to the caller's REAL Pi agent directory
  // (matching the README's own PI_CODING_AGENT_DIR:-$HOME/.pi/agent
  // convention), or every --backend pi run would silently look at an empty,
  // freshly-created isolated directory that could never contain the harness
  // the caller actually registered.
  options.agentDir ??= options.backend === "pi"
    ? (process.env.PI_CODING_AGENT_DIR || path.join(homedir(), ".pi", "agent"))
    : path.join(options.runRoot, "agent");
  options.agentDirProvided = agentDirProvided;
  options.model ??= defaults[options.backend].model;
  options.thinking ??= defaults[options.backend].thinking;
  return options;
}

function help() {
  console.log(`Usage: npm run e2e -- [options]

  --backend <claude|codex|agy|grok|pi>  external backend (default: codex)
  --harness <name>              required with --backend pi: a pi-* harness already registered in your own real harnesses.json
  --model <id>                  child model (backend default when omitted; ignored for pi, which pins its own)
  --thinking <level>            child thinking (default: high; ignored for pi, which pins its own)
  --workflow                    test a blocking two-child workflow instead of a single direct Agent call
  --interrupt                   launch a background Agent, then cancel/wait/inspect it through external_runs
  --agent-dir <dir>             Pi agent directory (default: isolated under run root; real dir for --backend pi)
  --run-root <dir>              temporary output directory
  --timeout-ms <ms>             per-child subagent timeout, and basis for the script's own watchdog (default: 180000)
  --keep                        preserve profile and output

Default mode is deterministic and root-model-free: it builds an in-process
Pi SDK session with a faux, never-prompted root model and calls the
Agent/workflow/external_runs tool executors directly, so tool selection is
never left to a live LLM decision. The selected external backend's child
process (or, for --backend pi, its in-process nested Pi child) is real.

  --routing-smoke                switch to the natural-language coordinator routing check instead: spawns a real
                                  "pi" CLI process with a real root model and asks it, in plain language, to call
                                  the right tool. Requires real agent config (a working root model/auth) and is
                                  never the default; use it only when role discovery, tool descriptions, or
                                  coordinator guidance changes.
  --root-model <provider/model>  --routing-smoke only: root Pi model (default: openai-codex/gpt-5.6-sol)
  --root-thinking <level>        --routing-smoke only: root thinking (default: high)`);
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

/** Bound on how long withWatchdog waits for aborted work to actually settle before giving up on draining it. */
const WATCHDOG_DRAIN_GRACE_MS = 15_000;

/**
 * Races `promise` against a timeout. Unlike a bare `Promise.race`, a timeout
 * here first aborts `controller` (so the underlying tool call — a real
 * spawned child process, or an in-process nested pi child — is told to stop)
 * and then waits (up to WATCHDOG_DRAIN_GRACE_MS) for `promise` to actually
 * settle before this function returns. A caller's `finally` therefore never
 * runs cleanup (removing runRoot, restoring env vars) while that work is
 * still active: a bare race would let the loser keep running unobserved,
 * potentially still holding files open under a directory about to be
 * deleted, or leaving a real backend process orphaned.
 */
function withWatchdog(promise, controller, timeoutMs, message) {
  const settleQuietly = promise.then(() => {}, () => {});
  return (async () => {
    let timer;
    let timedOut = false;
    await Promise.race([settleQuietly, new Promise((resolve) => { timer = setTimeout(() => { timedOut = true; resolve(); }, timeoutMs); })]);
    clearTimeout(timer);
    if (!timedOut) return promise;
    controller.abort(message);
    await Promise.race([settleQuietly, new Promise((resolve) => setTimeout(resolve, WATCHDOG_DRAIN_GRACE_MS))]);
    throw new Error(message);
  })();
}

/**
 * Doctor-style precheck: confirm the named pi harness actually resolves in
 * the real, on-disk harnesses.json before spending time on the real backend
 * call. Mirrors /external doctor's own pi-aware check (model shape and
 * presence only; it cannot verify live provider auth from a standalone
 * script) rather than letting a missing/misspelled harness surface only as a
 * confusing failure deep inside session construction.
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

// The fixture content is an unpredictable nonce, generated fresh per run and
// never told to the child in the prompt — only written into the file it must
// read. A prior version derived the file content from options.model/thinking,
// which was also embedded (as a suffix) in the very token the child was asked
// to prefix its answer with; against real grok that self-referential overlap
// let a child that only echoed the token (never actually reading the file)
// still land a plausible-looking but wrong reply, and in one observed
// workflow run one of two parallel children in fact dropped the file-content
// half entirely. A random nonce shares nothing with any part of the prompt,
// so reproducing it is only possible by actually reading the file.
function buildFixture(fixture) {
  const nonce = randomUUID();
  const targetContent = `${nonce}\n`;
  const targetPath = path.join(fixture, "e2e-target.txt");
  writeFileSync(targetPath, targetContent);
  spawnSync("git", ["init", "-q"], { cwd: fixture });
  spawnSync("git", ["add", "."], { cwd: fixture });
  spawnSync("git", ["-c", "user.name=pi-flow-e2e", "-c", "user.email=e2e@example.invalid", "commit", "-qm", "fixture"], { cwd: fixture });
  // The expected result is the nonce itself: no concatenation, no format to
  // get subtly wrong, and nothing derivable without reading the file.
  return { marker: nonce, targetPath, expectedResult: nonce };
}

function buildReadPrompt(targetPath) {
  return `Read the file at ${JSON.stringify(targetPath)} and reply with exactly its full contents, trimmed of leading and trailing whitespace, and nothing else — no extra words, quotes, or labels. Do not edit files.`;
}

function assertFixtureClean(fixture) {
  assert(spawnSync("git", ["status", "--short"], { cwd: fixture, encoding: "utf8" }).stdout.trim() === "", "Fixture was modified");
}

// ---------------------------------------------------------------------------
// --routing-smoke: the original natural-language coordinator check. A real
// root Pi LLM reads a plain-language instruction and decides which tool to
// call; that decision is inherently non-deterministic and provider-billed,
// so this lane is opt-in only and never the default backend gate.
// ---------------------------------------------------------------------------

async function runRoutingSmoke(options) {
  // As in runDeterministic: run-root creation is the only thing that must
  // precede the try/finally. Every other failure (preflight, fixture,
  // profile, or model-mirroring setup) must still reach the same cleanup,
  // or a leftover temp directory survives an early throw.
  mkdirSync(options.runRoot, { recursive: true });

  let profilePath;
  let result;
  // Assume failure until the try block reaches its final "PASS" line, so a
  // thrown assertion or setup error (the common case worth investigating)
  // preserves runRoot even without --keep; only a clean pass still cleans up.
  let failed = true;
  const mode = options.workflow ? " workflow" : options.interrupt ? " interrupted Agent" : " Agent";
  try {
    const fixture = path.join(options.runRoot, "fixture");
    const sessionDir = path.join(options.runRoot, "sessions");
    const evidenceDir = path.join(options.runRoot, "evidence");
    const subagentsDir = path.join(options.agentDir, "subagents");
    for (const directory of [fixture, sessionDir, evidenceDir, subagentsDir]) mkdirSync(directory, { recursive: true });

    const isPi = options.backend === "pi";
    const harnessName = isPi ? options.harness : options.backend;
    if (isPi) preflightPiHarness(options.agentDir, harnessName);

    // A real custom root model (e.g. openai-codex/gpt-5.6-sol) is only ever
    // registered in the caller's REAL agent dir's models.json/auth.json. This
    // lane's CLI-backend default agent dir is an isolated temp directory (safe
    // for the temp profile file below), so mirror just those two files in —
    // read-only against the real dir, written only into the isolated one —
    // rather than either mutating the real dir or leaving the root model
    // unresolvable, which previously surfaced as an unrelated coordinator
    // startup failure.
    if (!isPi) {
      const realAgentDir = process.env.PI_CODING_AGENT_DIR || path.join(homedir(), ".pi", "agent");
      for (const file of ["models.json", "auth.json"]) {
        const source = path.join(realAgentDir, file);
        if (existsSync(source)) copyFileSync(source, path.join(options.agentDir, file));
      }
    }

    const { marker, targetPath } = buildFixture(fixture);

    const role = isPi ? "worker" : `zz-e2e-${randomUUID()}`;
    if (!isPi) {
      const profileName = `${options.backend}-${role}`;
      profilePath = path.join(subagentsDir, `${profileName}.md`);
      writeFileSync(profilePath, `---\ndescription: Temporary ${options.backend} E2E profile.\nbackend: ${options.backend}\nmodel: ${options.model}\nthinking: ${options.thinking}\n---\nRead requested files and reply exactly as instructed. Do not edit files.\n`, { flag: "wx" });
      if (!options.keep) cleanupProfilePath = profilePath;
    }

    const childPrompt = options.interrupt
      ? `Read ${JSON.stringify(targetPath)}, report ${marker}, then keep inspecting the read-only fixture until cancelled. Do not edit files.`
      : buildReadPrompt(targetPath);
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

    console.log(`Running ${options.backend}${mode} routing-smoke E2E`);
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
    // The durable per-run summary record has no `outcome` field — that is
    // exclusively the live registry's `wait` projection (see
    // waitForActivityOrTerminal/runInterrupt in the deterministic lane
    // below). Here only status + the exact cancellation reason are ever
    // persisted, so only those are checked.
    if (options.interrupt) assert(receipts.every((summary) => summary?.error === "E2E requested cancellation"), "Cancellation reason was not preserved");
    if (options.workflow) assert(transcript.includes("WORKFLOW_SUPERVISION_OK") && transcript.includes("external_runs"), "Workflow supervision was not exercised");
    assertFixtureClean(fixture);
    console.log(`PASS ${options.backend}${mode} routing-smoke E2E`);
    failed = false;
  } finally {
    if (!options.keep && !failed) {
      if (profilePath) { try { unlinkSync(profilePath); } catch {} }
      cleanupProfilePath = undefined;
      rmSync(options.runRoot, { recursive: true, force: true });
    } else {
      if (result) {
        writeFileSync(path.join(options.runRoot, "stdout.jsonl"), result.stdout);
        writeFileSync(path.join(options.runRoot, "stderr.log"), result.stderr);
      }
      console.log(`${failed ? "Preserved failing run" : "Kept"} artifacts at ${options.runRoot}${profilePath ? ` and ${profilePath}` : ""}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Default deterministic lane: no root LLM is ever prompted. This builds an
// in-process Pi SDK session (faux, never-streamed root model) and calls the
// Agent/workflow/external_runs tool executors directly, exactly as
// test/agent-contract.test.ts does. The selected external backend's child
// (a real spawned CLI process, or, for --backend pi, a real in-process
// nested Pi child against the caller's real harnesses.json) is real.
// ---------------------------------------------------------------------------

function makeMockTheme(Theme) {
  const theme = new Theme({}, {}, "truecolor");
  theme.fg = (_color, text) => text;
  theme.bold = (text) => text;
  return theme;
}

async function buildDeterministicSession({ agentDir, cwd, sessionDir, subagentTimeoutMs }) {
  const { createSubagentExtension } = await import("../../src/pi-subagent.ts");
  const {
    AuthStorage,
    createAgentSession,
    DefaultResourceLoader,
    ModelRegistry,
    SessionManager,
    SettingsManager,
    Theme,
  } = await import("@earendil-works/pi-coding-agent");
  const { registerFauxProvider } = await import(
    "../../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/index.js"
  );

  // The root model is a placeholder: this script never calls session.prompt(),
  // so it is never streamed or resolved through the model registry. It exists
  // only because createAgentSession() and the tool ExtensionContext require a
  // concrete Model object.
  const registration = registerFauxProvider({ models: [{ id: "faux-e2e-root", name: "Faux E2E Root", reasoning: false }] });
  const rootModel = registration.getModel("faux-e2e-root");

  // setRuntimeApiKey is an in-memory-only override (never persisted to
  // auth.json), so this is safe even when agentDir is the caller's real,
  // read-only Pi agent directory (the --backend pi case).
  const authStorage = AuthStorage.create(path.join(agentDir, "auth.json"));
  authStorage.setRuntimeApiKey(rootModel.provider, "faux-e2e-key");
  const modelRegistry = ModelRegistry.create(authStorage, path.join(agentDir, "models.json"));
  const settingsManager = SettingsManager.inMemory({});
  const sessionManager = SessionManager.inMemory(cwd);
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    extensionFactories: [createSubagentExtension({ subagentTimeoutMs })],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    cwd,
    agentDir,
    authStorage,
    modelRegistry,
    model: rootModel,
    thinkingLevel: "high",
    settingsManager,
    sessionManager,
    resourceLoader,
  });
  await session.bindExtensions({});

  const theme = makeMockTheme(Theme);
  const ctx = {
    hasUI: false,
    cwd,
    model: rootModel,
    modelRegistry,
    sessionManager: {
      isPersisted: () => true,
      getSessionFile: () => path.join(sessionDir, "session.jsonl"),
      getSessionDir: () => sessionDir,
      getSessionId: () => "e2e-session",
      getBranch: () => [],
    },
    isProjectTrusted: () => false,
    ui: { getAllThemes: () => [], setStatus: () => {}, notify: () => {}, theme },
  };

  return {
    ctx,
    agentTool: session.getToolDefinition("Agent"),
    workflowTool: session.getToolDefinition("workflow"),
    runsTool: session.getToolDefinition("external_runs"),
    dispose: () => {
      session.dispose();
      registration.unregister();
    },
  };
}

async function runDirect({ agentTool, ctx }, { role, harnessName, childPrompt, expectedResult, evidenceDir, signal }) {
  const result = await agentTool.execute(
    "e2e-direct",
    { description: "External smoke", prompt: childPrompt, role, harness: harnessName },
    signal,
    undefined,
    ctx,
  );
  assert(result.details?.status === "done", `Agent call did not complete: ${JSON.stringify(result.details)}`);
  const actual = typeof result.details.result === "string" ? result.details.result.trim() : undefined;
  assert(actual === expectedResult, `Expected exact result ${JSON.stringify(expectedResult)}, got ${JSON.stringify(result.details.result)}`);
  const summaries = walk(evidenceDir).filter((file) => file.endsWith("summary.json"));
  assert(summaries.length === 1, `Expected 1 receipt, found ${summaries.length}`);
  const summary = JSON.parse(readFileSync(summaries[0], "utf8")).summary;
  assert(summary?.status === "done", `Receipt was not done: ${JSON.stringify(summary)}`);
  return [summary];
}

async function runWorkflowMode({ workflowTool, ctx }, { role, harnessName, childPrompt, expectedResult, evidenceDir, signal }) {
  const script = `export const meta = { apiVersion: 1, name: "external_e2e", description: "External workflow smoke" };\nconst results = await parallel([\n  () => agent(${JSON.stringify(childPrompt)}, { label: "one", role: ${JSON.stringify(role)}, harness: ${JSON.stringify(harnessName)} }),\n  () => agent(${JSON.stringify(childPrompt)}, { label: "two", role: ${JSON.stringify(role)}, harness: ${JSON.stringify(harnessName)} })\n]);\nreturn results;`;
  const result = await workflowTool.execute("e2e-workflow", { script, background: false }, signal, undefined, ctx);
  assert(result.details?.status === "completed", `Workflow did not complete: ${JSON.stringify(result.details)}`);
  const agents = result.details.agents ?? [];
  assert(agents.length === 2, `Expected 2 workflow children, found ${agents.length}`);
  assert(agents.every((agent) => agent.status === "done"), `A workflow child was not done: ${JSON.stringify(agents)}`);
  const returned = result.details.result;
  assert(
    Array.isArray(returned) && returned.length === 2 && returned.every((value) => typeof value === "string" && value.trim() === expectedResult),
    `Workflow result did not exactly match expected ${JSON.stringify(expectedResult)}: ${JSON.stringify(returned)}`,
  );
  const summaries = walk(evidenceDir).filter((file) => file.endsWith("summary.json"));
  assert(summaries.length === 2, `Expected 2 receipts, found ${summaries.length}`);
  const receipts = summaries.map((file) => JSON.parse(readFileSync(file, "utf8")).summary);
  assert(receipts.every((summary) => summary?.status === "done"), `A workflow child receipt was not done: ${JSON.stringify(receipts)}`);
  return receipts;
}

/**
 * Poll `inspect summary` until the run reports actual backend activity
 * (`state.firstActivityAt`), or reaches a terminal status without ever
 * reporting any — whichever comes first. Waiting on "running" alone only
 * proves the process started, not that the provider actually did anything
 * cancellable; requiring firstActivityAt before cancelling ensures the
 * interrupt exercises real, active provider cancellation.
 */
async function waitForActivityOrTerminal(runsTool, ctx, runId, timeoutMs, signal) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus;
  while (Date.now() < deadline) {
    const inspected = await runsTool.execute("e2e-poll-activity", { action: "inspect", runId, view: "summary" }, signal, undefined, ctx);
    const projection = JSON.parse(inspected.content[0].text);
    lastStatus = projection.state?.status;
    if (projection.state?.firstActivityAt) return projection;
    if (lastStatus && lastStatus !== "queued" && lastStatus !== "running") return projection;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Run ${runId} never reported activity within ${timeoutMs}ms (last status: ${lastStatus})`);
}

/** Follow an inspect view's nextCursor to exhaustion so paging is actually exercised, not just its first page. */
async function drainInspectPages(runsTool, ctx, runId, view, signal) {
  let cursor;
  let pages = 0;
  const MAX_PAGES = 1000;
  do {
    const inspected = await runsTool.execute(
      `e2e-inspect-${view}-${pages}`,
      { action: "inspect", runId, view, ...(cursor ? { cursor } : {}) },
      signal,
      undefined,
      ctx,
    );
    cursor = inspected.details?.nextCursor;
    pages += 1;
    assert(pages <= MAX_PAGES, `${view} inspection did not exhaust its nextCursor within ${MAX_PAGES} pages`);
  } while (cursor);
  return pages;
}

async function runInterrupt({ agentTool, runsTool, ctx }, { role, harnessName, targetPath, evidenceDir, signal }) {
  const childPrompt = `Read ${JSON.stringify(targetPath)}, then keep inspecting the read-only fixture until cancelled. Do not edit files.`;
  const launched = await agentTool.execute(
    "e2e-interrupt",
    { description: "External interruption smoke", prompt: childPrompt, role, harness: harnessName, background: true },
    signal,
    undefined,
    ctx,
  );
  assert(launched.details?.status === "queued" && typeof launched.details.runId === "string", `Background launch did not queue: ${JSON.stringify(launched.details)}`);
  const runId = launched.details.runId;

  const activityProjection = await waitForActivityOrTerminal(runsTool, ctx, runId, 60_000, signal);
  assert(
    activityProjection.state?.firstActivityAt,
    `Run ${runId} reached terminal status ${JSON.stringify(activityProjection.state?.status)} without ever reporting activity`,
  );

  await runsTool.execute("e2e-cancel", { action: "cancel", runId, reason: "E2E requested cancellation" }, signal, undefined, ctx);
  const waited = await runsTool.execute("e2e-wait", { action: "wait", runIds: [runId] }, signal, undefined, ctx);
  const outcome = waited.details?.outcomes?.[0];
  assert(outcome?.outcome === "cancelled" && outcome?.error === "E2E requested cancellation", `Cancellation outcome or reason was not preserved: ${JSON.stringify(outcome)}`);

  await drainInspectPages(runsTool, ctx, runId, "diagnostics", signal);
  await drainInspectPages(runsTool, ctx, runId, "output", signal);

  const summaries = walk(evidenceDir).filter((file) => file.endsWith("summary.json"));
  assert(summaries.length === 1, `Expected 1 receipt, found ${summaries.length}`);
  const summary = JSON.parse(readFileSync(summaries[0], "utf8")).summary;
  assert(
    summary?.status === "aborted" && summary?.error === "E2E requested cancellation",
    `Receipt was not aborted with the requested reason: ${JSON.stringify(summary)}`,
  );
}

/**
 * Grok reports native session/cost accounting (unlike codex/claude/agy,
 * which estimate or omit cost) — see AGENTS.md's "Grok supports `resume` via
 * its own `--resume <sessionId>` flag and reports native cost". A successful
 * grok receipt should therefore always carry a real sessionId and a known,
 * non-estimated, non-zero cost; other backends keep whatever cost semantics
 * their own tests already cover and are not asserted here.
 */
function assertReceiptSemantics(options, summary) {
  if (options.backend !== "grok") return;
  assert(typeof summary?.sessionId === "string" && summary.sessionId.length > 0, `Grok receipt missing a non-empty sessionId: ${JSON.stringify(summary)}`);
  const usage = summary?.usage;
  assert(usage?.costKnown === true, `Grok receipt usage.costKnown was not true: ${JSON.stringify(usage)}`);
  assert(usage?.costEstimated === false, `Grok receipt usage.costEstimated was not false: ${JSON.stringify(usage)}`);
  assert(typeof usage?.cost === "number" && usage.cost > 0, `Grok receipt usage.cost was not a positive number: ${JSON.stringify(usage)}`);
}

async function runDeterministic(options) {
  const isPi = options.backend === "pi";
  const harnessName = isPi ? options.harness : options.backend;

  // Everything from here on (preflight, fixture, profile, session
  // construction) can throw before ever reaching the try below; run-root
  // creation is the only thing that must precede the try/finally, so it is
  // the only statement outside it. Every other failure — including a
  // preflight rejection, the single most common real-world one for
  // --backend pi — must still reach the same cleanup.
  mkdirSync(options.runRoot, { recursive: true });

  let profilePath;
  let built;
  // Assume failure until the try block reaches its final "PASS" line, so a
  // thrown assertion, setup error, or watchdog timeout (the common cases
  // worth investigating) preserves runRoot even without --keep; only a
  // clean pass still cleans up.
  let failed = true;
  const originalAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
  const originalRunsDirEnv = process.env.PI_FLOW_EXTERNAL_RUNS_DIR;
  const mode = options.workflow ? " workflow" : options.interrupt ? " interrupted Agent" : " Agent";
  try {
    const fixture = path.join(options.runRoot, "fixture");
    const evidenceDir = path.join(options.runRoot, "evidence");
    const sessionDir = path.join(options.runRoot, "sessions");
    for (const directory of [fixture, evidenceDir, sessionDir]) mkdirSync(directory, { recursive: true });

    const agentDir = options.agentDir;
    const subagentsDir = path.join(agentDir, "subagents");
    mkdirSync(subagentsDir, { recursive: true });

    // Fail fast on a missing/misspelled harness before ever building the SDK
    // session, exactly like the routing-smoke lane's own precheck.
    if (isPi) preflightPiHarness(agentDir, harnessName);

    const { targetPath, expectedResult } = buildFixture(fixture);

    const role = isPi ? "worker" : `zz-e2e-${randomUUID()}`;
    if (!isPi) {
      profilePath = path.join(subagentsDir, `${options.backend}-${role}.md`);
      writeFileSync(
        profilePath,
        `---\ndescription: Temporary ${options.backend} E2E profile.\nbackend: ${options.backend}\nmodel: ${options.model}\nthinking: ${options.thinking}\n---\nRead requested files and reply exactly as instructed. Do not edit files.\n`,
        { flag: "wx" },
      );
      if (!options.keep) cleanupProfilePath = profilePath;
    }

    const childPrompt = buildReadPrompt(targetPath);

    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.PI_FLOW_EXTERNAL_RUNS_DIR = evidenceDir;

    console.log(`Running ${options.backend}${mode} deterministic E2E`);

    built = await buildDeterministicSession({
      agentDir,
      cwd: fixture,
      sessionDir,
      subagentTimeoutMs: options.timeoutMs,
    });
    const controller = new AbortController();
    const check = options.workflow
      ? runWorkflowMode(built, { role, harnessName, childPrompt, expectedResult, evidenceDir, signal: controller.signal })
      : options.interrupt
        ? runInterrupt(built, { role, harnessName, targetPath, evidenceDir, signal: controller.signal })
        : runDirect(built, { role, harnessName, childPrompt, expectedResult, evidenceDir, signal: controller.signal });
    const receipts = await withWatchdog(check, controller, options.timeoutMs + 30_000, `Deterministic ${options.backend}${mode} E2E timed out after ${options.timeoutMs + 30_000}ms`);
    if (!options.interrupt) {
      for (const summary of receipts) assertReceiptSemantics(options, summary);
    }
    assertFixtureClean(fixture);
    console.log(`PASS ${options.backend}${mode} deterministic E2E`);
    failed = false;
  } finally {
    built?.dispose();
    if (originalAgentDirEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDirEnv;
    if (originalRunsDirEnv === undefined) delete process.env.PI_FLOW_EXTERNAL_RUNS_DIR;
    else process.env.PI_FLOW_EXTERNAL_RUNS_DIR = originalRunsDirEnv;
    if (!options.keep && !failed) {
      if (profilePath) { try { unlinkSync(profilePath); } catch {} }
      cleanupProfilePath = undefined;
      rmSync(options.runRoot, { recursive: true, force: true });
    } else {
      console.log(`${failed ? "Preserved failing run" : "Kept"} artifacts at ${options.runRoot}${profilePath ? ` and ${profilePath}` : ""}`);
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) return help();

  if (options.routingSmoke) await runRoutingSmoke(options);
  else await runDeterministic(options);
}

main().catch((error) => {
  console.error(`FAIL external E2E: ${error instanceof Error ? error.stack || error.message : String(error)}`);
  process.exitCode = 1;
});
