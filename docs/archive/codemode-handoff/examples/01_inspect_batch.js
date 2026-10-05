// @options: {"max_output_tokens": 2000, "timeout_ms": 30000}
// POST-IMPLEMENTATION codemode example, not a Node program.
// Seed store("flow.runIds", [...]) with 2–20 real, session-owned IDs.
// Read-only. This script does not launch agents or retry failures.
const input = load("flow.runIds");
if (!Array.isArray(input) || input.some(id => typeof id !== "string")) {
  throw new Error("flow.runIds must be an array of real run ID strings");
}
const runIds = [...new Set(input)];
if (runIds.length < 2 || runIds.length > 20) {
  throw new Error("This batch example requires 2–20 unique targets; use single-view paging for one target");
}
const collected = [];
let cursor;
const seenCursors = new Set();
for (let pageNumber = 0; pageNumber < 20; pageNumber++) {
  const response = await tools.external_runs({
    action: "inspect", runIds, view: "summary", limitBytes: 32768,
    ...(cursor ? { cursor } : {}),
  });
  if (!response || response.contractVersion !== 1) throw new Error("Flow public contract v1 required");
  if (!response.ok) {
    text({ inspectionFailed: true, error: response.error, previouslyRead: collected.length });
    return;
  }
  if (response.data.mode !== "batch") throw new Error("Unexpected inspection payload");
  collected.push(...response.data.entries);
  cursor = response.data.nextCursor;
  if (!cursor) {
    text({ complete: true, runs: collected.map(run => ({
      runId: run.runId, status: run.state.status, outcome: run.state.outcome,
      finalAvailable: run.output.finalAvailable, refs: run.evidence.refs,
    })) });
    return;
  }
  if (seenCursors.has(cursor)) throw new Error("Non-advancing cursor; inspection stopped");
  seenCursors.add(cursor);
}
throw new Error("Page bound exceeded; do not claim complete inspection");
