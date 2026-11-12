import { z } from "zod";

/**
 * AI Processor HTTP adapter (ADR-006 §17, AGENTS.md §16).
 *
 * Server-side only boundary around the `ai-processor` Python service, mirroring
 * how `FFprobeAdapter` wraps the ffprobe executable. The adapter:
 *   - is the ONLY place that knows the processor's HTTP contract,
 *   - validates every response with Zod before it reaches business logic,
 *   - is timeout-aware and error-aware, mapping transport failures to typed
 *     error codes that the Runner classifies as TRANSIENT / PERMANENT,
 *   - accepts only an absolute, already-contained media path (the Runner
 *     resolves it through `resolveInsideRoot`; the adapter never accepts a
 *     client-supplied path).
 */

export const AI_PROCESSOR_ERROR_CODES = {
  /** Network/connection failure, or 5xx: plausibly transient. */
  UNAVAILABLE: "AI_PROCESSOR_UNAVAILABLE",
  /** The request exceeded the configured timeout: transient. */
  TIMEOUT: "AI_PROCESSOR_TIMEOUT",
  /** A 4xx from the processor (bad path, unreadable media): permanent. */
  BAD_REQUEST: "AI_PROCESSOR_BAD_REQUEST",
  /** A 2xx response whose body did not match the contract: permanent. */
  INVALID_RESPONSE: "AI_PROCESSOR_INVALID_RESPONSE",
} as const;

export type AiProcessorErrorCode =
  (typeof AI_PROCESSOR_ERROR_CODES)[keyof typeof AI_PROCESSOR_ERROR_CODES];

export class AiProcessorError extends Error {
  public readonly code: AiProcessorErrorCode;

  public constructor(code: AiProcessorErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AiProcessorError";
    this.code = code;
  }
}

// ── Contract schemas (validated, never trusted) ──────────────────────────
// The processor wraps every response as `{ ok: true, data: ... }`; these
// schemas describe the inner `data`, which `requestJson` unwraps.

const transcribeStartSchema = z.object({
  job_id: z.string(),
  status: z.enum(["STARTED", "ALREADY_RUNNING"]),
});

const transcriptionSegmentSchema = z.object({
  start: z.number(),
  end: z.number(),
  text: z.string(),
});

export const transcriptionResultSchema = z.object({
  segments: z.array(transcriptionSegmentSchema),
  full_text: z.string(),
  duration_sec: z.number().nullable().optional(),
  language: z.string().nullable().optional(),
});
export type TranscriptionResult = z.infer<typeof transcriptionResultSchema>;

/** `/transcribe/status` returns a union whose discriminator is `status`. */
export const transcribeStatusSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("RUNNING"), progress: z.unknown().optional() }),
  z.object({ status: z.literal("COMPLETED"), result: transcriptionResultSchema }),
  z.object({ status: z.literal("FAILED"), error: z.string() }),
  z.object({ status: z.literal("NOT_FOUND") }),
]);
export type TranscribeStatus = z.infer<typeof transcribeStatusSchema>;

/** `/transcribe/cancel/{asset_id}` reports whether a live job was signalled. */
export const transcribeCancelSchema = z.object({
  asset_id: z.string(),
  cancelled: z.boolean(),
});
export type TranscribeCancel = z.infer<typeof transcribeCancelSchema>;

export const summarizeResultSchema = z.object({
  summary: z.string(),
  keywords: z.array(z.string()),
  category: z.string(),
});
export type SummarizeResult = z.infer<typeof summarizeResultSchema>;

export const ocrResultSchema = z.object({
  raw_text: z.string(),
  presenter: z.object({ name: z.string().nullable(), role: z.string().nullable() }).nullable(),
  // Diagnostic extras from multi-frame sampling (ADR-006 §17). Optional so an
  // older processor (single frame) still satisfies the contract.
  sampled_count: z.number().int().nonnegative().optional(),
  best_timestamp_sec: z.number().optional(),
});
export type OcrResult = z.infer<typeof ocrResultSchema>;

// ── Adapter interface ────────────────────────────────────────────────────

export interface AiProcessorAdapter {
  /** Liveness probe. Resolves `true` when the processor reports healthy. */
  health(signal?: AbortSignal): Promise<boolean>;
  /** Start transcription for a TMIP-owned external job id. Idempotent by jobId. */
  startTranscription(input: {
    absolutePath: string;
    externalJobId: string;
    modelSize: string;
    language: string;
    signal?: AbortSignal;
  }): Promise<{ jobId: string; alreadyRunning: boolean }>;
  /** Poll status of a transcription job. */
  transcriptionStatus(externalJobId: string, signal?: AbortSignal): Promise<TranscribeStatus>;
  /**
   * Ask the processor to stop a running transcription job (best-effort,
   * ADR-006 §18). The processor cancels cooperatively between whisper segments;
   * a false return means no live job matched, which is not an error.
   */
  cancelTranscription(externalJobId: string, signal?: AbortSignal): Promise<boolean>;
  /** Fetch the final transcription result (only meaningful when COMPLETED). */
  transcriptionResult(externalJobId: string, signal?: AbortSignal): Promise<TranscriptionResult>;
  /** Single summarize call yielding summary + keywords + category. */
  summarize(
    fullText: string,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<SummarizeResult>;
  /** Lower-third OCR for a frame timestamp. */
  ocr(input: {
    absolutePath: string;
    timestampSec: number;
    /** Known media duration; enables multi-frame sampling (ADR-006 §17). */
    durationSec?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<OcrResult>;
}

export interface HttpAiProcessorAdapterOptions {
  baseUrl: string;
  requestTimeoutMs: number;
  /** Injectable fetch for deterministic tests (TESTING.md §2). */
  fetchImpl?: typeof fetch;
}

interface RequestContext {
  method: "GET" | "POST";
  path: string;
  body?: unknown;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export class HttpAiProcessorAdapter implements AiProcessorAdapter {
  private readonly baseUrl: string;
  private readonly requestTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  public constructor(options: HttpAiProcessorAdapterOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.requestTimeoutMs = options.requestTimeoutMs;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  public async health(signal?: AbortSignal): Promise<boolean> {
    try {
      const response = await this.request({ method: "GET", path: "/health", signal });
      return response.ok;
    } catch {
      return false;
    }
  }

  public async startTranscription(input: {
    absolutePath: string;
    externalJobId: string;
    modelSize: string;
    language: string;
    signal?: AbortSignal;
  }): Promise<{ jobId: string; alreadyRunning: boolean }> {
    const data = await this.requestJson(
      {
        method: "POST",
        path: "/transcribe",
        body: {
          video_path: input.absolutePath,
          asset_id: input.externalJobId,
          model_size: input.modelSize,
          language: input.language,
        },
        signal: input.signal,
      },
      transcribeStartSchema,
    );
    return { jobId: data.job_id, alreadyRunning: data.status === "ALREADY_RUNNING" };
  }

  public async transcriptionStatus(
    externalJobId: string,
    signal?: AbortSignal,
  ): Promise<TranscribeStatus> {
    return this.requestJson(
      {
        method: "GET",
        path: `/transcribe/status/${encodeURIComponent(externalJobId)}`,
        signal,
      },
      transcribeStatusSchema,
    );
  }

  public async cancelTranscription(
    externalJobId: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const data = await this.requestJson(
      {
        method: "POST",
        path: `/transcribe/cancel/${encodeURIComponent(externalJobId)}`,
        signal,
      },
      transcribeCancelSchema,
    );
    return data.cancelled;
  }

  public async transcriptionResult(
    externalJobId: string,
    signal?: AbortSignal,
  ): Promise<TranscriptionResult> {
    return this.requestJson(
      {
        method: "GET",
        path: `/transcribe/result/${encodeURIComponent(externalJobId)}`,
        signal,
      },
      transcriptionResultSchema,
    );
  }

  public async summarize(
    fullText: string,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<SummarizeResult> {
    return this.requestJson(
      {
        method: "POST",
        path: "/summarize",
        body: { full_text: fullText },
        timeoutMs: options?.timeoutMs,
        signal: options?.signal,
      },
      summarizeResultSchema,
    );
  }

  public async ocr(input: {
    absolutePath: string;
    timestampSec: number;
    /** Known media duration; enables multi-frame sampling (ADR-006 §17). */
    durationSec?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<OcrResult> {
    return this.requestJson(
      {
        method: "POST",
        path: "/ocr",
        body: {
          video_path: input.absolutePath,
          timestamp_sec: input.timestampSec,
          ...(input.durationSec === undefined ? {} : { duration_sec: input.durationSec }),
        },
        timeoutMs: input.timeoutMs,
        signal: input.signal,
      },
      ocrResultSchema,
    );
  }

  private async requestJson<TOutput>(
    context: RequestContext,
    schema: z.ZodType<TOutput>,
  ): Promise<TOutput> {
    const response = await this.request(context);
    let parsedBody: unknown;
    try {
      parsedBody = await response.json();
    } catch (error) {
      throw new AiProcessorError(
        AI_PROCESSOR_ERROR_CODES.INVALID_RESPONSE,
        `AI Processor returned a non-JSON response for ${context.path}`,
        { cause: error },
      );
    }
    if (!response.ok) {
      // 429 (rate limit) and 5xx are plausibly transient (ADR-006 §6); other
      // 4xx are a request the provider rejected, which retrying cannot fix
      // (ADR-006 §12): auth, model, quota, and bad-request are PERMANENT.
      const code =
        response.status === 429 || response.status >= 500
          ? AI_PROCESSOR_ERROR_CODES.UNAVAILABLE
          : AI_PROCESSOR_ERROR_CODES.BAD_REQUEST;
      // Include the processor's own (already-sanitized) detail so auth/model/
      // quota causes are diagnosable. The processor never puts the API key,
      // request headers, or the raw provider body in this message.
      const detail = extractErrorDetail(parsedBody);
      throw new AiProcessorError(
        code,
        `AI Processor responded ${response.status} for ${context.path}${detail === null ? "" : `: ${detail}`}`,
      );
    }

    // Every processor endpoint wraps its payload as `{ ok: true, data: ... }`.
    const envelope = parsedBody as { ok?: unknown; data?: unknown } | null;
    if (
      envelope === null ||
      typeof envelope !== "object" ||
      envelope.ok !== true ||
      !("data" in envelope)
    ) {
      throw new AiProcessorError(
        AI_PROCESSOR_ERROR_CODES.INVALID_RESPONSE,
        `AI Processor returned a malformed envelope for ${context.path}`,
      );
    }

    const result = schema.safeParse(envelope.data);
    if (!result.success) {
      throw new AiProcessorError(
        AI_PROCESSOR_ERROR_CODES.INVALID_RESPONSE,
        `AI Processor returned an unexpected payload for ${context.path}: ${result.error.message}`,
      );
    }
    return result.data;
  }

  private async request(context: RequestContext): Promise<Response> {
    const controller = new AbortController();
    const timeoutMs = context.timeoutMs ?? this.requestTimeoutMs;
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    // Forward an externally supplied signal (job deadline) into the request.
    const externalAbort = (): void => controller.abort();
    context.signal?.addEventListener("abort", externalAbort, { once: true });

    try {
      return await this.fetchImpl(`${this.baseUrl}${context.path}`, {
        method: context.method,
        headers: context.body === undefined ? undefined : { "Content-Type": "application/json" },
        body: context.body === undefined ? undefined : JSON.stringify(context.body),
        signal: controller.signal,
      });
    } catch (error) {
      if (context.signal?.aborted === true) {
        throw new AiProcessorError(
          AI_PROCESSOR_ERROR_CODES.TIMEOUT,
          `AI Processor call ${context.path} exceeded the job deadline`,
          { cause: error },
        );
      }
      if (controller.signal.aborted || isAbortError(error)) {
        throw new AiProcessorError(
          AI_PROCESSOR_ERROR_CODES.TIMEOUT,
          `AI Processor call ${context.path} timed out after ${timeoutMs}ms`,
          { cause: error },
        );
      }
      throw new AiProcessorError(
        AI_PROCESSOR_ERROR_CODES.UNAVAILABLE,
        `AI Processor is unreachable for ${context.path}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    } finally {
      clearTimeout(timer);
      context.signal?.removeEventListener("abort", externalAbort);
    }
  }
}

/** A DOMException/Error named `AbortError` (ADR-006 §6: timeout → TRANSIENT). */
function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/**
 * Pull a short, safe diagnostic string from a processor error body.
 *
 * The processor reports failures as FastAPI's `{ "detail": "..." }` (see
 * `ai-processor/app/main.py`). The processor guarantees the detail never holds
 * the API key, request headers, or the raw provider body, so echoing it back to
 * TMIP's error fields is safe and makes auth/model/quota causes diagnosable
 * (ADR-006 §12). Unknown shapes yield `null` rather than a raw dump.
 */
function extractErrorDetail(body: unknown): string | null {
  if (body === null || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  const detail = record.detail ?? record.error;
  if (typeof detail !== "string") return null;
  const trimmed = detail.replace(/\s+/g, " ").trim();
  return trimmed === "" ? null : trimmed.slice(0, 300);
}
