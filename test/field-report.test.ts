import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];
const reportScript = new URL("../scripts/field-report.mjs", import.meta.url);

async function makeRunDirectory(baseDirectory: string, runId: string): Promise<string> {
  const directory = join(baseDirectory, runId);
  await mkdir(directory, { recursive: true });
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe("field report", () => {
  it("counts complete runs and keeps missing summaries visible", async () => {
    const baseDirectory = await mkdtemp(join(tmpdir(), "pi-flow-field-report-"));
    temporaryDirectories.push(baseDirectory);

    const completeDirectory = await makeRunDirectory(baseDirectory, "run_complete");
    await writeFile(join(completeDirectory, "summary.json"), JSON.stringify({
      version: 1,
      runId: "run_complete",
      startedAt: "2026-08-21T00:00:00.000Z",
      finishedAt: "2026-08-21T00:01:00.000Z",
      eventCount: 5,
      attemptedEventCount: 5,
      writeErrorCount: 0,
      summary: {
        backend: "codex",
        profile: "codex-reviewer",
        status: "done",
        durationMs: 60_000,
        backendEventCount: 3,
        nestedActivitySeen: true,
        nestedTimeoutExtended: true,
        usage: { input: 100, output: 20, cacheRead: 10, cost: 0.01, costKnown: true },
      },
    }));
    await writeFile(join(completeDirectory, "events.ndjson"), [
      { type: "run_started" },
      { type: "backend_event" },
      { type: "backend_event" },
      { type: "backend_event" },
      { type: "run_finished" },
    ].map((event) => JSON.stringify(event)).join("\n") + "\n");

    const incompleteDirectory = await makeRunDirectory(baseDirectory, "run_incomplete");
    await writeFile(join(incompleteDirectory, "events.ndjson"), [
      JSON.stringify({
        runId: "run_incomplete",
        timestamp: "2026-08-21T00:02:00.000Z",
        type: "run_started",
        data: { description: "Agy review", profile: { backend: "agy", name: "agy-reviewer" } },
      }),
      JSON.stringify({
        runId: "run_incomplete",
        timestamp: "2026-08-21T00:02:10.000Z",
        type: "backend_event",
        data: { event: { event: "init" } },
      }),
    ].join("\n") + "\n");

    const damagedDirectory = await makeRunDirectory(baseDirectory, "run_damaged");
    await writeFile(join(damagedDirectory, "summary.json"), JSON.stringify({
      version: 1,
      runId: "run_damaged",
      startedAt: "2026-08-21T00:03:00.000Z",
      finishedAt: "2026-08-21T00:04:00.000Z",
      eventCount: 2,
      attemptedEventCount: 3,
      writeErrorCount: 1,
      summary: {
        backend: "claude",
        profile: "claude-reviewer",
        status: "done",
        backendEventCount: 2,
      },
    }));
    await writeFile(join(damagedDirectory, "events.ndjson"), [
      JSON.stringify({ type: "run_started" }),
      JSON.stringify({ type: "backend_event" }),
    ].join("\n") + "\n");

    const malformedDirectory = await makeRunDirectory(baseDirectory, "run_malformed");
    await writeFile(join(malformedDirectory, "summary.json"), "{}\n");

    const output = execFileSync(process.execPath, [reportScript.pathname, "--json", baseDirectory], {
      encoding: "utf8",
    });
    const report = JSON.parse(output);

    expect(report).toMatchObject({
      runs: 4,
      byStatus: { done: 2, incomplete: 2 },
      byBackend: { codex: 1, agy: 1, claude: 1, unknown: 1 },
      averageDurationMs: 60_000,
      incompleteRecords: 3,
      runsWithNoBackendEvents: 1,
      runsWithNestedActivity: 1,
      runsWithExtendedTimeout: 1,
      usage: {
        input: 100,
        output: 20,
        cacheRead: 10,
        cost: 0.01,
        reportedCost: 0.01,
        estimatedCost: 0,
        unknownCostRuns: 3,
      },
    });
    expect(report.recentFailures).toEqual(expect.arrayContaining([
      expect.objectContaining({
        runId: "run_incomplete",
        backend: "agy",
        profile: "agy-reviewer",
        status: "incomplete",
      }),
      expect.objectContaining({
        runId: "run_damaged",
        backend: "claude",
        status: "done",
        error: expect.stringContaining("write errors"),
      }),
      expect.objectContaining({
        runId: "run_malformed",
        status: "incomplete",
      }),
    ]));
  });
});
