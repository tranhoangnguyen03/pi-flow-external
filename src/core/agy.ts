import { spawn, type ChildProcess } from "node:child_process";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createProgressEmitter, textResult, type AgentToolResult } from "./progress.ts";
import {
  createBoundedBuffer,
  MAX_STDERR_CHARS,
  MAX_STDOUT_LINE_CHARS,
} from "./stream.ts";
import type { SubagentProfile, SubagentUsage, ThinkingLevel } from "../types.ts";

const AGY_COMMAND = "agy";
const FORCE_KILL_DELAY_MS = 3000;

export interface AgyTokenUsage {
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
}

export interface AgyTerminalResult {
  status?: string;
  response?: string;
  error?: string;
  conversationId?: string;
  structuredOutput?: unknown;
  usage?: AgyTokenUsage;
}

function emptyUsage(): SubagentUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, costKnown: false };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

export function parseAgyJsonLine(line: string): Record<string, unknown> | undefined {
  const trimmed = line.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    return asRecord(JSON.parse(trimmed));
  } catch {
    return undefined;
  }
}

function parseAgyUsage(value: unknown): AgyTokenUsage | undefined {
  const usage = asRecord(value);
  if (!usage) {
    return undefined;
  }
  const inputTokens = asFiniteNumber(usage.input_tokens);
  const outputTokens = asFiniteNumber(usage.output_tokens);
  const thinkingTokens = asFiniteNumber(usage.thinking_tokens ?? 0);
  const cacheReadTokens = asFiniteNumber(usage.cache_read_tokens ?? 0);
  const totalTokens = asFiniteNumber(
    usage.total_tokens ?? ((inputTokens ?? 0) + (outputTokens ?? 0) + (thinkingTokens ?? 0)),
  );
  if (
    inputTokens === undefined ||
    outputTokens === undefined ||
    thinkingTokens === undefined ||
    cacheReadTokens === undefined ||
    totalTokens === undefined
  ) {
    return undefined;
  }
  return { inputTokens, outputTokens, thinkingTokens, cacheReadTokens, totalTokens };
}

export function agyUsageToSubagentUsage(usage: AgyTokenUsage): SubagentUsage {
  const inputTokens = Math.max(0, usage.inputTokens);
  const cacheRead = Math.min(inputTokens, Math.max(0, usage.cacheReadTokens));
  return {
    input: inputTokens - cacheRead,
    // Antigravity reports reasoning separately; include it in generated-token
    // usage so aggregate field totals match the backend's total_tokens value.
    output: Math.max(0, usage.outputTokens) + Math.max(0, usage.thinkingTokens),
    cacheRead,
    cacheWrite: 0,
    cost: 0,
    costKnown: false,
    latestCacheHitRate: inputTokens > 0 ? (cacheRead / inputTokens) * 100 : undefined,
  };
}

export function normalizeAgyEffort(thinkingLevel: ThinkingLevel | undefined): "low" | "medium" | "high" | undefined {
  const normalized = thinkingLevel?.trim().toLowerCase();
  if (!normalized || normalized === "off") {
    return undefined;
  }
  if (normalized === "minimal" || normalized === "low") {
    return "low";
  }
  if (normalized === "medium") {
    return "medium";
  }
  if (normalized === "high" || normalized === "xhigh" || normalized === "max") {
    return "high";
  }
  return undefined;
}

export function extractAgyTerminalResult(event: Record<string, unknown>): AgyTerminalResult | undefined {
  if (event.event !== "result") {
    return undefined;
  }
  const result = asRecord(event.result);
  if (!result) {
    return undefined;
  }
  return {
    status: typeof result.status === "string" ? result.status : undefined,
    response: typeof result.response === "string" ? result.response : undefined,
    error: typeof result.error === "string" ? result.error : undefined,
    conversationId:
      typeof result.conversation_id === "string"
        ? result.conversation_id
        : typeof event.conversation_id === "string"
          ? event.conversation_id
          : undefined,
    ...(Object.hasOwn(result, "structured_output") ? { structuredOutput: result.structured_output } : {}),
    usage: parseAgyUsage(result.usage),
  };
}

function textFromAgyResult(result: AgyTerminalResult): string | undefined {
  if (result.structuredOutput !== undefined) {
    return typeof result.structuredOutput === "string"
      ? result.structuredOutput
      : JSON.stringify(result.structuredOutput);
  }
  return result.response;
}

function agyActivityFromEvent(event: Record<string, unknown>): string | undefined {
  if (event.event === "init") {
    return "agy session started";
  }
  if (event.event === "result") {
    return "agy turn completed";
  }
  if (event.event !== "step_update") {
    return undefined;
  }
  const update = asRecord(event.step_update);
  if (!update) {
    return undefined;
  }
  if (typeof update.tool_name === "string" && update.tool_name.trim()) {
    return update.tool_name;
  }
  if (typeof update.text_delta === "string" && update.text_delta.trim()) {
    return update.text_delta.split("\n").find((line) => line.trim());
  }
  return undefined;
}

export function buildAgyArgs({
  profile,
  thinkingLevel,
  prompt,
  outputSchema,
}: {
  profile: SubagentProfile;
  thinkingLevel: ThinkingLevel | undefined;
  prompt: string;
  outputSchema?: unknown;
}): string[] {
  const args = [
    "--dangerously-skip-permissions",
    "--output-format",
    "stream-json",
  ];
  if (profile.model) {
    args.push("--model", profile.model);
  }
  const effort = normalizeAgyEffort(thinkingLevel);
  if (effort) {
    args.push("--effort", effort);
  }
  if (outputSchema !== undefined && outputSchema !== null) {
    args.push("--json-schema", JSON.stringify(outputSchema));
  }
  args.push("-p", prompt);
  return args;
}

function hasChildExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function signalChildTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall through to direct child kill if the process group is already gone.
    }
  }
  child.kill(signal);
}

function abortChild(child: ChildProcess): void {
  if (hasChildExited(child)) {
    return;
  }
  signalChildTree(child, "SIGTERM");
  setTimeout(() => {
    if (!hasChildExited(child)) {
      signalChildTree(child, "SIGKILL");
    }
  }, FORCE_KILL_DELAY_MS).unref();
}

export async function spawnAgySubagent(params: {
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
  appendInstructions?: string;
  outputSchema?: unknown;
}): Promise<AgentToolResult> {
  const subagentType = params.profile.name;
  const promptParts = [params.profile.systemPrompt, params.prompt, params.appendInstructions].filter(Boolean);
  const taskPrompt = promptParts.join("\n\n");
  let latestUsage = emptyUsage();
  const emitter = createProgressEmitter({
    toolCallId: params.toolCallId,
    description: params.description,
    subagentType,
    backend: params.profile.backend,
    enabled: params.progressEnabled,
    onProgress: params.onProgress,
  });
  const progress = emitter.progress;
  const stderrBuffer = createBoundedBuffer(MAX_STDERR_CHARS);
  let terminalResult: AgyTerminalResult | undefined;
  let conversationId: string | undefined;
  let protocolError: string | undefined;
  let oversizeError: string | undefined;
  let sawTerminalEvent = false;
  let child: ChildProcess | undefined;
  let abortHandler: (() => void) | undefined;

  const handleEvent = (event: Record<string, unknown>) => {
    try {
      params.onBackendEvent?.(event);
    } catch {
      // Observation hooks must not change the backend result.
    }

    if (sawTerminalEvent) {
      protocolError ??= "agy emitted an event after its terminal result event";
      return;
    }

    if (event.event === "init" && typeof event.conversation_id === "string") {
      conversationId ??= event.conversation_id;
    }

    const activity = agyActivityFromEvent(event);
    if (activity) {
      emitter.addActivity(activity);
      emitter.emitSoon();
    }

    if (event.event !== "result") {
      return;
    }
    sawTerminalEvent = true;
    const parsed = extractAgyTerminalResult(event);
    if (!parsed) {
      protocolError ??= "agy emitted a malformed terminal result event";
      return;
    }
    terminalResult = parsed;
    conversationId = parsed.conversationId ?? conversationId;
    if (parsed.usage) {
      latestUsage = agyUsageToSubagentUsage(parsed.usage);
      if (progress) {
        progress.usage = latestUsage;
      }
      params.onUsage(latestUsage);
      emitter.emitSoon();
    }
  };

  try {
    if (params.signal?.aborted) {
      throw new Error("Subagent aborted before prompt start");
    }
    const proc = spawn(AGY_COMMAND, buildAgyArgs({
      profile: params.profile,
      thinkingLevel: params.thinkingLevel,
      prompt: taskPrompt,
      outputSchema: params.outputSchema,
    }), {
      cwd: params.ctx.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    child = proc;
    if (!proc.stdout || !proc.stderr) {
      throw new Error("agy stdout/stderr pipes were not available");
    }
    abortHandler = () => abortChild(proc);
    params.signal?.addEventListener("abort", abortHandler, { once: true });
    if (params.signal?.aborted) {
      abortChild(proc);
      throw new Error("Subagent aborted before prompt start");
    }
    proc.stdout.setEncoding("utf8");
    proc.stderr.setEncoding("utf8");
    let stdoutBuffer = "";
    proc.stdout.on("data", (chunk) => {
      stdoutBuffer += String(chunk);
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? "";
      if (stdoutBuffer.length > MAX_STDOUT_LINE_CHARS) {
        oversizeError ??= `agy emitted a stdout line over ${MAX_STDOUT_LINE_CHARS} chars without a newline; stream is unparseable`;
        stdoutBuffer = "";
        abortChild(proc);
        return;
      }
      for (const line of lines) {
        if (!line.trim()) {
          continue;
        }
        const event = parseAgyJsonLine(line);
        if (!event) {
          protocolError ??= "agy emitted invalid stream-json output";
          continue;
        }
        handleEvent(event);
      }
    });
    proc.stderr.on("data", (chunk) => stderrBuffer.append(String(chunk)));

    emitter.emit();
    emitter.startHeartbeat();
    const closeResult = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      proc.once("error", reject);
      proc.once("close", (code, signal) => {
        if (stdoutBuffer.trim()) {
          const event = parseAgyJsonLine(stdoutBuffer);
          if (event) {
            handleEvent(event);
          } else {
            protocolError ??= "agy emitted invalid stream-json output";
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
    if (protocolError) {
      throw new Error(protocolError);
    }
    if (closeResult.code !== 0) {
      const stderr = stderrBuffer.text().trim();
      throw new Error(`agy exited with code ${closeResult.code}${closeResult.signal ? ` (signal ${closeResult.signal})` : ""}${stderr ? `: ${stderr}` : ""}`);
    }
    if (!terminalResult) {
      throw new Error("agy exited without a terminal result event");
    }
    const terminalStatus = terminalResult.status?.trim().toUpperCase();
    if (!terminalStatus) {
      throw new Error("agy terminal result is missing status");
    }
    if (terminalStatus !== "SUCCESS") {
      throw new Error(`agy failed with status ${terminalStatus}${terminalResult.error?.trim() ? `: ${terminalResult.error.trim()}` : ""}`);
    }
    const result = textFromAgyResult(terminalResult)?.trim();
    if (!result) {
      throw new Error("agy reported SUCCESS without a result response");
    }
    params.onUsage(latestUsage);
    if (progress) {
      progress.status = "done";
      progress.result = result;
      progress.usage = latestUsage;
      progress.endedAt = Date.now();
    }
    return textResult(`Subagent "${params.description}" (${subagentType}) completed:\n\n${result}`, {
      description: params.description,
      subagentType,
      backend: params.profile.backend,
      status: "done",
      result,
      usage: latestUsage,
      ...(conversationId ? { conversationId } : {}),
      ...(progress ? { progress } : {}),
    });
  } catch (error) {
    if (child && !hasChildExited(child)) abortChild(child);
    const message = error instanceof Error ? error.message : String(error);
    const status = params.signal?.aborted ? "aborted" : "error";
    params.onUsage(latestUsage);
    if (progress) {
      progress.status = status;
      progress.error = message;
      progress.usage = latestUsage;
      progress.endedAt = Date.now();
    }
    return textResult(`Subagent "${params.description}" (${subagentType}) ${status === "aborted" ? "aborted" : "failed"}: ${message}`, {
      description: params.description,
      subagentType,
      backend: params.profile.backend,
      status,
      error: message,
      usage: latestUsage,
      ...(conversationId ? { conversationId } : {}),
      ...(progress ? { progress } : {}),
    });
  } finally {
    emitter.stop();
    if (abortHandler) params.signal?.removeEventListener("abort", abortHandler);
  }
}
