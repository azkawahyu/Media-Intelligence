import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPrismaClient } from "../db.js";
import { AiRunner, buildExternalJobId } from "./runner.js";
import { sweepInterruptedAiState } from "./startup.js";
import { createAiReprocessor } from "./reprocess.js";
import {
  AiProcessorError,
  AI_PROCESSOR_ERROR_CODES,
  type AiProcessorAdapter,
  type OcrResult,
  type SummarizeResult,
  type TranscribeStatus,
  type TranscriptionResult,
} from "./adapter.js";
import type { PrismaClient } from "@prisma/client";

/**
 * AI integration tests (TESTING.md, Plan 006 §8). These exercise the real
 * PostgreSQL schema end-to-end with a fake adapter: no processor, no ffprobe,
 * no Server B required (TESTING.md §28/§63). They prove claim/concurrency,
 * partial-result retention, restart recovery, path safety, source-media
 * read-only safety, and idempotency against actual DB constraints.
 */

const databaseUrl = process.env.TEST_DATABASE_URL ?? "postgresql://tmip:tmip@localhost:5432/tmip_test";
const prisma: PrismaClient = createPrismaClient(databaseUrl);
let storageId: string;
const temporaryRoots: string[] = [];

const transcriptResult: TranscriptionResult = {
  segments: [{ start: 0, end: 1.5, text: "selamat pagi" }],
  full_text: "selamat pagi indonesia",
  duration_sec: 1.5,
  language: "id",
};
const summarizeResult: SummarizeResult = { summary: "Ringkasan", keywords: ["pagi", "indonesia"], category: "Berita" };
const ocrResult: OcrResult = { raw_text: "BUDI SANTOSO", presenter: { name: "Budi Santoso", role: "Host" } };

/** Configurable fake processor adapter; behaviour per test. */
class FakeAiAdapter implements AiProcessorAdapter {
  public startCalls = 0;
  public startArgs: { absolutePath: string; externalJobId: string }[] = [];
  public behavior: {
    start?: () => Promise<void>;
    status?: () => Promise<TranscribeStatus>;
    summarize?: () => Promise<SummarizeResult>;
    ocr?: () => Promise<OcrResult>;
  } = {};

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
    this.startArgs.push({ absolutePath: input.absolutePath, externalJobId: input.externalJobId });
    if (this.behavior.start) await this.behavior.start();
    return { jobId: input.externalJobId, alreadyRunning: false };
  }

  public async transcriptionStatus(): Promise<TranscribeStatus> {
    if (this.behavior.status) return this.behavior.status();
    return { status: "COMPLETED", result: transcriptResult };
  }

  public async transcriptionResult(): Promise<TranscriptionResult> {
    return transcriptResult;
  }

  /** Overridable so tests can assert the exact remote asset id TMIP sends. */
  public cancelTranscription: (externalJobId: string) => Promise<boolean> = async () => true;

  public async summarize(): Promise<SummarizeResult> {
    if (this.behavior.summarize) return this.behavior.summarize();
    return summarizeResult;
  }

  public async ocr(): Promise<OcrResult> {
    if (this.behavior.ocr) return this.behavior.ocr();
    return ocrResult;
  }
}

function runner(root: string, adapter: AiProcessorAdapter, options: Partial<ConstructorParameters<typeof AiRunner>[0]> = {}) {
  return new AiRunner({
    prisma,
    adapter,
    storageRoot: root,
    pollIntervalMs: 0,
    retryBackoffMs: 0,
    sleep: async () => {},
    ...options,
  });
}

async function createRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "tmip-ai-"));
  temporaryRoots.push(root);
  return root;
}

async function createMediaFile(root: string, relativePath: string, overrides: Partial<{ aiStatus: string; metadataStatus: string }> = {}) {
  const absolutePath = path.join(root, relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, "media-bytes");
  const now = new Date();
  const scan = await prisma.scanJob.create({
    data: { storageId, status: "RUNNING", startedAt: now, discoveryCompletedAt: now },
  });
  const media = await prisma.mediaFile.create({
    data: {
      storageId,
      relativePath,
      filename: path.basename(relativePath),
      extension: path.extname(relativePath),
      fileSize: BigInt(11),
      modifiedAt: now,
      firstSeenAt: now,
      lastSeenAt: now,
      lastSeenScanId: scan.id,
      metadataStatus: (overrides.metadataStatus as never) ?? "READY",
      status: "ACTIVE",
      aiStatus: (overrides.aiStatus as never) ?? "PENDING",
    },
  });
  return media;
}

async function snapshotTree(root: string): Promise<Array<{ relativePath: string; sha256: string }>> {
  const files: Array<{ relativePath: string; sha256: string }> = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolutePath);
      else if (entry.isFile()) {
        const content = await readFile(absolutePath);
        files.push({
          relativePath: path.relative(root, absolutePath).split(path.sep).join("/"),
          sha256: createHash("sha256").update(content).digest("hex"),
        });
      }
    }
  }
  await visit(root);
  return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch (error) {
    throw new Error(
      `Dedicated test database is unreachable at TEST_DATABASE_URL (${databaseUrl}). ` +
        `Provision tmip_test and apply migrations before running integration tests: ${String(error)}`,
    );
  }
  await prisma.aiResult.deleteMany();
  await prisma.mediaFile.deleteMany();
  await prisma.scanJob.deleteMany();
  await prisma.storage.deleteMany();
  const storage = await prisma.storage.create({ data: { name: "AI Test Storage", rootPath: "/test-media" } });
  storageId = storage.id;
});

afterAll(async () => {
  await prisma.aiResult.deleteMany();
  await prisma.mediaFile.deleteMany();
  await prisma.scanJob.deleteMany();
  await prisma.storage.deleteMany();
  await prisma.$disconnect();
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

beforeEach(async () => {
  await prisma.aiResult.deleteMany();
  await prisma.mediaFile.deleteMany();
  await prisma.scanJob.deleteMany();
});

describe("AI end-to-end (real database)", () => {
  it("processes a media file to READY with five persisted stage rows", async () => {
    const root = await createRoot();
    await createMediaFile(root, "News/report.mp4");
    const adapter = new FakeAiAdapter();

    const claimed = await runner(root, adapter).drainOnce();
    expect(claimed).toBe(1);

    const media = await prisma.mediaFile.findFirstOrThrow();
    expect(media.aiStatus).toBe("READY");
    expect(media.aiPartial).toBe(false);
    expect(media.aiProcessedAt).not.toBeNull();

    const results = await prisma.aiResult.findMany({ where: { mediaFileId: media.id } });
    expect(results.map((row) => row.stage).sort()).toEqual([
      "CLASSIFICATION", "KEYWORDS", "OCR", "SUMMARY", "TRANSCRIPTION",
    ]);
    expect(results.every((row) => row.status === "READY")).toBe(true);
  });

  it("never writes to the source media tree", async () => {
    const root = await createRoot();
    await createMediaFile(root, "News/report.mp4");
    const before = await snapshotTree(root);

    await runner(root, new FakeAiAdapter()).drainOnce();

    const after = await snapshotTree(root);
    expect(after).toEqual(before);
  });

  it("is idempotent: a repeated drain does not duplicate AiResult rows", async () => {
    const root = await createRoot();
    await createMediaFile(root, "a.mp4");
    const aiRunner = runner(root, new FakeAiAdapter());

    await aiRunner.drainOnce();
    const media = await prisma.mediaFile.findFirstOrThrow();
    // Put the row back to PENDING and drain again (simulates a re-run).
    await prisma.mediaFile.update({ where: { id: media.id }, data: { aiStatus: "PENDING" } });
    await aiRunner.drainOnce();

    const results = await prisma.aiResult.findMany({ where: { mediaFileId: media.id } });
    expect(results).toHaveLength(5);
  });

  it("claims a row exactly once under concurrent drains", async () => {
    const root = await createRoot();
    await createMediaFile(root, "a.mp4");
    const adapter = new FakeAiAdapter();
    const aiRunner = runner(root, adapter);

    await Promise.all([aiRunner.drainOnce(), aiRunner.drainOnce()]);

    // The adapter was only ever started once for the single row.
    expect(adapter.startCalls).toBe(1);
  });

  it("keeps partial results when a later stage fails permanently", async () => {
    const root = await createRoot();
    await createMediaFile(root, "a.mp4");
    const adapter = new FakeAiAdapter();
    adapter.behavior.ocr = async () => {
      throw new AiProcessorError(AI_PROCESSOR_ERROR_CODES.BAD_REQUEST, "ocr rejected");
    };

    await runner(root, adapter).drainOnce();

    const media = await prisma.mediaFile.findFirstOrThrow();
    expect(media.aiStatus).toBe("READY");
    expect(media.aiPartial).toBe(true);

    const byStage = new Map(
      (await prisma.aiResult.findMany({ where: { mediaFileId: media.id } })).map((row) => [row.stage, row]),
    );
    expect(byStage.get("TRANSCRIPTION")?.status).toBe("READY");
    expect(byStage.get("SUMMARY")?.status).toBe("READY");
    expect(byStage.get("OCR")?.status).toBe("FAILED");
    expect(byStage.get("OCR")?.errorCode).toBe(AI_PROCESSOR_ERROR_CODES.BAD_REQUEST);
    // The successful transcription payload is preserved verbatim.
    expect(byStage.get("TRANSCRIPTION")?.payload).toMatchObject({ full_text: "selamat pagi indonesia" });
  });

  it("retries a TRANSIENT failure and succeeds within the bound", async () => {
    const root = await createRoot();
    await createMediaFile(root, "a.mp4");
    const adapter = new FakeAiAdapter();
    let attempt = 0;
    adapter.behavior.start = async () => {
      attempt += 1;
      if (attempt === 1) {
        throw new AiProcessorError(AI_PROCESSOR_ERROR_CODES.UNAVAILABLE, "processor starting");
      }
    };

    await runner(root, adapter, { maxRetries: 2 }).drainOnce();

    const media = await prisma.mediaFile.findFirstOrThrow();
    expect(media.aiStatus).toBe("READY");
    expect(media.aiAttempt).toBe(1);
    expect(adapter.startCalls).toBe(2);
  });

  it("exhausts the retry bound on a persistent TRANSIENT failure and ends FAILED", async () => {
    const root = await createRoot();
    await createMediaFile(root, "a.mp4");
    const adapter = new FakeAiAdapter();
    adapter.behavior.start = async () => {
      throw new AiProcessorError(AI_PROCESSOR_ERROR_CODES.UNAVAILABLE, "processor down");
    };
    adapter.behavior.ocr = async () => {
      throw new AiProcessorError(AI_PROCESSOR_ERROR_CODES.UNAVAILABLE, "processor down");
    };

    await runner(root, adapter, { maxRetries: 2 }).drainOnce();

    const media = await prisma.mediaFile.findFirstOrThrow();
    expect(media.aiStatus).toBe("FAILED");
    expect(media.aiErrorCode).toBe(AI_PROCESSOR_ERROR_CODES.UNAVAILABLE);
    expect(media.aiAttempt).toBe(2);
    expect(adapter.startCalls).toBe(3);
  });

  it("does NOT retry a PERMANENT failure (single attempt)", async () => {
    const root = await createRoot();
    await createMediaFile(root, "a.mp4");
    const adapter = new FakeAiAdapter();
    adapter.behavior.start = async () => {
      throw new AiProcessorError(AI_PROCESSOR_ERROR_CODES.BAD_REQUEST, "bad request");
    };
    adapter.behavior.ocr = async () => {
      throw new AiProcessorError(AI_PROCESSOR_ERROR_CODES.BAD_REQUEST, "bad request");
    };

    await runner(root, adapter, { maxRetries: 2 }).drainOnce();

    const media = await prisma.mediaFile.findFirstOrThrow();
    expect(media.aiStatus).toBe("FAILED");
    expect(adapter.startCalls).toBe(1);
  });

  it("rejects a path that escapes the storage root without calling the processor", async () => {
    const root = await createRoot();
    await createMediaFile(root, "a.mp4");
    const media = await prisma.mediaFile.findFirstOrThrow();
    await prisma.mediaFile.update({
      where: { id: media.id },
      data: { relativePath: "../../etc/passwd" },
    });
    const adapter = new FakeAiAdapter();

    await runner(root, adapter).drainOnce();

    const updated = await prisma.mediaFile.findUniqueOrThrow({ where: { id: media.id } });
    expect(updated.aiStatus).toBe("FAILED");
    expect(updated.aiErrorCode).toBe("AI_PATH_INVALID");
    expect(adapter.startCalls).toBe(0);
  });

  it("sends TMIP's deterministic external job id and the resolved absolute path", async () => {
    const root = await createRoot();
    const media = await createMediaFile(root, "News/report.mp4");
    const adapter = new FakeAiAdapter();

    await runner(root, adapter).drainOnce();

    expect(adapter.startArgs[0]?.externalJobId).toBe(buildExternalJobId(media.id, 0));
    expect(adapter.startArgs[0]?.absolutePath).toBe(path.join(root, "News/report.mp4"));
  });

  it("does not claim a PENDING row until technical metadata is READY", async () => {
    const root = await createRoot();
    await createMediaFile(root, "a.mp4", { metadataStatus: "PENDING" });
    const adapter = new FakeAiAdapter();

    const claimed = await runner(root, adapter).drainOnce();

    expect(claimed).toBe(0);
    expect(adapter.startCalls).toBe(0);
  });

  it("does not claim a MISSING file", async () => {
    const root = await createRoot();
    const media = await createMediaFile(root, "a.mp4");
    await prisma.mediaFile.update({ where: { id: media.id }, data: { status: "MISSING" } });

    const claimed = await runner(root, new FakeAiAdapter()).drainOnce();

    expect(claimed).toBe(0);
  });

  it("restart recovery resets PROCESSING to PENDING and re-runs to READY", async () => {
    const root = await createRoot();
    const media = await createMediaFile(root, "a.mp4");
    // Simulate a process that died mid-job.
    await prisma.mediaFile.update({ where: { id: media.id }, data: { aiStatus: "PROCESSING", aiAttempt: 1 } });

    const swept = await sweepInterruptedAiState(prisma);
    expect(swept.processingAiFiles).toBe(1);

    const recovered = await prisma.mediaFile.findUniqueOrThrow({ where: { id: media.id } });
    expect(recovered.aiStatus).toBe("PENDING");
    // The interrupted attempt is not consumed by recovery.
    expect(recovered.aiAttempt).toBe(1);

    await runner(root, new FakeAiAdapter()).drainOnce();
    const done = await prisma.mediaFile.findUniqueOrThrow({ where: { id: media.id } });
    expect(done.aiStatus).toBe("READY");
  });

  it("manual reprocess resets a FAILED row and re-runs it to READY", async () => {
    const root = await createRoot();
    const media = await createMediaFile(root, "a.mp4");
    const adapter = new FakeAiAdapter();
    adapter.behavior.start = async () => {
      throw new AiProcessorError(AI_PROCESSOR_ERROR_CODES.BAD_REQUEST, "nope");
    };
    adapter.behavior.ocr = async () => {
      throw new AiProcessorError(AI_PROCESSOR_ERROR_CODES.BAD_REQUEST, "nope");
    };
    const aiRunner = runner(root, adapter);
    await aiRunner.drainOnce();
    expect((await prisma.mediaFile.findUniqueOrThrow({ where: { id: media.id } })).aiStatus).toBe("FAILED");

    // Reprocess, then let the processor succeed.
    adapter.behavior.start = undefined;
    adapter.behavior.ocr = undefined;
    const reprocessor = createAiReprocessor(prisma);
    expect(await reprocessor.reprocessOne(media.id)).toBe("STARTED");

    const afterReset = await prisma.mediaFile.findUniqueOrThrow({ where: { id: media.id } });
    expect(afterReset.aiStatus).toBe("PENDING");
    expect(afterReset.aiAttempt).toBe(0);
    expect(afterReset.aiErrorCode).toBeNull();

    await aiRunner.drainOnce();
    expect((await prisma.mediaFile.findUniqueOrThrow({ where: { id: media.id } })).aiStatus).toBe("READY");
  });

  it("manual reprocess returns CONFLICT for a PROCESSING row and NOT_FOUND for an unknown id", async () => {
    const root = await createRoot();
    const media = await createMediaFile(root, "a.mp4", { aiStatus: "PROCESSING" });
    const reprocessor = createAiReprocessor(prisma);

    expect(await reprocessor.reprocessOne(media.id)).toBe("CONFLICT");
    expect(await reprocessor.reprocessOne("missing-id")).toBe("NOT_FOUND");
  });

  it("leaves the technical metadata pipeline columns untouched", async () => {
    const root = await createRoot();
    const media = await createMediaFile(root, "a.mp4");
    await prisma.mediaFile.update({
      where: { id: media.id },
      data: { metadataStatus: "READY", videoCodec: "h264", width: 1920, height: 1080 },
    });

    await runner(root, new FakeAiAdapter()).drainOnce();

    const after = await prisma.mediaFile.findUniqueOrThrow({ where: { id: media.id } });
    // AI runs never touch metadataStatus or the technical columns.
    expect(after.metadataStatus).toBe("READY");
    expect(after.videoCodec).toBe("h264");
    expect(after.width).toBe(1920);
    expect(after.height).toBe(1080);
  });
});

describe("AI cancellation end-to-end (real database, ADR-006 §18)", () => {
  it("records a durable intent without writing a terminal state", async () => {
    const root = await createRoot();
    const media = await createMediaFile(root, "a.mp4", { aiStatus: "PROCESSING" });
    const aiRunner = runner(root, new FakeAiAdapter());

    expect(await aiRunner.cancel(media.id)).toBe("REQUESTED");

    const after = await prisma.mediaFile.findUniqueOrThrow({ where: { id: media.id } });
    // The intent is persisted, but the row stays PROCESSING — the runner, not
    // the request, performs the terminal transition.
    expect(after.aiCancelRequestedAt).not.toBeNull();
    expect(after.aiStatus).toBe("PROCESSING");
  });

  it("stops mid-pipeline, keeps the succeeded stage, and finalizes CANCELLED", async () => {
    const root = await createRoot();
    const media = await createMediaFile(root, "a.mp4");
    const adapter = new FakeAiAdapter();
    const holder: { runner?: AiRunner } = {};
    adapter.behavior.status = async () => {
      // Cancel while transcription is in flight.
      await holder.runner?.cancel(media.id);
      return { status: "COMPLETED", result: transcriptResult };
    };
    adapter.behavior.summarize = async () => {
      throw new Error("summarize must not run after cancellation");
    };
    const aiRunner = runner(root, adapter);
    holder.runner = aiRunner;

    await aiRunner.drainOnce();

    const after = await prisma.mediaFile.findUniqueOrThrow({ where: { id: media.id } });
    expect(after.aiStatus).toBe("CANCELLED");
    expect(after.aiPartial).toBe(true);

    const stages = await prisma.aiResult.findMany({ where: { mediaFileId: media.id } });
    expect(stages.map((row) => row.stage)).toContain("TRANSCRIPTION");
    expect(stages.map((row) => row.stage)).not.toContain("SUMMARY");
  });

  it("late worker cannot overwrite CANCELLED (compare-and-set guard)", async () => {
    const root = await createRoot();
    const media = await createMediaFile(root, "a.mp4");
    const aiRunner = runner(root, new FakeAiAdapter());

    // Claim, cancel, and finalize CANCELLED.
    await aiRunner.claimPending(1);
    await aiRunner.cancel(media.id);
    await aiRunner.process(media.id);
    expect((await prisma.mediaFile.findUniqueOrThrow({ where: { id: media.id } })).aiStatus).toBe("CANCELLED");

    // A stale worker attempts a normal run; the guarded writes must not revive it.
    await aiRunner.process(media.id);
    expect((await prisma.mediaFile.findUniqueOrThrow({ where: { id: media.id } })).aiStatus).toBe("CANCELLED");
  });

  it("restart recovery finalizes a cancelled row as CANCELLED and re-queues a live one", async () => {
    const root = await createRoot();
    const cancelled = await createMediaFile(root, "cancelled.mp4", { aiStatus: "PROCESSING" });
    const live = await createMediaFile(root, "live.mp4", { aiStatus: "PROCESSING" });
    await prisma.mediaFile.update({
      where: { id: cancelled.id },
      data: { aiCancelRequestedAt: new Date() },
    });

    const result = await sweepInterruptedAiState(prisma);

    expect((await prisma.mediaFile.findUniqueOrThrow({ where: { id: cancelled.id } })).aiStatus).toBe("CANCELLED");
    expect((await prisma.mediaFile.findUniqueOrThrow({ where: { id: live.id } })).aiStatus).toBe("PENDING");
    expect(result.cancelledAiFiles).toBe(1);
    expect(result.processingAiFiles).toBe(1);
  });

  it("manual reprocess after CANCELLED clears the intent and re-runs to READY", async () => {
    const root = await createRoot();
    const media = await createMediaFile(root, "a.mp4", { aiStatus: "CANCELLED" });
    await prisma.mediaFile.update({
      where: { id: media.id },
      data: { aiCancelRequestedAt: new Date(), aiPartial: true },
    });

    const reprocessor = createAiReprocessor(prisma);
    expect(await reprocessor.reprocessOne(media.id)).toBe("STARTED");

    const afterReset = await prisma.mediaFile.findUniqueOrThrow({ where: { id: media.id } });
    expect(afterReset.aiStatus).toBe("PENDING");
    expect(afterReset.aiCancelRequestedAt).toBeNull();
    expect(afterReset.aiPartial).toBe(false);

    await runner(root, new FakeAiAdapter()).drainOnce();
    expect((await prisma.mediaFile.findUniqueOrThrow({ where: { id: media.id } })).aiStatus).toBe("READY");
  });

  it("sends the correct remote asset id to the processor's transcription cancel", async () => {
    const root = await createRoot();
    const media = await createMediaFile(root, "a.mp4", { aiStatus: "PROCESSING" });
    await prisma.mediaFile.update({
      where: { id: media.id },
      data: { aiExternalJobId: buildExternalJobId(media.id, 0) },
    });
    const cancelledIds: string[] = [];
    const adapter = new FakeAiAdapter();
    adapter.cancelTranscription = async (externalJobId: string) => {
      cancelledIds.push(externalJobId);
      return true;
    };
    const aiRunner = runner(root, adapter);

    await aiRunner.cancel(media.id);

    // The asset_id TMIP sends must be its own aiExternalJobId, not the media id.
    expect(cancelledIds).toEqual([buildExternalJobId(media.id, 0)]);
    expect(cancelledIds[0]).not.toBe(media.id);
  });

  it("repeated cancellation requests are idempotent", async () => {
    const root = await createRoot();
    const media = await createMediaFile(root, "a.mp4", { aiStatus: "PROCESSING" });
    const aiRunner = runner(root, new FakeAiAdapter());

    expect(await aiRunner.cancel(media.id)).toBe("REQUESTED");
    expect(await aiRunner.cancel(media.id)).toBe("REQUESTED");
  });
});
