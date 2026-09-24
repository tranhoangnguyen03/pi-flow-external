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
 * OpenCode 2 permission actions for the tools each restricted tier keeps
 * (verified against @opencode/cli 2.0.16, packages/core/src/tool/plugin/*.ts:
 * write and patch also check `edit`). Everything else, including shell,
 * subagent, web, MCP, the session-management `opencode` tool, and plugin
 * tools, falls under the leading `*` deny. Rules are last-match-wins
 * (packages/core/src/permission.ts `evaluate` uses findLast).
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
 * OPENCODE_CONFIG_CONTENT and selected with `default_agent`. OpenCode 2 loads
 * that source after global, project, and `.opencode/` config
 * (packages/core/src/config.ts), so its `default_agent` wins and its agent
 * rules are appended after every other document's rules
 * (core/src/config/plugin/agent.ts). The agent name is random per run, so a
 * project file cannot pre-seed later-appended rules for it.
 *
 * The env reaches only the private `--standalone` server this process
 * spawns. The shared background service never sees it, which is why every
 * run is standalone.
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
  const permissions = [
    { action: "*", resource: "*", effect: "deny" },
    ...OPENCODE_TIER_ALLOWED[permission].map((action) => ({ action, resource: "*", effect: "allow" })),
  ];
  return {
    ...baseEnv,
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ default_agent: agent, agents: { [agent]: { mode: "primary", permissions } } }),
  };
}

export function buildOpencodeArgs({
  profile,
  permission = "danger",
  resumeSessionId,
}: {
  profile: SubagentProfile;
  permission?: PermissionTier;
  resumeSessionId?: string;
}): string[] {
  const problem = opencodeProfileProblem(profile);
  if (problem) throw new Error(problem);
  // The prompt goes over stdin. OpenCode 2 has no --dir; it takes the project
  // from $PWD, then cwd, so spawn sets both (see opencodeSpawnEnv).
  const args = ["run", "--standalone", "--format", "json"];
  if (resumeSessionId) args.push("--session", resumeSessionId);
  if (profile.model) args.push("--model", profile.thinking ? `${profile.model}#${profile.thinking}` : profile.model);
  args.push(...buildPermissionArgs(permission, "opencode"));
  return args;
}

/**
 * `opencode run --format json` writes one `{type, timestamp, sessionID, ...}`
 * object per line, only for the root session
 * (packages/cli/src/run/noninteractive.ts). Child `subagent` sessions are not
 * streamed.
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

/** OpenCode 2 errors are `{type, message}`. */
export function extractOpencodeError(event: Record<string, unknown>): string | undefined {
  if (event.type !== "error") return undefined;
  const error = asRecord(event.error);
  const message = error?.message;
  const reason = typeof message === "string" && message.trim()
    ? message.trim()
    : typeof error?.type === "string" && error.type
      ? error.type
      : "unknown error";
  return `opencode failed: ${reason}`;
}

/** `subagent` is OpenCode 2's delegation tool. `tool_use` is emitted only once the tool finishes. */
export function opencodeHasNestedAgentActivity(event: Record<string, unknown>): boolean {
  return event.type === "tool_use" && partOf(event)?.tool === "subagent";
}

function isPermissionDenial(part: Record<string, unknown>): boolean {
  const state = asRecord(part.state);
  // Permission.BlockedError (packages/core/src/permission.ts).
  return state?.status === "error" && typeof state.error === "string" && state.error.startsWith("Permission denied");
}

/**
 * Without --auto, a permission ask is rejected and the session interrupted,
 * yet the CLI still exits 0. It prints only this stderr notice
 * (packages/cli/src/run/noninteractive.ts replyPermission).
 */
const AUTO_REJECT_NOTICE = /permission requested: .*; auto-rejecting/;

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
  // them from its own model catalog. Cost is unknown when the final step's
  // step_finish never arrived (see the terminal check below) or once a
  // `subagent` ran, because child sessions are not streamed.
  const latestUsage: SubagentUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, costKnown: false, costEstimated: false };
  let nestedSeen = false;
  let sessionId: string | undefined;
  let sawStep = false;
  let stepText: string[] = [];
  let stepFinish: string | undefined;
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
    if (typeof event.sessionID !== "string") return;
    // A failure before any session exists (e.g. an unknown --session) carries
    // an empty sessionID.
    if (event.type === "error" && (event.sessionID === "" || event.sessionID === (sessionId ?? event.sessionID))) {
      const message = extractOpencodeError(event)!;
      eventError = eventError ? `${eventError}; ${message}` : message;
      emitter.addActivity(message);
      emitter.emitSoon();
      return;
    }
    if (!event.sessionID) return;
    // The first event fixes the root session. Anything else is foreign.
    sessionId ??= event.sessionID;
    if (event.sessionID !== sessionId) return;
    const part = partOf(event);
    if (event.type === "step_start") {
      sawStep = true;
      stepText = [];
      stepFinish = undefined;
    } else if (event.type === "text") {
      // Text reconciled after the stream closes arrives after step_finish; it
      // still belongs to the step that produced it.
      const text = extractOpencodeText(event);
      if (text) {
        stepText.push(text);
        allText.push(text);
      }
    } else if (event.type === "step_finish" && part) {
      stepFinish = typeof part.reason === "string" ? part.reason : "unknown";
      const tokens = asRecord(part.tokens);
      const cache = asRecord(tokens?.cache);
      latestUsage.input += asFiniteNumber(tokens?.input);
      latestUsage.output += asFiniteNumber(tokens?.output) + asFiniteNumber(tokens?.reasoning);
      latestUsage.cacheRead += asFiniteNumber(cache?.read);
      latestUsage.cacheWrite += asFiniteNumber(cache?.write);
      latestUsage.cost += asFiniteNumber(part.cost);
    } else if (event.type === "tool_use" && part) {
      if (part.tool === "subagent") nestedSeen = true;
      if (isPermissionDenial(part)) permissionDenials++;
    }
    latestUsage.costKnown = stepFinish !== undefined && !nestedSeen;
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
      profile: params.profile,
      permission,
      resumeSessionId: params.resumeSessionId,
    });
    // OpenCode 2 resolves the project from $PWD before cwd.
    const env = { ...buildOpencodeEnv(permission, process.env), PWD: params.ctx.cwd };

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
    if (AUTO_REJECT_NOTICE.test(stderrBuffer.text())) {
      throw new Error("opencode auto-rejected a permission request and interrupted the run");
    }
    if (params.resumeSessionId && sessionId !== params.resumeSessionId) {
      throw new Error(`opencode reported session ${sessionId ?? "(none)"}, not the resumed session ${params.resumeSessionId}`);
    }
    // OpenCode 2 exits 0 only after session.wait reports the session idle and
    // the run reconciles its messages. It may drop the final step_finish on
    // that path (noninteractive.ts skips non-execution events once
    // finalizing), so a missing final finish is accepted. A final finish that
    // did arrive must be "stop": "tool-calls" marks an intermediate step, and
    // length/content-filter/error/unknown are not a completed answer.
    if (!sawStep) {
      throw new Error("opencode exited without running a model step");
    }
    if (stepFinish !== undefined && stepFinish !== "stop") {
      throw new Error(`opencode's final step ended with reason "${stepFinish}", not "stop"`);
    }
    const finalText = stepText.join("\n\n");
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
