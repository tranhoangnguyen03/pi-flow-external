#!/usr/bin/env node
// 3-way experiment harness for #29: recent vs blackboard vs handoff
// Offline by default (measures bytes without spawning pi). Use --real for live checks.
// Usage:
//   node scripts/experiments/blackboard-compare.mjs              # offline, no tokens (Node 22+ strips TS)
//   npx tsx scripts/experiments/blackboard-compare.mjs           # offline via tsx
//   node scripts/experiments/blackboard-compare.mjs --real       # prints real-backend checklist
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const args = process.argv.slice(2);
const real = args.includes("--real");

function mockMessages() {
  const user = (text) => ({ role: "user", content: text, timestamp: 0 });
  const assistant = (blocks) => ({ role: "assistant", content: blocks, timestamp: 0 });
  const toolResult = (id, name, text) => ({ role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text }], isError: false, timestamp: 0 });
  return [
    user("We need JWT auth with refresh tokens. Use RS256, 15m access, 7d refresh."),
    assistant([{ type: "text", text: "Acknowledged. Will use RS256." }]),
    user("Map the repo structure for auth module"),
    assistant([{ type: "toolCall", id: "read1", name: "read", arguments: { path: "/repo/src/auth" } }]),
    toolResult("read1", "read", "src/auth/jwt.ts, src/auth/refresh.ts, src/auth/middleware.ts"),
    assistant([{ type: "text", text: "Mapped 3 auth files." }]),
    user("Design the login flow: POST /login returns access+refresh, POST /refresh rotates"),
    assistant([{ type: "text", text: "Design: login validates creds, issues tokens; refresh validates refresh token, rotates both." }]),
    user("Implement login endpoint read-only review first"),
    assistant([{ type: "toolCall", id: "read2", name: "read", arguments: { path: "/repo/src/routes/login.ts" } }]),
    toolResult("read2", "read", "login.ts: 42 lines, uses bcrypt, no rate limit"),
    user("Now implement the fix with rate limiting"),
  ];
}

async function offline() {
  const { prepareParentContext, prepareBlackboardContext, resolveBlackboardDir } = await import("../../src/core/parent-context.ts");
  const messages = mockMessages();
  const cwd = mkdtempSync(join(tmpdir(), "board-compare-"));
  const boardDir = resolveBlackboardDir(cwd);
  mkdirSync(boardDir, { recursive: true });
  const threadText = `# API Auth Decision\nDecision: JWT RS256, 15m access / 7d refresh, POST /login + POST /refresh with rotation.\nRationale: stateless, survives compaction.\nFiles: src/auth/jwt.ts, src/auth/refresh.ts\nOpen: rate limit on /login`;
  writeFileSync(join(boardDir, "api-auth.md"), threadText);
  writeFileSync(join(boardDir, "login-design.md"), "Design: login validates creds via bcrypt, issues tokens; refresh rotates. No rate limit yet.");

  const arms = [
    { name: "recent 1", fn: () => prepareParentContext("Implement rate limit on /login", { mode: "recent", turns: 1 }, messages, undefined, undefined, cwd) },
    { name: "recent 3", fn: () => prepareParentContext("Implement rate limit on /login", { mode: "recent", turns: 3 }, messages, undefined, undefined, cwd) },
    { name: "full", fn: () => prepareParentContext("Implement rate limit on /login", { mode: "full" }, messages, undefined, undefined, cwd) },
    { name: "blackboard 1", fn: () => prepareBlackboardContext("Implement rate limit on /login", { mode: "blackboard", threads: ["api-auth"] }, cwd) },
    { name: "blackboard 2", fn: () => prepareBlackboardContext("Implement rate limit on /login", { mode: "blackboard", threads: ["api-auth", "login-design"] }, cwd) },
    { name: "handoff", fn: () => ({ prompt: "Implement rate limit on /login. Context: JWT RS256, 15m/7d, POST /login + POST /refresh. Repo: /repo", context: undefined }) },
  ];

  console.log(`\n# Blackboard compare — offline (mock ${messages.length} messages, ${messages.filter(m=>m.role==="user").length} user turns)\n`);
  console.log(`| arm | bytes | messages/threads | receipt |`);
  console.log(`|---|---|---|---|`);
  for (const arm of arms) {
    try {
      const { prompt, context } = arm.fn();
      const bytes = context?.bytes ?? Buffer.byteLength(prompt, "utf8");
      const meta = context ? `${context.messages} msgs` + (context.contentDigest ? ` digest ${context.contentDigest.slice(0,8)}` : "") : "no context";
      const receipt = context ? `${context.mode} ${context.sharedTurns ?? context.sharedThreads}/${context.requestedTurns ?? context.requestedThreads ?? "?"}` : "handoff";
      console.log(`| ${arm.name} | ${bytes} | ${meta} | ${receipt} |`);
    } catch (e) {
      console.log(`| ${arm.name} | ERR | - | ${String(e.message).slice(0,80)} |`);
    }
  }
  console.log(`\nDurability: recent/full die on compaction/session restart; blackboard survives (file on disk).`);
  console.log(`Selection effort: recent=1 int, blackboard=1-2 slugs (after Agent A writes file), handoff=parent rewrites.\n`);
  rmSync(cwd, { recursive: true, force: true });

  console.log(`---\nReal-backend checklist (costs tokens, run manually):`);
  console.log(`  1. Explorer maps repo -> Implementer needs map (measure repeated reads)`);
  console.log(`  2. Planner designs API -> Reviewer needs design (measure missed requirements)`);
  console.log(`  3. Explorer+Planner -> Implementer synthesizes (measure bytes + durability after compaction)`);
  console.log(`For each arm, check:`);
  console.log(`  jq '.summary.context | {mode, bytes, messages}' $PI_FLOW_EXTERNAL_RUNS_DIR/run_*/summary.json`);
  console.log(`  grep -c '\"name\":\"read\"' $PI_FLOW_EXTERNAL_RUNS_DIR/run_*/events.ndjson  # repeated exploration`);
  console.log(`  # durability: compact session, switch harness claude->agy, re-resolve\n`);
}

async function runReal() {
  console.log(`\n# Real run — manual steps (each costs tokens):\n`);
  console.log(`  # Arm 1: recent 3`);
  console.log(`  pi -p --mode json --extension ./index.ts --tools Agent --approve @prompt-recent.md`);
  console.log(`  # Arm 2: blackboard (first write .pi/pi-flow-external/blackboard/api-auth.md)`);
  console.log(`  pi -p --mode json --extension ./index.ts --tools Agent --approve @prompt-board.md`);
  console.log(`  # Arm 3: handoff (no context, self-contained prompt)`);
  console.log(`  pi -p --mode json --extension ./index.ts --tools Agent --approve @prompt-handoff.md`);
  console.log(`\nSee offline table for expected bytes. Real runs add: repeated reads, missed reqs, durability.\n`);
}

if (real) await runReal();
else await offline();
