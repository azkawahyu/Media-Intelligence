/**
 * Extraction failure classification (WORKFLOWS.md §33, AGENTS.md §19).
 *
 * A failure is retryable only when it is plausibly transient. Anything not
 * explicitly recognized is PERMANENT (fail-closed) so an unknown error can
 * never produce an unbounded retry loop.
 *
 * The keys are the exact error codes the extraction path emits today:
 *   extractor.ts            VALIDATION_FAILED, FILE_NOT_FOUND, PERMISSION_DENIED
 *   metadata/ffprobe-adapter.ts  FFPROBE_TIMEOUT, FFPROBE_FAILED, INVALID_PROBE_OUTPUT
 *   scan/startup.ts         INTERRUPTED
 */
export const TRANSIENT_FAILURE_CODES = [
  "FFPROBE_TIMEOUT",
  "FILE_NOT_FOUND",
  "PERMISSION_DENIED",
] as const;

export type FailureClass = "TRANSIENT" | "PERMANENT";

const transientCodes: ReadonlySet<string> = new Set(TRANSIENT_FAILURE_CODES);

/**
 * Classify an extraction failure by its error code. `errorCode` is the only
 * input: the code already encodes the cause, and stage is not a reliable
 * signal (the same code maps to one stage).
 */
export function classifyExtractionFailure(code: string): FailureClass {
  return transientCodes.has(code) ? "TRANSIENT" : "PERMANENT";
}

export function isRetryableFailure(code: string): boolean {
  return classifyExtractionFailure(code) === "TRANSIENT";
}
