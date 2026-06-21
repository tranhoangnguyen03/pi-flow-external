import { spawn, type ChildProcess } from "node:child_process";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createProgressEmitter, textResult, type AgentToolResult } from "./progress.ts";
import { createBoundedBuffer, MAX_STDERR_CHARS } from "./stream.ts";
import type { SubagentProfile, SubagentUsage, ThinkingLevel } from "../types.ts";

const AGY_COMMAND = "agy";
const FORCE_KILL_DELAY_MS = 3000;

function emptyUsage(): SubagentUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, costKnown: false };
}

export function buildAgyArgs({
  profile,
  thinkingLevel,
}: {
  profile: SubagentProfile;
  thinkingLevel: ThinkingLevel | undefined;
}): string[] {
  const args = ["--print", "--dangerously-skip-permissions"];
  if (profile.model) {
    args.push("--model", profile.model);
  }
  if (thinkingLevel) {
    // agy does not expose a separate effort flag in 1.0.10; keep the profile
    // field accepted for parity but communicate it via the prompt instead.
  }
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
  appendInstructions?: string;
  outputSchema?: unknown;
}): Promise<AgentToolResult> {
  const subagentType = params.profile.name;
  const promptParts = [params.profile.systemPrompt, params.prompt, params.appendInstructions].filter(Boolean);
  if (params.thinkingLevel) {
    promptParts.push(`Requested reasoning effort: ${params.thinkingLevel}`);
  }
  if (params.outputSchema !== undefined && params.outputSchema !== null) {
    promptParts.push(`Return only JSON matching this schema. No markdown fences or prose.\n${JSON.stringify(params.outputSchema)}`);
  }
  const taskPrompt = promptParts.join("\n\n");
  const usage = emptyUsage();
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
  let stdout = "";
  let child: ChildProcess | undefined;
  let abortHandler: (() => void) | undefined;

  try {
    if (params.signal?.aborted) {
      throw new Error("Subagent aborted before prompt start");
    }
    const proc = spawn(AGY_COMMAND, buildAgyArgs({ profile: params.profile, thinkingLevel: params.thinkingLevel }), {
      cwd: params.ctx.cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    child = proc;
    if (!proc.stdin || !proc.stdout || !proc.stderr) {
      throw new Error("agy stdin/stdout/stderr pipes were not available");
    }
    abortHandler = () => abortChild(proc);
    params.signal?.addEventListener("abort", abortHandler, { once: true });
    if (params.signal?.aborted) {
      abortChild(proc);
      throw new Error("Subagent aborted before prompt start");
    }
    proc.stdout.setEncoding("utf8");
    proc.stderr.setEncoding("utf8");
    proc.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      const firstLine = stdout.split("\n").find((line) => line.trim());
      if (firstLine) {
        emitter.addActivity(firstLine);
        emitter.emitSoon();
      }
    });
    proc.stderr.on("data", (chunk) => stderrBuffer.append(String(chunk)));
    proc.stdin.on("error", () => undefined);

    emitter.emit();
    emitter.startHeartbeat();
    proc.stdin.end(taskPrompt);
    const closeResult = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      proc.once("error", reject);
      proc.once("close", (code, signal) => resolve({ code, signal }));
    });
    if (abortHandler) {
      params.signal?.removeEventListener("abort", abortHandler);
      abortHandler = undefined;
    }
    if (params.signal?.aborted) {
      throw new Error("Subagent aborted");
    }
    if (closeResult.code !== 0) {
      const stderr = stderrBuffer.text().trim();
      throw new Error(`agy exited with code ${closeResult.code}${closeResult.signal ? ` (signal ${closeResult.signal})` : ""}${stderr ? `: ${stderr}` : ""}`);
    }
    const result = stdout.trim() || "(no final text output)";
    params.onUsage(usage);
    if (progress) {
      progress.status = "done";
      progress.result = result;
      progress.usage = usage;
      progress.endedAt = Date.now();
    }
    return textResult(`Subagent "${params.description}" (${subagentType}) completed:\n\n${result}`, {
      description: params.description,
      subagentType,
      backend: params.profile.backend,
      status: "done",
      result,
      usage,
      ...(progress ? { progress } : {}),
    });
  } catch (error) {
    if (child && !hasChildExited(child)) abortChild(child);
    const message = error instanceof Error ? error.message : String(error);
    const status = params.signal?.aborted ? "aborted" : "error";
    params.onUsage(usage);
    if (progress) {
      progress.status = status;
      progress.error = message;
      progress.usage = usage;
      progress.endedAt = Date.now();
    }
    return textResult(`Subagent "${params.description}" (${subagentType}) ${status === "aborted" ? "aborted" : "failed"}: ${message}`, {
      description: params.description,
      subagentType,
      backend: params.profile.backend,
      status,
      error: message,
      usage,
      ...(progress ? { progress } : {}),
    });
  } finally {
    emitter.stop();
    if (abortHandler) params.signal?.removeEventListener("abort", abortHandler);
  }
}
