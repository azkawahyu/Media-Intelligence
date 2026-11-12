import { describe, expect, it } from "vitest";
import {
  TRANSIENT_FAILURE_CODES,
  classifyExtractionFailure,
  isRetryableFailure,
} from "./failure-classification.js";

describe("classifyExtractionFailure", () => {
  // Every code the extraction path can persist today, with its expected class
  // (WORKFLOWS.md §33: transient vs permanent).
  it.each([
    ["FFPROBE_TIMEOUT", "TRANSIENT"],
    ["FILE_NOT_FOUND", "TRANSIENT"],
    ["PERMISSION_DENIED", "TRANSIENT"],
    ["FFPROBE_FAILED", "PERMANENT"],
    ["INVALID_PROBE_OUTPUT", "PERMANENT"],
    ["VALIDATION_FAILED", "PERMANENT"],
    ["INTERRUPTED", "PERMANENT"],
  ] as const)("classifies %s as %s", (code, expected) => {
    expect(classifyExtractionFailure(code)).toBe(expected);
  });

  it("fails closed for unknown, empty, and not-yet-emitted codes", () => {
    for (const code of ["UNSUPPORTED_MEDIA", "UNKNOWN", "PERSISTENCE_FAILED", "", "anything-else"]) {
      expect(classifyExtractionFailure(code)).toBe("PERMANENT");
    }
  });

  it("exposes exactly the transient allowlist", () => {
    expect([...TRANSIENT_FAILURE_CODES].sort()).toEqual([
      "FFPROBE_TIMEOUT",
      "FILE_NOT_FOUND",
      "PERMISSION_DENIED",
    ]);
  });

  it("agrees with isRetryableFailure", () => {
    expect(isRetryableFailure("FFPROBE_TIMEOUT")).toBe(true);
    expect(isRetryableFailure("INVALID_PROBE_OUTPUT")).toBe(false);
    expect(isRetryableFailure("not-a-known-code")).toBe(false);
  });
});
