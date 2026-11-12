import { access, constants, stat } from "node:fs/promises";
import { Prisma, type PrismaClient } from "@prisma/client";
import { normalizeFFprobeOutput, type NormalizedMetadata } from "../metadata/normalizer.js";
import type { FFprobeAdapter } from "../metadata/ffprobe-adapter.js";
import { FFPROBE_ERROR_CODES, InvalidProbeOutputError } from "../metadata/ffprobe-adapter.js";
import { isRetryableFailure } from "../metadata/failure-classification.js";
import { resolveInsideRoot, PathContainmentError } from "../paths.js";

export type ExtractionDatabase = Pick<PrismaClient, "mediaFile" | "scanJob">;
export type MetadataNormalizer = (probe: Parameters<typeof normalizeFFprobeOutput>[0]) => NormalizedMetadata;

/** Injectable sleep so retry backoff is deterministic in tests (TESTING.md §2). */
export type RetrySleep = (milliseconds: number) => Promise<void>;

const DEFAULT_RETRY_BACKOFF_MS = 250;
const RETRY_BACKOFF_CAP_MS = 5_000;

const defaultRetrySleep: RetrySleep = (milliseconds) =>
  milliseconds <= 0
    ? Promise.resolve()
    : new Promise((resolve) => setTimeout(resolve, milliseconds));

export interface ExtractionRunnerOptions {
  prisma: ExtractionDatabase;
  adapter: FFprobeAdapter;
  normalizer?: MetadataNormalizer;
  storageRoot: string;
  concurrency?: number;
  /**
   * Bounded automatic retry for TRANSIENT failures (WORKFLOWS.md §33,
   * AGENTS.md §19). Defaults to 0 — no automatic retry — so a caller that does
   * not opt in keeps the Phase 1–11 single-attempt behavior. The production
   * path passes METADATA_MAX_RETRIES (config default 2).
   */
  maxRetries?: number;
  retryBackoffMs?: number;
  retrySleep?: RetrySleep;
}

type FailureStage = "VALIDATION" | "FFPROBE" | "NORMALIZATION" | "PERSISTENCE";

type ExtractionFailure = {
  code: string;
  message: string;
  stage: FailureStage;
};

type AttemptResult =
  | { outcome: "SUCCESS" }
  | { outcome: "FAILURE"; failure: ExtractionFailure }
  | { outcome: "ABORTED" };

function failureFrom(error: unknown): ExtractionFailure {
  if (error instanceof PathContainmentError) {
    return { code: "VALIDATION_FAILED", message: error.message, stage: "VALIDATION" };
  }

  if (error instanceof InvalidProbeOutputError) {
    return { code: error.code, message: error.message, stage: error.stage };
  }

  if (error instanceof Error && "code" in error && "stage" in error) {
    const candidate = error as Error & { code?: unknown; stage?: unknown };
    if (typeof candidate.code === "string" && isFailureStage(candidate.stage)) {
      return { code: candidate.code, message: candidate.message, stage: candidate.stage };
    }
  }

  const nodeCode = error instanceof Error && "code" in error
    ? (error as Error & { code?: unknown }).code
    : undefined;
  if (nodeCode === "ENOENT") {
    return { code: "FILE_NOT_FOUND", message: errorMessage(error), stage: "VALIDATION" };
  }
  if (nodeCode === "EACCES" || nodeCode === "EPERM") {
    return { code: "PERMISSION_DENIED", message: errorMessage(error), stage: "VALIDATION" };
  }

  // An unstructured adapter exception is a probe failure at this boundary;
  // persistence failures are handled separately by the guarded persistence
  // block below.
  return { code: FFPROBE_ERROR_CODES.FAILED, message: errorMessage(error), stage: "FFPROBE" };
}

function isFailureStage(value: unknown): value is FailureStage {
  return value === "VALIDATION" || value === "FFPROBE" || value === "NORMALIZATION" || value === "PERSISTENCE";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class FileValidationError extends Error {
  public readonly code: string;
  public readonly stage = "VALIDATION" as const;

  public constructor(code: string, message: string) {
    super(message);
    this.name = "FileValidationError";
    this.code = code;
  }
}

export class ExtractionRunner {
  private readonly prisma: ExtractionDatabase;
  private readonly adapter: FFprobeAdapter;
  private readonly normalizer: MetadataNormalizer;
  private readonly storageRoot: string;
  private readonly concurrency: number;
  private readonly maxRetries: number;
  private readonly retryBackoffMs: number;
  private readonly retrySleep: RetrySleep;

  public constructor(options: ExtractionRunnerOptions) {
    this.prisma = options.prisma;
    this.adapter = options.adapter;
    this.normalizer = options.normalizer ?? normalizeFFprobeOutput;
    this.storageRoot = options.storageRoot;
    this.concurrency = options.concurrency ?? 1;
    if (!Number.isSafeInteger(this.concurrency) || this.concurrency < 1) {
      throw new Error("Extraction runner concurrency must be a positive integer");
    }
    this.maxRetries = options.maxRetries ?? 0;
    if (!Number.isSafeInteger(this.maxRetries) || this.maxRetries < 0) {
      throw new Error("Extraction runner maxRetries must be a non-negative integer");
    }
    this.retryBackoffMs = options.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
    if (!Number.isSafeInteger(this.retryBackoffMs) || this.retryBackoffMs < 0) {
      throw new Error("Extraction runner retryBackoffMs must be a non-negative integer");
    }
    this.retrySleep = options.retrySleep ?? defaultRetrySleep;
  }

  /**
   * Drain PostgreSQL-backed pending work with bounded parallel claims. Work is
   * attributed to the MediaFile's lastSeenScanId when that scan is still
   * RUNNING; otherwise the active scan receives the terminal-attempt counter.
   * Each claimed row may retry transient failures a bounded number of times
   * inside `appendAttempt` (WORKFLOWS.md §33); the terminal outcome still
   * increments the scan counters exactly once per claim.
   */
  public async drain(storageId: string, activeScanId: string): Promise<void> {
    await Promise.all(
      Array.from({ length: this.concurrency }, () => this.worker(storageId, activeScanId)),
    );
  }

  private async worker(storageId: string, activeScanId: string): Promise<void> {
    while (true) {
      const claimed = await this.claimOne(storageId);
      if (claimed === null) return;
      await this.processOne(claimed, activeScanId);
    }
  }

  private async claimOne(storageId: string) {
    while (true) {
      const candidate = await this.prisma.mediaFile.findFirst({
        where: { storageId, metadataStatus: "PENDING" },
        orderBy: { id: "asc" },
      });
      if (candidate === null) return null;

      const claimed = await this.prisma.mediaFile.updateMany({
        where: { id: candidate.id, metadataStatus: "PENDING" },
        data: { metadataStatus: "PROCESSING", retryCount: 0 },
      });
      if (claimed.count === 1) {
        return this.prisma.mediaFile.findUnique({ where: { id: candidate.id } });
      }
    }
  }

  private async processOne(mediaFile: NonNullable<Awaited<ReturnType<ExtractionRunner["claimOne"]>>>, activeScanId: string): Promise<void> {
    const terminalScanId = await this.resolveCounterScan(mediaFile.lastSeenScanId, activeScanId, mediaFile.storageId);
    const outcome = await this.appendAttempt(mediaFile);
    // ABORTED means the failure record itself could not be persisted; leaving
    // the counter untouched keeps the scan unfinished so the completion guard
    // exposes the outstanding work rather than falsely completing the scan.
    if (outcome === "ABORTED") return;
    await this.incrementCounters(terminalScanId, outcome === "FAILED");
  }

  /**
   * Run one extraction attempt for an already-claimed row: validate, probe,
   * normalise, then persist READY (clearing error fields). On an extraction
   * failure it returns the failure WITHOUT persisting it — the caller decides
   * whether to retry a transient failure or write the terminal FAILED state —
   * so a retry never leaves the row in a claimable state. A failure to persist
   * the READY transition surfaces as ABORTED.
   */
  private async attemptOnce(mediaFile: { id: string; relativePath: string }): Promise<AttemptResult> {
    let normalized: NormalizedMetadata;
    let rawProbeData: Prisma.InputJsonValue;
    try {
      const absolutePath = await this.validateFile(mediaFile.relativePath);
      const probe = await this.adapter.probe(absolutePath);
      normalized = this.normalizer(probe.parsed);
      rawProbeData = JSON.parse(probe.rawJson) as Prisma.InputJsonValue;
    } catch (error) {
      const failure = error instanceof FileValidationError
        ? { code: error.code, message: error.message, stage: error.stage }
        : failureFrom(error);
      return { outcome: "FAILURE", failure };
    }

    const technicalMetadata = normalized.technicalMetadata as Prisma.InputJsonValue;
    try {
      await this.prisma.mediaFile.update({
        where: { id: mediaFile.id },
        data: {
          ...normalized,
          technicalMetadata,
          rawProbeData,
          metadataStatus: "READY",
          lastMetadataExtractedAt: new Date(),
          retryCount: 0,
          errorCode: null,
          errorMessage: null,
          errorStage: null,
          errorAt: null,
        },
      });
      return { outcome: "SUCCESS" };
    } catch {
      return { outcome: "ABORTED" };
    }
  }

  /**
   * Bounded retry core shared by the scan drain and explicit reprocess
   * (WORKFLOWS.md §§31–33, AGENTS.md §19). It wraps the whole attempt —
   * validate → probe → normalise — so transient VALIDATION failures
   * (FILE_NOT_FOUND / PERMISSION_DENIED) are retried alongside transient
   * FFPROBE failures. Only TRANSIENT codes retry, the count is bounded by
   * `maxRetries`, and the row stays PROCESSING between attempts (no terminal
   * write) so no scan or reprocess can claim it concurrently. The terminal
   * attempt writes READY (clearing error fields) or FAILED (last failure).
   */
  private async appendAttempt(mediaFile: { id: string; relativePath: string }): Promise<"SUCCESS" | "FAILED" | "ABORTED"> {
    let retriesUsed = 0;
    while (true) {
      const attempt = await this.attemptOnce(mediaFile);
      if (attempt.outcome === "SUCCESS") return "SUCCESS";
      if (attempt.outcome === "ABORTED") return "ABORTED";

      if (isRetryableFailure(attempt.failure.code) && retriesUsed < this.maxRetries) {
        retriesUsed += 1;
        await this.persistRetryProgress(mediaFile.id, retriesUsed);
        await this.waitBeforeRetry(this.backoffFor(retriesUsed));
        continue;
      }

      return (await this.recordFailure(mediaFile.id, attempt.failure, retriesUsed)) ? "FAILED" : "ABORTED";
    }
  }

  /**
   * Record retry progress without changing metadataStatus. The row must remain
   * PROCESSING for the whole retry sequence so neither a scan drain nor a
   * manual reprocess can claim it (Phase 12 concurrency invariant). This is an
   * observability-only write; a failure here must not cancel the retry that is
   * about to run, and the terminal write below is the one that surfaces real
   * persistence problems as ABORTED.
   */
  private async persistRetryProgress(mediaFileId: string, retriesUsed: number): Promise<void> {
    try {
      await this.prisma.mediaFile.update({
        where: { id: mediaFileId },
        data: { retryCount: retriesUsed },
      });
    } catch {
      // Non-terminal observability write; continue retrying regardless.
    }
  }

  private async recordFailure(mediaFileId: string, failure: ExtractionFailure, retriesUsed: number): Promise<boolean> {
    try {
      await this.prisma.mediaFile.update({
        where: { id: mediaFileId },
        data: {
          metadataStatus: "FAILED",
          errorCode: failure.code,
          errorMessage: failure.message,
          errorStage: failure.stage,
          errorAt: new Date(),
          retryCount: retriesUsed,
        },
      });
      return true;
    } catch {
      // A persistence outage is outside the file-level failure record's
      // control. Keep this attempt isolated so another claimed file can run;
      // the orchestrator's durable completion guard will expose unfinished
      // work rather than falsely completing the scan.
      return false;
    }
  }

  /**
   * Wait before the next retry. The default `setTimeout` sleep never rejects,
   * but an injected test seam could; a throwing sleep must not strand the row
   * in PROCESSING, so it is treated as "retry immediately" rather than
   * propagating out of the drain/reprocess call.
   */
  private async waitBeforeRetry(milliseconds: number): Promise<void> {
    try {
      await this.retrySleep(milliseconds);
    } catch {
      // Retry without the pause; the bound still limits total attempts.
    }
  }

  /** Exponential backoff with a cap; `retriesUsed` is 1-based. */
  private backoffFor(retriesUsed: number): number {
    if (this.retryBackoffMs === 0) return 0;
    return Math.min(this.retryBackoffMs * 2 ** (retriesUsed - 1), RETRY_BACKOFF_CAP_MS);
  }

  /**
   * Explicit user-initiated metadata reprocessing for a single existing row
   * (WORKFLOWS.md §52, AGENTS.md §10). Atomically claims READY|FAILED →
   * PROCESSING; PENDING|PROCESSING are rejected so concurrent reprocesses of
   * the same file cannot overlap. The claim resets retryCount so a fresh
   * reprocess always gets the full retry budget. Reprocess is not a scan: it
   * never touches ScanJob counters and never writes lastSeenScanId, so a
   * subsequent incremental scan still classifies the file by size/modifiedAt.
   *
   * The atomic claim runs in the request path so the API can answer
   * 202/404/409; the extraction itself is detached (AGENTS.md §8 — no ffprobe
   * inside the HTTP handler) and the client observes the terminal state via
   * GET /media/:id.
   */
  public async reprocessOne(mediaFileId: string): Promise<"STARTED" | "CONFLICT" | "NOT_FOUND"> {
    const mediaFile = await this.prisma.mediaFile.findUnique({
      where: { id: mediaFileId },
      select: { id: true, relativePath: true },
    });
    if (mediaFile === null) return "NOT_FOUND";

    const claimed = await this.prisma.mediaFile.updateMany({
      where: { id: mediaFileId, metadataStatus: { in: ["READY", "FAILED"] } },
      data: { metadataStatus: "PROCESSING", retryCount: 0 },
    });
    if (claimed.count === 0) return "CONFLICT";

    void this.appendAttempt(mediaFile);
    return "STARTED";
  }

  private async validateFile(relativePath: string): Promise<string> {
    const absolutePath = resolveInsideRoot(this.storageRoot, relativePath);
    try {
      const attributes = await stat(absolutePath);
      if (!attributes.isFile()) {
        throw new FileValidationError(
          "VALIDATION_FAILED",
          `Metadata extraction target is not a regular file: ${relativePath}`,
        );
      }
      await access(absolutePath, constants.R_OK);
      return absolutePath;
    } catch (error) {
      if (error instanceof FileValidationError) throw error;
      throw error;
    }
  }

  private async resolveCounterScan(lastSeenScanId: string, activeScanId: string, storageId: string): Promise<string> {
    if (lastSeenScanId === activeScanId) return activeScanId;
    const observedScan = await this.prisma.scanJob.findFirst({
      where: { id: lastSeenScanId, storageId, status: "RUNNING" },
      select: { id: true },
    });
    return observedScan?.id ?? activeScanId;
  }

  private async incrementCounters(scanId: string, failed: boolean): Promise<void> {
    await this.prisma.scanJob.update({
      where: { id: scanId },
      data: {
        processedCount: { increment: 1 },
        ...(failed ? { failedCount: { increment: 1 } } : {}),
      },
    });
  }
}

export { FFPROBE_ERROR_CODES };
