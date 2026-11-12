import { describe, expect, it } from "vitest";
import {
  classifyAiFailure,
  isRetryableAiFailure,
  TRANSIENT_AI_FAILURE_CODES,
} from "./ai-failure-classification.js";

describe("AI failure classification", () => {
  it.each([...TRANSIENT_AI_FAILURE_CODES])("classifies %s as TRANSIENT", (code) => {
    expect(classifyAiFailure(code)).toBe("TRANSIENT");
    expect(isRetryableAiFailure(code)).toBe(true);
  });

  it.each([
    "AI_PROCESSOR_BAD_REQUEST",
    "AI_PROCESSOR_INVALID_RESPONSE",
    "AI_STAGE_FAILED",
    "AI_FILE_NOT_FOUND",
    "AI_PATH_INVALID",
    "AI_DISABLED",
  ])("classifies %s as PERMANENT", (code) => {
    expect(classifyAiFailure(code)).toBe("PERMANENT");
    expect(isRetryableAiFailure(code)).toBe(false);
  });

  it("fails closed to PERMANENT for an unknown code", () => {
    expect(classifyAiFailure("SOMETHING_NEW")).toBe("PERMANENT");
    expect(isRetryableAiFailure("SOMETHING_NEW")).toBe(false);
  });
});
