export interface UsageLimit {
  source: "claude.rate_limit_event" | "agy.result.error";
  observedAt: string;
  resetsAt?: string;
}

export function usageLimitFromEvent(backend: string, value: unknown, now = Date.now()): UsageLimit | undefined {
  if (!value || typeof value !== "object") return;
  const event = value as Record<string, unknown>;
  let source: UsageLimit["source"];
  let reset: number | undefined;
  if (backend === "claude" && event.type === "rate_limit_event") {
    const info = event.rate_limit_info as Record<string, unknown> | undefined;
    if (!info || info.status !== "rejected") return;
    source = "claude.rate_limit_event";
    if (typeof info.resetsAt === "number") reset = info.resetsAt * 1000;
  } else if (backend === "agy" && event.type === "result" && event.status === "ERROR" && typeof event.error === "string" && /\bIndividual quota reached\b/i.test(event.error)) {
    source = "agy.result.error";
    const duration = /Resets in (?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?\./i.exec(event.error);
    if (duration && duration.slice(1).some(Boolean)) reset = now + ((Number(duration[1] ?? 0) * 3600) + (Number(duration[2] ?? 0) * 60) + Number(duration[3] ?? 0)) * 1000;
  } else return;
  return { source, observedAt: new Date(now).toISOString(), ...(reset !== undefined && Number.isFinite(reset) && Math.abs(reset) <= 8.64e15 ? { resetsAt: new Date(reset).toISOString() } : {}) };
}
