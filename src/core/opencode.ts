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

/** Name shape of the per-run agents this adapter injects. */
const RESTRICTED_AGENT_NAME = /^pi-flow-(readonly|edit)-[0-9a-f]+$/;

/** A fresh random agent name for a restricted tier; danger uses the session's own agent. */
export function opencodeRestrictedAgent(permission: PermissionTier): string | undefined {
  return permission === "danger" ? undefined : `pi-flow-${permission}-${randomBytes(6).toString("hex")}`;
}

/**
 * readonly/edit define a primary agent through OPENCODE_CONFIG_CONTENT, and
 * every restricted run selects it with `--agent`, including resumes. A
 * resumed session otherwise keeps the agent it was saved with
 * (packages/cli/src/session-target.ts), and `default_agent` only applies to
 * new sessions. OpenCode 2 loads that source after global, project, and
 * `.opencode/` config (packages/core/src/config.ts), so the agent's rules are
 * appended after every other document's rules
 * (core/src/config/plugin/agent.ts). The name is random per run, so a project
 * file cannot pre-seed later-appended rules for it. An agent that fails to
 * load resolves to deny-all (core/src/permission.ts missingAgentPermissions).
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
  agent: string | undefined,
): NodeJS.ProcessEnv {
  if (permission === "danger") return baseEnv;
  if (!agent) throw new Error(`OpenCode ${permission} needs an injected agent name`);
  if (baseEnv.OPENCODE_CONFIG_CONTENT !== undefined) {
    throw new Error(
      `OpenCode ${permission} needs OPENCODE_CONFIG_CONTENT to install its restricted agent, but that variable is already set in this environment. Unset it, or pass permission "danger".`,
    );
  }
  const permissions = [
    { action: "*", resource: "*", effect: "deny" },
    ...OPENCODE_TIER_ALLOWED[permission].map((action) => ({ action, resource: "*", effect: "allow" })),
  ];
  return {
    ...baseEnv,
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ agents: { [agent]: { mode: "primary", permissions } } }),
  };
}

export function buildOpencodeArgs({
  profile,
  permission = "danger",
  resumeSessionId,
  agent,
}: {
  profile: SubagentProfile;
  permission?: PermissionTier;
  resumeSessionId?: string;
  agent?: string;
}): string[] {
  const problem = opencodeProfileProblem(profile);
  if (problem) throw new Error(problem);
  // The prompt goes over stdin. OpenCode 2 has no --dir; it takes the project
  // from $PWD, then cwd, so spawn sets both.
  const args = ["run", "--standalone", "--format", "json"];
  if (resumeSessionId) args.push("--session", resumeSessionId);
  if (agent) args.push("--agent", agent);
  if (profile.model) args.push("--model", profile.thinking ? `${profile.model}#${profile.thinking}` : profile.model);
  args.push(...buildPermissionArgs(permission, "opencode"));
  return args;
}

const MAX_EXPORT_CHARS = 16 * 1024 * 1024;

function records(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error("opencode session export has no messages list");
  return value.map((item) => {
    const record = asRecord(item);
    if (!record) throw new Error("opencode session export has a malformed message");
    return record;
  });
}

/**
 * Checks a session before resuming it. Returns the IDs already present, so
 * the run's own new user turn can be told apart from earlier ones. Refuses a
 * restricted resume of a session with its own permission rules, which
 * OpenCode evaluates after the agent's (core/src/permission.ts `configured`).
 * Refuses a danger resume of a session last run by an injected restricted
 * agent: that agent no longer exists, so the session would run deny-all.
 */
export function checkOpencodeResumable(exported: Record<string, unknown>, sessionId: string, permission: PermissionTier): Set<string> {
  const info = asRecord(exported.info);
  if (info?.id !== sessionId) throw new Error(`opencode session export does not describe session ${sessionId}`);
  if (permission !== "danger" && Array.isArray(info.permissions) && info.permissions.length > 0) {
    throw new Error(`OpenCode session ${sessionId} carries its own permission rules, which OpenCode applies after the agent's; a ${permission} resume cannot guarantee its restriction. Start a new run instead.`);
  }
  if (permission === "danger" && typeof info.agent === "string" && RESTRICTED_AGENT_NAME.test(info.agent)) {
    throw new Error(`OpenCode session ${sessionId} was last run at a restricted tier by agent ${info.agent}, which no longer exists, so a danger resume would have no tools. Resume it at readonly or edit, or start a new run.`);
  }
  return new Set(records(exported.messages).map((message) => String(message.id)));
}

/**
 * The persisted session is the terminal authority. The streamed JSON is not:
 * OpenCode 2 stops forwarding events once the session is idle, ignores
 * execution.succeeded, and exits 0 after an interruption or a cancelled MCP
 * form (packages/cli/src/run/noninteractive.ts). The run's own user turn is
 * the last one. It must be new (not one of `priorIds`, or the only user turn
 * of a new session) and carry exactly this prompt. After it, the session must
 * end in an idle `succeeded` outcome, and the last assistant message must
 * have completed with `stop`, no error, and nonempty text. Usage covers only
 * this turn's assistant messages. Cost is unknown if any lacks usage or ran a
 * `subagent`, whose child session is not included.
 */
export function verifyOpencodeTurn(
  exported: Record<string, unknown>,
  expected: { sessionId: string; prompt: string; priorIds?: Set<string>; agent?: string },
): { text: string; usage: SubagentUsage } {
  const info = asRecord(exported.info);
  if (info?.id !== expected.sessionId) throw new Error(`opencode session export does not describe session ${expected.sessionId}`);
  if (info.outcome !== "succeeded") throw new Error(`opencode session outcome is ${JSON.stringify(info.outcome ?? null)}, not "succeeded"`);
  const messages = records(exported.messages);
  let userIndex = messages.length - 1;
  while (userIndex >= 0 && messages[userIndex]!.type !== "user") userIndex--;
  const user = messages[userIndex];
  const owned = user !== undefined && typeof user.id === "string" && (expected.priorIds
    ? !expected.priorIds.has(user.id)
    : messages.filter((message) => message.type === "user").length === 1);
  if (!owned || user.text !== expected.prompt) {
    throw new Error("opencode session export has no user turn from this invocation");
  }
  const turn = messages.slice(userIndex + 1);
  const terminal = turn.at(-1);
  if (terminal?.type !== "idle" || terminal.outcome !== "succeeded") {
    throw new Error(`opencode turn did not end in a succeeded idle outcome (${JSON.stringify(terminal?.outcome ?? terminal?.type ?? null)})`);
  }
  const assistants = turn.filter((message) => message.type === "assistant");
  const final = assistants.at(-1);
  if (!final) throw new Error("opencode turn has no assistant message");
  if (final.finish !== "stop" || typeof asRecord(final.time)?.completed !== "number" || final.error !== undefined) {
    throw new Error(`opencode final assistant message did not complete cleanly (finish ${JSON.stringify(final.finish ?? null)})`);
  }
  if (expected.agent) {
    const wrong = assistants.find((message) => message.agent !== expected.agent);
    if (wrong) throw new Error(`opencode ran this turn as agent ${JSON.stringify(wrong.agent ?? null)}, not the injected ${expected.agent}`);
  }
  const content = Array.isArray(final.content) ? final.content.map(asRecord) : [];
  const text = content.flatMap((item) => (item?.type === "text" && typeof item.text === "string" ? [item.text] : [])).join("").trim();
  if (!text) throw new Error("opencode reported completion without a final result");

  const usage: SubagentUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, costKnown: true, costEstimated: false };
  for (const message of assistants) {
    const tokens = asRecord(message.tokens);
    const cache = asRecord(tokens?.cache);
    if (!tokens || typeof message.cost !== "number") usage.costKnown = false;
    usage.input += asFiniteNumber(tokens?.input);
    usage.output += asFiniteNumber(tokens?.output) + asFiniteNumber(tokens?.reasoning);
    usage.cacheRead += asFiniteNumber(cache?.read);
    usage.cacheWrite += asFiniteNumber(cache?.write);
    usage.cost += asFiniteNumber(message.cost);
    const items = Array.isArray(message.content) ? message.content.map(asRecord) : [];
    if (items.some((item) => item?.type === "tool" && item.name === "subagent")) usage.costKnown = false;
  }
  return { text, usage };
}

/**
 * `opencode session export --standalone <id>` in its own process group with
 * bounded output. It honors the run's abort signal, which also carries the
 * run timeout.
 */
async function exportOpencodeSession(sessionId: string, cwd: string, signal: AbortSignal | undefined): Promise<Record<string, unknown>> {
  if (signal?.aborted) throw new Error("Subagent aborted");
  const proc = spawn(OPENCODE_COMMAND, ["session", "export", "--standalone", sessionId], {
    cwd,
    env: { ...process.env, PWD: cwd },
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  const stderr = createBoundedBuffer(MAX_STDERR_CHARS);
  let stdout = "";
  let oversize = false;
  const abort = () => abortChildTree(proc);
  signal?.addEventListener("abort", abort, { once: true });
  try {
    proc.stdout!.setEncoding("utf8");
    proc.stderr!.setEncoding("utf8");
    proc.stdout!.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > MAX_EXPORT_CHARS && !oversize) {
        oversize = true;
        stdout = "";
        abortChildTree(proc);
      }
    });
    proc.stderr!.on("data", (chunk: string) => stderr.append(chunk));
    const code = await new Promise<number | null>((resolve, reject) => {
      proc.once("error", reject);
      proc.once("close", resolve);
    });
    if (signal?.aborted) throw new Error("Subagent aborted");
    if (oversize) throw new Error(`opencode session export exceeded ${MAX_EXPORT_CHARS} chars`);
    if (code !== 0) {
      const detail = stderr.text().trim();
      throw new Error(`opencode session export exited with code ${code}${detail ? `: ${detail}` : ""}`);
    }
    let parsed: Record<string, unknown> | undefined;
    try {
      parsed = asRecord(JSON.parse(stdout));
    } catch {
      parsed = undefined;
    }
    if (!parsed) throw new Error("opencode session export was not a JSON object");
    return parsed;
  } finally {
    signal?.removeEventListener("abort", abort);
    if (proc.exitCode === null && proc.signalCode === null) abortChildTree(proc);
  }
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

  // The stream drives progress and interrupted-output previews only. Result,
  // usage, and success come from the verified session export.
  let latestUsage: SubagentUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, costKnown: false, costEstimated: false };
  let sessionId: string | undefined;
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
    const text = extractOpencodeText(event);
    if (text) allText.push(text);
    if (event.type === "tool_use" && part && isPermissionDenial(part)) permissionDenials++;
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
    const agent = opencodeRestrictedAgent(permission);
    const args = buildOpencodeArgs({
      profile: params.profile,
      permission,
      resumeSessionId: params.resumeSessionId,
      agent,
    });
    // OpenCode 2 resolves the project from $PWD before cwd.
    const env = { ...buildOpencodeEnv(permission, process.env, agent), PWD: params.ctx.cwd };
    const priorIds = params.resumeSessionId
      ? checkOpencodeResumable(await exportOpencodeSession(params.resumeSessionId, params.ctx.cwd, params.signal), params.resumeSessionId, permission)
      : undefined;

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
    if (!sessionId) throw new Error("opencode exited without reporting a session");
    if (params.resumeSessionId && sessionId !== params.resumeSessionId) {
      throw new Error(`opencode reported session ${sessionId}, not the resumed session ${params.resumeSessionId}`);
    }
    const verified = verifyOpencodeTurn(await exportOpencodeSession(sessionId, params.ctx.cwd, params.signal), {
      sessionId,
      prompt: taskPrompt,
      priorIds,
      agent,
    });
    latestUsage = verified.usage;

    params.onUsage(latestUsage);
    const result = verified.text;
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
