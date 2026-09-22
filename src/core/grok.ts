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

const GROK_COMMAND = "grok";

export type GrokReasoningEffort = "low" | "medium" | "high" | "xhigh";

export interface GrokTokenUsage {
  inputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  outputTokens: number;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

export function normalizeGrokReasoningEffort(thinkingLevel: ThinkingLevel | undefined): GrokReasoningEffort | undefined {
  const normalized = thinkingLevel?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized === "off" || normalized === "minimal" || normalized === "low") {
    return "low";
  }
  if (normalized === "medium") {
    return "medium";
  }
  if (normalized === "high") {
    return "high";
  }
  if (normalized === "xhigh") {
    return "xhigh";
  }
  return undefined;
}

export function buildGrokArgs({
  promptFilePath,
  profile,
  thinkingLevel,
  outputSchema,
  permission = "danger",
  resumeSessionId,
}: {
  promptFilePath?: string;
  profile: SubagentProfile;
  thinkingLevel?: ThinkingLevel;
  outputSchema?: unknown;
  permission?: PermissionTier;
  resumeSessionId?: string;
}): string[] {
  const args: string[] = [];
  if (promptFilePath) {
    args.push("--prompt-file", promptFilePath);
  }
  if (outputSchema !== undefined && outputSchema !== null) {
    args.push("--json-schema", typeof outputSchema === "string" ? outputSchema : JSON.stringify(outputSchema));
  } else {
    args.push("--output-format", "streaming-messages-json");
  }
  if (resumeSessionId) {
    args.push("--resume", resumeSessionId);
  }
  args.push(...buildPermissionArgs(permission, "grok"));
  if (profile.systemPrompt) {
    args.push("--system-prompt-override", profile.systemPrompt);
  }
  if (profile.model) {
    args.push("-m", profile.model);
  }
  const effort = normalizeGrokReasoningEffort(thinkingLevel ?? profile.thinking);
  if (effort) {
    args.push("--reasoning-effort", effort);
  }
  return args;
}

export function parseGrokJsonLine(line: string): Record<string, unknown> | undefined {
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

function parseUsageRecord(value: unknown): GrokTokenUsage | undefined {
  const usage = asRecord(value);
  if (!usage) {
    return undefined;
  }
  const inputTokens = asFiniteNumber(usage.input_tokens ?? usage.inputTokens);
  const cacheReadInputTokens = asFiniteNumber(usage.cache_read_input_tokens ?? usage.cacheReadInputTokens ?? 0);
  const cacheCreationInputTokens = asFiniteNumber(usage.cache_creation_input_tokens ?? usage.cacheCreationInputTokens ?? 0);
  const outputTokens = asFiniteNumber(usage.output_tokens ?? usage.outputTokens);
  if (
    inputTokens === undefined ||
    cacheReadInputTokens === undefined ||
    cacheCreationInputTokens === undefined ||
    outputTokens === undefined
  ) {
    return undefined;
  }
  return { inputTokens, cacheReadInputTokens, cacheCreationInputTokens, outputTokens };
}

function parseModelUsage(value: unknown): GrokTokenUsage | undefined {
  const modelUsage = asRecord(value);
  if (!modelUsage) {
    return undefined;
  }
  const totals: GrokTokenUsage = {
    inputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    outputTokens: 0,
  };
  let found = false;
  for (const item of Object.values(modelUsage)) {
    const usage = asRecord(item);
    if (!usage) {
      continue;
    }
    const inputTokens = asFiniteNumber(usage.inputTokens ?? usage.input_tokens);
    const cacheReadInputTokens = asFiniteNumber(usage.cacheReadInputTokens ?? usage.cache_read_input_tokens ?? 0);
    const cacheCreationInputTokens = asFiniteNumber(usage.cacheCreationInputTokens ?? usage.cache_creation_input_tokens ?? 0);
    const outputTokens = asFiniteNumber(usage.outputTokens ?? usage.output_tokens);
    if (
      inputTokens === undefined ||
      cacheReadInputTokens === undefined ||
      cacheCreationInputTokens === undefined ||
      outputTokens === undefined
    ) {
      continue;
    }
    found = true;
    totals.inputTokens += inputTokens;
    totals.cacheReadInputTokens += cacheReadInputTokens;
    totals.cacheCreationInputTokens += cacheCreationInputTokens;
    totals.outputTokens += outputTokens;
  }
  return found ? totals : undefined;
}

function sumModelUsageCost(value: unknown): number | undefined {
  const modelUsage = asRecord(value);
  if (!modelUsage) {
    return undefined;
  }
  let total = 0;
  let found = false;
  for (const item of Object.values(modelUsage)) {
    const cost = asFiniteNumber(asRecord(item)?.costUSD);
    if (cost !== undefined) {
      found = true;
      total += cost;
    }
  }
  return found ? total : undefined;
}

export function extractGrokUsage(event: Record<string, unknown>): GrokTokenUsage | undefined {
  if (event.type === "result" || event.stopReason !== undefined || event.stop_reason !== undefined) {
    return parseModelUsage(event.modelUsage) ?? parseUsageRecord(event.usage);
  }
  if (event.type === "assistant") {
    const message = asRecord(event.message);
    return message ? parseUsageRecord(message.usage) : undefined;
  }
  return undefined;
}

export function extractGrokCostUsd(event: Record<string, unknown>): number | undefined {
  return asFiniteNumber(event.total_cost_usd) ?? sumModelUsageCost(event.modelUsage);
}

export function extractGrokSessionId(event: Record<string, unknown>): string | undefined {
  if (typeof event.session_id === "string" && event.session_id) {
    return event.session_id;
  }
  if (typeof event.sessionId === "string" && event.sessionId) {
    return event.sessionId;
  }
  return undefined;
}

export function grokUsageToSubagentUsage(usage: GrokTokenUsage, costUsd: number | undefined): SubagentUsage {
  const input = Math.max(0, usage.inputTokens);
  const cacheRead = Math.max(0, usage.cacheReadInputTokens);
  const cacheWrite = Math.max(0, usage.cacheCreationInputTokens);
  const output = Math.max(0, usage.outputTokens);
  const promptTokens = input + cacheRead + cacheWrite;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    cost: costUsd ?? 0,
    costKnown: costUsd !== undefined,
    costEstimated: false,
    latestCacheHitRate: promptTokens > 0 ? (cacheRead / promptTokens) * 100 : undefined,
  };
}

function textFromGrokContent(content: unknown): string | undefined {
  if (!Array.isArray(content)) {
    return undefined;
  }
  const text = content
    .map((part) => {
      const block = asRecord(part);
      return block?.type === "text" && typeof block.text === "string" ? block.text : undefined;
    })
    .filter((part): part is string => part !== undefined)
    .join("");
  return text ? text : undefined;
}

export function extractGrokFinalText(event: Record<string, unknown>): string | undefined {
  if (event.type === "result") {
    if (event.is_error === true) {
      return undefined;
    }
    return typeof event.result === "string" ? event.result : undefined;
  }
  if (event.type !== "assistant") {
    return undefined;
  }
  const message = asRecord(event.message);
  return message ? textFromGrokContent(message.content) : undefined;
}

export function extractGrokError(event: Record<string, unknown>): string | undefined {
  if (event.type === "result" && (event.is_error === true || event.subtype !== "success")) {
    const errors = Array.isArray(event.errors) ? event.errors : [];
    const first = errors.find((candidate) => typeof candidate === "string");
    const result = typeof event.result === "string" && event.result.trim() ? event.result.trim() : undefined;
    return `Grok failed: ${first ?? result ?? (typeof event.subtype === "string" ? event.subtype : "turn failed")}`;
  }
  if (event.type === "error") {
    return `Grok error: ${typeof event.message === "string" ? event.message : "unknown error"}`;
  }
  return undefined;
}

function getPreviewFromRecord(record: Record<string, unknown>): string {
  const candidates = [
    record.command,
    record.cmd,
    record.file_path,
    record.path,
    record.pattern,
    record.query,
    record.prompt,
    record.description,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.replace(/\s+/g, " ").trim();
    }
  }
  const input = asRecord(record.input) ?? asRecord(record.arguments) ?? asRecord(record.args);
  return input ? getPreviewFromRecord(input) : "";
}

export function grokActivityFromEvent(event: Record<string, unknown>): string | undefined {
  if (event.type === "assistant") {
    const message = asRecord(event.message);
    const content = message?.content;
    if (Array.isArray(content)) {
      for (const part of content) {
        const block = asRecord(part);
        if (block?.type === "tool_use") {
          const toolName = typeof block.name === "string" && block.name ? block.name : "tool_use";
          const preview = getPreviewFromRecord(block);
          return `${toolName}${preview ? ` ${preview}` : ""}`;
        }
      }
    }
  }
  const error = extractGrokError(event);
  return error ? error : undefined;
}

async function createGrokPromptFile(prompt: string): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "pi-subagents-grok-prompt-"));
  const promptPath = join(dir, "prompt.txt");
  await writeFile(promptPath, prompt, "utf8");
  return {
    path: promptPath,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

export async function spawnGrokSubagent(params: {
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
  const taskPrompt = params.appendInstructions ? `${params.prompt}\n\n${params.appendInstructions}` : params.prompt;
  const emitter = createProgressEmitter({
    toolCallId: params.toolCallId,
    description: params.description,
    subagentType,
    backend: params.profile.backend,
    enabled: params.progressEnabled,
    onProgress: params.onProgress,
    executionStartedAt: params.executionStartedAt,
  });
  const progress = emitter.progress;

  let latestRawUsage: GrokTokenUsage = {
    inputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    outputTokens: 0,
  };
  let latestCostUsd: number | undefined;
  let latestUsage = grokUsageToSubagentUsage(latestRawUsage, latestCostUsd);
  let resultText = "";
  const assistantMessages: Array<{ id?: string; text: string }> = [];
  let sessionId: string | undefined;
  const stderrBuffer = createBoundedBuffer(MAX_STDERR_CHARS);
  let sawTerminalEvent = false;
  let terminalSucceeded = false;
  let eventError: string | undefined;
  let oversizeError: string | undefined;
  let child: ChildProcess | undefined;
  let promptFile: Awaited<ReturnType<typeof createGrokPromptFile>> | undefined;
  let abortHandler: (() => void) | undefined;
  const isStructuredMode = params.outputSchema !== undefined && params.outputSchema !== null;
  let structuredStdout = "";

  const publishUsage = (usage: GrokTokenUsage | undefined, costUsd: number | undefined) => {
    if (usage) {
      latestRawUsage = usage;
    }
    if (costUsd !== undefined) {
      latestCostUsd = costUsd;
    }
    latestUsage = grokUsageToSubagentUsage(latestRawUsage, latestCostUsd);
    if (progress) {
      progress.usage = latestUsage;
    }
    params.onUsage(latestUsage);
    emitter.emitSoon();
  };

  const handleEvent = (event: Record<string, unknown>) => {
    try {
      params.onBackendEvent?.(event);
    } catch {
      // Observation hooks must not change the backend result.
    }
    if (event.type === "result") {
      sawTerminalEvent = true;
      const stopReason = event.stop_reason ?? event.stopReason;
      terminalSucceeded = event.subtype === "success" && event.is_error === false && stopReason === "end_turn";
    }
    const activity = grokActivityFromEvent(event);
    if (activity) {
      emitter.addActivity(activity);
      emitter.emitSoon();
    }
    const usage = extractGrokUsage(event);
    const cost = extractGrokCostUsd(event);
    if (usage || cost !== undefined) {
      publishUsage(usage, cost);
    }
    const eventSessionId = extractGrokSessionId(event);
    if (eventSessionId) {
      sessionId = eventSessionId;
    }
    const text = extractGrokFinalText(event);
    if (text !== undefined) {
      resultText = text;
      if (event.type === "assistant" && text.trim()) {
        const message = asRecord(event.message);
        assistantMessages.push({ ...(typeof message?.id === "string" ? { id: message.id } : {}), text });
      }
      if (text.trim()) {
        emitter.addActivity(text.split("\n").find((line) => line.trim()) ?? text);
        emitter.emitSoon();
      }
    }
    const error = extractGrokError(event);
    if (error) {
      eventError ??= error;
    } else if (event.type === "result" && !terminalSucceeded) {
      eventError ??= "grok terminal event did not affirm success";
    }
  };

  try {
    if (params.signal?.aborted) {
      throw new Error("Subagent aborted before prompt start");
    }

    promptFile = await createGrokPromptFile(taskPrompt);
    if (params.signal?.aborted) {
      throw new Error("Subagent aborted before prompt start");
    }

    const args = buildGrokArgs({
      promptFilePath: promptFile.path,
      profile: params.profile,
      thinkingLevel: params.thinkingLevel,
      outputSchema: params.outputSchema,
      permission: params.permission,
      resumeSessionId: params.resumeSessionId,
    });

    const proc = spawn(GROK_COMMAND, args, {
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
      throw new Error("grok stdin/stdout/stderr pipes were not available");
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
      if (isStructuredMode) {
        structuredStdout += chunk;
        if (structuredStdout.length > MAX_STDOUT_LINE_CHARS) {
          oversizeError ??= `grok emitted a stdout payload over ${MAX_STDOUT_LINE_CHARS} chars; stream is unparseable`;
          structuredStdout = "";
          abortChildTree(proc);
        }
        return;
      }

      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? "";
      if (stdoutBuffer.length > MAX_STDOUT_LINE_CHARS || lines.some((line) => line.length > MAX_STDOUT_LINE_CHARS)) {
        oversizeError ??= `grok emitted a stdout line over ${MAX_STDOUT_LINE_CHARS} chars; stream is unparseable`;
        stdoutBuffer = "";
        abortChildTree(proc);
        return;
      }
      for (const line of lines) {
        const event = parseGrokJsonLine(line);
        if (event) {
          handleEvent(event);
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
        if (!isStructuredMode && stdoutBuffer.trim()) {
          const event = parseGrokJsonLine(stdoutBuffer);
          if (event) {
            handleEvent(event);
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
    if (eventError) {
      throw new Error(eventError);
    }
    if (closeResult.code !== 0) {
      const stderr = stderrBuffer.text().trim();
      throw new Error(
        `grok exited with code ${closeResult.code}${closeResult.signal ? ` (signal ${closeResult.signal})` : ""}${stderr ? `: ${stderr}` : ""}`,
      );
    }

    if (isStructuredMode) {
      const trimmedDoc = structuredStdout.trim();
      if (!trimmedDoc) {
        throw new Error("grok exited without a terminal JSON event");
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmedDoc);
      } catch {
        throw new Error("grok exited without a terminal JSON event");
      }
      const doc = asRecord(parsed);
      if (!doc) {
        throw new Error("grok exited without a terminal JSON event");
      }

      try {
        params.onBackendEvent?.(doc);
      } catch {
        // Observation hooks must not change the backend result.
      }

      sawTerminalEvent = true;
      const stopReason = doc.stopReason ?? doc.stop_reason;
      terminalSucceeded = stopReason === "end_turn";
      if (!terminalSucceeded) {
        throw new Error("grok terminal event did not affirm success");
      }

      const eventSessionId = extractGrokSessionId(doc);
      if (eventSessionId) {
        sessionId = eventSessionId;
      }
      const usage = extractGrokUsage(doc);
      const cost = extractGrokCostUsd(doc);
      if (usage || cost !== undefined) {
        publishUsage(usage, cost);
      }

      if (doc.structuredOutput === undefined || doc.structuredOutput === null) {
        const structuredError =
          (typeof doc.structuredOutputError === "string" && doc.structuredOutputError.trim()) ||
          (typeof doc.error === "string" && doc.error.trim()) ||
          (typeof doc.message === "string" && doc.message.trim()) ||
          undefined;
        throw new Error(
          structuredError
            ? `Grok structured output failed: ${structuredError}`
            : "grok reported completion without a final result",
        );
      }
      resultText = JSON.stringify(doc.structuredOutput);
    } else {
      if (!sawTerminalEvent) {
        throw new Error("grok exited without a terminal JSON event");
      }
      if (!terminalSucceeded) {
        throw new Error("grok terminal event did not affirm success");
      }
      if (!resultText.trim()) {
        throw new Error("grok reported completion without a final result");
      }
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
      status: "done",
      result,
      usage: latestUsage,
      assistantOutput: output,
      ...(sessionId ? { sessionId } : {}),
      ...(progress ? { progress } : {}),
    });
  } catch (error) {
    if (child) abortChildTree(child);
    const message = error instanceof Error ? error.message : String(error);
    const status = params.signal?.aborted ? "aborted" : "error";
    const output = assistantOutput(assistantMessages, "interrupted", resultText);
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
      status,
      error: message,
      usage: latestUsage,
      assistantOutput: output,
      ...(sessionId ? { sessionId } : {}),
      ...(progress ? { progress } : {}),
    });
  } finally {
    emitter.stop();
    if (abortHandler) {
      params.signal?.removeEventListener("abort", abortHandler);
    }
    await promptFile?.cleanup().catch(() => undefined);
  }
}
