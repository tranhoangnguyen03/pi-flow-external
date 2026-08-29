import { readFile, readdir, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const RUN_RECORDS_DIRECTORY_ENV = "PI_FLOW_EXTERNAL_RUNS_DIR";

/** Directory holding local external run records (env-overridable). */
export function runRecordsDirectory(): string {
  const configured = process.env[RUN_RECORDS_DIRECTORY_ENV]?.trim();
  return configured ? resolve(configured) : join(getAgentDir(), "pi-flow-external", "runs");
}

/**
 * Prune completed run records beyond `maxRecords`, oldest first.
 *
 * Only records whose `summary.json` exists are eligible: a record without a
 * summary is either still running or was interrupted, and deleting it could
 * kill the evidence of an active run. `maxRecords <= 0` keeps everything.
 */
export async function pruneRunRecords(
  runsDirectory: string,
  maxRecords: number,
): Promise<{ pruned: string[]; kept: number }> {
  if (!(maxRecords > 0)) {
    return { pruned: [], kept: 0 };
  }
  let entries: string[];
  try {
    entries = await readdir(runsDirectory);
  } catch {
    return { pruned: [], kept: 0 };
  }
  const completed: { directory: string; mtimeMs: number }[] = [];
  let kept = 0;
  for (const entry of entries) {
    if (!entry.startsWith("run_")) {
      continue;
    }
    const directory = join(runsDirectory, entry);
    try {
      // A summary is only a completion marker when it parses and matches its
      // run directory; damaged or partial evidence stays untouched.
      const summary = JSON.parse(await readFile(join(directory, "summary.json"), "utf8")) as Record<string, unknown>;
      if (summary.runId !== entry) {
        continue;
      }
    } catch {
      // Incomplete, active, or damaged: never eligible for pruning.
      continue;
    }
    completed.push({ directory, mtimeMs: (await stat(directory)).mtimeMs });
  }
  completed.sort((a, b) => a.mtimeMs - b.mtimeMs);
  const pruned: string[] = [];
  for (const item of completed) {
    if (completed.length - pruned.length <= maxRecords) {
      break;
    }
    await rm(item.directory, { recursive: true, force: true });
    pruned.push(item.directory);
  }
  kept = completed.length - pruned.length;
  return { pruned, kept };
}
