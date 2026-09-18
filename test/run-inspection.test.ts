import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
