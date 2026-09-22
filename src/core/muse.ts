import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  assistantOutput,
  createProgressEmitter,
  formatInterruptedOutputPreview,
  textResult,
  type AgentToolResult,
} from "./progress.ts";
import {
  createBoundedBuffer,
  MAX_STDERR_CHARS,
  MAX_STDOUT_LINE_CHARS,
} from "./stream.ts";
import type { PermissionTier, SubagentProfile, SubagentUsage, ThinkingLevel } from "../types.ts";
import { buildPermissionArgs } from "./permissions.ts";
import { abortChildTree } from "./process-tree.ts";
import { selectorHarness } from "../profiles.ts";

const MUSE_COMMAND = "muse";
const MUSE_PROVIDER = "meta";

export type MuseReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Pi's six thinking levels map 1:1 onto muse's `--reasoning-effort` values
 * (verified against `muse exec --help`); muse additionally accepts `max` and
 * `ultra`, which no Pi thinking level ever requests, so they never appear here.
 */
export function normalizeMuseReasoningEffort(thinkingLevel: ThinkingLevel | undefined): MuseReasoningEffort | undefined {
  const normalized = thinkingLevel?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized === "off") {
    return "none";
  }
  if (normalized === "minimal" || normalized === "low" || normalized === "medium" || normalized === "high" || normalized === "xhigh") {
    return normalized;
  }
  return undefined;
}

/**
 * `muse exec --help` syntactically lists `none` as a valid `--reasoning-effort`
 * value, but `--provider meta` rejects it at launch (verified against
 * installed Muse Code 1.3.0: `--reasoning-effort none is not supported with
 * --provider meta; choose minimal|low|medium|high|xhigh|max|ultra`, exit 2).
 * `thinking: "off"` therefore has no representable effort for this provider —
 * and it is not a rare edge case. `off` is the pinned `pi-agent-core` SDK's
 * own session-level thinking default (`agent.js`/`agent-harness.js`/
 * `session.js`), so any muse call whose profile leaves `thinking` unset
 * inherits `"off"` from the parent session unless a user has explicitly
 * raised it; `pi-subagent.ts`/`workflow/tool.ts` resolve
 * `profile.thinking ?? <session thinking level>` before ever reaching
 * {@link buildMuseArgs}, so a profile pinning `thinking: off` in its own
 * frontmatter reaches this same check the same way. `buildMuseArgs` applies
 * one more `thinkingLevel ?? profile.thinking` fallback of its own (for
 * direct/test callers), so this is checked once on that fully merged,
 * already-normalized value — inherited-default and profile-pinned `off`
 * are indistinguishable by the time they get here, and both are rejected
 * rather than one silently downgraded to `minimal` (a different, undisclosed
 * reasoning level from what was actually requested or inherited).
 */
function assertMuseReasoningEffortSupported(effort: MuseReasoningEffort | undefined, profileName: string): void {
  if (effort !== "none") {
    return;
  }
  throw new Error(
    `Muse profile "${profileName}" resolved thinking "off", which has no --reasoning-effort equivalent under --provider ${MUSE_PROVIDER} ` +
      `(muse rejects "--reasoning-effort none"). Pin this Muse profile's thinking to minimal, low, medium, high, or xhigh, ` +
      `or select a supported parent thinking level. An unset profile inherits the parent's level, which may still be off.`,
  );
}

export function buildMuseArgs({
  promptFilePath,
  schemaFilePath,
  workspace,
  profile,
  thinkingLevel,
  permission = "danger",
  resumeSessionId,
}: {
  promptFilePath: string;
  schemaFilePath?: string;
  workspace: string;
  profile: SubagentProfile;
  thinkingLevel?: ThinkingLevel;
  permission?: PermissionTier;
  resumeSessionId?: string;
}): string[] {
  const effort = normalizeMuseReasoningEffort(thinkingLevel ?? profile.thinking);
  assertMuseReasoningEffortSupported(effort, profile.name);

  const args: string[] = ["exec", "--json", "--provider", MUSE_PROVIDER, "--workspace", workspace, "--prompt-file", promptFilePath];
  if (schemaFilePath) {
    args.push("--output-schema", schemaFilePath);
  }
  if (resumeSessionId) {
    args.push("--session-id", resumeSessionId);
  }
  args.push(...buildPermissionArgs(permission, "muse"));
  if (profile.model) {
    args.push("--model", profile.model);
  }
  if (effort) {
    args.push("--reasoning-effort", effort);
  }
  return args;
}

export function parseMuseJsonLine(line: string): Record<string, unknown> | undefined {
  const trimmed = line.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(trimmed);
    return asRecord(parsed);
  } catch {
    return undefined;
  }
}

/**
 * The stable, resumable identity for a muse session is its envelope stream id
 * (`stream: { kind: "session", id }`), not the per-invocation `run_stream` or
 * `task_stream` ids embedded in individual payloads. Verified by probe: two
 * separate `muse exec --session-id X` processes sharing the same X reported
 * the same session stream id and the second recalled a fact only told to the
 * first, confirming `--session-id` actually reloads prior context rather than
 * merely labeling a fresh session.
 */
export function extractMuseSessionId(envelope: Record<string, unknown>): string | undefined {
  const stream = asRecord(envelope.stream);
  return stream?.kind === "session" && typeof stream.id === "string" && stream.id ? stream.id : undefined;
}

function payloadOf(envelope: Record<string, unknown>): Record<string, unknown> | undefined {
  return asRecord(envelope.payload);
}

/**
 * Root-run identity, established once from the envelopes that actually
 * declare it (`runtime.command.accepted`'s `command_id`, then
 * `session.run.linked` or `run.lifecycle.started` tying that same
 * `command_id` to a `run_stream.id`), never guessed from an arbitrary event.
 * A single `muse exec` invocation is one prompt/one root run by contract, but
 * nested work (task-lifecycle events, and potentially a future nested
 * delegated run with its own `run_stream`) must never be mistaken for it:
 * every `run.terminal.*`/`run.output.delta` envelope is checked against this
 * identity before it can affect the result, and `sessionId` is captured
 * exactly once, from the same root-establishing envelope, rather than
 * overwritten by every subsequent envelope's `stream.id`.
 */
interface MuseRootIdentity {
  commandId?: string;
  runId?: string;
  sessionId?: string;
}

function captureMuseRootIdentity(envelope: Record<string, unknown>, root: MuseRootIdentity): void {
  const payload = payloadOf(envelope);
  if (!payload) return;
  if (envelope.payload_type === "runtime.command.accepted") {
    if (!root.commandId && typeof payload.command_id === "string" && payload.command_id) {
      root.commandId = payload.command_id;
    }
    return;
  }
  if (root.runId) return;
  if (envelope.payload_type !== "session.run.linked" && envelope.payload_type !== "run.lifecycle.started") {
    return;
  }
  const runStream = asRecord(payload.run_stream);
  const runId = runStream?.kind === "run" && typeof runStream.id === "string" && runStream.id ? runStream.id : undefined;
  if (!runId) return;
  // If a command was already observed, this run must be tied to it. If none
  // was ever observed (an out-of-order or truncated stream), fall back to
  // trusting the first run-establishing envelope rather than never
  // establishing a root at all — still strictly better than the prior
  // unconditional-trust behavior, since every later envelope is now checked
  // against whichever identity this captures.
  if (root.commandId !== undefined && payload.command_id !== root.commandId) return;
  root.runId = runId;
  root.sessionId = extractMuseSessionId(envelope);
}

/** True only for an envelope whose own `payload.run_stream.id` matches the established root run — never for nested/task/foreign-run envelopes. */
function isMuseRootRunEnvelope(envelope: Record<string, unknown>, root: MuseRootIdentity): boolean {
  if (!root.runId) return false;
  const payload = payloadOf(envelope);
  const runStream = asRecord(payload?.run_stream);
  return runStream?.kind === "run" && runStream.id === root.runId;
}

/** `run.terminal.completed`'s `payload.text` is the sole canonical final answer; structured-output mode delivers its JSON document pre-serialized in that same field. */
export function extractMuseFinalText(envelope: Record<string, unknown>): string | undefined {
  if (envelope.payload_type !== "run.terminal.completed") {
    return undefined;
  }
  const payload = payloadOf(envelope);
  return payload && typeof payload.text === "string" ? payload.text : undefined;
}

export function extractMuseError(envelope: Record<string, unknown>): string | undefined {
  if (envelope.payload_type === "run.terminal.failed") {
    const payload = payloadOf(envelope);
    const reason = payload && typeof payload.reason === "string" && payload.reason.trim() ? payload.reason.trim() : undefined;
    return `muse failed: ${reason ?? "run did not complete"}`;
  }
  return undefined;
}

function getPreviewFromRecord(record: Record<string, unknown>): string {
  const candidates = [record.text, record.command, record.path, record.file_path, record.query];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.replace(/\s+/g, " ").trim();
    }
  }
  return "";
}

/**
 * Human-readable per-event activity for progress display: tool results,
 * retry/status narration (surfaces muse's own native provider-retry
 * disclosure, e.g. "retrying meta model stream in 60000ms (attempt 3/10)"),
 * and streamed answer deltas.
 */
export function museActivityFromEvent(envelope: Record<string, unknown>): string | undefined {
  const payload = payloadOf(envelope);
  if (!payload) {
    return undefined;
  }
  if (envelope.payload_type === "tool.result") {
    const facts = asRecord(payload.correlation_facts);
    const toolName = typeof facts?.tool_name === "string" && facts.tool_name ? facts.tool_name : "tool";
    const preview = getPreviewFromRecord(payload);
    return `${toolName}${preview ? ` ${preview}` : ""}`;
  }
  if (envelope.payload_type === "task.lifecycle.status") {
    const event = asRecord(payload.event);
    return typeof event?.message === "string" && event.message.trim() ? event.message.trim() : undefined;
  }
  if (envelope.payload_type === "run.output.delta") {
    return typeof payload.text === "string" && payload.text ? payload.text : undefined;
  }
  const error = extractMuseError(envelope);
  return error ? error : undefined;
}

/**
 * Nested-agent (sub-delegation) detection deliberately always returns false.
 * Every probe run only ever observed internal `reminder.agent.*` skill
 * reminders (and stderr's "Agent delegation: auto unavailable: workspace is
 * untrusted"), never a genuine agent-delegation task-lifecycle event — there
 * is no confirmed real event shape to key off. Matching on a speculative
 * `task_kind` prefix (e.g. "agent." but not "reminder.") would let ordinary
 * internal task activity spuriously grant the one-time nested-timeout
 * extension (see spawn.ts's `hasNestedAgentActivity`/`extendOnce`), which is
 * worse than never extending it. Revisit only once a real delegation event
 * has actually been observed and its shape confirmed.
 */
export function museHasNestedAgentActivity(_envelope: Record<string, unknown>): boolean {
  return false;
}

async function createMuseTempFiles(prompt: string, schema: unknown): Promise<{
  dir: string;
  promptPath: string;
  schemaPath: string | undefined;
  cleanup: () => Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), "pi-subagents-muse-"));
  const promptPath = join(dir, "prompt.txt");
  await writeFile(promptPath, prompt, "utf8");
  let schemaPath: string | undefined;
  if (schema !== undefined && schema !== null) {
    schemaPath = join(dir, "output-schema.json");
    await writeFile(schemaPath, typeof schema === "string" ? schema : JSON.stringify(schema), "utf8");
  }
  return {
    dir,
    promptPath,
    schemaPath,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

export async function spawnMuseSubagent(params: {
  toolCallId: string;
  description: string;
  prompt: string;
  profile: SubagentProfile;
  thinkingLevel: ThinkingLevel | undefined;
  ctx: ExtensionContext;
  signal: AbortSignal | undefined;
  progressEnabled: boolean;
  onProgress: ((result: AgentToolResult) => void) | undefined;
  onUsage: (usage: SubagentUsage) => void;
  onBackendEvent?: (event: unknown) => void;
  onProcessStart?: (pid: number | undefined) => void;
  appendInstructions?: string;
  outputSchema?: unknown;
  permission?: PermissionTier;
  resumeSessionId?: string;
  executionStartedAt?: number;
}): Promise<AgentToolResult> {
  const subagentType = params.profile.name;
  // muse exec has no native system-prompt flag (unlike claude/codex/grok);
  // fold the profile's instructions into the prompt file content, matching
  // agy's identical no-native-flag composition.
  const promptParts = [params.profile.systemPrompt, params.prompt, params.appendInstructions].filter(
    (part): part is string => Boolean(part),
  );
  const taskPrompt = promptParts.join("\n\n");
  const emitter = createProgressEmitter({
    toolCallId: params.toolCallId,
    description: params.description,
    subagentType,
    backend: params.profile.backend,
    harness: selectorHarness(params.profile),
    enabled: params.progressEnabled,
    onProgress: params.onProgress,
    executionStartedAt: params.executionStartedAt,
  });
  const progress = emitter.progress;

  // muse has never been observed to report token usage or cost on any
  // successful or failed run (prep probe: "no usage/cost event was observed
  // in the successful direct sample"); report unknown rather than a
  // fabricated zero-known or locally estimated cost.
  const latestUsage: SubagentUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, costKnown: false, costEstimated: false };
  let resultText = "";
  // Accumulated run.output.delta chunks: not the canonical result (only
  // run.terminal.completed's text is authoritative), but the best available
  // partial-output preview when a run is aborted or fails before completing.
  let deltaText = "";
  const assistantMessages: Array<{ id?: string; text: string }> = [];
  const root: MuseRootIdentity = {};
  const stderrBuffer = createBoundedBuffer(MAX_STDERR_CHARS);
  let sawTerminalEvent = false;
  let terminalSucceeded = false;
  let eventError: string | undefined;
  let oversizeError: string | undefined;
  let child: ChildProcess | undefined;
  let tempFiles: Awaited<ReturnType<typeof createMuseTempFiles>> | undefined;
  let abortHandler: (() => void) | undefined;

  const handleEvent = (envelope: Record<string, unknown>) => {
    try {
      params.onBackendEvent?.(envelope);
    } catch {
      // Observation hooks must not change the backend result.
    }
    captureMuseRootIdentity(envelope, root);
    // Only the root run's own terminal/delta events may affect the result.
    // A nested run (task-lifecycle work, or a hypothetical future nested
    // delegated run with its own run_stream) can never finalize, fail, or
    // contribute partial text to the root's outcome, however plausible its
    // shape looks — isMuseRootRunEnvelope requires an established root
    // identity and an exact run_stream.id match, not just a payload_type.
    if (isMuseRootRunEnvelope(envelope, root)) {
      if (envelope.payload_type === "run.terminal.completed") {
        sawTerminalEvent = true;
        const text = extractMuseFinalText(envelope);
        terminalSucceeded = typeof text === "string" && text.length > 0;
        if (terminalSucceeded) {
          resultText = text!;
          assistantMessages.push({ text: resultText });
        }
      } else if (envelope.payload_type === "run.terminal.failed") {
        sawTerminalEvent = true;
        terminalSucceeded = false;
        eventError ??= extractMuseError(envelope);
      } else if (envelope.payload_type === "run.output.delta") {
        const payload = payloadOf(envelope);
        if (typeof payload?.text === "string") {
          deltaText += payload.text;
        }
      }
    }
    // Activity narration is progress-only display, never authoritative for
    // the result, so it is deliberately not gated on root-run ownership:
    // nested tool/status activity is still useful live-progress signal.
    const activity = museActivityFromEvent(envelope);
    if (activity) {
      emitter.addActivity(activity);
      emitter.emitSoon();
    }
  };

  try {
    if (params.signal?.aborted) {
      throw new Error("Subagent aborted before prompt start");
    }

    tempFiles = await createMuseTempFiles(taskPrompt, params.outputSchema);
    if (params.signal?.aborted) {
      throw new Error("Subagent aborted before prompt start");
    }

    const args = buildMuseArgs({
      promptFilePath: tempFiles.promptPath,
      schemaFilePath: tempFiles.schemaPath,
      workspace: params.ctx.cwd,
      profile: params.profile,
      thinkingLevel: params.thinkingLevel,
      permission: params.permission,
      resumeSessionId: params.resumeSessionId,
    });

    const proc = spawn(MUSE_COMMAND, args, {
      cwd: params.ctx.cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    child = proc;

    proc.once("spawn", () => {
      if (progress) progress.processStartedAt = Date.now();
      try {
        params.onProcessStart?.(proc.pid);
      } catch {
        // observation is best-effort
      }
    });

    if (!proc.stdin || !proc.stdout || !proc.stderr) {
      throw new Error("muse stdin/stdout/stderr pipes were not available");
    }

    abortHandler = () => {
      abortChildTree(proc);
    };
    params.signal?.addEventListener("abort", abortHandler, { once: true });
    if (params.signal?.aborted) {
      abortChildTree(proc);
      throw new Error("Subagent aborted before prompt start");
    }

    let stdoutBuffer = "";
    proc.stdout.setEncoding("utf8");
    proc.stderr.setEncoding("utf8");
    proc.stdin.on("error", () => {
      // Avoid unhandled EPIPE if child exits before reading stdin
    });

    proc.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? "";
      if (stdoutBuffer.length > MAX_STDOUT_LINE_CHARS || lines.some((line) => line.length > MAX_STDOUT_LINE_CHARS)) {
        oversizeError ??= `muse emitted a stdout line over ${MAX_STDOUT_LINE_CHARS} chars; stream is unparseable`;
        stdoutBuffer = "";
        abortChildTree(proc);
        return;
      }
      for (const line of lines) {
        const envelope = parseMuseJsonLine(line);
        if (envelope) {
          handleEvent(envelope);
        }
      }
    });

    proc.stderr.on("data", (chunk) => {
      stderrBuffer.append(String(chunk));
    });

    emitter.emit();
    emitter.startHeartbeat();
    proc.stdin.end();

    const closeResult = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      proc.once("error", reject);
      proc.once("close", (code, signal) => {
        if (stdoutBuffer.trim()) {
          const envelope = parseMuseJsonLine(stdoutBuffer);
          if (envelope) {
            handleEvent(envelope);
          }
        }
        resolve({ code, signal });
      });
    });

    if (abortHandler) {
      params.signal?.removeEventListener("abort", abortHandler);
      abortHandler = undefined;
    }

    if (params.signal?.aborted) {
      throw new Error("Subagent aborted");
    }
    if (oversizeError) {
      throw new Error(oversizeError);
    }
    if (closeResult.code !== 0) {
      const stderr = stderrBuffer.text().trim();
      throw new Error(
        `muse exited with code ${closeResult.code}${closeResult.signal ? ` (signal ${closeResult.signal})` : ""}${stderr ? `: ${stderr}` : ""}`,
      );
    }
    if (eventError) {
      throw new Error(eventError);
    }
    if (!sawTerminalEvent) {
      throw new Error("muse exited without a terminal JSON event");
    }
    if (!terminalSucceeded || !resultText.trim()) {
      throw new Error("muse reported completion without a final result");
    }

    params.onUsage(latestUsage);
    const result = resultText.trim();
    const output = assistantOutput(assistantMessages, "final", result);
    if (progress) {
      progress.status = "done";
      progress.result = result;
      progress.usage = latestUsage;
      progress.assistantOutput = output;
      progress.endedAt = Date.now();
    }
    return textResult(`Subagent "${params.description}" (${subagentType}) completed:\n\n${result}`, {
      description: params.description,
      subagentType,
      backend: params.profile.backend,
      harness: selectorHarness(params.profile),
      status: "done",
      result,
      usage: latestUsage,
      assistantOutput: output,
      ...(root.sessionId ? { sessionId: root.sessionId } : {}),
      ...(progress ? { progress } : {}),
    });
  } catch (error) {
    if (child) abortChildTree(child);
    const message = error instanceof Error ? error.message : String(error);
    const status = params.signal?.aborted ? "aborted" : "error";
    const output = assistantOutput(assistantMessages, "interrupted", resultText || deltaText);
    params.onUsage(latestUsage);
    if (progress) {
      progress.status = status;
      progress.error = message;
      progress.usage = latestUsage;
      progress.assistantOutput = output;
      progress.endedAt = Date.now();
    }
    const verb = status === "aborted" ? "aborted" : "failed";
    const preview = formatInterruptedOutputPreview(output);
    return textResult(`Subagent "${params.description}" (${subagentType}) ${verb}: ${message}${preview}`, {
      description: params.description,
      subagentType,
      backend: params.profile.backend,
      harness: selectorHarness(params.profile),
      status,
      error: message,
      usage: latestUsage,
      assistantOutput: output,
      ...(root.sessionId ? { sessionId: root.sessionId } : {}),
      ...(progress ? { progress } : {}),
    });
  } finally {
    emitter.stop();
    if (abortHandler) {
      params.signal?.removeEventListener("abort", abortHandler);
    }
    await tempFiles?.cleanup().catch(() => undefined);
  }
}
