export const FLOW_ERROR_CODES = ["configuration_invalid", "harness_unavailable", "selection_invalid", "model_unavailable", "context_invalid", "session_closed", "failed", "cancelled", "timed_out"] as const;
export type FlowErrorCode = (typeof FLOW_ERROR_CODES)[number];

/** Expected caller/configuration failure, distinct from a programming error. */
export class ExpectedFlowError extends Error {
  constructor(readonly code: FlowErrorCode, message: string) {
    super(message);
    this.name = "ExpectedFlowError";
  }
}
