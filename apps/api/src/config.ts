import { z } from "zod";

const DEFAULT_PORT = 4000;
const DEFAULT_WEB_ORIGIN = "http://localhost:3000";
const DEFAULT_METADATA_WORKER_CONCURRENCY = 1;
const DEFAULT_METADATA_MAX_RETRIES = 2;
const DEFAULT_METADATA_RETRY_BACKOFF_MS = 250;

// AI enrichment defaults (ADR-006 §13, Plan 006 §4). Chosen from the audited
// CPU-only Whisper profile. AI_ENABLED defaults to false: the subsystem is
// additive v2 and stays inert until an operator enables it.
const DEFAULT_AI_PROCESSOR_URL = "http://ai-processor:8000";
const DEFAULT_AI_MODEL_SIZE = "medium";
const DEFAULT_AI_LANGUAGE = "id";
const DEFAULT_AI_CONCURRENCY = 1;
const DEFAULT_AI_MAX_RETRIES = 2;
const DEFAULT_AI_RETRY_BACKOFF_MS = 5_000;
const DEFAULT_AI_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_AI_POLL_INTERVAL_MS = 10_000;
const DEFAULT_AI_STAGE_TIMEOUT_MS = 900_000;
const DEFAULT_AI_JOB_DEADLINE_MS = 5_400_000;

// faster-whisper model sizes. The audited default is `medium`; `tiny`/`base`
// are included because they are valid sizes the processor accepts and are useful
// for fast verification or low-resource hosts.
export const AI_MODEL_SIZES = ["tiny", "base", "small", "medium", "large-v3"] as const;
export type AiModelSize = (typeof AI_MODEL_SIZES)[number];

export const DEFAULT_SUPPORTED_MEDIA_EXTENSIONS = [
  ".mp4",
  ".mov",
  ".mxf",
  ".mpg",
  ".mpeg",
  ".avi",
  ".mkv",
  ".ts",
  ".mts",
] as const;

const configSchema = z.object({
  DATABASE_URL: z
    .string({ error: "DATABASE_URL is required" })
    .trim()
    .refine((value) => /^postgres(?:ql)?:\/\/[^\s]+$/i.test(value), {
      error: "DATABASE_URL must be a postgres:// URL",
    }),
  MEDIA_ROOT: z
    .string({ error: "MEDIA_ROOT is required" })
    .trim()
    .min(1, "MEDIA_ROOT must be a non-empty path"),
  STORAGE_NAME: z
    .string({ error: "STORAGE_NAME is required" })
    .trim()
    .min(1, "STORAGE_NAME must be non-empty"),
  PORT: z.string().optional(),
  WEB_ORIGIN: z.string().optional(),
  SUPPORTED_MEDIA_EXTENSIONS: z.string().optional(),
  METADATA_WORKER_CONCURRENCY: z.string().optional(),
  METADATA_MAX_RETRIES: z.string().optional(),
  METADATA_RETRY_BACKOFF_MS: z.string().optional(),
  AI_ENABLED: z.string().optional(),
  AI_PROCESSOR_URL: z.string().optional(),
  AI_MODEL_SIZE: z.string().optional(),
  AI_LANGUAGE: z.string().optional(),
  AI_CONCURRENCY: z.string().optional(),
  AI_MAX_RETRIES: z.string().optional(),
  AI_RETRY_BACKOFF_MS: z.string().optional(),
  AI_REQUEST_TIMEOUT_MS: z.string().optional(),
  AI_POLL_INTERVAL_MS: z.string().optional(),
  AI_STAGE_TIMEOUT_MS: z.string().optional(),
  AI_JOB_DEADLINE_MS: z.string().optional(),
});

export interface AiConfig {
  enabled: boolean;
  processorUrl: string;
  modelSize: AiModelSize;
  language: string;
  concurrency: number;
  maxRetries: number;
  retryBackoffMs: number;
  requestTimeoutMs: number;
  pollIntervalMs: number;
  stageTimeoutMs: number;
  jobDeadlineMs: number;
}

export interface AppConfig {
  databaseUrl: string;
  mediaRoot: string;
  storageName: string;
  port: number;
  webOrigin: string;
  supportedMediaExtensions: readonly string[];
  metadataWorkerConcurrency: number;
  metadataMaxRetries: number;
  metadataRetryBackoffMs: number;
  ai: AiConfig;
}

export function parseMetadataWorkerConcurrency(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_METADATA_WORKER_CONCURRENCY;
  }

  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(
      `METADATA_WORKER_CONCURRENCY must be a positive integer (received "${raw}")`,
    );
  }
  return value;
}

export function parseMetadataMaxRetries(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_METADATA_MAX_RETRIES;
  }

  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      `METADATA_MAX_RETRIES must be a non-negative integer (received "${raw}")`,
    );
  }
  return value;
}

export function parseMetadataRetryBackoffMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_METADATA_RETRY_BACKOFF_MS;
  }

  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      `METADATA_RETRY_BACKOFF_MS must be a non-negative integer (received "${raw}")`,
    );
  }
  return value;
}

// ── AI configuration (ADR-006 §13, Plan 006 §4) ─────────────────────────

/** Parse a boolean env flag; only "true"/"1" (case-insensitive) enable it. */
export function parseAiEnabled(raw: string | undefined): boolean {
  if (raw === undefined || raw.trim() === "") return false;
  const value = raw.trim().toLowerCase();
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new Error(`AI_ENABLED must be true or false (received "${raw}")`);
}

export function parseAiProcessorUrl(raw: string | undefined): string {
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_AI_PROCESSOR_URL;
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`AI_PROCESSOR_URL must be a valid URL (received "${raw}")`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(
      `AI_PROCESSOR_URL must use http or https (received "${raw}")`,
    );
  }
  return raw.replace(/\/+$/, "");
}

export function parseAiModelSize(raw: string | undefined): AiModelSize {
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_AI_MODEL_SIZE;
  }
  const value = raw.trim();
  if (!(AI_MODEL_SIZES as readonly string[]).includes(value)) {
    throw new Error(
      `AI_MODEL_SIZE must be one of ${AI_MODEL_SIZES.join(", ")} (received "${raw}")`,
    );
  }
  return value as AiModelSize;
}

export function parseAiLanguage(raw: string | undefined): string {
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_AI_LANGUAGE;
  }
  const value = raw.trim();
  if (!/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(value)) {
    throw new Error(`AI_LANGUAGE must be a language code such as "id" (received "${raw}")`);
  }
  return value;
}

/** Parse a required-positive-integer AI setting with a default. */
export function parseAiPositiveInt(
  name: string,
  raw: string | undefined,
  fallback: number,
): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer (received "${raw}")`);
  }
  return value;
}

/** Parse a non-negative-integer AI setting with a default (0 allowed). */
export function parseAiNonNegativeInt(
  name: string,
  raw: string | undefined,
  fallback: number,
): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer (received "${raw}")`);
  }
  return value;
}

export function parseAiConfig(env: NodeJS.ProcessEnv): AiConfig {
  return {
    enabled: parseAiEnabled(env.AI_ENABLED),
    processorUrl: parseAiProcessorUrl(env.AI_PROCESSOR_URL),
    modelSize: parseAiModelSize(env.AI_MODEL_SIZE),
    language: parseAiLanguage(env.AI_LANGUAGE),
    concurrency: parseAiPositiveInt("AI_CONCURRENCY", env.AI_CONCURRENCY, DEFAULT_AI_CONCURRENCY),
    maxRetries: parseAiNonNegativeInt("AI_MAX_RETRIES", env.AI_MAX_RETRIES, DEFAULT_AI_MAX_RETRIES),
    retryBackoffMs: parseAiNonNegativeInt(
      "AI_RETRY_BACKOFF_MS",
      env.AI_RETRY_BACKOFF_MS,
      DEFAULT_AI_RETRY_BACKOFF_MS,
    ),
    requestTimeoutMs: parseAiPositiveInt(
      "AI_REQUEST_TIMEOUT_MS",
      env.AI_REQUEST_TIMEOUT_MS,
      DEFAULT_AI_REQUEST_TIMEOUT_MS,
    ),
    pollIntervalMs: parseAiPositiveInt(
      "AI_POLL_INTERVAL_MS",
      env.AI_POLL_INTERVAL_MS,
      DEFAULT_AI_POLL_INTERVAL_MS,
    ),
    stageTimeoutMs: parseAiPositiveInt(
      "AI_STAGE_TIMEOUT_MS",
      env.AI_STAGE_TIMEOUT_MS,
      DEFAULT_AI_STAGE_TIMEOUT_MS,
    ),
    jobDeadlineMs: parseAiPositiveInt(
      "AI_JOB_DEADLINE_MS",
      env.AI_JOB_DEADLINE_MS,
      DEFAULT_AI_JOB_DEADLINE_MS,
    ),
  };
}

function parseSingleWebOrigin(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("unsupported protocol");
  }
  return url.origin;
}

export function parseWebOrigin(raw: string | undefined): string {
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_WEB_ORIGIN;
  }

  // Comma-separated allowlist of browser origins (e.g. localhost + LAN IP
  // access). A single value behaves exactly as before.
  try {
    return raw
      .split(",")
      .map((entry) => parseSingleWebOrigin(entry.trim()))
      .join(",");
  } catch {
    throw new Error(
      `WEB_ORIGIN must be a valid http(s) origin such as ${DEFAULT_WEB_ORIGIN} (received "${raw}")`,
    );
  }
}

export function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_PORT;
  }

  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`PORT must be an integer between 1 and 65535 (received "${raw}")`);
  }
  return value;
}

export function parseSupportedMediaExtensions(raw: string | undefined): string[] {
  if (raw === undefined) {
    return [...DEFAULT_SUPPORTED_MEDIA_EXTENSIONS];
  }

  if (raw.trim() === "") {
    throw new Error("SUPPORTED_MEDIA_EXTENSIONS must not be empty");
  }

  const extensions = raw.split(",").map((extension) => extension.trim().toLowerCase());
  if (
    extensions.some(
      (extension) => !/^\.[^./\\\s]+$/.test(extension),
    )
  ) {
    throw new Error(
      "SUPPORTED_MEDIA_EXTENSIONS must be a comma-separated list of extensions such as .mp4,.mxf",
    );
  }

  return [...new Set(extensions)];
}

export function isSupportedMediaExtension(
  extension: string,
  supportedExtensions: readonly string[],
): boolean {
  const normalizedExtension = extension.toLowerCase();
  return supportedExtensions.some(
    (supportedExtension) => supportedExtension.toLowerCase() === normalizedExtension,
  );
}

export function parseConfig(env: NodeJS.ProcessEnv): AppConfig {
  const result = configSchema.safeParse({
    DATABASE_URL: env.DATABASE_URL,
    MEDIA_ROOT: env.MEDIA_ROOT,
    STORAGE_NAME: env.STORAGE_NAME,
    PORT: env.PORT,
    SUPPORTED_MEDIA_EXTENSIONS: env.SUPPORTED_MEDIA_EXTENSIONS,
    METADATA_WORKER_CONCURRENCY: env.METADATA_WORKER_CONCURRENCY,
    METADATA_MAX_RETRIES: env.METADATA_MAX_RETRIES,
    METADATA_RETRY_BACKOFF_MS: env.METADATA_RETRY_BACKOFF_MS,
  });

  const issues = result.success ? [] : result.error.issues.map((issue) => {
    const variable = issue.path[0] ?? "configuration";
    return `${String(variable)}: ${issue.message}`;
  });

  let port: number | undefined;
  let webOrigin: string | undefined;
  let supportedMediaExtensions: string[] | undefined;
  let metadataWorkerConcurrency: number | undefined;
  let metadataMaxRetries: number | undefined;
  let metadataRetryBackoffMs: number | undefined;
  let ai: AiConfig | undefined;
  if (issues.length === 0) {
    try {
      port = parsePort(env.PORT);
    } catch (error) {
      issues.push(error instanceof Error ? error.message : "PORT is invalid");
    }

    try {
      webOrigin = parseWebOrigin(env.WEB_ORIGIN);
    } catch (error) {
      issues.push(error instanceof Error ? error.message : "WEB_ORIGIN is invalid");
    }

    try {
      supportedMediaExtensions = parseSupportedMediaExtensions(
        env.SUPPORTED_MEDIA_EXTENSIONS,
      );
    } catch (error) {
      issues.push(
        error instanceof Error
          ? error.message
          : "SUPPORTED_MEDIA_EXTENSIONS is invalid",
      );
    }

    try {
      metadataWorkerConcurrency = parseMetadataWorkerConcurrency(
        env.METADATA_WORKER_CONCURRENCY,
      );
    } catch (error) {
      issues.push(
        error instanceof Error
          ? error.message
          : "METADATA_WORKER_CONCURRENCY is invalid",
      );
    }

    try {
      metadataMaxRetries = parseMetadataMaxRetries(env.METADATA_MAX_RETRIES);
    } catch (error) {
      issues.push(
        error instanceof Error ? error.message : "METADATA_MAX_RETRIES is invalid",
      );
    }

    try {
      metadataRetryBackoffMs = parseMetadataRetryBackoffMs(
        env.METADATA_RETRY_BACKOFF_MS,
      );
    } catch (error) {
      issues.push(
        error instanceof Error
          ? error.message
          : "METADATA_RETRY_BACKOFF_MS is invalid",
      );
    }

    try {
      ai = parseAiConfig(env);
    } catch (error) {
      issues.push(error instanceof Error ? error.message : "AI configuration is invalid");
    }
  }

  if (
    !result.success ||
    issues.length > 0 ||
    port === undefined ||
    webOrigin === undefined ||
    supportedMediaExtensions === undefined ||
    metadataWorkerConcurrency === undefined ||
    metadataMaxRetries === undefined ||
    metadataRetryBackoffMs === undefined ||
    ai === undefined
  ) {
    throw new Error(`Invalid configuration:\n- ${issues.join("\n- ")}`);
  }

  return {
    databaseUrl: result.data.DATABASE_URL,
    mediaRoot: result.data.MEDIA_ROOT,
    storageName: result.data.STORAGE_NAME,
    port,
    webOrigin,
    supportedMediaExtensions,
    metadataWorkerConcurrency,
    metadataMaxRetries,
    metadataRetryBackoffMs,
    ai,
  };
}
