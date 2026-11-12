import { describe, expect, it } from "vitest";
import {
  DEFAULT_SUPPORTED_MEDIA_EXTENSIONS,
  parseConfig,
  parseMetadataMaxRetries,
  parseMetadataRetryBackoffMs,
  parseMetadataWorkerConcurrency,
  parseSupportedMediaExtensions,
} from "./config.js";

const validEnv = {
  DATABASE_URL: "postgresql://tmip:tmip@localhost:5432/tmip",
  MEDIA_ROOT: "/media",
  STORAGE_NAME: "Server B Media",
  PORT: "4001",
};

describe("parseConfig", () => {
  it("parses valid environment variables", () => {
    expect(parseConfig(validEnv)).toEqual({
      databaseUrl: validEnv.DATABASE_URL,
      mediaRoot: validEnv.MEDIA_ROOT,
      storageName: validEnv.STORAGE_NAME,
      port: 4001,
      webOrigin: "http://localhost:3000",
      supportedMediaExtensions: [...DEFAULT_SUPPORTED_MEDIA_EXTENSIONS],
      metadataWorkerConcurrency: 1,
      metadataMaxRetries: 2,
      metadataRetryBackoffMs: 250,
      ai: {
        enabled: false,
        processorUrl: "http://ai-processor:8000",
        modelSize: "medium",
        language: "id",
        concurrency: 1,
        maxRetries: 2,
        retryBackoffMs: 5_000,
        requestTimeoutMs: 30_000,
        pollIntervalMs: 10_000,
        stageTimeoutMs: 900_000,
        jobDeadlineMs: 5_400_000,
      },
    });
  });

  it("uses the default web origin when WEB_ORIGIN is unset", () => {
    expect(parseConfig(validEnv).webOrigin).toBe("http://localhost:3000");
  });

  it("normalizes WEB_ORIGIN to its origin form", () => {
    expect(
      parseConfig({ ...validEnv, WEB_ORIGIN: "http://localhost:3000/" }).webOrigin,
    ).toBe("http://localhost:3000");
  });

  it("accepts a comma-separated WEB_ORIGIN allowlist and normalizes each entry", () => {
    expect(
      parseConfig({
        ...validEnv,
        WEB_ORIGIN: " http://localhost:3000/ , http://172.20.20.231:3000 ",
      }).webOrigin,
    ).toBe("http://localhost:3000,http://172.20.20.231:3000");
  });

  it("rejects a WEB_ORIGIN allowlist containing an invalid entry", () => {
    expect(() =>
      parseConfig({ ...validEnv, WEB_ORIGIN: "http://localhost:3000,not-a-url" }),
    ).toThrow(/WEB_ORIGIN must be a valid http\(s\) origin/);
  });

  it("parses and normalizes configured extensions", () => {
    expect(
      parseConfig({
        ...validEnv,
        SUPPORTED_MEDIA_EXTENSIONS: " .MP4, .mxf, .MP4 ",
      }).supportedMediaExtensions,
    ).toEqual([".mp4", ".mxf"]);
  });

  it.each([
    ["DATABASE_URL", { DATABASE_URL: undefined }],
    ["MEDIA_ROOT", { MEDIA_ROOT: "" }],
    ["STORAGE_NAME", { STORAGE_NAME: "" }],
    ["DATABASE_URL", { DATABASE_URL: "mysql://user:pass@localhost/db" }],
  ])("reports the invalid %s variable clearly", (variable, override) => {
    expect(() => parseConfig({ ...validEnv, ...override })).toThrow(variable);
  });

  it("reports an invalid PORT clearly", () => {
    expect(() => parseConfig({ ...validEnv, PORT: "70000" })).toThrow("PORT");
  });

  it("reports invalid supported extensions clearly", () => {
    expect(() => parseConfig({ ...validEnv, SUPPORTED_MEDIA_EXTENSIONS: "mp4" })).toThrow(
      "SUPPORTED_MEDIA_EXTENSIONS",
    );
  });

  it.each(["0", "1.5", "-1", "not-a-number"]) (
    "rejects invalid metadata worker concurrency %s",
    (value) => {
      expect(() => parseConfig({ ...validEnv, METADATA_WORKER_CONCURRENCY: value })).toThrow(
        "METADATA_WORKER_CONCURRENCY",
      );
    },
  );

  it("parses a positive metadata worker concurrency", () => {
    expect(parseConfig({ ...validEnv, METADATA_WORKER_CONCURRENCY: "3" }).metadataWorkerConcurrency).toBe(3);
  });

  it.each(["1.5", "-1", "not-a-number"])(
    "rejects invalid METADATA_MAX_RETRIES %s",
    (value) => {
      expect(() => parseConfig({ ...validEnv, METADATA_MAX_RETRIES: value })).toThrow(
        "METADATA_MAX_RETRIES",
      );
    },
  );

  it.each(["1.5", "-1", "not-a-number"])(
    "rejects invalid METADATA_RETRY_BACKOFF_MS %s",
    (value) => {
      expect(() =>
        parseConfig({ ...validEnv, METADATA_RETRY_BACKOFF_MS: value }),
      ).toThrow("METADATA_RETRY_BACKOFF_MS");
    },
  );

  it("accepts zero retries to disable automatic retry", () => {
    expect(parseConfig({ ...validEnv, METADATA_MAX_RETRIES: "0" }).metadataMaxRetries).toBe(0);
  });
});

describe("AI configuration", () => {
  it("defaults AI to disabled with the documented processor contract", () => {
    const config = parseConfig(validEnv).ai;
    expect(config).toEqual({
      enabled: false,
      processorUrl: "http://ai-processor:8000",
      modelSize: "medium",
      language: "id",
      concurrency: 1,
      maxRetries: 2,
      retryBackoffMs: 5_000,
      requestTimeoutMs: 30_000,
      pollIntervalMs: 10_000,
      stageTimeoutMs: 900_000,
      jobDeadlineMs: 5_400_000,
    });
  });

  it.each([
    ["true", true],
    ["TRUE", true],
    ["1", true],
    ["false", false],
    ["0", false],
    ["", false],
  ])("parses AI_ENABLED=%s", (raw, expected) => {
    expect(parseConfig({ ...validEnv, AI_ENABLED: raw }).ai.enabled).toBe(expected);
  });

  it("rejects an invalid AI_ENABLED", () => {
    expect(() => parseConfig({ ...validEnv, AI_ENABLED: "yes" })).toThrow("AI_ENABLED");
  });

  it("normalizes a trailing slash off the processor URL", () => {
    expect(
      parseConfig({ ...validEnv, AI_PROCESSOR_URL: "http://ai-processor:8000/" }).ai.processorUrl,
    ).toBe("http://ai-processor:8000");
  });

  it("rejects a non-http processor URL", () => {
    expect(() => parseConfig({ ...validEnv, AI_PROCESSOR_URL: "ftp://x" })).toThrow(
      "AI_PROCESSOR_URL",
    );
  });

  it("rejects an unsupported model size", () => {
    expect(() => parseConfig({ ...validEnv, AI_MODEL_SIZE: "gigantic" })).toThrow("AI_MODEL_SIZE");
  });

  it("accepts a supported model size", () => {
    expect(parseConfig({ ...validEnv, AI_MODEL_SIZE: "small" }).ai.modelSize).toBe("small");
  });

  it("rejects an invalid AI_LANGUAGE", () => {
    expect(() => parseConfig({ ...validEnv, AI_LANGUAGE: "!!" })).toThrow("AI_LANGUAGE");
  });

  it.each([
    ["AI_CONCURRENCY", "0"],
    ["AI_REQUEST_TIMEOUT_MS", "-1"],
    ["AI_POLL_INTERVAL_MS", "1.5"],
    ["AI_STAGE_TIMEOUT_MS", "abc"],
    ["AI_JOB_DEADLINE_MS", "0"],
  ])("rejects invalid positive-integer %s=%s", (name, value) => {
    expect(() => parseConfig({ ...validEnv, [name]: value })).toThrow(name);
  });

  it("accepts zero AI_MAX_RETRIES (no automatic retry)", () => {
    expect(parseConfig({ ...validEnv, AI_MAX_RETRIES: "0" }).ai.maxRetries).toBe(0);
  });

  it("rejects a negative AI_MAX_RETRIES", () => {
    expect(() => parseConfig({ ...validEnv, AI_MAX_RETRIES: "-1" })).toThrow("AI_MAX_RETRIES");
  });
});

describe("parseMetadataWorkerConcurrency", () => {
  it("defaults to one worker", () => {
    expect(parseMetadataWorkerConcurrency(undefined)).toBe(1);
  });
});

describe("parseMetadataMaxRetries", () => {
  it("defaults to two retries", () => {
    expect(parseMetadataMaxRetries(undefined)).toBe(2);
    expect(parseMetadataMaxRetries("  ")).toBe(2);
  });

  it("accepts a finite non-negative integer", () => {
    expect(parseMetadataMaxRetries("0")).toBe(0);
    expect(parseMetadataMaxRetries("5")).toBe(5);
  });
});

describe("parseMetadataRetryBackoffMs", () => {
  it("defaults to 250 ms", () => {
    expect(parseMetadataRetryBackoffMs(undefined)).toBe(250);
    expect(parseMetadataRetryBackoffMs("  ")).toBe(250);
  });

  it("accepts a finite non-negative integer", () => {
    expect(parseMetadataRetryBackoffMs("0")).toBe(0);
    expect(parseMetadataRetryBackoffMs("1000")).toBe(1000);
  });
});

describe("parseSupportedMediaExtensions", () => {
  it("uses the documented default list when unset", () => {
    expect(parseSupportedMediaExtensions(undefined)).toEqual([
      ...DEFAULT_SUPPORTED_MEDIA_EXTENSIONS,
    ]);
  });

  it("rejects an empty list", () => {
    expect(() => parseSupportedMediaExtensions("  ")).toThrow(
      "SUPPORTED_MEDIA_EXTENSIONS",
    );
  });
});
