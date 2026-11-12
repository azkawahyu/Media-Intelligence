import type { PrismaClient } from "@prisma/client";
import { resolveInsideRoot, PathContainmentError } from "../paths.js";
import { AiProcessorError, type AiProcessorAdapter } from "./adapter.js";
import { isRetryableAiFailure } from "./ai-failure-classification.js";

/**
 * AI Runner (ADR-006 §2, §4, §6, §7, §8). Mirrors `ExtractionRunner`'s proven
 * PostgreSQL claim model — no Redis, no queue.
 *
 * Durable work signal: `MediaFile.aiStatus = PENDING`. The runner claims a row
 * with an atomic `updateMany({ where: { id, aiStatus: "PENDING" }, ... })` and
 * checks the affected count, so concurrent claimers cannot double-process a row.
 *
 * Pipeline (Phase 14 MVP, text only — ADR-006 §15):
 *   TRANSCRIPTION (async, polled) → SUMMARY + KEYWORDS + CLASSIFICATION
 *   (one `/summarize` call split into three per-stage rows) → OCR
 *
 * Each successful stage is persisted immediately (`AiResult` upsert on
 * `(mediaFileId, stage)`), so a later permanent failure keeps earlier results
 * and yields `aiStatus = READY` with `aiPartial = true` (§7).
 *
 * Retry is in-claim and bounded (§6, Plan 006 §5): a TRANSIENT failure with
 * budget left keeps `aiStatus = PROCESSING`, increments `aiAttempt`, backs off,
 * and re-runs the pipeline. Exhaustion finalizes `FAILED` with the cause.
 */

export const AI_STAGE_CODES = {
  FILE_NOT_FOUND: "AI_FILE_NOT_FOUND",
  PATH_INVALID: "AI_PATH_INVALID",
  STAGE_FAILED: "AI_STAGE_FAILED",
  DEADLINE_EXCEEDED: "AI_DEADLINE_EXCEEDED",
  INTERRUPTED: "AI_INTERRUPTED",
  /** Cancellation observed; not a failure (ADR-006 §18). */
  CANCELLED: "AI_CANCELLED",
} as const;

type AiStageName = "TRANSCRIPTION" | "SUMMARY" | "KEYWORDS" | "CLASSIFICATION" | "OCR";

/** Per-stage outcome recorded to `AiResult` and folded into the final state. */
export interface StageOutcome {
  stage: AiStageName;
  ok: boolean;
  payload?: unknown;
  errorCode?: string;
  errorMessage?: string;
}

export interface RunOutcome {
  final: "READY" | "FAILED" | "CANCELLED";
  partial: boolean;
  errorCode?: string;
  errorMessage?: string;
}

/** Result of a cancellation request against one media file (ADR-006 §18). */
export type CancelOutcome = "REQUESTED" | "NOT_FOUND" | "NOT_PROCESSING";

export type AiRunnerDatabase = Pick<PrismaClient, "mediaFile" | "aiResult">;

/** Injectable sleep so polling/backoff is deterministic in tests (TESTING.md §2). */
export type SleepFn = (milliseconds: number) => Promise<void>;

const defaultSleep: SleepFn = (milliseconds) =>
  milliseconds <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, milliseconds));

const RETRY_BACKOFF_CAP_MS = 60_000;

export interface AiRunnerOptions {
  prisma: AiRunnerDatabase;
  adapter: AiProcessorAdapter;
  /** Absolute media root; relative paths are resolved inside it (ADR-006 §9). */
  storageRoot: string;
  concurrency?: number;
  maxRetries?: number;
  retryBackoffMs?: number;
  pollIntervalMs?: number;
  stageTimeoutMs?: number;
  jobDeadlineMs?: number;
  modelSize?: string;
  language?: string;
  sleep?: SleepFn;
  /** Injectable clock for deterministic deadline math in tests. */
  now?: () => number;
}
/**
 * Deterministic external job identity (ADR-006 §3): derivable from the media id
 * and the attempt number, so the same logical job is recognizable after a
 * restart. TMIP mints it BEFORE dispatch and sends it as the processor's
 * `asset_id`.
 */
export function buildExternalJobId(mediaFileId: string, attempt: number): string {
  return `${mediaFileId}:${attempt}`;
}

export class AiRunner {
  private readonly prisma: AiRunnerDatabase;
  private readonly adapter: AiProcessorAdapter;
  private readonly storageRoot: string;
  private readonly concurrency: number;
  private readonly maxRetries: number;
  private readonly retryBackoffMs: number;
  private readonly pollIntervalMs: number;
  private readonly stageTimeoutMs: number;
  private readonly jobDeadlineMs: number;
  private readonly modelSize: string;
  private readonly language: string;
  private readonly sleep: SleepFn;
  private readonly now: () => number;
  /**
   * In-flight jobs by media id, used ONLY to abort local work quickly
   * (ADR-006 §18). This is NOT the source of truth: the durable intent lives in
   * `MediaFile.aiCancelRequestedAt`, so a restart or a lost map cannot lose a
   * cancellation.
   */
  private readonly inFlight = new Map<string, AbortController>();

  public constructor(options: AiRunnerOptions) {
    this.prisma = options.prisma;
    this.adapter = options.adapter;
    this.storageRoot = options.storageRoot;
    this.concurrency = Math.max(1, options.concurrency ?? 1);
    this.maxRetries = options.maxRetries ?? 2;
    this.retryBackoffMs = options.retryBackoffMs ?? 5_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 10_000;
    this.stageTimeoutMs = options.stageTimeoutMs ?? 900_000;
    this.jobDeadlineMs = options.jobDeadlineMs ?? 5_400_000;
    this.modelSize = options.modelSize ?? "medium";
    this.language = options.language ?? "id";
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Request cancellation of the AI job for one media file (ADR-006 §18).
   *
   * Durability first: the intent is persisted with a conditional update so it
   * only applies to a row that is genuinely PROCESSING. Only then does the
   * in-memory controller abort local work. The terminal `CANCELLED` state is
   * NOT written here — the runner observes the intent, stops before the next
   * stage, keeps already-succeeded stages, and finalizes `CANCELLED` itself.
   *
   * Idempotent: a repeated request on a row that already carries the intent
   * returns `REQUESTED` without error. Returns `NOT_PROCESSING` when the row is
   * not in flight, and `NOT_FOUND` when the media does not exist.
   */
  public async cancel(mediaFileId: string): Promise<CancelOutcome> {
    const persisted = await this.prisma.mediaFile.updateMany({
      where: { id: mediaFileId, aiStatus: "PROCESSING" },
      data: { aiCancelRequestedAt: new Date() },
    });

    if (persisted.count === 1) {
      // Abort local work fast. The durable intent is what actually finalizes
      // the row, so a missing controller (e.g. this process did not start the
      // job) is still a successful request.
      this.inFlight.get(mediaFileId)?.abort();
      // Best-effort remote stop: aborting the HTTP call does NOT stop the
      // processor's whisper computation (ADR-006 §18 limitation), so ask the
      // processor to cancel cooperatively between segments. The asset id is
      // TMIP's `aiExternalJobId`, which the runner sent as the processor's
      // `asset_id` (see `runTranscription` / adapter `startTranscription`).
      await this.cancelRemoteTranscription(mediaFileId);
      return "REQUESTED";
    }

    const existing = await this.prisma.mediaFile.findUnique({
      where: { id: mediaFileId },
      select: { aiStatus: true, aiCancelRequestedAt: true },
    });
    if (existing === null) return "NOT_FOUND";
    // A row that is PROCESSING but already carries the intent is still a valid,
    // idempotent request (the conditional update simply matched nothing new).
    if (existing.aiStatus === "PROCESSING" && existing.aiCancelRequestedAt !== null) {
      return "REQUESTED";
    }
    return "NOT_PROCESSING";
  }

  /**
   * Best-effort cooperative cancel of the processor-side transcription job.
   * Failures are swallowed: cancellation of the TMIP row is driven by the
   * durable intent, not by whether the remote call succeeded.
   */
  private async cancelRemoteTranscription(mediaFileId: string): Promise<void> {
    try {
      const row = await this.prisma.mediaFile.findUnique({
        where: { id: mediaFileId },
        select: { aiExternalJobId: true },
      });
      if (row?.aiExternalJobId !== null && row?.aiExternalJobId !== undefined) {
        await this.adapter.cancelTranscription(row.aiExternalJobId);
      }
    } catch {
      // Ignore: the durable intent + local abort still stop TMIP's processing.
    }
  }

  /**
   * Drain up to `concurrency` PENDING rows once. Returns how many rows were
   * claimed. Safe to call repeatedly; a row is processed by at most one caller.
   */
  public async drainOnce(): Promise<number> {
    const claimed = await this.claimPending(this.concurrency);
    await Promise.all(claimed.map((id) => this.processClaimed(id)));
    return claimed.length;
  }

  /**
   * Atomically claim up to `limit` PENDING rows by flipping them to PROCESSING.
   * The per-candidate `updateMany` is the compare-and-set: a row another caller
   * already flipped returns count 0 and is skipped (no double processing).
   *
   * Candidates are restricted to `status = ACTIVE` and `metadataStatus = READY`
   * (Plan 006 §5): technical metadata always precedes AI (ARCHITECTURE.md §46),
   * and a MISSING file is not worth enriching. The claim resets `aiAttempt = 0`
   * and mints the deterministic `aiExternalJobId` for attempt 0.
   */
  public async claimPending(limit: number): Promise<string[]> {
    const candidates = await this.prisma.mediaFile.findMany({
      where: { aiStatus: "PENDING", status: "ACTIVE", metadataStatus: "READY" },
      orderBy: { updatedAt: "asc" },
      take: Math.max(limit * 4, limit),
      select: { id: true },
    });

    const claimed: string[] = [];
    for (const candidate of candidates) {
      if (claimed.length >= limit) break;
      const result = await this.prisma.mediaFile.updateMany({
        where: { id: candidate.id, aiStatus: "PENDING" },
        data: {
          aiStatus: "PROCESSING",
          aiAttempt: 0,
          aiExternalJobId: buildExternalJobId(candidate.id, 0),
          aiErrorCode: null,
          aiErrorMessage: null,
          aiErrorAt: null,
          // A fresh claim starts with no cancellation intent (ADR-006 §18).
          aiCancelRequestedAt: null,
        },
      });
      if (result.count === 1) {
        claimed.push(candidate.id);
      }
    }
    return claimed;
  }

  /**
   * Process a single media file end-to-end. Exposed so the manual reprocess
   * path and tests can drive one file deterministically.
   */
  public async process(mediaFileId: string): Promise<RunOutcome | "NOT_FOUND"> {
    const row = await this.prisma.mediaFile.findUnique({
      where: { id: mediaFileId },
      select: { id: true },
    });
    if (row === null) return "NOT_FOUND";
    return this.runPipeline(mediaFileId);
  }

  private async processClaimed(mediaFileId: string): Promise<void> {
    // Register an abort handle for fast local stop (ADR-006 §18). The durable
    // intent in the DB is authoritative; this only lets `cancel()` interrupt an
    // in-flight HTTP call without waiting for its timeout.
    const controller = new AbortController();
    this.inFlight.set(mediaFileId, controller);
    try {
      await this.runPipeline(mediaFileId, controller.signal);
    } catch (error) {
      // A crash here must not leave the row stuck in PROCESSING; fail fast with
      // a clear cause (the restart sweep is the backstop for a process death).
      // Guarded so a late crash cannot overwrite a terminal CANCELLED/READY.
      await this.prisma.mediaFile.updateMany({
        where: { id: mediaFileId, aiStatus: "PROCESSING" },
        data: {
          aiStatus: "FAILED",
          aiErrorCode: AI_STAGE_CODES.INTERRUPTED,
          aiErrorMessage: error instanceof Error ? error.message : String(error),
          aiErrorAt: new Date(),
        },
      });
    } finally {
      this.inFlight.delete(mediaFileId);
    }
  }

  /** True when a durable cancellation intent exists for this row (ADR-006 §18). */
  private async isCancelRequested(mediaFileId: string): Promise<boolean> {
    const row = await this.prisma.mediaFile.findUnique({
      where: { id: mediaFileId },
      select: { aiCancelRequestedAt: true, aiStatus: true },
    });
    if (row === null) return false;
    // A row that is no longer PROCESSING cannot be cancelled further.
    return row.aiStatus === "PROCESSING" && row.aiCancelRequestedAt !== null;
  }

  /**
   * True when processing should stop: the local abort fired OR a durable
   * cancellation intent is present. A method (not an inline check) so the
   * result is not narrowed by TypeScript control-flow analysis across calls.
   */
  private async isStopped(mediaFileId: string, signal?: AbortSignal): Promise<boolean> {
    if (signal !== undefined && signal.aborted) return true;
    return this.isCancelRequested(mediaFileId);
  }

  /** True while the row is still owned by a live claim (PROCESSING). */
  private async isStillProcessing(mediaFileId: string): Promise<boolean> {
    const row = await this.prisma.mediaFile.findUnique({
      where: { id: mediaFileId },
      select: { aiStatus: true },
    });
    return row?.aiStatus === "PROCESSING";
  }

  /**
   * Finalize a cancelled run: keep already-persisted stage rows, write the
   * terminal CANCELLED state, and record the cancellation time. Guarded by
   * `aiStatus = PROCESSING` so a late worker cannot resurrect a row that was
   * already finalized (ADR-006 §18).
   */
  private async finalizeCancelled(mediaFileId: string): Promise<RunOutcome> {
    const outcome: RunOutcome = {
      final: "CANCELLED",
      partial: true,
      errorCode: AI_STAGE_CODES.CANCELLED,
      errorMessage: "AI processing was cancelled",
    };
    await this.prisma.mediaFile.updateMany({
      where: { id: mediaFileId, aiStatus: "PROCESSING" },
      data: {
        aiStatus: "CANCELLED",
        aiPartial: true,
        aiProcessedAt: null,
        aiErrorCode: AI_STAGE_CODES.CANCELLED,
        aiErrorMessage: "AI processing was cancelled",
        aiErrorAt: new Date(),
      },
    });
    return outcome;
  }

  /**
   * Run the pipeline with bounded in-claim retry (ADR-006 §6, Plan 006 §5).
   * Stays PROCESSING across retries; only a terminal outcome is persisted.
   *
   * Cancellation is checked before every stage, before every retry, and before
   * finalizing (ADR-006 §18). Already-succeeded stages are left in place.
   */
  private async runPipeline(
    mediaFileId: string,
    signal?: AbortSignal,
  ): Promise<RunOutcome> {
    const row = await this.prisma.mediaFile.findUnique({
      where: { id: mediaFileId },
      select: { id: true, relativePath: true, aiAttempt: true, durationSeconds: true },
    });
    if (row === null) {
      return { final: "FAILED", partial: false, errorCode: AI_STAGE_CODES.FILE_NOT_FOUND, errorMessage: "Media file not found" };
    }

    // Resolve + contain the path INSIDE TMIP (ADR-006 §9); never send a client
    // path. A containment failure is PERMANENT (config/DB inconsistency).
    let absolutePath: string;
    try {
      absolutePath = resolveInsideRoot(this.storageRoot, row.relativePath);
    } catch (error) {
      return this.finalize(mediaFileId, {
        final: "FAILED",
        partial: false,
        errorCode: AI_STAGE_CODES.PATH_INVALID,
        errorMessage:
          error instanceof PathContainmentError
            ? error.message
            : error instanceof Error
              ? error.message
              : String(error),
      });
    }

    // Retry counters are per the whole claim (ADR-006 §6): `maxRetries` bounds
    // the number of extra attempts any single stage may make.
    const attemptsUsed = { value: row.aiAttempt };

    // ── Stage 1: transcription (async, polled) ──────────────────────────
    if (await this.isCancelRequested(mediaFileId)) {
      return this.finalizeCancelled(mediaFileId);
    }
    const transcription = await this.runStageWithRetry(
      mediaFileId,
      attemptsUsed,
      (deadline, externalJobId) => this.runTranscription(mediaFileId, absolutePath, externalJobId, deadline, signal),
      signal,
    );
    const stages: StageOutcome[] = [transcription];

    // ── Stage 2: LLM summary/keywords/classification (one call, three rows) ─
    if (transcription.ok && !(await this.isCancelRequested(mediaFileId))) {
      const transcriptText = extractTranscriptText(transcription.payload);
      const llmOutcome = await this.runLlmWithRetry(mediaFileId, transcriptText, attemptsUsed, signal);
      stages.push(...llmOutcome);
    }

    // ── Stage 3: OCR (independent of transcription success) ─────────────
    if (await this.isCancelRequested(mediaFileId)) {
      return this.finalizeCancelled(mediaFileId);
    }
    const ocr = await this.runStageWithRetry(
      mediaFileId,
      attemptsUsed,
      (deadline) => this.runOcr(absolutePath, deadline, signal, row.durationSeconds ?? undefined),
      signal,
    );
    stages.push(ocr);

    // Cancellation may have arrived while OCR ran: do not finalize as
    // READY/FAILED over a stop request.
    if (await this.isCancelRequested(mediaFileId)) {
      return this.finalizeCancelled(mediaFileId);
    }

    // Fold (ADR-006 §7/§8): at least one READY -> READY (partial if not all);
    // none READY -> FAILED with the first non-transient cause.
    const anySucceeded = stages.some((stage) => stage.ok);
    const allSucceeded = stages.every((stage) => stage.ok);

    if (allSucceeded) {
      return this.finalize(mediaFileId, { final: "READY", partial: false });
    }

    const failure = stages.find((stage) => !stage.ok);
    return this.finalize(mediaFileId, {
      final: anySucceeded ? "READY" : "FAILED",
      partial: anySucceeded,
      errorCode: failure?.errorCode,
      errorMessage: failure?.errorMessage,
    });
  }

  /**
   * Run one stage with bounded retry (ADR-006 §6). Retries are per-stage: a
   * TRANSIENT failure is retried while the shared claim budget allows, without
   * re-running stages that already succeeded (avoids duplicate expensive work).
   */
  private async runStageWithRetry(
    mediaFileId: string,
    attemptsUsed: { value: number },
    run: (deadline: number, externalJobId: string) => Promise<StageOutcome>,
    signal?: AbortSignal,
  ): Promise<StageOutcome> {
    for (;;) {
      // A fresh AI_JOB_DEADLINE_MS per attempt. ADR-006 §13 classifies a
      // deadline breach as TRANSIENT so `aiAttempt` can bound repeated breaches;
      // a shared absolute deadline would make it terminal on first breach and
      // contradict that decision.
      const deadline = this.now() + this.jobDeadlineMs;
      const externalJobId = buildExternalJobId(mediaFileId, attemptsUsed.value);
      const outcome = await run(deadline, externalJobId);

      const retryable =
        !outcome.ok &&
        outcome.errorCode !== undefined &&
        isRetryableAiFailure(outcome.errorCode) &&
        attemptsUsed.value < this.maxRetries;

      if (!retryable) {
        await this.persistStageIfOwned(mediaFileId, outcome);
        return outcome;
      }

      // Do not start a retry once cancellation is requested.
      if (signal?.aborted === true || (await this.isCancelRequested(mediaFileId))) {
        await this.persistStageIfOwned(mediaFileId, outcome);
        return outcome;
      }

      // Consume one unit of the claim's retry budget, record it, back off, and
      // re-run THIS stage only (the next attempt gets its own deadline).
      attemptsUsed.value += 1;
      await this.persistAttemptProgress(mediaFileId, attemptsUsed.value);
      await this.waitBeforeRetry(attemptsUsed.value);
    }
  }

  /** LLM stages share a single `/summarize` call, so retry is shared too. */
  private async runLlmWithRetry(
    mediaFileId: string,
    transcriptText: string,
    attemptsUsed: { value: number },
    signal?: AbortSignal,
  ): Promise<StageOutcome[]> {
    for (;;) {
      const deadline = this.now() + this.jobDeadlineMs;
      const outcomes = await this.runLlmStages(transcriptText, deadline, signal);
      const failure = outcomes.find((outcome) => !outcome.ok);

      const retryable =
        failure !== undefined &&
        failure.errorCode !== undefined &&
        isRetryableAiFailure(failure.errorCode) &&
        attemptsUsed.value < this.maxRetries;

      if (!retryable) {
        for (const outcome of outcomes) {
          await this.persistStageIfOwned(mediaFileId, outcome);
        }
        return outcomes;
      }

      attemptsUsed.value += 1;
      await this.persistAttemptProgress(mediaFileId, attemptsUsed.value);
      await this.waitBeforeRetry(attemptsUsed.value);
    }
  }

  private async runTranscription(
    mediaFileId: string,
    absolutePath: string,
    externalJobId: string,
    deadline: number,
    signal?: AbortSignal,
  ): Promise<StageOutcome> {
    try {
      await this.adapter.startTranscription({
        absolutePath,
        externalJobId,
        modelSize: this.modelSize,
        language: this.language,
        signal,
      });
    } catch (error) {
      return this.stageFailure("TRANSCRIPTION", error);
    }

    // Poll the processor's status until terminal or the job deadline elapses.
    for (;;) {
      // Cancellation must break the poll loop, not just the HTTP call: the
      // remote job is stopped via `/transcribe/cancel`, so a later status would
      // read NOT_FOUND and the re-dispatch branch below would restart
      // transcription — the opposite of stopping (ADR-006 §18).
      if (await this.isStopped(mediaFileId, signal)) {
        return {
          stage: "TRANSCRIPTION",
          ok: false,
          errorCode: AI_STAGE_CODES.CANCELLED,
          errorMessage: "Transcription stopped by cancellation request",
        };
      }

      if (this.now() >= deadline) {
        return {
          stage: "TRANSCRIPTION",
          ok: false,
          errorCode: AI_STAGE_CODES.DEADLINE_EXCEEDED,
          errorMessage: "AI job deadline exceeded while awaiting transcription",
        };
      }

      let status;
      try {
        status = await this.adapter.transcriptionStatus(externalJobId, signal);
      } catch (error) {
        return this.stageFailure("TRANSCRIPTION", error);
      }

      if (status.status === "COMPLETED") {
        return { stage: "TRANSCRIPTION", ok: true, payload: status.result };
      }
      if (status.status === "FAILED") {
        return {
          stage: "TRANSCRIPTION",
          ok: false,
          errorCode: AI_STAGE_CODES.STAGE_FAILED,
          errorMessage: status.error,
        };
      }
      if (status.status === "NOT_FOUND") {
        // A NOT_FOUND can mean either (a) a restart lost the job, or (b) our
        // own cooperative cancel just removed it. Re-check cancellation BEFORE
        // re-dispatching, or a cancel would restart transcription (§18).
        if (await this.isStopped(mediaFileId, signal)) {
          return {
            stage: "TRANSCRIPTION",
            ok: false,
            errorCode: AI_STAGE_CODES.CANCELLED,
            errorMessage: "Transcription stopped by cancellation request",
          };
        }
        // The processor does not know this job (restarted mid-flight, or a
        // re-dispatch after a TMIP restart). Re-dispatch and keep polling.
        try {
          await this.adapter.startTranscription({
            absolutePath,
            externalJobId,
            modelSize: this.modelSize,
            language: this.language,
            signal,
          });
        } catch (error) {
          return this.stageFailure("TRANSCRIPTION", error);
        }
      }

      try {
        await this.sleep(this.pollIntervalMs);
      } catch {
        return {
          stage: "TRANSCRIPTION",
          ok: false,
          errorCode: AI_STAGE_CODES.DEADLINE_EXCEEDED,
          errorMessage: "Transcription polling was aborted",
        };
      }
    }
  }

  private async runLlmStages(
    transcriptText: string,
    deadline: number,
    signal?: AbortSignal,
  ): Promise<StageOutcome[]> {
    if (this.now() >= deadline) {
      return (["SUMMARY", "KEYWORDS", "CLASSIFICATION"] as const).map((stage) => ({
        stage,
        ok: false,
        errorCode: AI_STAGE_CODES.DEADLINE_EXCEEDED,
        errorMessage: "AI job deadline exceeded before LLM stages",
      }));
    }

    try {
      const result = await this.adapter.summarize(transcriptText, {
        timeoutMs: this.stageTimeoutMs,
        signal,
      });
      return [
        { stage: "SUMMARY", ok: true, payload: { summary: result.summary } },
        { stage: "KEYWORDS", ok: true, payload: { keywords: result.keywords } },
        { stage: "CLASSIFICATION", ok: true, payload: { category: result.category } },
      ];
    } catch (error) {
      const failure = failureFromError(error);
      return (["SUMMARY", "KEYWORDS", "CLASSIFICATION"] as const).map((stage) => ({
        stage,
        ok: false,
        errorCode: failure.errorCode,
        errorMessage: failure.errorMessage,
      }));
    }
  }

  private async runOcr(
    absolutePath: string,
    deadline: number,
    signal?: AbortSignal,
    durationSec?: number,
  ): Promise<StageOutcome> {
    if (this.now() >= deadline) {
      return {
        stage: "OCR",
        ok: false,
        errorCode: AI_STAGE_CODES.DEADLINE_EXCEEDED,
        errorMessage: "AI job deadline exceeded before OCR",
      };
    }
    try {
      const result = await this.adapter.ocr({
        absolutePath,
        // Fallback frame when duration is unknown; the processor samples
        // multiple frames when `durationSec` is valid (ADR-006 §17).
        timestampSec: 0,
        durationSec,
        timeoutMs: this.stageTimeoutMs,
        signal,
      });
      return { stage: "OCR", ok: true, payload: result };
    } catch (error) {
      return this.stageFailure("OCR", error);
    }
  }

  private stageFailure(stage: AiStageName, error: unknown): StageOutcome {
    const failure = failureFromError(error);
    return { stage, ok: false, errorCode: failure.errorCode, errorMessage: failure.errorMessage };
  }

  /**
   * Persist a terminal outcome, guarded by `aiStatus = PROCESSING` (ADR-006
   * §18). The guard makes the write a compare-and-set: a worker whose job was
   * cancelled and already finalized as `CANCELLED` cannot overwrite that
   * terminal state with READY/FAILED.
   */
  private async finalize(mediaFileId: string, outcome: RunOutcome): Promise<RunOutcome> {
    const succeeded = outcome.final === "READY";
    await this.prisma.mediaFile.updateMany({
      where: { id: mediaFileId, aiStatus: "PROCESSING" },
      data: {
        aiStatus: outcome.final,
        aiPartial: outcome.partial,
        aiProcessedAt: succeeded ? new Date() : null,
        aiErrorCode: outcome.errorCode ?? null,
        aiErrorMessage: outcome.errorMessage ?? null,
        aiErrorAt: outcome.errorCode !== undefined ? new Date() : null,
        // A finalized run has no pending cancellation intent.
        aiCancelRequestedAt: null,
      },
    });
    return outcome;
  }

  /**
   * Record retry progress without changing aiStatus. The row must remain
   * PROCESSING for the whole retry sequence so no scan or reprocess can claim it
   * (same invariant as `ExtractionRunner.persistRetryProgress`). Observability
   * only; a failure here must not cancel the retry about to run.
   */
  private async persistAttemptProgress(mediaFileId: string, attempt: number): Promise<void> {
    try {
      await this.prisma.mediaFile.update({
        where: { id: mediaFileId },
        data: { aiAttempt: attempt, aiExternalJobId: buildExternalJobId(mediaFileId, attempt) },
      });
    } catch {
      // Non-terminal observability write; continue retrying regardless.
    }
  }

  private async waitBeforeRetry(attempt: number): Promise<void> {
    const backoff = Math.min(this.retryBackoffMs * 2 ** (attempt - 1), RETRY_BACKOFF_CAP_MS);
    try {
      await this.sleep(backoff);
    } catch {
      // Retry without the pause; the bound still limits total attempts.
    }
  }

  /** Upsert a stage row keyed on `(mediaFileId, stage)` — idempotent by design. */
  private async persistStage(mediaFileId: string, outcome: StageOutcome): Promise<void> {
    const attemptedAt = new Date();
    await this.prisma.aiResult.upsert({
      where: { mediaFileId_stage: { mediaFileId, stage: outcome.stage } },
      create: {
        mediaFileId,
        stage: outcome.stage,
        status: outcome.ok ? "READY" : "FAILED",
        payload: outcome.ok ? toJson(outcome.payload) : undefined,
        errorCode: outcome.ok ? null : outcome.errorCode ?? null,
        errorMessage: outcome.ok ? null : outcome.errorMessage ?? null,
        attemptedAt,
      },
      update: {
        status: outcome.ok ? "READY" : "FAILED",
        payload: outcome.ok ? toJson(outcome.payload) : undefined,
        errorCode: outcome.ok ? null : outcome.errorCode ?? null,
        errorMessage: outcome.ok ? null : outcome.errorMessage ?? null,
        attemptedAt,
      },
    });
  }

  /**
   * Persist a stage outcome, honoring cancellation (ADR-006 §18):
   *   - a SUCCEEDED stage is always kept — partial results are the point of a
   *     stop, and the row is still PROCESSING at this point;
   *   - a FAILED stage is dropped when a cancellation was requested, because the
   *     failure is an artifact of aborting (not a real defect) and would
   *     otherwise be recorded as a misleading per-stage error;
   *   - once the row is no longer PROCESSING (already finalized elsewhere) no
   *     write happens at all, so a late worker cannot add rows to a terminal run.
   */
  private async persistStageIfOwned(mediaFileId: string, outcome: StageOutcome): Promise<void> {
    if (!(await this.isStillProcessing(mediaFileId))) return;
    if (!outcome.ok && (await this.isCancelRequested(mediaFileId))) return;
    await this.persistStage(mediaFileId, outcome);
  }
}

function toJson(value: unknown) {
  return value === undefined ? undefined : (value as never);
}

function extractTranscriptText(payload: unknown): string {
  if (payload !== null && typeof payload === "object" && "full_text" in payload) {
    const text = (payload as { full_text?: unknown }).full_text;
    if (typeof text === "string") return text;
  }
  return "";
}

function failureFromError(error: unknown): { errorCode: string; errorMessage: string } {
  if (error instanceof AiProcessorError) {
    return { errorCode: error.code, errorMessage: error.message };
  }
  // Unknown errors are a deterministic stage failure (PERMANENT via fail-closed
  // classification), not retried blindly (AGENTS.md §19).
  return {
    errorCode: AI_STAGE_CODES.STAGE_FAILED,
    errorMessage: error instanceof Error ? error.message : String(error),
  };
}
