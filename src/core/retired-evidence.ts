// Read-only decoders for historical Grok and OpenCode run evidence. They never launch a CLI.
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function extractGrokAssistantText(event: Record<string, unknown>): string | undefined {
  const content = asRecord(event.message)?.content;
  if (!Array.isArray(content)) return undefined;
  return content.map((item) => {
    const part = asRecord(item);
    return part?.type === "text" && typeof part.text === "string" ? part.text : "";
  }).join("") || undefined;
}

function grokToolPreview(record: Record<string, unknown>): string {
  for (const key of ["command", "cmd", "file_path", "path", "pattern", "query", "prompt", "description"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.replace(/\s+/g, " ").trim();
  }
  const input = asRecord(record.input) ?? asRecord(record.arguments) ?? asRecord(record.args);
  return input ? grokToolPreview(input) : "";
}

export function grokActivityFromEvent(event: Record<string, unknown>): string | undefined {
  if (event.type === "assistant") {
    const content = asRecord(event.message)?.content;
    if (Array.isArray(content)) for (const item of content) {
      const part = asRecord(item);
      if (part?.type !== "tool_use") continue;
      const tool = typeof part.name === "string" && part.name ? part.name : "tool_use";
      const preview = grokToolPreview(part);
      return `${tool}${preview ? ` ${preview}` : ""}`;
    }
  }
  if (event.type === "result" && (event.is_error === true || event.subtype !== "success")) {
    const first = Array.isArray(event.errors) ? event.errors.find((item) => typeof item === "string") : undefined;
    const result = typeof event.result === "string" && event.result.trim() ? event.result : undefined;
    return `Grok failed: ${first ?? result ?? (typeof event.subtype === "string" ? event.subtype : "turn failed")}`;
  }
  if (event.type === "error") return `Grok error: ${typeof event.message === "string" ? event.message : "unknown error"}`;
  return undefined;
}

function opencodePart(event: Record<string, unknown>): Record<string, unknown> | undefined {
  const part = asRecord(event.part);
  return part && part.sessionID === event.sessionID ? part : undefined;
}

export function extractOpencodeText(event: Record<string, unknown>): string | undefined {
  if (event.type !== "text") return undefined;
  const text = opencodePart(event)?.text;
  return typeof text === "string" && text ? text : undefined;
}

export function opencodeActivityFromEvent(event: Record<string, unknown>): string | undefined {
  if (event.type === "tool_use") {
    const part = opencodePart(event);
    if (!part) return undefined;
    const tool = typeof part.tool === "string" && part.tool ? part.tool : "tool";
    const state = asRecord(part.state);
    const title = typeof state?.title === "string" ? state.title.replace(/\s+/g, " ").trim() : "";
    return `${tool}${state?.status === "error" ? " failed" : ""}${title ? ` ${title}` : ""}`;
  }
  if (event.type === "error") {
    const error = asRecord(event.error);
    const message = typeof error?.message === "string" ? error.message.trim() : "";
    return `opencode failed: ${message || (typeof error?.type === "string" && error.type ? error.type : "unknown error")}`;
  }
  return extractOpencodeText(event);
}
