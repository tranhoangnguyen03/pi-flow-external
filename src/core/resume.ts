import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SubagentBackend } from "../types.ts";

export interface ResumedSession {
  runId: string;
  sessionId: string;
  backend: SubagentBackend;
}

/**
 * Resolve a prior run id to its recorded backend session id by reading the
 * run record's summary.json. Returns an error string on mismatch or missing
 * records; callers surface it as a failed tool result, not a throw.
 */
export async function resolveResume(
  runsDirectory: string,
  runId: string,
  expectedBackend: SubagentBackend,
): Promise<{ session?: ResumedSession; error?: string }> {
  if (!/^run_[a-z0-9-]+$/i.test(runId)) {
    return { error: `Invalid resume run id "${runId}".` };
  }
  let summary: unknown;
  try {
    summary = JSON.parse(await readFile(join(runsDirectory, runId, "summary.json"), "utf8"));
  } catch {
    return { error: `No completed run record found for "${runId}" under ${runsDirectory}.` };
  }
  const record = summary as Record<string, unknown> | null;
  const payload = record && typeof record === "object"
    ? record.summary as Record<string, unknown> | undefined
    : undefined;
  const sessionId = typeof payload?.sessionId === "string" ? payload.sessionId : undefined;
  const backend = typeof payload?.backend === "string" ? payload.backend : undefined;
  if (!sessionId || !backend) {
    return { error: `Run record "${runId}" has no session id to resume.` };
  }
  if (backend !== expectedBackend) {
    return { error: `Run "${runId}" used backend "${backend}"; resume must use the same backend (expected "${expectedBackend}").` };
  }
  return { session: { runId, sessionId, backend: backend as SubagentBackend } };
}
