import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveResume } from "../src/core/resume.ts";
import { pruneRunRecords } from "../src/core/retention.ts";

const roots: string[] = [];
function tempRoot(): string {
  const path = mkdtempSync(join(tmpdir(), "pi-flow-retention-"));
  roots.push(path);
  return path;
}

afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

function writeRecord(runsDir: string, runId: string, summary: unknown, complete = true): void {
  const directory = join(runsDir, runId);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "events.ndjson"), "{}\n");
  if (complete) {
    writeFileSync(join(directory, "summary.json"), JSON.stringify({ version: 1, runId, summary }));
  }
}
describe("resume resolution", () => {
  it("resolves a recorded session id for the same backend", async () => {
    const root = tempRoot();
    const runsDir = join(root, "runs");
    writeRecord(runsDir, "run_abc", { backend: "claude", sessionId: "sess-1" });
    const resolved = await resolveResume(runsDir, "run_abc", "claude");
    expect(resolved.session).toEqual({ runId: "run_abc", sessionId: "sess-1", backend: "claude" });
  });

  it("rejects a backend mismatch instead of cross-harness resume", async () => {
    const root = tempRoot();
    const runsDir = join(root, "runs");
    writeRecord(runsDir, "run_abc", { backend: "codex", sessionId: "thread-1" });
    const resolved = await resolveResume(runsDir, "run_abc", "claude");
    expect(resolved.error).toMatch(/same backend/);
  });

  it("rejects unknown or incomplete records and malformed ids", async () => {
    const root = tempRoot();
    const runsDir = join(root, "runs");
    writeRecord(runsDir, "run_incomplete", { backend: "claude" }, false);
    expect((await resolveResume(runsDir, "run_missing", "claude")).error).toMatch(/No completed run record/);
    expect((await resolveResume(runsDir, "run_incomplete", "claude")).error).toMatch(/No completed run record/);
    expect((await resolveResume(runsDir, "../escape", "claude")).error).toMatch(/Invalid resume run id/);
  });
});

describe("run record retention", () => {
  it("prunes oldest completed records beyond the cap and keeps incomplete ones", async () => {
    const root = tempRoot();
    const runsDir = join(root, "runs");
    // Distinct mtimes so ordering is deterministic: oldest first.
    for (let index = 0; index < 4; index++) {
      writeRecord(runsDir, `run_old${index}`, { backend: "claude", sessionId: `s${index}` });
      const path = join(runsDir, `run_old${index}`);
      const time = new Date(Date.now() - (10 - index) * 60_000);
      // touch with explicit mtime, preserving the runId completion marker
      const fs = await import("node:fs");
      fs.utimesSync(path, time, time);
      fs.utimesSync(join(path, "summary.json"), time, time);
    }
    writeRecord(runsDir, "run_active", { backend: "claude" }, false);
    rmSync(join(runsDir, "run_active", "events.ndjson"));

    const { pruned, kept } = await pruneRunRecords(runsDir, 3);
    expect(pruned).toHaveLength(1);
    expect(pruned[0]).toContain("run_old0");
    expect(kept).toBe(3);
    // Active/incomplete records are never candidates.
    const fs = await import("node:fs");
    expect(fs.existsSync(join(runsDir, "run_active"))).toBe(true);
  });

  it("keeps damaged or mismatched summaries instead of pruning them", async () => {
    const root = tempRoot();
    const runsDir = join(root, "runs");
    writeRecord(runsDir, "run_a", { backend: "claude", sessionId: "s" });
    writeRecord(runsDir, "run_b", { backend: "claude", sessionId: "s" });
    writeFileSync(join(runsDir, "run_b", "summary.json"), "{not json");
    writeRecord(runsDir, "run_c", { backend: "claude", sessionId: "s" });
    // run_d's summary names a different run: damaged evidence.
    writeRecord(runsDir, "run_d", { backend: "claude", sessionId: "s" });
    writeFileSync(join(runsDir, "run_d", "summary.json"), JSON.stringify({ runId: "run_x", summary: {} }));
    const fs = await import("node:fs");
    const { pruned } = await pruneRunRecords(runsDir, 2);
    expect(pruned).toEqual([]);
    expect(fs.existsSync(join(runsDir, "run_d"))).toBe(true);
    expect(fs.existsSync(join(runsDir, "run_b"))).toBe(true);
  });

  it("keeps everything when disabled", async () => {
    const root = tempRoot();
    const runsDir = join(root, "runs");
    writeRecord(runsDir, "run_a", { backend: "claude", sessionId: "s" });
    const { pruned } = await pruneRunRecords(runsDir, 0);
    expect(pruned).toEqual([]);
  });
});
