import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRunRecord, redactSecrets } from "../src/core/run-record.ts";

const temporaryDirectories: string[] = [];

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-flow-run-record-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("createRunRecord", () => {
  it("writes ordered NDJSON events and a final JSON summary", async () => {
    const baseDirectory = await makeTemporaryDirectory();
    const record = createRunRecord({
      directory: baseDirectory,
      metadata: { backend: "codex", profile: "reviewer" },
    });

    expect(record.runId).toMatch(/^run_[a-f0-9]{32}$/);
    expect(record.directory).toBe(join(baseDirectory, record.runId));

    await Promise.all([
      record.event("process_started", { pid: 123 }),
      record.event("output", { text: "working" }),
    ]);
    await record.finish({ status: "succeeded", result: "done" });

    const events = (await readFile(record.eventsPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events.map((event) => event.type)).toEqual([
      "run_started",
      "process_started",
      "output",
      "run_finished",
    ]);
    expect(events.map((event) => event.sequence)).toEqual([0, 1, 2, 3]);
    expect(events.every((event) => event.runId === record.runId)).toBe(true);
    expect(events[0]?.data).toEqual({ backend: "codex", profile: "reviewer" });

    const summary = JSON.parse(await readFile(record.summaryPath, "utf8")) as Record<string, unknown>;
    expect(summary).toMatchObject({
      version: 1,
      runId: record.runId,
      eventCount: 4,
      attemptedEventCount: 4,
      writeErrorCount: 0,
      summary: { status: "succeeded", result: "done" },
    });
    expect(summary.startedAt).toEqual(expect.any(String));
    expect(summary.finishedAt).toEqual(expect.any(String));
    if (process.platform !== "win32") {
      expect((await stat(record.directory)).mode & 0o777).toBe(0o700);
      expect((await stat(record.eventsPath)).mode & 0o777).toBe(0o600);
      expect((await stat(record.summaryPath)).mode & 0o777).toBe(0o600);
    }
  });

  it("redacts secret-bearing keys and obvious inline credentials", async () => {
    const baseDirectory = await makeTemporaryDirectory();
    const record = createRunRecord({
      directory: baseDirectory,
      metadata: {
        env: {
          PATH: "/usr/bin",
          OPENAI_API_KEY: "sk-test-secret",
          AWS_SECRET_ACCESS_KEY: "aws-secret",
          GITHUB_TOKEN: "github-secret",
        },
      },
    });

    await record.event("request", {
      authorization: "Bearer should-not-survive",
      clientSecret: "nested-secret",
      tokenCount: 42,
      message: "Authorization: Bearer inline-secret PASSWORD=hunter2 API_KEY=sk-bare",
    });
    await record.finish({
      status: "succeeded",
      connectionString: "postgres://user:password@example.test/db",
    });

    const persisted = `${await readFile(record.eventsPath, "utf8")}\n${await readFile(record.summaryPath, "utf8")}`;
    expect(persisted).not.toContain("sk-test-secret");
    expect(persisted).not.toContain("aws-secret");
    expect(persisted).not.toContain("github-secret");
    expect(persisted).not.toContain("should-not-survive");
    expect(persisted).not.toContain("nested-secret");
    expect(persisted).not.toContain("inline-secret");
    expect(persisted).not.toContain("hunter2");
    expect(persisted).not.toContain("sk-bare");
    expect(persisted).not.toContain("postgres://user:password");
    expect(persisted).toContain("[REDACTED]");
    expect(persisted).toContain('"tokenCount":42');
    expect(persisted).toContain('"PATH":"/usr/bin"');
  });

  it("never rejects when its local directory cannot be written", async () => {
    const baseDirectory = await makeTemporaryDirectory();
    const fileInsteadOfDirectory = join(baseDirectory, "not-a-directory");
    await writeFile(fileInsteadOfDirectory, "occupied", "utf8");
    const errors: Error[] = [];
    const record = createRunRecord({
      directory: fileInsteadOfDirectory,
      onWriteError: (error) => {
        errors.push(error);
        throw new Error("diagnostic hooks cannot poison the run");
      },
    });

    await expect(record.event("still_safe", { value: 1 })).resolves.toBeUndefined();
    await expect(record.finish({ status: "failed" })).resolves.toBeUndefined();
    expect(errors.length).toBeGreaterThan(0);
    expect(record.writeError).toBeInstanceOf(Error);
    expect(record.writeErrorCount).toBeGreaterThan(0);
  });

  it("ignores events and repeated finishes after finalization", async () => {
    const baseDirectory = await makeTemporaryDirectory();
    const record = createRunRecord({ directory: baseDirectory });

    await record.finish({ status: "first" });
    await record.event("too_late", { ignored: true });
    await record.finish({ status: "second" });

    const events = await readFile(record.eventsPath, "utf8");
    const summary = JSON.parse(await readFile(record.summaryPath, "utf8")) as { summary: unknown };
    expect(events).not.toContain("too_late");
    expect(summary.summary).toEqual({ status: "first" });
  });
});

describe("redactSecrets", () => {
  it("returns a detached JSON-safe value and tolerates unserializable input", () => {
    const source = { normal: { value: 1 }, password: "secret" };
    const redacted = redactSecrets(source);
    expect(redacted).toEqual({ normal: { value: 1 }, password: "[REDACTED]" });
    expect(redacted).not.toBe(source);

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(redactSecrets(circular)).toBe("[UNSERIALIZABLE]");
  });
});
