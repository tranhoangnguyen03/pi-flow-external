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

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("run evidence inspection", () => {
  it("preserves message boundaries without duplicating adapter finals", async () => {
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
      event: { type: "assistant", message: { id: "m2", content: [{ type: "text", text: "final answer" }] } },
    });
    await record.event("backend_event", {
      backend: "claude",
      event: { type: "result", subtype: "success", is_error: false, result: "final answer" },
    });
    await record.finish({ status: "done", result: "final answer", backend: "claude", description: "Review" });

    const page = await inspectRun({ runsDirectory: root, runId: record.runId, view: "output", limitBytes: 1_000 });
    expect(page.outputStatus).toBe("final");
    expect(page.items).toEqual([
      { id: "m1", text: "first finding" },
      { id: "m2", text: "final answer" },
    ]);
    expect(page.nextCursor).toBeUndefined();
    expect(page.integrity).toBe("complete");
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

  it("reads legacy records and lists scoped workflow children", async () => {
    const root = await temporaryRoot();
    const current = createRunRecord({
      directory: root,
      metadata: { parentSessionId: "current", project: "/repo", workflowRunId: "wf_current", description: "Child", backend: "codex" },
    });
    await current.finish({ status: "done", result: "answer", backend: "codex", description: "Child" });
    const other = createRunRecord({ directory: root, metadata: { parentSessionId: "other", project: "/repo" } });
    await other.finish({ status: "done", result: "other" });

    const legacyId = "run_legacy";
    const legacyDir = join(root, legacyId);
    await mkdir(legacyDir, { recursive: true });
    await writeFile(join(legacyDir, "events.ndjson"), `${JSON.stringify({ runId: legacyId, sequence: 0, type: "backend_event", data: { backend: "codex", event: { type: "item.completed", item: { type: "agent_message", text: "legacy answer" } } } })}\n`, "utf8");
    await writeFile(join(legacyDir, "summary.json"), JSON.stringify({ version: 1, runId: legacyId, summary: { status: "done", result: "legacy answer" } }), "utf8");

    const legacy = await inspectRun({ runsDirectory: root, runId: legacyId, view: "output" });
    expect(legacy.items).toEqual([{ text: "legacy answer" }]);
    const list = await listRunRecords({ runsDirectory: root, sessionId: "current", project: "/repo", workflowRunId: "wf_current", limit: 1 });
    expect(list.items).toEqual([expect.objectContaining({ runId: current.runId, workflowRunId: "wf_current", status: "done" })]);
    expect(list.items).not.toContainEqual(expect.objectContaining({ runId: other.runId }));
  });
});
