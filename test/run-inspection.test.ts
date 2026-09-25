import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRunRecord } from "../src/core/run-record.ts";
import { inspectRun, listRunRecords } from "../src/core/run-inspection.ts";

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-flow-inspection-"));
  roots.push(root);
  return root;
}

function cursor(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

async function writeRun(root: string, runId: string, metadata: Record<string, unknown>, summary?: Record<string, unknown>, events: unknown[] = []): Promise<void> {
  const directory = join(root, runId);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "events.ndjson"), [
    { runId, sequence: 0, timestamp: metadata.queuedAt, type: "run_started", data: metadata },
    ...events,
  ].map((event) => JSON.stringify(event)).join("\n") + "\n", "utf8");
  if (summary) {
    await writeFile(join(directory, "summary.json"), JSON.stringify({ version: 1, runId, queuedAt: metadata.queuedAt, metadata, summary }), "utf8");
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("run evidence inspection", () => {
  it("pages launch evidence while active without mixing backend events or rereading configuration", async () => {
    const root = await temporaryRoot();
    const record = createRunRecord({ directory: root, metadata: { prompt: "Inspect the repository", profile: "reviewer" } });
    const config = { model: "original-model", apiKey: "private-value" };
    await record.event("launch_resolved", config);
    config.model = "changed-model";
    await record.event("backend_event", { text: "not launch data" });
    let cursor: string | undefined;
    let text = "";
    let pages = 0;
    do {
      const page = await inspectRun({ runsDirectory: root, runId: record.runId, view: "launch", limitBytes: 40, cursor });
      text += page.items.map(item => item.text).join("");
      cursor = page.nextCursor;
      expect(++pages).toBeLessThan(100);
    } while (cursor);
    expect(text).toContain("Inspect the repository");
    expect(text).toContain("original-model");
    expect(text).not.toMatch(/changed-model|private-value|not launch data/);
    expect(text).toContain("[REDACTED]");
    const old = createRunRecord({ directory: root, metadata: { prompt: "Historical task" } });
    await old.finish({ status: "done", result: "done" });
    const legacy = await inspectRun({ runsDirectory: root, runId: old.runId, view: "launch" });
    expect(legacy.items[0]?.text).toContain("Not recorded");
    const waiting = createRunRecord({ directory: root, metadata: { prompt: "queued" } });
    await waiting.event("intent_ready");
    const inspect = (live = false) => inspectRun({ runsDirectory: root, runId: waiting.runId, view: "launch", live });
    expect((await inspect()).items[0]?.text).toContain("Interrupted or uncertain");
    expect((await inspect(true)).items[0]?.text).toContain("Pending");
    await waiting.finish({ status: "aborted", backendStarted: false });
    expect((await inspect()).items[0]?.text).toContain("Never started");
  });
  it("reconciles streamed messages with a distinct canonical terminal answer", async () => {
    const root = await temporaryRoot();
    const record = createRunRecord({
      directory: root,
      metadata: { parentSessionId: "session-a", project: "/repo", workflowRunId: "wf_1", description: "Review", backend: "claude" },
    });
    await record.event("backend_event", {
      backend: "claude",
      event: { type: "assistant", message: { id: "m1", content: [{ type: "text", text: "first finding" }] } },
    });
    await record.event("backend_event", {
      backend: "claude",
      event: { type: "assistant", message: { id: "m2", content: [{ type: "text", text: "draft answer" }] } },
    });
    await record.event("backend_event", {
      backend: "claude",
      event: { type: "result", subtype: "success", is_error: false, result: "canonical answer" },
    });
    await record.finish({
      status: "done",
      result: "canonical answer",
      assistantOutput: { status: "final", messages: [{ id: "m1", text: "first finding" }, { id: "m2", text: "draft answer" }] },
      backend: "claude",
      description: "Review",
    });

    const page = await inspectRun({ runsDirectory: root, runId: record.runId, view: "output", limitBytes: 1_000 });
    expect(page.outputStatus).toBe("final");
    expect(page.items).toEqual([
      { id: "m1", text: "first finding" },
      { id: "m2", text: "draft answer" },
      { text: "canonical answer" },
    ]);
    expect(page.nextCursor).toBeUndefined();
    expect(page.integrity).toBe("complete");

    let cursor: string | undefined;
    let paged = "";
    const statuses: string[] = [];
    do {
      const portion = await inspectRun({ runsDirectory: root, runId: record.runId, view: "output", limitBytes: 10, cursor });
      paged += portion.items.map((item) => item.text).join("");
      statuses.push(portion.outputStatus);
      cursor = portion.nextCursor;
    } while (cursor);
    expect(paged).toBe("first findingdraft answercanonical answer");
    expect(statuses.every((status) => status === "final")).toBe(true);

    const repeated = createRunRecord({ directory: root });
    await repeated.event("backend_event", {
      backend: "codex",
      event: { type: "item.completed", item: { id: "same", type: "agent_message", text: "same answer" } },
    });
    await repeated.finish({ status: "done", result: "same answer", assistantOutput: { status: "final", messages: [{ id: "same", text: "same answer" }] } });
    expect((await inspectRun({ runsDirectory: root, runId: repeated.runId, view: "output" })).items)
      .toEqual([{ id: "same", text: "same answer" }]);
  });

  it("extracts grok assistant messages and activity from streamed events during inspection", async () => {
    const root = await temporaryRoot();
    const record = createRunRecord({ directory: root });
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));
      await record.event("backend_event", {
        backend: "grok",
        event: { type: "assistant", message: { id: "m1", content: [{ type: "text", text: "first finding" }] } },
      });
      // A tool_use-only assistant event produces no output text, but must
      // still register as activity via grokActivityFromEvent — otherwise a
      // grok child mid-tool-call would look stale to the parent.
      vi.setSystemTime(new Date("2024-01-01T00:00:01.000Z"));
      await record.event("backend_event", {
        backend: "grok",
        event: { type: "assistant", message: { id: "m2", content: [{ type: "tool_use", name: "read_file", input: { path: "src/index.ts" } }] } },
      });
      // The terminal "result" event is not re-projected as output (mirrors the
      // claude gate): only "assistant" events project text here.
      vi.setSystemTime(new Date("2024-01-01T00:00:02.000Z"));
      await record.event("backend_event", {
        backend: "grok",
        event: { type: "result", subtype: "success", is_error: false, result: "canonical answer" },
      });
    } finally {
      vi.useRealTimers();
    }

    const page = await inspectRun({ runsDirectory: root, runId: record.runId, view: "output" });
    expect(page.outputStatus).toBe("preliminary");
    expect(page.items).toEqual([{ id: "m1", text: "first finding" }]);

    const summaryPage = await inspectRun({ runsDirectory: root, runId: record.runId, view: "summary" });
    const projection = JSON.parse(summaryPage.items.map((item) => item.text).join(""));
    expect(projection.state.firstActivityAt).toBe("2024-01-01T00:00:00.000Z");
    // Advances to m2's timestamp, not m1's or the terminal result's: proof
    // that grokActivityFromEvent (not just outputFromEvent) drives activity.
    expect(projection.state.lastActivityAt).toBe("2024-01-01T00:00:01.000Z");
    expect(projection.output).toEqual({ available: true, status: "preliminary", finalAvailable: false });
  });

  it("concatenates muse run.output.delta chunks into one growing item and registers status narration as activity", async () => {
    const root = await temporaryRoot();
    const record = createRunRecord({ directory: root });
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));
      await record.event("backend_event", {
        backend: "muse",
        event: { payload_type: "run.output.delta", payload: { text: "60db8abf-e619-" } },
      });
      // A status-only envelope produces no output text, but must still
      // register as activity via museActivityFromEvent (e.g. surfacing
      // muse's own native provider-retry narration).
      vi.setSystemTime(new Date("2024-01-01T00:00:01.000Z"));
      await record.event("backend_event", {
        backend: "muse",
        event: { payload_type: "task.lifecycle.status", payload: { event: { kind: "status", message: "opening meta model stream attempt 1/10" } } },
      });
      vi.setSystemTime(new Date("2024-01-01T00:00:02.000Z"));
      await record.event("backend_event", {
        backend: "muse",
        event: { payload_type: "run.output.delta", payload: { text: "42b6-b9f3" } },
      });
    } finally {
      vi.useRealTimers();
    }

    const page = await inspectRun({ runsDirectory: root, runId: record.runId, view: "output" });
    expect(page.outputStatus).toBe("preliminary");
    expect(page.items).toEqual([{ text: "60db8abf-e619-42b6-b9f3" }]);

    const summaryPage = await inspectRun({ runsDirectory: root, runId: record.runId, view: "summary" });
    const projection = JSON.parse(summaryPage.items.map((item) => item.text).join(""));
    expect(projection.state.firstActivityAt).toBe("2024-01-01T00:00:00.000Z");
    expect(projection.state.lastActivityAt).toBe("2024-01-01T00:00:02.000Z");
  });

  it("continues a single oversized message with a bound cursor", async () => {
    const root = await temporaryRoot();
    const record = createRunRecord({ directory: root });
    const text = "alpha🙂beta🙂gamma";
    await record.event("backend_event", {
      backend: "codex",
      event: { type: "item.completed", item: { id: "answer", type: "agent_message", text } },
    });
    await record.finish({ status: "error", error: "later failure", backend: "codex" });

    let cursor: string | undefined;
    let recovered = "";
    do {
      const page = await inspectRun({ runsDirectory: root, runId: record.runId, view: "output", limitBytes: 7, cursor });
      recovered += page.items.map((item) => item.text).join("");
      cursor = page.nextCursor;
      expect(page.outputStatus).toBe("interrupted");
    } while (cursor);
    expect(recovered).toBe(text);
  });

  it("recovers interrupted assistant output from summary when a run fails or is aborted", async () => {
    const root = await temporaryRoot();
    const record = createRunRecord({ directory: root });
    await record.finish({
      status: "error",
      error: "process crashed",
      assistantOutput: { status: "interrupted", messages: [{ id: "m1", text: "partial work before crash" }] },
      backend: "pi",
      description: "Interrupted task",
    });

    const page = await inspectRun({ runsDirectory: root, runId: record.runId, view: "output" });
    expect(page.outputStatus).toBe("interrupted");
    expect(page.items).toEqual([{ id: "m1", text: "partial work before crash" }]);
  });

  it("extracts pi assistant messages from streamed events during inspection", async () => {
    const root = await temporaryRoot();
    const record = createRunRecord({ directory: root });
    await record.event("backend_event", {
      backend: "pi",
      event: {
        type: "message_end",
        message: { role: "assistant", responseId: "resp_pi", content: [{ type: "text", text: "streamed pi response" }] },
      },
    });

    const page = await inspectRun({ runsDirectory: root, runId: record.runId, view: "output" });
    expect(page.outputStatus).toBe("preliminary");
    expect(page.items).toEqual([{ id: "resp_pi", text: "streamed pi response" }]);
  });

  it("rejects malformed and cross-target cursors", async () => {
    const root = await temporaryRoot();
    const first = createRunRecord({ directory: root });
    const second = createRunRecord({ directory: root });
    await first.event("backend_event", { backend: "codex", event: { type: "item.completed", item: { type: "agent_message", text: "long enough" } } });
    await first.finish({ status: "done", result: "long enough" });
    await second.finish({ status: "done", result: "other" });
    const page = await inspectRun({ runsDirectory: root, runId: first.runId, view: "output", limitBytes: 3 });

    await expect(inspectRun({ runsDirectory: root, runId: first.runId, view: "output", cursor: "not-a-cursor" })).rejects.toThrow(/invalid.*cursor/i);
    await expect(inspectRun({ runsDirectory: root, runId: second.runId, view: "output", cursor: page.nextCursor })).rejects.toThrow(/cursor.*run/i);
    await expect(inspectRun({ runsDirectory: root, runId: first.runId, view: "diagnostics", cursor: page.nextCursor })).rejects.toThrow(/cursor.*view/i);
    await expect(inspectRun({ runsDirectory: root, runId: "../escape", view: "output" })).rejects.toThrow(/invalid run id/i);
    await expect(inspectRun({ runsDirectory: root, runId: `run_${"a".repeat(129)}`, view: "output" })).rejects.toThrow(/invalid run id/i);
    await expect(inspectRun({
      runsDirectory: root,
      runId: first.runId,
      view: "diagnostics",
      cursor: cursor({ v: 1, kind: "inspect", runId: first.runId, view: "diagnostics", source: "events", position: 1, textOffset: 0 }),
    })).rejects.toThrow(/cursor.*record boundary/i);
    await expect(inspectRun({
      runsDirectory: root,
      runId: first.runId,
      view: "diagnostics",
      cursor: cursor({ v: 1, kind: "inspect", runId: first.runId, view: "diagnostics", source: "events", position: Number.MAX_SAFE_INTEGER, textOffset: 0 }),
    })).rejects.toThrow(/cursor.*evidence/i);
    const decoded = JSON.parse(Buffer.from(page.nextCursor!, "base64url").toString("utf8"));
    await expect(inspectRun({ runsDirectory: root, runId: first.runId, view: "output", cursor: cursor({ ...decoded, textOffset: 99_999 }) })).rejects.toThrow(/cursor.*text offset/i);
    await expect(inspectRun({ runsDirectory: root, runId: first.runId, view: "output", cursor: "x".repeat(4_097) })).rejects.toThrow(/invalid.*cursor/i);
  });

  it("ignores an incomplete NDJSON tail and distinguishes damaged terminal evidence", async () => {
    const root = await temporaryRoot();
    const record = createRunRecord({ directory: root });
    await record.event("backend_event", { backend: "agy", event: { event: "step_update", step_update: { step_id: "a", step_type: "agent_response", text_delta: "kept" } } });
    await record.finish({ status: "error", error: "backend failed" });
    await appendFile(record.eventsPath, "{truncated", "utf8");

    const page = await inspectRun({ runsDirectory: root, runId: record.runId, view: "output" });
    expect(page.items).toEqual([{ id: "a", text: "kept" }]);
    expect(page.truncatedTail).toBe(true);
    expect(page.integrity).toBe("damaged");
    expect(page.outputStatus).toBe("interrupted");
  });

  it("returns a bounded safe summary with useful live state", async () => {
    const root = await temporaryRoot();
    const record = createRunRecord({
      directory: root,
      metadata: {
        parentSessionId: "session-a",
        project: "/repo",
        workflowRunId: "wf_live",
        description: "Live review",
        backend: "codex",
        prompt: "private prompt must not leak",
        context: { messages: ["private context must not leak"] },
      },
    });
    await record.event("process_started", { pid: 123 });
    await record.event("backend_event", {
      backend: "codex",
      event: { type: "item.completed", item: { id: "partial", type: "agent_message", text: "available finding" } },
    });

    let next: string | undefined;
    let text = "";
    do {
      const page = await inspectRun({ runsDirectory: root, runId: record.runId, view: "summary", limitBytes: 40, cursor: next });
      expect(Buffer.byteLength(page.items.map((item) => item.text).join(""))).toBeLessThanOrEqual(40);
      text += page.items.map((item) => item.text).join("");
      next = page.nextCursor;
    } while (next);
    expect(text).not.toContain("private prompt");
    expect(text).not.toContain("private context");
    expect(JSON.parse(text)).toMatchObject({
      runId: record.runId,
      task: { description: "Live review", backend: "codex", project: "/repo", workflowRunId: "wf_live" },
      state: { status: "running", processStartedAt: expect.any(String), lastActivityAt: expect.any(String) },
      output: { available: true, status: "preliminary" },
    });

    const firstPage = await inspectRun({ runsDirectory: root, runId: record.runId, view: "summary", limitBytes: 40 });
    await record.event("backend_event", {
      backend: "codex",
      event: { type: "item.completed", item: { id: "later", type: "agent_message", text: "new output" } },
    });
    await expect(inspectRun({ runsDirectory: root, runId: record.runId, view: "summary", limitBytes: 40, cursor: firstPage.nextCursor }))
      .rejects.toThrow(/run changed.*restart inspection/i);
  });

  it("derives queue delay, terminal elapsed time, and process duration from the execution_started boundary without inventing live fields", async () => {
    const root = await temporaryRoot();
    const record = createRunRecord({ directory: root, metadata: { queuedAt: "2026-09-20T00:00:00.000Z" } });
    await record.event("execution_started");
    await record.event("process_started", { pid: 1 });
    await record.finish({ status: "done", result: "ok" });

    const page = await inspectRun({ runsDirectory: root, runId: record.runId, view: "summary" });
    const projection = JSON.parse(page.items.map((item) => item.text).join(""));
    expect(projection.timing.executionStartedAt).toEqual(expect.any(String));
    expect(projection.timing.queueDelayMs).toBeGreaterThanOrEqual(0);
    expect(projection.timing.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(projection.timing.processDurationMs).toBeGreaterThanOrEqual(0);
    // A terminal run never presents lastActivityAt as current staleness.
    expect(projection.timing.activityAgeMs).toBeUndefined();
  });

  it("never derives a now-relative elapsed time or activity age from durable evidence alone, even when status reads running", async () => {
    const root = await temporaryRoot();
    const record = createRunRecord({ directory: root });
    await record.event("execution_started");
    await record.event("backend_event", {
      backend: "codex",
      event: { type: "item.completed", item: { id: "partial", type: "agent_message", text: "still working" } },
    });
    // No record.finish(): this record looks exactly like an orphaned/crashed
    // run would (no finishedAt, no owning RunRegistry entry). run-inspection.ts
    // has no registry access, so it must never fabricate now-relative timing
    // for it; only src/external-runs.ts may do that for a registry-confirmed
    // live entry.
    const page = await inspectRun({ runsDirectory: root, runId: record.runId, view: "summary" });
    const projection = JSON.parse(page.items.map((item) => item.text).join(""));
    expect(projection.state.status).toBe("running");
    expect(projection.timing.executionStartedAt).toEqual(expect.any(String));
    expect(projection.timing.elapsedMs).toBeUndefined();
    expect(projection.timing.activityAgeMs).toBeUndefined();
  });

  it("classifies a pi run as running from executionStartedAt alone, before any processStartedAt or output evidence exists", async () => {
    const root = await temporaryRoot();
    const record = createRunRecord({ directory: root });
    // Pi children have no child OS process, so process_started never fires
    // for them; execution_started (backend-agnostic) must be enough on its
    // own to classify the run as running rather than still queued.
    await record.event("execution_started");

    const page = await inspectRun({ runsDirectory: root, runId: record.runId, view: "summary" });
    const projection = JSON.parse(page.items.map((item) => item.text).join(""));
    expect(projection.state.status).toBe("running");
    expect(projection.timing.executionStartedAt).toEqual(expect.any(String));
  });

  it("exposes a verified final answer separately from combined output, reusing the same canonical terminal result", async () => {
    const root = await temporaryRoot();
    const done = createRunRecord({ directory: root });
    await done.event("backend_event", {
      backend: "claude",
      event: { type: "assistant", message: { id: "m1", content: [{ type: "text", text: "narration, not the answer" }] } },
    });
    await done.finish({
      status: "done",
      result: "canonical answer",
      assistantOutput: { status: "final", messages: [{ id: "m1", text: "narration, not the answer" }] },
    });

    const finalPage = await inspectRun({ runsDirectory: root, runId: done.runId, view: "final", limitBytes: 1_000 });
    expect(finalPage.finalAvailable).toBe(true);
    expect(finalPage.items).toEqual([{ text: "canonical answer" }]);
    expect(finalPage.nextCursor).toBeUndefined();

    const summaryPage = await inspectRun({ runsDirectory: root, runId: done.runId, view: "summary" });
    expect(JSON.parse(summaryPage.items.map((item) => item.text).join("")).output.finalAvailable).toBe(true);

    const outputPage = await inspectRun({ runsDirectory: root, runId: done.runId, view: "output" });
    expect(outputPage.finalAvailable).toBe(true);
    expect(outputPage.items.map((item) => item.text)).toContain("narration, not the answer");

    const failed = createRunRecord({ directory: root });
    await failed.event("backend_event", {
      backend: "claude",
      event: { type: "assistant", message: { id: "m1", content: [{ type: "text", text: "partial progress before failure" }] } },
    });
    await failed.finish({ status: "error", error: "boom" });
    const failedFinal = await inspectRun({ runsDirectory: root, runId: failed.runId, view: "final" });
    expect(failedFinal.finalAvailable).toBe(false);
    expect(failedFinal.items).toEqual([]);
    expect(failedFinal.outputStatus).toBe("interrupted");

    const queued = createRunRecord({ directory: root });
    const queuedFinal = await inspectRun({ runsDirectory: root, runId: queued.runId, view: "final" });
    expect(queuedFinal.finalAvailable).toBe(false);
    expect(queuedFinal.items).toEqual([]);
  });

  it("lists a pi run as running from executionStartedAt alone, before any processStartedAt or output evidence exists", async () => {
    const root = await temporaryRoot();
    const record = createRunRecord({ directory: root, metadata: { parentSessionId: "session-a", project: "/repo" } });
    await record.event("execution_started");

    const page = await listRunRecords({ runsDirectory: root, sessionId: "session-a", project: "/repo" });
    expect(page.items).toEqual([expect.objectContaining({ runId: record.runId, status: "running" })]);
  });

  it("reads legacy records and lists scoped workflow children with stable keyset pagination", async () => {
    const root = await temporaryRoot();
    const scoped = { parentSessionId: "current", project: "/repo", workflowRunId: "wf_current", backend: "codex" };
    await writeRun(root, "run_z", { ...scoped, queuedAt: "2026-09-14T03:00:00.000Z", description: "Newest" }, { status: "done", result: "z" });
    await writeRun(root, "run_m", { ...scoped, queuedAt: "2026-09-14T02:00:00.000Z", description: "Active" }, undefined, [{
      runId: "run_m",
      sequence: 1,
      timestamp: "2026-09-14T02:01:00.000Z",
      type: "backend_event",
      data: { backend: "codex", event: { type: "item.completed", item: { type: "agent_message", text: "partial" } } },
    }]);
    await writeRun(root, "run_a", { ...scoped, queuedAt: "2026-09-14T01:00:00.000Z", description: "Oldest" }, { status: "done", result: "a" });
    await writeRun(root, "run_other", { ...scoped, parentSessionId: "other", queuedAt: "2026-09-14T04:00:00.000Z" }, { status: "done", result: "other" });

    const legacyId = "run_legacy";
    const legacyDir = join(root, legacyId);
    await mkdir(legacyDir, { recursive: true });
    await writeFile(join(legacyDir, "events.ndjson"), `${JSON.stringify({ runId: legacyId, sequence: 0, type: "backend_event", data: { backend: "codex", event: { type: "item.completed", item: { type: "agent_message", text: "legacy answer" } } } })}\n`, "utf8");
    await writeFile(join(legacyDir, "summary.json"), JSON.stringify({ version: 1, runId: legacyId, summary: { status: "done", result: "legacy answer" } }), "utf8");

    const legacy = await inspectRun({ runsDirectory: root, runId: legacyId, view: "output" });
    expect(legacy.items).toEqual([{ text: "legacy answer" }]);
    const first = await listRunRecords({ runsDirectory: root, sessionId: "current", project: "/repo", workflowRunId: "wf_current", limit: 1 });
    expect(first.items).toEqual([expect.objectContaining({ runId: "run_z", status: "done" })]);
    await writeRun(root, "run_zz", { ...scoped, queuedAt: "2026-09-14T05:00:00.000Z", description: "Inserted" }, { status: "done", result: "zz" });
    const second = await listRunRecords({ runsDirectory: root, sessionId: "current", project: "/repo", workflowRunId: "wf_current", limit: 1, cursor: first.nextCursor });
    expect(second.items).toEqual([expect.objectContaining({ runId: "run_m", status: "running", outputAvailable: true })]);
  });
});
