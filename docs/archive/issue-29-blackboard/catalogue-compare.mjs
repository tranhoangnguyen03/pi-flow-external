#!/usr/bin/env node
/*
 * Real-session evaluation harness for #29 (parent-context sharing: none vs
 * recent vs blackboard vs handoff), scoped to the Catalogue project.
 *
 * Source of truth: the actual Catalogue session JSONL at SESSION_PATH below.
 * We extract the *real* ontology-contract-v0.2.md write (JSONL line 437) and
 * apply its later edit (line 484) verbatim from that transcript, then split
 * the resulting contract text into two source-grounded thread excerpts by
 * section. No synthetic mock conversation and no keyword/marker scoring
 * anywhere in this file.
 *
 * Arms:
 *   none       - task alone, no parent context.
 *   recent     - the real session transcript (every "message"/"compaction"
 *                entry up to the delegation point) run through the actual
 *                production `prepareParentContext({mode:"recent"})`.
 *   blackboard - the two extracted threads written as files under
 *                .pi/pi-flow-external/blackboard/ in the child's cwd, shared
 *                live via context:{mode:"blackboard", threads:[...]}.
 *   handoff    - the identical curated thread text (built with the real
 *                `prepareBlackboardContext` against the same two files),
 *                inlined directly into the prompt instead of read through
 *                the blackboard mechanism. Same content, different transport.
 *
 * Why recent/handoff are pre-built out-of-band: `context:{mode:"recent"}`
 * and blackboard's *file* reads both come from the extension's own code, but
 * "recent" replays the *live calling session's* history, which a one-shot
 * spawned `pi -p` process never has. We call the real, unmodified
 * `prepareParentContext`/`prepareBlackboardContext` functions from
 * src/core/parent-context.ts ourselves against the real extracted data, then
 * deliver the exact resulting prompt text to the child with context:none.
 * The "blackboard" arm alone is exercised live end-to-end, since it is
 * file-based and works the same from any process.
 *
 * The task given to every child is deliberately neutral: it names no
 * contract fact, gives no answer marker, and states no rubric. Output is
 * one JSON object per arm/backend to stdout (JSONL), carrying the task, the
 * context receipt/bytes, the child's verbatim final result, and the local
 * evidence path - for a human to read blind and judge yes/no per fact. This
 * script does not score, grep for keywords, or run an LLM judge.
 *
 * Usage:
 *   npx tsx scripts/experiments/catalogue-compare.mjs                        # offline (default): extraction + byte metrics only, no providers
 *   npx tsx scripts/experiments/catalogue-compare.mjs --real                  # run all 4 arms against every backend
 *   npx tsx scripts/experiments/catalogue-compare.mjs --real --backend claude --keep
 *   npx tsx scripts/experiments/catalogue-compare.mjs --real --recent-turns 5
 *
 * Guard: if the source session is missing, unreadable, or the contract
 * write/edit cannot be found, extraction throws before anything else runs -
 * in both offline and --real modes. There is no synthetic fallback and no
 * provider is ever launched without a real, extracted contract behind it.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SESSION_PATH = join(
  homedir(),
  ".pi/agent/sessions",
  "--Users-davidus-tranus-orca-workspaces-100x-Credit-Monitoring-Borrower-Catalogue--",
  "2026-09-06T09-53-28-833Z_01a07623-2100-73e8-8ca7-5e3ae8d9ca18.jsonl",
);
const CONTRACT_SUFFIX = "ontology-contract-v0.2.md";
const THREAD_A_ID = "catalogue-contract-a";
const THREAD_B_ID = "catalogue-contract-b";
const TASK =
  "This repository contains design work for a borrower information catalogue. Propose one concrete next " +
  "implementation step, and separately name one specific open risk or unresolved question in the current " +
  "design that should be resolved before that step is built. If you were given supporting material, say " +
  "which part of it your reasoning relies on; if you were not given any, say so explicitly.";

const args = process.argv.slice(2);
const real = args.includes("--real");
const keep = args.includes("--keep");
const backendFilter = args.includes("--backend") ? args[args.indexOf("--backend") + 1] : "both";
const backends = backendFilter === "both" ? ["claude", "agy"] : [backendFilter];
const recentTurns = args.includes("--recent-turns") ? Number(args[args.indexOf("--recent-turns") + 1]) : 8;
const timeoutMs = 1_800_000;

// --- Extraction: real session, no synthetic data ---

function loadSessionEntries() {
  if (!existsSync(SESSION_PATH)) {
    throw new Error(`Source session not found at ${SESSION_PATH}. No synthetic fallback; nothing was run.`);
  }
  return readFileSync(SESSION_PATH, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/** Replays the real write + later edit of ontology-contract-v0.2.md, verbatim. */
function extractContract(entries) {
  let content = null;
  let writeLine = null;
  const editLines = [];
  entries.forEach((entry, index) => {
    if (entry.type !== "message" || entry.message?.role !== "assistant") return;
    const blocks = Array.isArray(entry.message.content) ? entry.message.content : [];
    for (const block of blocks) {
      if (block.type !== "toolCall") continue;
      const toolArgs = block.arguments ?? {};
      if (typeof toolArgs.path !== "string" || !toolArgs.path.endsWith(CONTRACT_SUFFIX)) continue;
      if (typeof toolArgs.content === "string") {
        content = toolArgs.content;
        writeLine = index + 1;
      } else if (Array.isArray(toolArgs.edits)) {
        for (const edit of toolArgs.edits) {
          if (content && typeof edit.oldText === "string" && content.includes(edit.oldText)) {
            content = content.replace(edit.oldText, edit.newText ?? "");
            editLines.push(index + 1);
          }
        }
      }
    }
  });
  if (!content) {
    throw new Error(`Could not find a ${CONTRACT_SUFFIX} write in ${SESSION_PATH}. No synthetic fallback; nothing was run.`);
  }
  return { content, writeLine, editLines };
}

/** Splits the real contract into two roughly-even, source-grounded excerpts by numbered section. */
function splitContractIntoThreads(contract) {
  const sections = contract.content.split(/\n(?=## \d)/);
  const preamble = sections[0];
  const numbered = sections.slice(1);
  const half = Math.ceil(numbered.length / 2);
  const provenance = `<!-- source: ${path.basename(SESSION_PATH)}, ${CONTRACT_SUFFIX} write@line ${contract.writeLine}${
    contract.editLines.length ? `, edit@line ${contract.editLines.join(",")}` : ""
  } -->\n\n`;
  return [
    { id: THREAD_A_ID, text: provenance + [preamble, ...numbered.slice(0, half)].join("\n") },
    { id: THREAD_B_ID, text: provenance + numbered.slice(half).join("\n") },
  ];
}

/** The real transcript, converted to the same shape the extension captures live (no mock data). */
function sessionMessages(entries) {
  const messages = [];
  for (const entry of entries) {
    if (entry.type === "message") messages.push(entry.message);
    else if (entry.type === "compaction") messages.push({ role: "compactionSummary", summary: entry.summary, timestamp: entry.timestamp });
  }
  return messages;
}

function countUserTurns(messages) {
  return messages.filter((message) => message.role === "user").length;
}

async function buildArmPrompts(threads, messages) {
  const { prepareParentContext, prepareBlackboardContext } = await import("../../src/core/parent-context.ts");
  const boardScratch = mkdtempSync(join(tmpdir(), "catalogue-board-"));
  const boardDir = join(boardScratch, ".pi/pi-flow-external/blackboard");
  mkdirSync(boardDir, { recursive: true });
  for (const thread of threads) writeFileSync(join(boardDir, `${thread.id}.md`), thread.text);

  const recent = prepareParentContext(TASK, { mode: "recent", turns: recentTurns }, messages, undefined, undefined, boardScratch);
  const handoff = prepareBlackboardContext(TASK, { mode: "blackboard", threads: threads.map((t) => t.id) }, boardScratch);
  rmSync(boardScratch, { recursive: true, force: true });
  return { recent, handoff };
}

// --- Offline: extraction + byte metrics, no providers ---

async function offline() {
  const entries = loadSessionEntries();
  const contract = extractContract(entries);
  const threads = splitContractIntoThreads(contract);
  const messages = sessionMessages(entries);
  const { recent, handoff } = await buildArmPrompts(threads, messages);

  console.log(`\n# Catalogue impact (#29) — offline extraction from real session\n`);
  console.log(`Session: ${SESSION_PATH}`);
  console.log(`Contract: write@line ${contract.writeLine}, edit@line ${contract.editLines.join(",") || "none"}, ${contract.content.length} chars`);
  console.log(`Threads: ${threads.map((t) => `${t.id} (${Buffer.byteLength(t.text)}B)`).join(", ")}`);
  console.log(`Transcript: ${messages.length} messages, ${countUserTurns(messages)} user turns\n`);

  console.log(`| arm | bytes | shared user turns | transport |`);
  console.log(`|---|---|---|---|`);
  console.log(`| none | 0 | 0 | none |`);
  console.log(`| recent ${recentTurns} | ${recent.context?.bytes ?? 0} | ${recent.context?.sharedTurns ?? 0} | live context:recent (computed here against real transcript) |`);
  console.log(`| blackboard | ${threads.reduce((n, t) => n + Buffer.byteLength(t.text), 0)} | - | live context:blackboard (file read in child cwd) |`);
  console.log(`| handoff | ${Buffer.byteLength(handoff.prompt)} | - | inlined prompt, same curated text as blackboard, no file |`);

  console.log(`\nRun live: npx tsx scripts/experiments/catalogue-compare.mjs --real [--backend claude|agy] [--recent-turns N] [--keep]\n`);
}

// --- Real: isolated child calls through the existing pi/Agent pattern ---

function walk(root) {
  const files = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) visit(full);
      else files.push(full);
    }
  };
  if (existsSync(root)) visit(root);
  return files;
}

function run(cmd, opts) {
  return new Promise((resolve) => {
    const child = spawn(cmd[0], cmd.slice(1), { ...opts, stdio: ["ignore", "pipe", "pipe"] });
    const stdoutChunks = [];
    const stderrChunks = [];
    const append = (chunks, chunk) => {
      chunks.push(chunk);
      let size = chunks.reduce((total, value) => total + value.length, 0);
      while (size > 200_000) size -= chunks.shift().length;
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 3000).unref();
    }, opts.timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => append(stdoutChunks, chunk));
    child.stderr.on("data", (chunk) => append(stderrChunks, chunk));
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout: stdoutChunks.join(""), stderr: stderrChunks.join("") });
    });
  });
}

async function runArm({ backend, armName, prompt, context, fixture, sessionDir, evidenceDir, agentDir }) {
  const contextArg = context ? `, context: ${JSON.stringify(context)}` : "";
  const wrapper =
    `Call Agent exactly once with description "catalogue #29 - ${armName}", role "explorer", harness "${backend}", ` +
    `prompt ${JSON.stringify(prompt)}${contextArg}. Report its exact result verbatim and nothing else.`;
  const promptPath = join(tmpdir(), `catalogue-${backend}-${armName}-${Date.now()}.md`);
  writeFileSync(promptPath, wrapper);

  const cmd = [
    "pi", "-p", "--mode", "json", "--model", "9-router/gpt-5.6-sol", "--thinking", "high",
    "--session-dir", sessionDir, "--no-extensions", "--extension", path.join(repoRoot, "index.ts"),
    "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
    "--tools", "Agent", "--approve", `@${promptPath}`,
  ];
  const result = await run(cmd, { cwd: fixture, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_FLOW_EXTERNAL_RUNS_DIR: evidenceDir }, timeoutMs });

  const summaryPath = walk(evidenceDir).find((f) => f.endsWith("summary.json"));
  const summary = summaryPath ? JSON.parse(readFileSync(summaryPath, "utf8")).summary : null;
  const record = {
    arm: armName,
    backend,
    task: prompt,
    exitCode: result.code,
    status: summary?.status ?? null,
    result: summary?.result ?? null,
    contextReceipt: summary?.context ?? null,
    evidencePath: summaryPath ?? null,
  };
  if (!summaryPath) record.driverOutput = { stdout: result.stdout.slice(0, 2000), stderr: result.stderr.slice(0, 2000) };
  for (const f of walk(evidenceDir)) { try { rmSync(f); } catch { /* best-effort cleanup */ } }
  for (const f of walk(sessionDir)) { try { rmSync(f); } catch { /* best-effort cleanup */ } }
  return record;
}

async function realRun() {
  const entries = loadSessionEntries();
  const contract = extractContract(entries);
  const threads = splitContractIntoThreads(contract);
  const messages = sessionMessages(entries);
  const { recent, handoff } = await buildArmPrompts(threads, messages);

  for (const backend of backends) {
    const runRoot = mkdtempSync(join(tmpdir(), `catalogue-${backend}-`));
    const fixture = join(runRoot, "fixture");
    const sessionDir = join(runRoot, "sessions");
    const evidenceDir = join(runRoot, "evidence");
    const agentDir = join(runRoot, "agent");
    const subagentsDir = join(agentDir, "subagents");
    for (const dir of [fixture, sessionDir, evidenceDir, subagentsDir]) mkdirSync(dir, { recursive: true });
    spawnSync("git", ["init", "-q"], { cwd: fixture });
    writeFileSync(join(fixture, "README.md"), "# fixture\n");
    spawnSync("git", ["add", "."], { cwd: fixture });
    spawnSync("git", ["-c", "user.name=test", "-c", "user.email=test@test", "commit", "-qm", "init"], { cwd: fixture });

    const profilePath = join(homedir(), ".pi/agent/subagents", `${backend}-explorer.md`);
    if (existsSync(profilePath)) writeFileSync(join(subagentsDir, `${backend}-explorer.md`), readFileSync(profilePath, "utf8"));
    const modelsPath = join(homedir(), ".pi/agent/models.json");
    if (existsSync(modelsPath)) writeFileSync(join(agentDir, "models.json"), readFileSync(modelsPath, "utf8"));

    const boardDir = join(fixture, ".pi/pi-flow-external/blackboard");
    mkdirSync(boardDir, { recursive: true });
    for (const thread of threads) writeFileSync(join(boardDir, `${thread.id}.md`), thread.text);

    const arms = [
      { name: "none", prompt: TASK, context: undefined },
      { name: `recent-${recentTurns}`, prompt: recent.prompt, context: undefined },
      { name: "blackboard", prompt: TASK, context: { mode: "blackboard", threads: threads.map((t) => t.id) } },
      { name: "handoff", prompt: handoff.prompt, context: undefined },
    ];

    for (const arm of arms) {
      const record = await runArm({ backend, armName: arm.name, prompt: arm.prompt, context: arm.context, fixture, sessionDir, evidenceDir, agentDir });
      console.log(JSON.stringify(record));
    }

    if (!keep) rmSync(runRoot, { recursive: true, force: true });
    else console.error(`Kept ${runRoot}`);
  }
}

if (real) await realRun();
else await offline();
