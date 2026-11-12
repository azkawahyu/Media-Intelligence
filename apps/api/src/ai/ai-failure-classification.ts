/**
 * AI failure classification (ADR-006 §12, WORKFLOWS.md §33, AGENTS.md §19).
 *
 * Mirrors `metadata/failure-classification.ts`: a failure is retryable only when
 * it is plausibly transient. Anything not explicitly recognized is PERMANENT
 * (fail-closed), so an unknown error can never produce an unbounded retry loop.
 *
 * Codes emitted on the AI path:
 *   ai/adapter.ts   AI_PROCESSOR_TIMEOUT, AI_PROCESSOR_UNAVAILABLE,
 *                   AI_PROCESSOR_BAD_REQUEST, AI_PROCESSOR_INVALID_RESPONSE
 *   ai/runner.ts    AI_STAGE_FAILED (the processor reported the stage itself
 *                   failed OR an unknown error was surfaced), AI_DEADLINE_EXCEEDED,
 *                   AI_FILE_NOT_FOUND, AI_PATH_INVALID, AI_INTERRUPTED
 *
 * TRANSIENT: transport-level unavailability/timeout and a per-attempt deadline
 * breach (ADR-006 §13 classifies a deadline breach as retryable; `aiAttempt`
 * bounds repeated breaches). PERMANENT: the processor rejected the request, the
 * media is gone/uncontained, the response was malformed, or a stage reported a
 * deterministic failure. A deterministically failing stage must not burn the
 * retry budget.
 */
export const TRANSIENT_AI_FAILURE_CODES = [
  "AI_PROCESSOR_TIMEOUT",
  "AI_PROCESSOR_UNAVAILABLE",
  "AI_DEADLINE_EXCEEDED",
] as const;

export type AiFailureClass = "TRANSIENT" | "PERMANENT";

const transientCodes: ReadonlySet<string> = new Set(TRANSIENT_AI_FAILURE_CODES);

export function classifyAiFailure(code: string): AiFailureClass {
  return transientCodes.has(code) ? "TRANSIENT" : "PERMANENT";
}

export function isRetryableAiFailure(code: string): boolean {
  return classifyAiFailure(code) === "TRANSIENT";
}
