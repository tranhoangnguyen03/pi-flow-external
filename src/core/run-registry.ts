export type RegisteredRunKind = "agent" | "workflow";
export type RegisteredRunState = "running" | "terminal";
export type RegisteredRunStatus = "done" | "error" | "aborted";
export type RegisteredRunOutcomeName = "succeeded" | "failed" | "cancelled" | "timed_out";

export interface RegisteredRunOutcome {
  runId: string;
  kind: RegisteredRunKind;
  status: RegisteredRunStatus;
  outcome: RegisteredRunOutcomeName;
  settledAt?: number;
  result?: unknown;
  error?: string;
}

export interface RegisteredRunEntry {
  runId: string;
  kind: RegisteredRunKind;
  sessionId: string;
  project: string;
  workflowRunId?: string;
  state: RegisteredRunState;
  observation?: unknown;
  outcome?: RegisteredRunOutcome;
}

export interface RegisteredRunHandle<T> {
  result: Promise<T>;
  terminal: Promise<RegisteredRunOutcome>;
}

interface InternalEntry extends RegisteredRunEntry {
  controller: AbortController;
  terminal: Promise<RegisteredRunOutcome>;
  resolveTerminal: (outcome: RegisteredRunOutcome) => void;
  result: Promise<unknown>;
  listeners: Set<(outcome: RegisteredRunOutcome) => void>;
}

export interface StartRegisteredRun<T> {
  runId: string;
  kind: RegisteredRunKind;
  sessionId: string;
  sessionVersion?: number;
  project: string;
  workflowRunId?: string;
  signal?: AbortSignal;
  run: (signal: AbortSignal) => Promise<T> | T;
  outcome?: (result: T, signal: AbortSignal) => Omit<RegisteredRunOutcome, "runId" | "kind" | "settledAt">;
  failure?: (error: unknown, signal: AbortSignal) => Omit<RegisteredRunOutcome, "runId" | "kind" | "settledAt">;
}

export interface RegisteredRunWaitResult {
  terminal: RegisteredRunOutcome[];
  pending: string[];
}

const DEFAULT_COMPLETED_LIMIT = 100;

/** Session-owned live execution state. Durable history stays in run records/journals. */
export class RunRegistry {
  private readonly entries = new Map<string, InternalEntry>();
  private readonly completed: string[] = [];
  private readonly sessionVersions = new Map<string, number>();
  private readonly closedSessions = new Set<string>();

  constructor(private readonly completedLimit = DEFAULT_COMPLETED_LIMIT, private readonly shutdownGraceMs = 4_000) {
    if (!Number.isInteger(completedLimit) || completedLimit < 0) {
      throw new Error("completed run limit must be a non-negative integer");
    }
    if (!Number.isInteger(shutdownGraceMs) || shutdownGraceMs < 0) throw new Error("shutdown grace must be a non-negative integer");
  }

  sessionVersion(sessionId: string): number {
    return this.sessionVersions.get(sessionId) ?? 0;
  }

  openSession(sessionId: string): void {
    this.sessionVersions.set(sessionId, this.sessionVersion(sessionId) + 1);
    this.closedSessions.delete(sessionId);
  }

  start<T>(params: StartRegisteredRun<T>): RegisteredRunHandle<T> {
    if (this.closedSessions.has(params.sessionId) || (params.sessionVersion !== undefined && params.sessionVersion !== this.sessionVersion(params.sessionId))) {
      throw new Error(`Session ${params.sessionId} is closed; run was not started`);
    }
    if (this.entries.has(params.runId)) {
      throw new Error(`Run is already registered: ${params.runId}`);
    }
    const controller = new AbortController();
    let resolveTerminal!: (outcome: RegisteredRunOutcome) => void;
    const terminal = new Promise<RegisteredRunOutcome>((resolve) => {
      resolveTerminal = resolve;
    });
    const entry: InternalEntry = {
      runId: params.runId,
      kind: params.kind,
      sessionId: params.sessionId,
      project: params.project,
      ...(params.workflowRunId ? { workflowRunId: params.workflowRunId } : {}),
      state: "running",
      controller,
      terminal,
      resolveTerminal,
      result: Promise.resolve(),
      listeners: new Set(),
    };
    this.entries.set(entry.runId, entry);

    const abortFromCaller = () => controller.abort(params.signal?.reason);
    if (params.signal?.aborted) abortFromCaller();
    else params.signal?.addEventListener("abort", abortFromCaller, { once: true });

    let execution: Promise<T>;
    try {
      execution = Promise.resolve(params.run(controller.signal));
    } catch (error) {
      execution = Promise.reject(error);
    }
    const result = execution.then(
      (value) => {
        const described = params.outcome?.(value, controller.signal);
        const status = described?.status ?? "done";
        this.settle(entry, {
          runId: entry.runId,
          kind: entry.kind,
          status,
          outcome: described?.outcome ?? (status === "done" ? "succeeded" : status === "aborted" ? "cancelled" : "failed"),
          settledAt: Date.now(),
          ...(described ? described.result !== undefined ? { result: described.result } : {} : { result: value }),
          ...(described?.error ? { error: described.error } : {}),
        });
        return value;
      },
      (error) => {
        const described = params.failure?.(error, controller.signal);
        const status = described?.status ?? (controller.signal.aborted ? "aborted" : "error");
        this.settle(entry, {
          runId: entry.runId,
          kind: entry.kind,
          status,
          outcome: described?.outcome ?? (status === "aborted" ? "cancelled" : "failed"),
          settledAt: Date.now(),
          ...(described?.result !== undefined ? { result: described.result } : {}),
          error: described?.error ?? (controller.signal.aborted && controller.signal.reason !== undefined
            ? controller.signal.reason instanceof Error ? controller.signal.reason.message : String(controller.signal.reason)
            : error instanceof Error ? error.message : String(error)),
        });
        throw error;
      },
    ).finally(() => {
      params.signal?.removeEventListener("abort", abortFromCaller);
    });
    entry.result = result;
    void result.catch(() => undefined);
    return { result, terminal };
  }

  get(runId: string): RegisteredRunEntry | undefined {
    const entry = this.entries.get(runId);
    return entry ? this.publicEntry(entry) : undefined;
  }

  list(sessionId: string, project?: string): RegisteredRunEntry[] {
    return [...this.entries.values()]
      .filter((entry) => entry.sessionId === sessionId && (project === undefined || entry.project === project))
      .map((entry) => this.publicEntry(entry));
  }

  update(runId: string, observation: unknown): void {
    const entry = this.entries.get(runId);
    if (entry && entry.state === "running") entry.observation = observation;
  }

  cancel(runId: string, reason = "run cancelled"): "requested" | "terminal" | "unknown" {
    const entry = this.entries.get(runId);
    if (!entry) return "unknown";
    if (entry.state === "terminal") return "terminal";
    entry.controller.abort(new Error(reason));
    return "requested";
  }

  async shutdownSession(sessionId: string, reason = "session shutdown"): Promise<{ settled: string[]; pending: string[] }> {
    this.closedSessions.add(sessionId);
    this.sessionVersions.set(sessionId, this.sessionVersion(sessionId) + 1);
    const owned = [...this.entries.values()].filter((entry) => entry.sessionId === sessionId && entry.state === "running");
    for (const entry of owned) entry.controller.abort(new Error(reason));
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.allSettled(owned.map((entry) => entry.result)),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, this.shutdownGraceMs); }),
    ]);
    if (timer) clearTimeout(timer);
    const settled = owned.filter((entry) => entry.state === "terminal").map((entry) => entry.runId);
    const pending = owned.filter((entry) => entry.state !== "terminal");
    for (const entry of pending) if (this.entries.get(entry.runId) === entry) this.entries.delete(entry.runId);
    return { settled, pending: pending.map((entry) => entry.runId) };
  }

  wait(runIds: string[], mode: "any" | "all", signal?: AbortSignal): Promise<RegisteredRunWaitResult> {
    const ids = [...new Set(runIds)];
    if (ids.length === 0) return Promise.reject(new Error("At least one run ID is required"));
    const entries = ids.map((id) => {
      const entry = this.entries.get(id);
      if (!entry) throw new Error(`Unknown live run: ${id}`);
      return entry;
    });

    return new Promise<RegisteredRunWaitResult>((resolve, reject) => {
      const unsubscribers: Array<() => void> = [];
      const cleanup = () => {
        for (const unsubscribe of unsubscribers) unsubscribe();
        signal?.removeEventListener("abort", onAbort);
      };
      const check = () => {
        const terminal = entries.flatMap((entry) => entry.outcome ? [entry.outcome] : []);
        if ((mode === "any" && terminal.length > 0) || (mode === "all" && terminal.length === entries.length)) {
          cleanup();
          resolve({ terminal, pending: entries.filter((entry) => !entry.outcome).map((entry) => entry.runId) });
        }
      };
      const onAbort = () => {
        cleanup();
        reject(new Error("Run wait aborted"));
      };
      if (signal?.aborted) return onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
      for (const entry of entries) {
        const listener = () => check();
        entry.listeners.add(listener);
        unsubscribers.push(() => entry.listeners.delete(listener));
      }
      check();
    });
  }

  private settle(entry: InternalEntry, outcome: RegisteredRunOutcome): void {
    if (entry.state === "terminal") return;
    entry.state = "terminal";
    entry.outcome = outcome;
    entry.resolveTerminal(outcome);
    for (const listener of [...entry.listeners]) listener(outcome);
    entry.listeners.clear();
    if (this.entries.get(entry.runId) !== entry) return;
    this.completed.push(entry.runId);
    while (this.completed.length > this.completedLimit) {
      const evicted = this.completed.shift();
      if (evicted) this.entries.delete(evicted);
    }
  }

  private publicEntry(entry: InternalEntry): RegisteredRunEntry {
    return {
      runId: entry.runId,
      kind: entry.kind,
      sessionId: entry.sessionId,
      project: entry.project,
      ...(entry.workflowRunId ? { workflowRunId: entry.workflowRunId } : {}),
      state: entry.state,
      ...(entry.observation !== undefined ? { observation: entry.observation } : {}),
      ...(entry.outcome ? { outcome: entry.outcome } : {}),
    };
  }
}
