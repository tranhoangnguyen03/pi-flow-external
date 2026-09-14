import { Worker } from "node:worker_threads";
import type { SerializedChildRunError, WorkflowLimits } from "./types.ts";

export type WorkerToParentMessage =
  | { type: "heartbeat" }
  | { type: "agent"; id: number; prompt: unknown; options: unknown }
  | { type: "log"; message: unknown }
  | { type: "phase"; title: unknown }
  | { type: "fatal"; error: string }
  | { type: "complete"; result: unknown }
  | { type: "error"; error: string; childError?: SerializedChildRunError };

export type ParentToWorkerMessage =
  | { type: "agentResult"; id: number; ok: true; result: unknown }
  | { type: "agentResult"; id: number; ok: false; error: string; fatal: true }
  | { type: "agentResult"; id: number; ok: false; error: SerializedChildRunError; fatal?: false }
  | { type: "abort"; reason: string };

export function createWorkflowScriptWorker({
  body,
  metaName,
  args,
  cwd,
  limits,
}: {
  body: string;
  metaName: string;
  args: unknown;
  cwd: string;
  limits: WorkflowLimits;
}): Worker {
  return new Worker(WORKFLOW_WORKER_SOURCE, {
    eval: true,
    workerData: {
      body,
      metaName,
      args,
      cwd,
      maxAgentCalls: limits.maxAgentCalls,
      maxLogs: limits.maxLogs,
      maxLogLength: limits.maxLogLength,
      heartbeatIntervalMs: limits.workerHeartbeatIntervalMs,
      syncExecutionTimeoutMs: limits.syncExecutionTimeoutMs,
    },
    resourceLimits: {
      maxOldGenerationSizeMb: limits.workerMaxOldGenerationSizeMb,
      maxYoungGenerationSizeMb: limits.workerMaxYoungGenerationSizeMb,
      stackSizeMb: limits.workerStackSizeMb,
    },
  });
}

const WORKFLOW_WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
const vm = require("node:vm");

class WorkflowFatalError extends Error {}
class ChildRunError extends Error {
  constructor(error) {
    super(error.message);
    this.name = "ChildRunError";
    this.runId = error.runId;
    this.outcome = error.outcome;
    this.outputRef = error.outputRef;
    this.diagnosticsRef = error.diagnosticsRef;
  }
}

let acceptingAgentCalls = true;
let aborted = false;
let fatalErrorMessage = undefined;
let nextAgentId = 0;
let startedAgentCount = 0;
const pendingAgents = new Map();
const agentObservations = [];
const chainObservations = [];

const heartbeat = setInterval(() => {
  post({ type: "heartbeat" });
}, workerData.heartbeatIntervalMs);
heartbeat.unref?.();
post({ type: "heartbeat" });

parentPort.on("message", (message) => {
  if (!message || typeof message !== "object") return;
  if (message.type === "agentResult") {
    const pending = pendingAgents.get(message.id);
    if (!pending) return;
    pendingAgents.delete(message.id);
    if (message.ok) {
      pending.resolve(message.result);
    } else {
      const error = message.fatal ? new WorkflowFatalError(message.error) : new ChildRunError(message.error);
      pending.reject(error);
    }
    return;
  }
  if (message.type === "abort") {
    markFatal(message.reason || "workflow aborted");
  }
});

function post(message) {
  parentPort.postMessage(message);
}

function postError(error) {
  const message = error instanceof Error ? error.message : String(error);
  try {
    post({
      type: "error",
      error: message,
      ...(error instanceof ChildRunError ? { childError: {
        runId: error.runId,
        outcome: error.outcome,
        message: error.message,
        ...(error.outputRef ? { outputRef: error.outputRef } : {}),
        ...(error.diagnosticsRef ? { diagnosticsRef: error.diagnosticsRef } : {}),
      } } : {}),
    });
  } finally {
    clearInterval(heartbeat);
  }
}

function markFatal(message) {
  fatalErrorMessage = fatalErrorMessage || message || "workflow aborted";
  aborted = true;
  acceptingAgentCalls = false;
  for (const pending of pendingAgents.values()) {
    pending.reject(new WorkflowFatalError(fatalErrorMessage));
  }
  pendingAgents.clear();
  post({ type: "fatal", error: fatalErrorMessage });
}

function throwIfFatal() {
  if (aborted || fatalErrorMessage) {
    throw new WorkflowFatalError(fatalErrorMessage || "workflow aborted");
  }
}

function requireString(value, name) {
  if (typeof value !== "string") throw new TypeError(name + " must be a string");
  return value;
}

let retainedLogCount = 0;

function truncateLogLine(text) {
  if (text.length <= workerData.maxLogLength) return text;
  return text.slice(0, Math.max(0, workerData.maxLogLength - 1)) + "…";
}

function log(message) {
  if (retainedLogCount > workerData.maxLogs) return;
  if (retainedLogCount === workerData.maxLogs) {
    retainedLogCount++;
    post({ type: "log", message: "workflow logs truncated after " + workerData.maxLogs + " entries" });
    return;
  }
  retainedLogCount++;
  post({ type: "log", message: truncateLogLine(String(message)) });
}

function phase(title) {
  post({ type: "phase", title: requireString(title, "phase title") });
}

function requestAgent(prompt, options) {
  throwIfFatal();
  if (startedAgentCount >= workerData.maxAgentCalls) {
    markFatal("maximum workflow agent calls exceeded (" + workerData.maxAgentCalls + ")");
    throwIfFatal();
  }
  startedAgentCount++;
  const id = ++nextAgentId;
  return new Promise((resolve, reject) => {
    pendingAgents.set(id, { resolve, reject });
    post({ type: "agent", id, prompt, options });
  });
}

function trackChain(promise) {
  const observation = { handled: false, settled: false, rejected: false, error: undefined, promise };
  chainObservations.push(observation);
  promise.then(
    () => { observation.settled = true; },
    (error) => { observation.settled = true; observation.rejected = true; observation.error = error; },
  ).catch(() => {});
  const transfer = (next) => {
    observation.handled = true;
    return trackChain(next);
  };
  return {
    then: (onFulfilled, onRejected) => transfer(promise.then(onFulfilled, onRejected)),
    catch: (onRejected) => transfer(promise.catch(onRejected)),
    finally: (onFinally) => transfer(promise.finally(onFinally)),
    [Symbol.toStringTag]: "Promise",
  };
}

function agent(prompt, agentOptions = {}) {
  if (!acceptingAgentCalls) {
    throw new Error("agent() cannot be called after the workflow body has returned");
  }
  const observation = { observed: false, settled: false, promise: undefined };
  agentObservations.push(observation);
  const start = () => {
    observation.observed = true;
    if (!acceptingAgentCalls) {
      return Promise.reject(new Error("agent() cannot be called after the workflow body has returned"));
    }
    if (!observation.promise) {
      observation.promise = requestAgent(prompt, agentOptions).finally(() => {
        observation.settled = true;
      });
    }
    return observation.promise;
  };
  return {
    then: (onFulfilled, onRejected) => trackChain(start().then(onFulfilled, onRejected)),
    catch: (onRejected) => trackChain(start().catch(onRejected)),
    finally: (onFinally) => trackChain(start().finally(onFinally)),
    [Symbol.toStringTag]: "Promise",
  };
}

async function parallel(thunks) {
  throwIfFatal();
  if (!Array.isArray(thunks)) {
    throw new TypeError("parallel() expects an array of functions");
  }
  if (thunks.some((thunk) => typeof thunk !== "function")) {
    throw new TypeError("parallel() expects an array of functions, not promises. Wrap each call: () => agent(...)");
  }
  return await Promise.all(thunks.map((thunk) => thunk()));
}

async function pipeline(items, ...stages) {
  throwIfFatal();
  if (!Array.isArray(items)) {
    throw new TypeError("pipeline() expects an array as the first argument");
  }
  if (stages.some((stage) => typeof stage !== "function")) {
    throw new TypeError("pipeline() stages must be functions: pipeline(items, item => ..., result => ...)");
  }
  return await Promise.all(items.map(async (item, index) => {
    let value = item;
    for (const stage of stages) {
      throwIfFatal();
      value = await stage(value, item, index);
      throwIfFatal();
    }
    return value;
  }));
}

const safeMath = Object.freeze(Object.fromEntries(
  Object.getOwnPropertyNames(Math)
    .filter((name) => name !== "random")
    .map((name) => [name, Math[name]])
));

const context = vm.createContext(
  {
    agent,
    parallel,
    pipeline,
    log,
    phase,
    args: workerData.args,
    cwd: workerData.cwd,
    process: Object.freeze({ cwd: () => workerData.cwd }),
    console: {
      log,
      info: log,
      warn: (m) => log("[warn] " + String(m)),
      error: (m) => log("[error] " + String(m)),
    },
    JSON,
    Math: safeMath,
    Date: undefined,
    eval: undefined,
    Function: undefined,
    Reflect: undefined,
    globalThis: undefined,
  },
  { codeGeneration: { strings: false, wasm: false } },
);

function normalizeJsonSerializable(value, name) {
  try {
    const normalized = normalizeJsonValue(value, name, new WeakSet(), false);
    if (normalized === undefined) {
      throw new Error(name + " is undefined; return null when there is intentionally no result");
    }
    return normalized;
  } catch (error) {
    throw new Error(name + " must be JSON-serializable. " + (error instanceof Error ? error.message : String(error)));
  }
}

function normalizeJsonValue(value, path, seen, insideArray) {
  if (value === null) return null;
  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      return Number.isFinite(value) ? value : null;
    case "undefined":
      return insideArray ? null : undefined;
    case "bigint":
    case "function":
    case "symbol":
      throw new Error(path + " contains " + typeof value);
    case "object":
      break;
  }
  if (seen.has(value)) {
    throw new Error(path + " contains a circular reference");
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item, index) => normalizeJsonValue(item, path + "[" + index + "]", seen, true));
    }
    if (!isPlainJsonObject(value)) {
      const proto = Object.getPrototypeOf(value);
      throw new Error(path + " contains non-plain object " + (proto?.constructor?.name || "unknown"));
    }
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      const normalized = normalizeJsonValue(child, path + "." + key, seen, false);
      if (normalized !== undefined) {
        out[key] = normalized;
      }
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

function isPlainJsonObject(value) {
  const proto = Object.getPrototypeOf(value);
  return proto === null || isObjectPrototype(proto);
}

function isObjectPrototype(value) {
  if (value === Object.prototype) return true;
  const parent = Object.getPrototypeOf(value);
  const constructor = value.constructor;
  return parent === null && typeof constructor === "function" && constructor.name === "Object";
}

(async () => {
  try {
    const wrapped = "(async () => {\n" + workerData.body + "\n})()";
    const result = await new vm.Script(wrapped, { filename: (workerData.metaName || "workflow") + ".js" }).runInContext(context, {
      timeout: workerData.syncExecutionTimeoutMs,
    });
    acceptingAgentCalls = false;
    throwIfFatal();
    if (agentObservations.some((observation) => !observation.observed)) {
      throw new Error("every agent() call must be awaited or returned");
    }
    const pending = agentObservations
      .filter((observation) => observation.observed && !observation.settled && observation.promise)
      .map((observation) => observation.promise);
    if (pending.length > 0) {
      await Promise.allSettled(pending);
      throw new Error("every started agent() call must be awaited before the workflow returns");
    }
    await Promise.allSettled(chainObservations.filter((observation) => !observation.handled).map((observation) => observation.promise));
    const unhandled = chainObservations.find((observation) => !observation.handled && observation.rejected);
    if (unhandled) throw unhandled.error;
    throwIfFatal();
    const normalizedResult = normalizeJsonSerializable(result, "workflow result");
    post({ type: "complete", result: normalizedResult });
    clearInterval(heartbeat);
  } catch (error) {
    acceptingAgentCalls = false;
    postError(error);
  }
})();
`;
