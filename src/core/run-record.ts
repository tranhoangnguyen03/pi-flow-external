import { randomUUID } from "node:crypto";
import { appendFile, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const RUN_RECORD_VERSION = 1;
const REDACTED = "[REDACTED]";

/**
 * Local, project-relative storage used when the caller does not choose a
 * directory. Each run gets its own child directory.
 */
export const DEFAULT_RUN_RECORD_DIRECTORY = ".pi-flow-external/runs";

export interface RunRecordOptions {
  /** Base directory for run folders. Relative paths are resolved from `cwd`. */
  directory?: string;
  /** Base for the default directory and relative `directory` values. */
  cwd?: string;
  /** Data to include in the automatically-written `run_started` event. */
  metadata?: unknown;
  /** Optional local diagnostic hook. Errors thrown by this hook are ignored. */
  onWriteError?: (error: Error) => void;
}

export interface RunRecord {
  readonly runId: string;
  readonly directory: string;
  readonly eventsPath: string;
  readonly summaryPath: string;
  /** First best-effort persistence failure, available after awaiting an operation. */
  readonly writeError: Error | undefined;
  readonly writeErrorCount: number;

  /** Append one redacted, timestamped NDJSON event. */
  event(type: string, data?: unknown): Promise<void>;

  /** Append `run_finished` and atomically write the redacted final summary. */
  finish(summary: unknown): Promise<void>;
}

/**
 * Create a best-effort, local-only record for one external-agent run.
 *
 * All filesystem work is serialized. Its promises always resolve: observation
 * must never turn an otherwise valid agent run into a failure.
 */
export function createRunRecord(options: RunRecordOptions = {}): RunRecord {
  const runId = createRunId();
  const baseDirectory = resolve(options.cwd ?? process.cwd(), options.directory ?? DEFAULT_RUN_RECORD_DIRECTORY);
  const directory = join(baseDirectory, runId);
  const eventsPath = join(directory, "events.ndjson");
  const summaryPath = join(directory, "summary.json");
  const startedAt = new Date().toISOString();

  let sequence = 0;
  let attemptedEventCount = 0;
  let persistedEventCount = 0;
  let firstWriteError: Error | undefined;
  let writeErrorCount = 0;
  let finished = false;
  let queue = Promise.resolve();

  const reportWriteError = (error: unknown): void => {
    const normalized = asError(error);
    firstWriteError ??= normalized;
    writeErrorCount++;
    if (!options.onWriteError) {
      return;
    }
    try {
      options.onWriteError(normalized);
    } catch {
      // Observation diagnostics are best-effort too.
    }
  };

  const enqueue = (operation: () => Promise<void>): Promise<void> => {
    queue = queue.then(operation).catch(reportWriteError);
    return queue;
  };

  const appendEvent = (type: string, data?: unknown): Promise<void> => {
    const event = {
      version: RUN_RECORD_VERSION,
      runId,
      sequence: sequence++,
      timestamp: new Date().toISOString(),
      type,
      ...(data === undefined ? {} : { data: redactSecrets(data) }),
    };
    attemptedEventCount++;
    return enqueue(async () => {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await appendFile(eventsPath, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
      persistedEventCount++;
    });
  };

  // Queue creation immediately, while still preserving a synchronous API.
  void appendEvent("run_started", options.metadata);

  return {
    runId,
    directory,
    eventsPath,
    summaryPath,
    get writeError() {
      return firstWriteError;
    },
    get writeErrorCount() {
      return writeErrorCount;
    },
    event(type, data) {
      if (finished) {
        return queue;
      }
      return appendEvent(type, data);
    },
    finish(summary) {
      if (finished) {
        return queue;
      }
      finished = true;
      const finishedAt = new Date().toISOString();
      void appendEvent("run_finished", { summary });
      return enqueue(async () => {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const temporaryPath = `${summaryPath}.${randomUUID()}.tmp`;
        const document = {
          version: RUN_RECORD_VERSION,
          runId,
          startedAt,
          finishedAt,
          eventCount: persistedEventCount,
          attemptedEventCount,
          writeErrorCount,
          summary: redactSecrets(summary),
        };
        try {
          await writeFile(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
          await rename(temporaryPath, summaryPath);
        } catch (error) {
          await rm(temporaryPath, { force: true }).catch(() => {});
          throw error;
        }
      });
    },
  };
}

/** Return a JSON-safe clone with common credentials replaced by `[REDACTED]`. */
export function redactSecrets(value: unknown): unknown {
  try {
    const serialized = JSON.stringify(value, (key, currentValue: unknown) => {
      if (key && isSecretBearingKey(key)) {
        return REDACTED;
      }
      if (typeof currentValue === "string") {
        return redactSecretText(currentValue);
      }
      return currentValue;
    });
    return serialized === undefined ? null : JSON.parse(serialized) as unknown;
  } catch {
    return "[UNSERIALIZABLE]";
  }
}

function createRunId(): string {
  return `run_${randomUUID().replaceAll("-", "")}`;
}

function isSecretBearingKey(key: string): boolean {
  const normalized = key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();

  if (!normalized) {
    return false;
  }

  if (/(?:^|_)(?:password|passwd|pwd|secret|credentials?|authorization|proxy_authorization|cookie|set_cookie)(?:_|$)/.test(normalized)) {
    return true;
  }
  if (/(?:^|_)(?:api|private|access|signing|encryption)_?key(?:_|$)/.test(normalized)) {
    return true;
  }
  if (/(?:^|_)(?:access|refresh|id|auth|session|bearer)?_?token$/.test(normalized)) {
    return true;
  }
  return /(?:^|_)(?:database|db|redis|mongodb?)_(?:url|uri)$|(?:^|_)(?:dsn|connection_string)$/.test(normalized);
}

function redactSecretText(value: string): string {
  return value
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [REDACTED]")
    .replace(/-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)? PRIVATE KEY-----/g, REDACTED)
    .replace(/\b((?:[A-Za-z_][A-Za-z0-9_]*_)?(?:API_KEY|ACCESS_KEY|SECRET_ACCESS_KEY|PRIVATE_KEY|ACCESS_TOKEN|AUTH_TOKEN|SESSION_TOKEN|PASSWORD|PASSWD|SECRET|CREDENTIALS?)=)[^\s,;]+/gi, `$1${REDACTED}`);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
