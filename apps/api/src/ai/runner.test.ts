import { describe, expect, it } from "vitest";
import {
  AiProcessorError,
  AI_PROCESSOR_ERROR_CODES,
  type AiProcessorAdapter,
  type TranscribeStatus,
  type TranscriptionResult,
  type SummarizeResult,
  type OcrResult,
} from "./adapter.js";
import { AiRunner, buildExternalJobId, type AiRunnerDatabase } from "./runner.js";

interface MediaRow {
  id: string;
  relativePath: string;
  status: string;
  metadataStatus: string;
  aiStatus: string;
  aiPartial: boolean;
  aiAttempt: number;
  aiExternalJobId: string | null;
  aiErrorCode: string | null;
  aiErrorMessage: string | null;
  aiErrorAt: Date | null;
  aiProcessedAt: Date | null;
  aiCancelRequestedAt: Date | null;
  durationSeconds?: number | null;
  updatedAt: Date;
}

interface ResultRow {
  mediaFileId: string;
  stage: string;
  status: string;
  payload: unknown;
  errorCode: string | null;
  errorMessage: string | null;
  attemptedAt: Date;
}

function makeMedia(id: string, overrides: Partial<MediaRow> = {}): MediaRow {
  return {
    id,
    relativePath: `${id}.mp4`,
    status: "ACTIVE",
    metadataStatus: "READY",
    aiStatus: "PENDING",
    aiPartial: false,
    aiAttempt: 0,
    aiExternalJobId: null,
    aiErrorCode: null,
    aiErrorMessage: null,
    aiErrorAt: null,
    aiProcessedAt: null,
    aiCancelRequestedAt: null,
    updatedAt: new Date("2026-10-07T00:00:00Z"),
    ...overrides,
  };
}

/**
 * Minimal in-memory Prisma stand-in for the AiRunner. Models the claim CAS
 * (`updateMany` filtered on aiStatus) and the per-stage upsert keyed on
 * `(mediaFileId, stage)` so idempotency is actually exercised.
 */
function createFakePrisma(media: MediaRow[]) {
  const results: ResultRow[] = [];
  const prisma = {
    mediaFile: {
      findMany: async ({
        where,
        take,
      }: {
        where: { aiStatus?: string; status?: string; metadataStatus?: string };
        take?: number;
      }) => {
        const filtered = media.filter(
          (row) =>
            (where.aiStatus === undefined || row.aiStatus === where.aiStatus) &&
            (where.status === undefined || row.status === where.status) &&
            (where.metadataStatus === undefined || row.metadataStatus === where.metadataStatus),
        );
        return filtered.slice(0, take ?? filtered.length);
      },
      findUnique: async ({ where }: { where: { id: string } }) =>
        media.find((row) => row.id === where.id) ?? null,
      updateMany: async ({
        where,
        data,
      }: {
        where: {
          id: string;
          aiStatus?: string | { in: string[] };
          aiCancelRequestedAt?: { not: null } | null;
        };
        data: Partial<MediaRow>;
      }) => {
        const row = media.find((entry) => entry.id === where.id);
        if (row === undefined) return { count: 0 };
        // Model Prisma's filters faithfully so cancellation/claim CAS logic is
        // genuinely exercised rather than trivially matching.
        const statusMatches =
          where.aiStatus === undefined
            ? true
            : typeof where.aiStatus === "string"
              ? row.aiStatus === where.aiStatus
              : where.aiStatus.in.includes(row.aiStatus);
        if (!statusMatches) return { count: 0 };
        if (where.aiCancelRequestedAt !== undefined) {
          const isNull = row.aiCancelRequestedAt === null;
          if (where.aiCancelRequestedAt === null && !isNull) return { count: 0 };
          if (
            typeof where.aiCancelRequestedAt === "object" &&
            where.aiCancelRequestedAt !== null &&
            "not" in where.aiCancelRequestedAt &&
            isNull
          ) {
            return { count: 0 };
          }
        }
        Object.assign(row, data);
        return { count: 1 };
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<MediaRow> }) => {
        const row = media.find((entry) => entry.id === where.id);
        if (row === undefined) throw new Error(`unknown media ${where.id}`);
        Object.assign(row, data);
        return row;
      },
    },
    aiResult: {
      upsert: async ({
        where,
        create,
        update,
      }: {
        where: { mediaFileId_stage: { mediaFileId: string; stage: string } };
        create: ResultRow;
        update: Partial<ResultRow>;
      }) => {
        const key = where.mediaFileId_stage;
        const existing = results.find(
          (row) => row.mediaFileId === key.mediaFileId && row.stage === key.stage,
        );
        if (existing === undefined) {
          results.push({ ...create });
          return create;
        }
        Object.assign(existing, update);
        return existing;
      },
    },
  };
  return { prisma: prisma as unknown as AiRunnerDatabase, media, results };
}

const transcriptResult: TranscriptionResult = {
  segments: [{ start: 0, end: 1, text: "halo" }],
  full_text: "halo dunia",
  duration_sec: 1,
  language: "id",
};
const summarizeResult: SummarizeResult = { summary: "ringkasan", keywords: ["a", "b"], category: "Berita" };
const ocrResult: OcrResult = { raw_text: "NAMA", presenter: { name: "A", role: "Host" } };

/** Configurable fake adapter: each stage's behaviour is set per test. */
class FakeAdapter implements AiProcessorAdapter {
  public startCalls = 0;
  public statusCalls = 0;
  public startArgs: { absolutePath: string; externalJobId: string; modelSize: string; language: string }[] = [];

  public constructor(
    private readonly behavior: {
      start?: () => Promise<void>;
      status?: () => Promise<TranscribeStatus>;
      summarize?: () => Promise<SummarizeResult>;
      ocr?: () => Promise<OcrResult>;
    } = {},
  ) {}

  public async health(): Promise<boolean> {
    return true;
  }

  public async startTranscription(input: {
    absolutePath: string;
    externalJobId: string;
    modelSize: string;
    language: string;
  }): Promise<{ jobId: string; alreadyRunning: boolean }> {
    this.startCalls += 1;
    this.startArgs.push(input);
    if (this.behavior.start) await this.behavior.start();
    return { jobId: "job", alreadyRunning: false };
  }

  public async transcriptionStatus(): Promise<TranscribeStatus> {
    this.statusCalls += 1;
    if (this.behavior.status) return this.behavior.status();
    return { status: "COMPLETED", result: transcriptResult };
  }

  public async transcriptionResult(): Promise<TranscriptionResult> {
    return transcriptResult;
  }

  public async cancelTranscription(): Promise<boolean> {
    return true;
  }

  public async summarize(): Promise<SummarizeResult> {
    if (this.behavior.summarize) return this.behavior.summarize();
    return summarizeResult;
  }

  public async ocr(): Promise<OcrResult> {
    if (this.behavior.ocr) return this.behavior.ocr();
    return ocrResult;
  }
}

function makeRunner(
  media: MediaRow[],
  adapter: AiProcessorAdapter,
  options: Partial<ConstructorParameters<typeof AiRunner>[0]> = {},
) {
  const fake = createFakePrisma(media);
  const runner = new AiRunner({
    prisma: fake.prisma,
    adapter,
    storageRoot: "/media",
    pollIntervalMs: 0,
    retryBackoffMs: 0,
    sleep: async () => {},
    ...options,
  });
  return { runner, ...fake };
}

describe("AiRunner claim", () => {
  it("claims a PENDING row, mints the deterministic external job id, and resets the attempt", async () => {
    const media = [makeMedia("m1", { aiAttempt: 3, aiStatus: "PENDING" })];
    const { runner, media: rows } = makeRunner(media, new FakeAdapter());

    const claimed = await runner.claimPending(1);

    expect(claimed).toEqual(["m1"]);
    expect(rows[0]).toMatchObject({
      aiStatus: "PROCESSING",
      aiAttempt: 0,
      aiExternalJobId: buildExternalJobId("m1", 0),
    });
  });

  it("does not claim rows that are not ACTIVE + metadata READY", async () => {
    const media = [
      makeMedia("missing", { status: "MISSING" }),
      makeMedia("pendingMeta", { metadataStatus: "PENDING" }),
    ];
    const { runner } = makeRunner(media, new FakeAdapter());
    await expect(runner.claimPending(5)).resolves.toEqual([]);
  });

  it("claim is a compare-and-set so a second claim of the same row returns nothing", async () => {
    // This asserts the CAS filter logic against the fake. True DB-level
    // concurrency is covered by ai/integration.test.ts (real Postgres), where
    // two concurrent drains start the processor only once.
    const media = [makeMedia("m1")];
    const { runner } = makeRunner(media, new FakeAdapter());
    const [a, b] = await Promise.all([runner.claimPending(1), runner.claimPending(1)]);
    expect(a.length + b.length).toBe(1);
  });
});

describe("AiRunner pipeline", () => {
  it("success writes all stage rows and finalizes READY", async () => {
    const media = [makeMedia("m1")];
    const { runner, results } = makeRunner(media, new FakeAdapter());
    await runner.claimPending(1);
    const outcome = await runner.process("m1");

    expect(outcome).toMatchObject({ final: "READY", partial: false });
    const stages = results.map((row) => row.stage).sort();
    expect(stages).toEqual(["CLASSIFICATION", "KEYWORDS", "OCR", "SUMMARY", "TRANSCRIPTION"]);
    expect(results.every((row) => row.status === "READY")).toBe(true);
    expect(media[0]).toMatchObject({ aiStatus: "READY", aiPartial: false });
    expect(media[0]?.aiProcessedAt).not.toBeNull();
  });

  it("upserts idempotently: running twice yields one row per stage", async () => {
    const media = [makeMedia("m1")];
    const { runner, results } = makeRunner(media, new FakeAdapter());
    await runner.claimPending(1);
    await runner.process("m1");
    await runner.process("m1");

    const stages = results.map((row) => row.stage);
    expect(stages).toHaveLength(5);
    expect(new Set(stages).size).toBe(5);
  });

  it("partial success: transcription OK, OCR fails -> READY + aiPartial + OCR FAILED", async () => {
    const media = [makeMedia("m1")];
    const adapter = new FakeAdapter({
      ocr: async () => {
        throw new AiProcessorError(AI_PROCESSOR_ERROR_CODES.BAD_REQUEST, "ocr rejected");
      },
    });
    const { runner, results } = makeRunner(media, adapter);
    await runner.claimPending(1);
    const outcome = await runner.process("m1");

    expect(outcome).toMatchObject({ final: "READY", partial: true });
    expect(media[0]).toMatchObject({ aiStatus: "READY", aiPartial: true });
    const ocr = results.find((row) => row.stage === "OCR");
    expect(ocr).toMatchObject({ status: "FAILED", errorCode: AI_PROCESSOR_ERROR_CODES.BAD_REQUEST });
    // Earlier successful stages are retained.
    expect(results.find((row) => row.stage === "TRANSCRIPTION")?.status).toBe("READY");
    expect(results.find((row) => row.stage === "SUMMARY")?.status).toBe("READY");
  });

  it("permanent failure on the root stage with no partial output -> FAILED with the code", async () => {
    const media = [makeMedia("m1")];
    const adapter = new FakeAdapter({
      start: async () => {
        throw new AiProcessorError(AI_PROCESSOR_ERROR_CODES.BAD_REQUEST, "bad request");
      },
      ocr: async () => {
        throw new AiProcessorError(AI_PROCESSOR_ERROR_CODES.BAD_REQUEST, "ocr rejected");
      },
    });
    const { runner } = makeRunner(media, adapter);
    await runner.claimPending(1);
    const outcome = await runner.process("m1");

    expect(outcome).toMatchObject({ final: "FAILED", partial: false });
    expect(media[0]?.aiStatus).toBe("FAILED");
    expect(media[0]?.aiErrorCode).toBe(AI_PROCESSOR_ERROR_CODES.BAD_REQUEST);
  });

  it("transient failure retries up to AI_MAX_RETRIES then fails", async () => {
    const media = [makeMedia("m1")];
    const adapter = new FakeAdapter({
      start: async () => {
        throw new AiProcessorError(AI_PROCESSOR_ERROR_CODES.UNAVAILABLE, "processor down");
      },
      ocr: async () => {
        throw new AiProcessorError(AI_PROCESSOR_ERROR_CODES.UNAVAILABLE, "processor down");
      },
    });
    const { runner } = makeRunner(media, adapter, { maxRetries: 2 });
    await runner.claimPending(1);
    const outcome = await runner.process("m1");

    expect(outcome).toMatchObject({ final: "FAILED" });
    expect(media[0]?.aiStatus).toBe("FAILED");
    // 1 initial attempt + 2 retries = 3 start calls.
    expect(adapter.startCalls).toBe(3);
    expect(media[0]?.aiAttempt).toBe(2);
  });

  it("a transient failure that succeeds on retry finalizes READY", async () => {
    const media = [makeMedia("m1")];
    let attempt = 0;
    const adapter = new FakeAdapter({
      start: async () => {
        attempt += 1;
        if (attempt === 1) {
          throw new AiProcessorError(AI_PROCESSOR_ERROR_CODES.UNAVAILABLE, "starting");
        }
      },
    });
    const { runner } = makeRunner(media, adapter, { maxRetries: 2 });
    await runner.claimPending(1);
    const outcome = await runner.process("m1");

    expect(outcome).toMatchObject({ final: "READY" });
    expect(adapter.startCalls).toBe(2);
  });

  it("deadline exceeded while polling is classified TRANSIENT and retried (ADR-006 §13)", async () => {
    const media = [makeMedia("m1")];
    const adapter = new FakeAdapter({ status: async () => ({ status: "RUNNING" }) });
    // now() advances by 1 hour each call, so every attempt's deadline is
    // exceeded at the first poll; the retry budget bounds the loop.
    let clock = 0;
    const { runner } = makeRunner(media, adapter, {
      maxRetries: 1,
      jobDeadlineMs: 1,
      now: () => {
        clock += 3_600_000;
        return clock;
      },
    });
    await runner.claimPending(1);
    const outcome = await runner.process("m1");

    expect(outcome).toMatchObject({ final: "FAILED" });
    expect(media[0]?.aiErrorCode).toBe("AI_DEADLINE_EXCEEDED");
    // 1 initial attempt + 1 retry = 2 attempts, then the bound is exhausted.
    expect(adapter.startCalls).toBe(2);
  });

  it("a processor NOT_FOUND status re-dispatches instead of failing", async () => {
    const media = [makeMedia("m1")];
    let statusCall = 0;
    const adapter = new FakeAdapter({
      status: async () => {
        statusCall += 1;
        return statusCall === 1 ? { status: "NOT_FOUND" } : { status: "COMPLETED", result: transcriptResult };
      },
    });
    const { runner } = makeRunner(media, adapter);
    await runner.claimPending(1);
    const outcome = await runner.process("m1");

    expect(outcome).toMatchObject({ final: "READY" });
    expect(adapter.startCalls).toBe(2);
  });

  it("rejects a path that escapes the storage root without calling the processor", async () => {
    const media = [makeMedia("m1", { relativePath: "../../etc/passwd" })];
    const adapter = new FakeAdapter();
    const { runner } = makeRunner(media, adapter);
    await runner.claimPending(1);
    const outcome = await runner.process("m1");

    expect(outcome).toMatchObject({ final: "FAILED" });
    expect(media[0]?.aiErrorCode).toBe("AI_PATH_INVALID");
    expect(adapter.startCalls).toBe(0);
  });

  it("sends the resolved absolute path (never a relative or client path)", async () => {
    const media = [makeMedia("m1", { relativePath: "News/report.mp4" })];
    const adapter = new FakeAdapter();
    const { runner } = makeRunner(media, adapter);
    await runner.claimPending(1);
    await runner.process("m1");

    expect(adapter.startArgs[0]?.absolutePath).toContain("report.mp4");
    expect(adapter.startArgs[0]?.externalJobId).toBe(buildExternalJobId("m1", 0));
  });

  it("drainOnce claims and processes a pending row", async () => {
    const media = [makeMedia("m1")];
    const { runner } = makeRunner(media, new FakeAdapter());
    await expect(runner.drainOnce()).resolves.toBe(1);
    expect(media[0]?.aiStatus).toBe("READY");
  });
});

describe("buildExternalJobId", () => {
  it("is deterministic for the same media + attempt", () => {
    expect(buildExternalJobId("abc", 0)).toBe("abc:0");
    expect(buildExternalJobId("abc", 0)).toBe(buildExternalJobId("abc", 0));
    expect(buildExternalJobId("abc", 1)).toBe("abc:1");
  });
});

describe("AiRunner cancellation (ADR-006 §18)", () => {
  it("persists the intent, does NOT claim a terminal state, and aborts fast", async () => {
    const media = [makeMedia("m1", { aiStatus: "PROCESSING", aiExternalJobId: "m1:0" })];
    const { runner, media: rows } = makeRunner(media, new FakeAdapter());

    const outcome = await runner.cancel("m1");

    expect(outcome).toBe("REQUESTED");
    // Durability: intent recorded, but status is still PROCESSING (the runner
    // finalizes CANCELLED, not the request handler).
    expect(rows[0]?.aiCancelRequestedAt).toBeInstanceOf(Date);
    expect(rows[0]?.aiStatus).toBe("PROCESSING");
  });

  it("returns NOT_FOUND for an unknown media id", async () => {
    const { runner } = makeRunner([makeMedia("m1")], new FakeAdapter());
    await expect(runner.cancel("nope")).resolves.toBe("NOT_FOUND");
  });

  it("returns NOT_PROCESSING when the row is not in flight and has no intent", async () => {
    const media = [makeMedia("m1", { aiStatus: "READY" })];
    const { runner } = makeRunner(media, new FakeAdapter());
    await expect(runner.cancel("m1")).resolves.toBe("NOT_PROCESSING");
  });

  it("is idempotent: a repeated request on PROCESSING + existing intent still returns REQUESTED", async () => {
    const media = [
      makeMedia("m1", { aiStatus: "PROCESSING", aiCancelRequestedAt: new Date() }),
    ];
    const { runner } = makeRunner(media, new FakeAdapter());
    await expect(runner.cancel("m1")).resolves.toBe("REQUESTED");
  });

  it("stops before the next stage and keeps already-succeeded stages", async () => {
    // Transcription succeeds; cancellation is requested while it runs, so the
    // LLM stage (summary/keywords/classification) must NOT be invoked.
    const media = [makeMedia("m1")];
    let cancelled = false;
    // Mutable holder so the adapter callback can reach the runner created below.
    const holder: { runner?: AiRunner } = {};
    const adapter = new FakeAdapter({
      status: async () => {
        // Simulate an operator cancelling mid-transcription.
        if (!cancelled) {
          cancelled = true;
          await holder.runner?.cancel("m1");
        }
        return { status: "COMPLETED", result: transcriptResult };
      },
      summarize: async () => {
        throw new Error("summarize must not run after cancellation");
      },
    });
    const made = makeRunner(media, adapter);
    holder.runner = made.runner;
    await made.runner.claimPending(1);
    const outcome = await made.runner.process("m1");

    expect(outcome).toMatchObject({ final: "CANCELLED" });
    expect(made.media[0]?.aiStatus).toBe("CANCELLED");
    expect(made.media[0]?.aiPartial).toBe(true);
    // The succeeded transcription row is preserved.
    expect(made.results.map((row) => row.stage)).toContain("TRANSCRIPTION");
    // The LLM stage never persisted.
    expect(made.results.map((row) => row.stage)).not.toContain("SUMMARY");

    // A late worker cannot resurrect the terminal state.
    expect(media[0]?.aiStatus).toBe("CANCELLED");
  });

  it("cancels before retry: a transient failure with budget left does not retry", async () => {
    const media = [makeMedia("m1")];
    let cancelled = false;
    const holder: { runner?: AiRunner } = {};
    const adapter = new FakeAdapter({
      start: async () => {
        if (!cancelled) {
          cancelled = true;
          await holder.runner?.cancel("m1");
        }
        throw new AiProcessorError(AI_PROCESSOR_ERROR_CODES.UNAVAILABLE, "processor down");
      },
    });
    const made = makeRunner(media, adapter, { maxRetries: 3 });
    holder.runner = made.runner;
    await made.runner.claimPending(1);
    await made.runner.process("m1");

    expect(made.media[0]?.aiStatus).toBe("CANCELLED");
    // No retry occurred despite remaining budget.
    expect(adapter.startCalls).toBe(1);
  });

  it("a late worker cannot overwrite CANCELLED (compare-and-set guard)", async () => {
    const media = [makeMedia("m1")];
    const made = makeRunner(media, new FakeAdapter());
    await made.runner.claimPending(1);

    // Cancel and let the runner finalize CANCELLED.
    await made.runner.cancel("m1");
    await made.runner.process("m1");
    expect(media[0]?.aiStatus).toBe("CANCELLED");

    // A stale worker now tries to finalize READY. The guard (aiStatus =
    // PROCESSING) must reject the write, so the terminal state stands.
    await made.runner.process("m1");
    expect(media[0]?.aiStatus).toBe("CANCELLED");
  });

  it("clears a stale intent when a row is freshly claimed", async () => {
    const media = [
      makeMedia("m1", { aiStatus: "PENDING", aiCancelRequestedAt: new Date() }),
    ];
    const { runner } = makeRunner(media, new FakeAdapter());
    await runner.claimPending(1);
    expect(media[0]?.aiCancelRequestedAt).toBeNull();
    expect(media[0]?.aiStatus).toBe("PROCESSING");
  });

  it("does NOT re-dispatch transcription after a cancel makes the remote job NOT_FOUND", async () => {
    // Regression (ADR-006 §18): `/transcribe/cancel` removes the remote job, so
    // the next status poll reads NOT_FOUND. Without a cancellation check in the
    // poll loop, the NOT_FOUND branch would restart transcription — the
    // opposite of stopping. The loop must stop instead.
    const media = [makeMedia("m1")];
    const holder: { runner?: AiRunner } = {};
    const adapter = new FakeAdapter({
      status: async () => {
        // First poll: cancel arrives, which removes the remote job.
        await holder.runner?.cancel("m1");
        return { status: "NOT_FOUND" };
      },
    });
    const made = makeRunner(media, adapter);
    holder.runner = made.runner;
    await made.runner.claimPending(1);
    await made.runner.process("m1");

    expect(made.media[0]?.aiStatus).toBe("CANCELLED");
    // startCalls === 1 (the initial dispatch only); no re-dispatch happened.
    expect(adapter.startCalls).toBe(1);
  });
});
