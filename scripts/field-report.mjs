#!/usr/bin/env node

import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const json = args.includes("--json");
const explicitDirectory = args.find((arg) => arg !== "--json");
const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const directory = resolve(
  explicitDirectory ||
  process.env.PI_FLOW_EXTERNAL_RUNS_DIR ||
  join(agentDir, "pi-flow-external", "runs"),
);

const records = await loadRecords(directory);
const report = summarize(records, directory);

if (json) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  printHumanReport(report);
}

async function loadRecords(baseDirectory) {
  let entries;
  try {
    entries = await readdir(baseDirectory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }

  const loaded = await Promise.all(entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("run_"))
    .map(async (entry) => {
      try {
        const document = JSON.parse(await readFile(join(baseDirectory, entry.name, "summary.json"), "utf8"));
        return {
          ...document.summary,
          runId: document.runId || entry.name,
          startedAt: document.startedAt,
          finishedAt: document.finishedAt,
          recordIncomplete: false,
        };
      } catch {
        return loadIncompleteRecord(baseDirectory, entry.name);
      }
    }));
  return loaded.filter(Boolean);
}

async function loadIncompleteRecord(baseDirectory, runId) {
  let events = [];
  try {
    events = (await readFile(join(baseDirectory, runId, "events.ndjson"), "utf8"))
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return undefined;
        }
      })
      .filter(Boolean);
  } catch {
    // A run directory with no readable files is still useful failure evidence.
  }

  const started = events.find((event) => event.type === "run_started");
  const finished = events.findLast((event) => event.type === "run_finished");
  const recoveredSummary = finished?.data?.summary || {};
  return {
    ...recoveredSummary,
    runId,
    backend: recoveredSummary.backend || started?.data?.profile?.backend || "unknown",
    profile: recoveredSummary.profile || started?.data?.profile?.name || "unknown",
    description: recoveredSummary.description || started?.data?.description,
    status: recoveredSummary.status || "incomplete",
    error: recoveredSummary.error || "summary.json is missing or unreadable",
    backendEventCount: finite(recoveredSummary.backendEventCount)
      ?? events.filter((event) => event.type === "backend_event").length,
    startedAt: started?.timestamp,
    finishedAt: finished?.timestamp,
    recordIncomplete: true,
  };
}

function summarize(records, baseDirectory) {
  const chronological = [...records].sort((left, right) =>
    String(left.finishedAt || left.startedAt || "").localeCompare(String(right.finishedAt || right.startedAt || "")));
  const byStatus = countBy(records, (record) => record.status || "unknown");
  const byBackend = countBy(records, (record) => record.backend || "unknown");
  const durations = records.map((record) => finite(record.durationMs)).filter((value) => value !== undefined);
  const usage = records.reduce((totals, record) => {
    totals.input += finite(record.usage?.input) || 0;
    totals.output += finite(record.usage?.output) || 0;
    totals.cacheRead += finite(record.usage?.cacheRead) || 0;
    const cost = finite(record.usage?.cost) || 0;
    totals.cost += cost;
    if (record.usage?.costEstimated === true) totals.estimatedCost += cost;
    else if (record.usage?.costKnown === true) totals.reportedCost += cost;
    if (record.usage?.costKnown !== true) totals.unknownCostRuns++;
    return totals;
  }, { input: 0, output: 0, cacheRead: 0, cost: 0, reportedCost: 0, estimatedCost: 0, unknownCostRuns: 0 });

  return {
    directory: baseDirectory,
    runs: records.length,
    byStatus,
    byBackend,
    averageDurationMs: durations.length
      ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length)
      : 0,
    usage,
    incompleteRecords: records.filter((record) => record.recordIncomplete === true).length,
    runsWithNoBackendEvents: records.filter((record) => !finite(record.backendEventCount)).length,
    runsWithNestedActivity: records.filter((record) => record.nestedActivitySeen === true).length,
    runsWithExtendedTimeout: records.filter((record) => record.nestedTimeoutExtended === true).length,
    recentFailures: chronological
      .filter((record) => record.recordIncomplete || (record.status && record.status !== "done"))
      .slice(-5)
      .map((record) => ({
        runId: record.runId,
        backend: record.backend,
        profile: record.profile,
        status: record.status,
        error: record.error,
      })),
  };
}

function countBy(values, keyFor) {
  const counts = {};
  for (const value of values) {
    const key = keyFor(value);
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function finite(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function printHumanReport(report) {
  const status = Object.entries(report.byStatus).map(([key, value]) => `${key}=${value}`).join(", ") || "none";
  const backend = Object.entries(report.byBackend).map(([key, value]) => `${key}=${value}`).join(", ") || "none";
  process.stdout.write([
    `pi-flow-external field report`,
    `records: ${report.directory}`,
    `runs: ${report.runs}`,
    `status: ${status}`,
    `backends: ${backend}`,
    `average duration: ${(report.averageDurationMs / 1000).toFixed(1)}s`,
    `tokens: input=${report.usage.input} output=${report.usage.output} cache-read=${report.usage.cacheRead}`,
    `cost: reported=$${report.usage.reportedCost.toFixed(4)} estimated=$${report.usage.estimatedCost.toFixed(4)} unknown-cost runs=${report.usage.unknownCostRuns}`,
    `missing/unreadable summaries: ${report.incompleteRecords}`,
    `no structured backend events: ${report.runsWithNoBackendEvents}`,
    `nested activity observed: ${report.runsWithNestedActivity}`,
    `nested timeout extended: ${report.runsWithExtendedTimeout}`,
  ].join("\n") + "\n");
  if (report.recentFailures.length) {
    process.stdout.write("recent failures:\n");
    for (const failure of report.recentFailures) {
      process.stdout.write(`- ${failure.runId} ${failure.backend}/${failure.profile} ${failure.status}: ${failure.error || "unknown error"}\n`);
    }
  }
}
