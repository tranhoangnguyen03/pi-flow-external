import { StringEnum, type JsonObject } from "@earendil-works/pi-ai";
import { Type, type Static, type TSchema } from "typebox";
import { ExpectedFlowError, FLOW_ERROR_CODES } from "../core/errors.ts";
import { redactSecrets } from "../core/run-record.ts";

/** Inline cap for a canonical value, in UTF-8 bytes of its redacted JSON. */
export const INLINE_RESULT_BYTES = 16 * 1024;

export const strings = <T extends string[]>(...values: T) => StringEnum(values);
export const errorSchema = Type.Object({ code: StringEnum(FLOW_ERROR_CODES), message: Type.String() });
export type PublicError = Static<typeof errorSchema>;

const envelopeFields = (tool: string, action: TSchema) => ({ contractVersion: Type.Literal(1), tool: Type.Literal(tool), action, observedAt: Type.String(), warnings: Type.Array(Type.String()) });

export function successVariant<S extends TSchema>(tool: string, action: TSchema, data: S) {
  return Type.Object({ ...envelopeFields(tool, action), ok: Type.Literal(true), data, error: Type.Optional(Type.Never()) });
}

export function failureVariant<F extends TSchema>(tool: string, action: TSchema, data: F) {
  return Type.Object({ ...envelopeFields(tool, action), ok: Type.Literal(false), data, error: errorSchema });
}

/** The versioned envelope shared by every public tool: `ok` discriminates `data` and `error`. */
export function contractEnvelope<S extends TSchema, F extends TSchema>(tool: string, action: TSchema, success: S, failure: F) {
  return Type.Union([successVariant(tool, action, success), failureVariant(tool, action, failure)]);
}

/** Builds one envelope as plain JSON. `redact` re-redacts the whole envelope (Agent and workflow receipts). */
export function envelope({ tool, action, data, warnings = [], error, redact = false }: {
  tool: string;
  action: string;
  data: unknown;
  warnings?: string[];
  error?: PublicError;
  redact?: boolean;
}): JsonObject {
  const base = { contractVersion: 1, tool, action, observedAt: new Date().toISOString(), data, warnings };
  const value = error ? { ...base, ok: false, error: { code: error.code, message: error.message } } : { ...base, ok: true };
  return JSON.parse(JSON.stringify(redact ? redactSecrets(value) : value)) as JsonObject;
}

/** Redacts memory-sourced text in full, before anything measures or slices it. */
export function redactedText(text: string): string {
  return redactSecrets(text) as string;
}

/**
 * The single canonical-value delivery rule: redact, measure, then inline the
 * whole value or deliver it by reference. A value is never truncated.
 */
export function deliverValue(value: unknown, { finalAvailable, inlineBudget, inspectable }: { finalAvailable: boolean; inlineBudget: number; inspectable: boolean }): {
  output: { delivery: "inline" | "reference" | "none"; value?: unknown };
  redacted: boolean;
} {
  let encoded: string | undefined;
  try { encoded = finalAvailable ? JSON.stringify(value) : undefined; } catch { /* Non-JSON values are never presented as complete. */ }
  const redactedValue = encoded === undefined ? undefined : redactSecrets(JSON.parse(encoded));
  const redactedEncoded = encoded === undefined ? undefined : JSON.stringify(redactedValue);
  const inline = redactedEncoded !== undefined && Buffer.byteLength(redactedEncoded, "utf8") <= inlineBudget;
  return {
    output: { delivery: inline ? "inline" : finalAvailable && inspectable ? "reference" : "none", ...(inline ? { value: redactedValue } : {}) },
    redacted: redactedEncoded !== encoded,
  };
}

export type TextContent = { type: "text"; text: string };

export interface ContractResult<D = unknown> {
  content: TextContent[];
  details: D;
  data: unknown;
  warnings?: string[];
  /** A returned failure keeps the caller's own content, details and data. */
  error?: PublicError;
}

/**
 * Runs one tool body and returns `content`/`details` plus the public
 * `structuredContent`, with `isError === !ok`. A thrown ExpectedFlowError
 * becomes a returned failure with `failureData` and `{error, code}` details
 * (so `D` must accept that shape); anything else is rethrown.
 */
export async function withContract<D>(
  { tool, action, failureData, redact = false }: { tool: string; action: string; failureData: unknown; redact?: boolean },
  body: () => Promise<ContractResult<D>>,
): Promise<{ content: TextContent[]; details: D; structuredContent: JsonObject; isError: boolean }> {
  let settled: ContractResult<D>;
  try {
    settled = await body();
  } catch (error) {
    if (!(error instanceof ExpectedFlowError)) throw error;
    settled = { content: [{ type: "text", text: error.message }], details: { error: error.message, code: error.code } as D, data: failureData, error };
  }
  const structuredContent = envelope({ tool, action, data: settled.data, warnings: settled.warnings, error: settled.error, redact });
  const content = redact ? redactSecrets(settled.content) as TextContent[] : settled.content;
  return { content, details: settled.details, structuredContent, isError: structuredContent.ok !== true };
}
