import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
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
import type { PermissionTier, SubagentProfile, SubagentUsage } from "../types.ts";
import { buildPermissionArgs } from "./permissions.ts";
import { abortChildTree } from "./process-tree.ts";
import { opencodeProfileProblem, selectorHarness } from "../profiles.ts";

const OPENCODE_COMMAND = "opencode";

/**
 * OpenCode's permission rule names for the tools each restricted tier keeps
 * (verified against opencode 1.18.32 src/tool/*.ts: `edit` also covers
 * write and apply_patch). Everything else, including bash, task, web, MCP,
 * plugin, and custom tools, falls under the leading `"*": "deny"` rule and is
 * hidden from the model. Rules are last-match-wins
 * (src/permission/index.ts `evaluate` uses findLast).
 */
const OPENCODE_TIER_ALLOWED: Readonly<Record<Exclude<PermissionTier, "danger">, readonly string[]>> = {
  readonly: ["read", "grep", "glob"],
  edit: ["read", "grep", "glob", "edit"],
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asFiniteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * readonly/edit run under a primary agent injected through
 * OPENCODE_CONFIG_CONTENT and selected with `default_agent`. That source is
 * merged after global, project, and `.opencode/` config
 * (src/config/config.ts), so it overrides a project `default_agent`. The
 * agent name is random per run: agent-level permission objects are
 * deep-merged by key, so a project file that predefined rules for a fixed
 * name could keep an `allow` after our `"*": "deny"`. A missing default
 * agent fails the run (src/agent/agent.ts `defaultInfo`) instead of falling
 * back to `build`. `--agent` is not used because an unknown `--agent` falls
 * back to the default agent with only a warning.
 *
 * danger injects nothing. `--auto` approves every `ask` rule. Explicit
 * denies in the user's own config still apply.
 */
export function buildOpencodeEnv(
  permission: PermissionTier,
  baseEnv: NodeJS.ProcessEnv,
  agentSuffix: string = randomBytes(6).toString("hex"),
): NodeJS.ProcessEnv {
  if (permission === "danger") return baseEnv;
  if (baseEnv.OPENCODE_CONFIG_CONTENT !== undefined) {
    throw new Error(
      `OpenCode ${permission} needs OPENCODE_CONFIG_CONTENT to install its restricted agent, but that variable is already set in this environment. Unset it, or pass permission "danger".`,
    );
  }
  const agent = `pi-flow-${permission}-${agentSuffix}`;
  const rules: Record<string, string> = { "*": "deny" };
  for (const tool of OPENCODE_TIER_ALLOWED[permission]) rules[tool] = "allow";
  return {
    ...baseEnv,
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ default_agent: agent, agent: { [agent]: { mode: "primary", permission: rules } } }),
  };
}

export function buildOpencodeArgs({
  workspace,
  profile,
  permission = "danger",
  resumeSessionId,
}: {
  workspace: string;
  profile: SubagentProfile;
  permission?: PermissionTier;
  resumeSessionId?: string;
}): string[] {
  const problem = opencodeProfileProblem(profile);
  if (problem) throw new Error(problem);
  // The prompt goes over stdin. `--dir` pins the project directory, because
  // opencode otherwise resolves it from an inherited $PWD.
  const args = ["run", "--format", "json", "--dir", workspace];
  if (resumeSessionId) args.push("--session", resumeSessionId);
  if (profile.model) args.push("--model", profile.model);
  args.push(...buildPermissionArgs(permission, "opencode"));
  return args;
}

/**
 * `opencode run --format json` writes one `{type, timestamp, sessionID, ...}`
 * object per line, only for parts whose own `sessionID` is the root session
 * (src/cli/cmd/run.ts). Child `task` sessions are not streamed.
 */
export function parseOpencodeJsonLine(line: string): Record<string, unknown> | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  try {
    return asRecord(JSON.parse(trimmed));
  } catch {
    return undefined;
  }
}

function partOf(event: Record<string, unknown>): Record<string, unknown> | undefined {
  const part = asRecord(event.part);
  // A part must belong to the session of the event that carries it.
  return part && part.sessionID === event.sessionID ? part : undefined;
}

/** Text of one completed `text` part. Parts are emitted once, when complete. */
export function extractOpencodeText(event: Record<string, unknown>): string | undefined {
  if (event.type !== "text") return undefined;
  const part = partOf(event);
  return typeof part?.text === "string" && part.text ? part.text : undefined;
}

export function extractOpencodeError(event: Record<string, unknown>): string | undefined {
  if (event.type !== "error") return undefined;
  const error = asRecord(event.error);
  const message = asRecord(error?.data)?.message;
  const reason = typeof message === "string" && message.trim()
    ? message.trim()
    : typeof error?.name === "string" && error.name
      ? error.name
      : "unknown error";
  return `opencode failed: ${reason}`;
}

/** `task` is OpenCode's subagent tool. `tool_use` is emitted only once the tool finishes. */
export function opencodeHasNestedAgentActivity(event: Record<string, unknown>): boolean {
  return event.type === "tool_use" && partOf(event)?.tool === "task";
}

function isPermissionDenial(part: Record<string, unknown>): boolean {
  const state = asRecord(part.state);
  if (state?.status !== "error" || typeof state.error !== "string") return false;
  // PermissionRejectedError / PermissionDeniedError messages (packages/core/src/v1/permission.ts).
  return state.error.includes("The user rejected permission to use this specific tool call") ||
    state.error.includes("The user has specified a rule which prevents you from using this specific tool call");
}

export function opencodeActivityFromEvent(event: Record<string, unknown>): string | undefined {
  if (event.type === "tool_use") {
    const part = partOf(event);
    if (!part) return undefined;
    const tool = typeof part.tool === "string" && part.tool ? part.tool : "tool";
    const state = asRecord(part.state);
    const title = typeof state?.title === "string" ? state.title.replace(/\s+/g, " ").trim() : "";
    return `${tool}${state?.status === "error" ? " failed" : ""}${title ? ` ${title}` : ""}`;
  }
  return extractOpencodeText(event) ?? extractOpencodeError(event);
}

export async function spawnOpencodeSubagent(params: {
  toolCallId: string;
  description: string;
  prompt: string;
  profile: SubagentProfile;
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
  // opencode run has no system-prompt flag; fold the profile instructions
  // into the prompt, as agy and muse do.
  const taskPrompt = [params.profile.systemPrompt, params.prompt, params.appendInstructions]
    .filter((part): part is string => Boolean(part))
    .join("\n\n");
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

  // Tokens and cost come from root-session step_finish parts. OpenCode prices
  // them from its own model catalog. Child `task` sessions are not streamed,
  // so their usage is missing and cost becomes unknown once one ran.
  const latestUsage: SubagentUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, costKnown: false, costEstimated: false };
  let sawUsage = false;
  let nestedTaskSeen = false;
  let sessionId: string | undefined;
  let stepText: string[] = [];
  let inStep = false;
  let finishReason: string | undefined;
  let finalText = "";
  const allText: string[] = [];
  let permissionDenials = 0;
  let eventError: string | undefined;
  let oversizeError: string | undefined;
  const stderrBuffer = createBoundedBuffer(MAX_STDERR_CHARS);
  let child: ChildProcess | undefined;
  let abortHandler: (() => void) | undefined;

  const handleEvent = (event: Record<string, unknown>) => {
    try {
      params.onBackendEvent?.(event);
    } catch {
      // Observation hooks must not change the backend result.
    }
    if (typeof event.sessionID !== "string" || !event.sessionID) return;
    // The first event fixes the root session. Anything else is foreign.
    sessionId ??= event.sessionID;
    if (event.sessionID !== sessionId) return;
    const part = partOf(event);
    if (event.type === "step_start") {
      inStep = true;
      stepText = [];
    } else if (event.type === "text") {
      const text = extractOpencodeText(event);
      if (text) {
        stepText.push(text);
        allText.push(text);
      }
    } else if (event.type === "step_finish" && part) {
      inStep = false;
      finishReason = typeof part.reason === "string" ? part.reason : "unknown";
      finalText = stepText.join("\n\n");
      const tokens = asRecord(part.tokens);
      const cache = asRecord(tokens?.cache);
      latestUsage.input += asFiniteNumber(tokens?.input);
      latestUsage.output += asFiniteNumber(tokens?.output) + asFiniteNumber(tokens?.reasoning);
      latestUsage.cacheRead += asFiniteNumber(cache?.read);
      latestUsage.cacheWrite += asFiniteNumber(cache?.write);
      latestUsage.cost += asFiniteNumber(part.cost);
      sawUsage = true;
    } else if (event.type === "tool_use" && part) {
      if (part.tool === "task") nestedTaskSeen = true;
      if (isPermissionDenial(part)) permissionDenials++;
    } else if (event.type === "error") {
      const message = extractOpencodeError(event);
      eventError = eventError ? `${eventError}; ${message}` : message;
    }
    latestUsage.costKnown = sawUsage && !nestedTaskSeen;
    const activity = opencodeActivityFromEvent(event);
    if (activity) {
      emitter.addActivity(activity);
      emitter.emitSoon();
    }
  };

  try {
    if (params.signal?.aborted) throw new Error("Subagent aborted before prompt start");
    if (params.outputSchema !== undefined && params.outputSchema !== null) {
      throw new Error("OpenCode run has no native output-schema option, so structured workflow output is unsupported on opencode. Drop the schema and parse the text result instead.");
    }
    const permission = params.permission ?? "danger";
    const args = buildOpencodeArgs({
      workspace: params.ctx.cwd,
      profile: params.profile,
      permission,
      resumeSessionId: params.resumeSessionId,
    });
    const env = buildOpencodeEnv(permission, process.env);

    const proc = spawn(OPENCODE_COMMAND, args, {
      cwd: params.ctx.cwd,
      env,
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
      throw new Error("opencode stdin/stdout/stderr pipes were not available");
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
      // Avoid unhandled EPIPE if the child exits before reading stdin.
    });

    proc.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? "";
      if (stdoutBuffer.length > MAX_STDOUT_LINE_CHARS || lines.some((line) => line.length > MAX_STDOUT_LINE_CHARS)) {
        oversizeError ??= `opencode emitted a stdout line over ${MAX_STDOUT_LINE_CHARS} chars; stream is unparseable`;
        stdoutBuffer = "";
        abortChildTree(proc);
        return;
      }
      for (const line of lines) {
        const event = parseOpencodeJsonLine(line);
        if (event) handleEvent(event);
      }
    });

    proc.stderr.on("data", (chunk) => {
      stderrBuffer.append(String(chunk));
    });

    emitter.emit();
    emitter.startHeartbeat();
    proc.stdin.end(taskPrompt);

    const closeResult = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      proc.once("error", reject);
      proc.once("close", (code, signal) => {
        if (stdoutBuffer.trim()) {
          const event = parseOpencodeJsonLine(stdoutBuffer);
          if (event) handleEvent(event);
        }
        resolve({ code, signal });
      });
    });

    if (abortHandler) {
      params.signal?.removeEventListener("abort", abortHandler);
      abortHandler = undefined;
    }

    if (params.signal?.aborted) throw new Error("Subagent aborted");
    if (oversizeError) throw new Error(oversizeError);
    if (eventError) throw new Error(eventError);
    if (closeResult.code !== 0) {
      const stderr = stderrBuffer.text().trim();
      throw new Error(
        `opencode exited with code ${closeResult.code}${closeResult.signal ? ` (signal ${closeResult.signal})` : ""}${stderr ? `: ${stderr}` : ""}`,
      );
    }
    if (params.resumeSessionId && sessionId !== params.resumeSessionId) {
      throw new Error(`opencode reported session ${sessionId ?? "(none)"}, not the resumed session ${params.resumeSessionId}`);
    }
    // step_finish closes one model step, not the turn. Intermediate steps end
    // with "tool-calls". The turn is complete only when the last step
    // finished with "stop" and nothing started after it.
    if (finishReason === undefined || inStep) {
      throw new Error("opencode exited without a completed final step");
    }
    if (finishReason !== "stop") {
      throw new Error(`opencode's final step ended with reason "${finishReason}", not "stop"`);
    }
    if (!finalText.trim()) {
      throw new Error("opencode reported completion without a final result");
    }

    params.onUsage(latestUsage);
    const result = finalText.trim();
    const output = assistantOutput([{ text: result }], "final", result);
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
      ...(permissionDenials > 0 ? { permissionDenials } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(progress ? { progress } : {}),
    });
  } catch (error) {
    if (child) abortChildTree(child);
    const message = error instanceof Error ? error.message : String(error);
    const status = params.signal?.aborted ? "aborted" : "error";
    const output = assistantOutput(allText.map((text) => ({ text })), "interrupted");
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
      ...(permissionDenials > 0 ? { permissionDenials } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(progress ? { progress } : {}),
    });
  } finally {
    emitter.stop();
    if (abortHandler) params.signal?.removeEventListener("abort", abortHandler);
  }
}
