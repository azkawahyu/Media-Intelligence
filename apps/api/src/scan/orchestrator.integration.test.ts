import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPrismaClient } from "../db.js";
import { DEFAULT_SUPPORTED_MEDIA_EXTENSIONS } from "../config.js";
import { ScanOrchestrator } from "./orchestrator.js";
import { ExtractionRunner } from "./extractor.js";
import { createExtractionReprocessor } from "../media/reprocess.js";
import { sweepInterruptedState } from "./startup.js";
import type { FFprobeAdapter, FFprobeResult } from "../metadata/ffprobe-adapter.js";
import type { PrismaClient } from "@prisma/client";

const databaseUrl = process.env.TEST_DATABASE_URL ?? "postgresql://tmip:tmip@localhost:5432/tmip_test";
const prisma = createPrismaClient(databaseUrl);
let storageId: string;
const temporaryRoots: string[] = [];

async function createRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "tmip-scan-"));
  temporaryRoots.push(root);
  return root;
}

async function createMedia(root: string, relativePath: string, content = "media"): Promise<string> {
  const absolutePath = path.join(root, relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content);
  return absolutePath;
}

const probeResult: FFprobeResult = {
  parsed: {
    format: { duration: "12.5", format_name: "mock" },
    streams: [{ codec_type: "video", codec_name: "h264", width: 1920, height: 1080, r_frame_rate: "30000/1001" }],
  },
  rawJson: JSON.stringify({ format: { duration: "12.5", format_name: "mock", customVendorField: "preserve" }, streams: [{ codec_type: "video", codec_name: "h264", width: 1920, height: 1080, r_frame_rate: "30000/1001" }] }),
};

type MockFailure = { code: string; stage: "FFPROBE" | "NORMALIZATION" };

class MockAdapter implements FFprobeAdapter {
  public readonly attempts: string[] = [];
  public constructor(private readonly failures = new Map<string, MockFailure>()) {}
  public async probe(absolutePath: string): Promise<FFprobeResult> {
    this.attempts.push(absolutePath);
    const failure = this.failures.get(absolutePath);
    if (failure !== undefined) {
      throw Object.assign(new Error(`mock ${failure.code.toLowerCase()} failure`), failure);
    }
    return probeResult;
  }
}

/**
 * Adapter whose per-path outcome can change between attempts, so retry behavior
 * (transient-then-success, exhausted retries) can be exercised deterministically.
 * Each entry is the failure for attempt N (null = success); the last entry
 * repeats for any further attempts.
 */
class SequenceAdapter implements FFprobeAdapter {
  public readonly attempts: string[] = [];
  public constructor(private readonly sequence = new Map<string, Array<MockFailure | null>>()) {}
  public async probe(absolutePath: string): Promise<FFprobeResult> {
    const attemptIndex = this.attempts.filter((path) => path === absolutePath).length;
    this.attempts.push(absolutePath);
    const outcomes = this.sequence.get(absolutePath) ?? [null];
    const outcome = outcomes[Math.min(attemptIndex, outcomes.length - 1)] ?? null;
    if (outcome !== null) {
      throw Object.assign(new Error(`mock ${outcome.code.toLowerCase()} failure`), outcome);
    }
    return probeResult;
  }
}

function extractionRunner(
  root: string,
  adapter: FFprobeAdapter,
  options: { maxRetries?: number; retryBackoffMs?: number; retrySleep?: (ms: number) => Promise<void>; concurrency?: number } = {},
): ExtractionRunner {
  return new ExtractionRunner({
    prisma,
    adapter,
    storageRoot: root,
    concurrency: options.concurrency ?? 1,
    maxRetries: options.maxRetries ?? 0,
    retryBackoffMs: options.retryBackoffMs ?? 0,
    retrySleep: options.retrySleep,
  });
}

async function createQueuedMedia(
  relativePath: string,
  overrides: { retryCount?: number } = {},
): Promise<{ scanId: string; mediaFileId: string }> {
  const now = new Date();
  const scan = await prisma.scanJob.create({
    data: { storageId, status: "RUNNING", startedAt: now, discoveryCompletedAt: now, queuedCount: 1 },
  });
  const media = await prisma.mediaFile.create({
    data: {
      storageId,
      relativePath,
      filename: path.basename(relativePath),
      extension: path.extname(relativePath),
      fileSize: BigInt(0),
      modifiedAt: now,
      firstSeenAt: now,
      lastSeenAt: now,
      lastSeenScanId: scan.id,
      metadataStatus: "PENDING",
      retryCount: overrides.retryCount ?? 0,
    },
  });
  return { scanId: scan.id, mediaFileId: media.id };
}

async function createScan(queuedCount = 0): Promise<string> {
  const scan = await prisma.scanJob.create({
    data: { storageId, status: "RUNNING", startedAt: new Date(), discoveryCompletedAt: new Date(), queuedCount },
  });
  return scan.id;
}

async function snapshotMediaTree(root: string): Promise<Array<{ relativePath: string; sha256: string }>> {
  const files: Array<{ relativePath: string; sha256: string }> = [];
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath);
      } else if (entry.isFile()) {
        const content = await readFile(absolutePath);
        files.push({
          relativePath: path.relative(root, absolutePath).split(path.sep).join("/"),
          sha256: createHash("sha256").update(content).digest("hex"),
        });
      }
    }
  }
  await visit(root);
  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function adapterFailure(code: string, stage: MockFailure["stage"]): MockFailure {
  return { code, stage };
}

function orchestrator(root: string, adapter?: FFprobeAdapter): ScanOrchestrator {
  const extractor = adapter === undefined ? undefined : new ExtractionRunner({
    prisma,
    adapter,
    storageRoot: root,
    concurrency: 2,
  });
  return new ScanOrchestrator({
    prisma,
    config: {
      mediaRoot: root,
      supportedMediaExtensions: DEFAULT_SUPPORTED_MEDIA_EXTENSIONS,
    },
    extractor,
  });
}

/** Full scan (discovery → drain → finalize) with a retry-configured extractor. */
function retryOrchestrator(
  root: string,
  adapter: FFprobeAdapter,
  options: { maxRetries?: number; retryBackoffMs?: number; retrySleep?: (ms: number) => Promise<void> } = {},
): ScanOrchestrator {
  return new ScanOrchestrator({
    prisma,
    config: {
      mediaRoot: root,
      supportedMediaExtensions: DEFAULT_SUPPORTED_MEDIA_EXTENSIONS,
    },
    extractor: extractionRunner(root, adapter, { ...options, concurrency: 1 }),
  });
}

function reprocessor(root: string, adapter: FFprobeAdapter) {
  return createExtractionReprocessor(
    new ExtractionRunner({ prisma, adapter, storageRoot: root, concurrency: 2 }),
  );
}

async function waitForReady(id: string): Promise<NonNullable<Awaited<ReturnType<typeof prisma.mediaFile.findUnique>>>> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const row = await prisma.mediaFile.findUnique({ where: { id } });
    if (row?.metadataStatus === "READY") return row;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timed out waiting for READY");
}

async function clearTestData(): Promise<void> {
  await prisma.mediaFile.deleteMany();
  await prisma.scanJob.deleteMany();
  await prisma.storage.deleteMany();
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
  await clearTestData();
  const storage = await prisma.storage.create({
    data: { name: "Test Storage", rootPath: "/test-media" },
  });
  storageId = storage.id;
});

afterAll(async () => {
  await clearTestData();
  await prisma.$disconnect();
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

beforeEach(async () => {
  await prisma.mediaFile.deleteMany();
  await prisma.scanJob.deleteMany();
  const storage = await prisma.storage.findUnique({ where: { id: storageId } });
  if (storage === null) {
    const restored = await prisma.storage.create({
      data: { id: storageId, name: "Test Storage", rootPath: "/test-media" },
    });
    storageId = restored.id;
  }
});

describe("ScanOrchestrator", () => {
  it("extracts queued files, preserves JSONB, and completes successfully", async () => {
    const root = await createRoot();
    await createMedia(root, "news/a.mp4", "a");
    const adapter = new MockAdapter();

    await orchestrator(root, adapter).run(storageId);

    const scan = await prisma.scanJob.findFirstOrThrow({ orderBy: { createdAt: "desc" } });
    const file = await prisma.mediaFile.findFirstOrThrow();
    expect(scan.status).toBe("COMPLETED");
    expect(scan.processedCount).toBe(1);
    expect(scan.failedCount).toBe(0);
    expect(file.metadataStatus).toBe("READY");
    expect(file.videoCodec).toBe("h264");
    expect(file.frameRateNumerator).toBe(30000);
    expect(file.frameRateDenominator).toBe(1001);
    expect(file.technicalMetadata).toMatchObject({ containerFormat: "mock" });
    expect(file.rawProbeData).toMatchObject({ format: { customVendorField: "preserve" } });
    expect(file.lastMetadataExtractedAt).not.toBeNull();
    expect(file.errorCode).toBeNull();
  });

  it("isolates one adapter failure and completes with errors", async () => {
    const root = await createRoot();
    const first = await createMedia(root, "a.mp4", "a");
    await createMedia(root, "b.mp4", "b");
    const adapter = new MockAdapter(new Map([[first, adapterFailure("FFPROBE_FAILED", "FFPROBE")]]));

    await orchestrator(root, adapter).run(storageId);

    const scan = await prisma.scanJob.findFirstOrThrow({ orderBy: { createdAt: "desc" } });
    const files = await prisma.mediaFile.findMany({ orderBy: { relativePath: "asc" } });
    expect(scan.status).toBe("COMPLETED_WITH_ERRORS");
    expect(scan.processedCount).toBe(2);
    expect(scan.failedCount).toBe(1);
    expect(files[0]?.metadataStatus).toBe("FAILED");
    expect(files[0]?.errorCode).toBe("FFPROBE_FAILED");
    expect(files[1]?.metadataStatus).toBe("READY");
  });

  it.each([
    ["FFPROBE_TIMEOUT", "FFPROBE"],
    ["INVALID_PROBE_OUTPUT", "NORMALIZATION"],
  ] as const)("persists %s with its structured stage", async (code, stage) => {
    const root = await createRoot();
    const filePath = await createMedia(root, `${code.toLowerCase()}.mp4`, code);
    const adapter = new MockAdapter(new Map([[filePath, adapterFailure(code, stage)]]));

    await orchestrator(root, adapter).run(storageId);

    const scan = await prisma.scanJob.findFirstOrThrow({ orderBy: { createdAt: "desc" } });
    const file = await prisma.mediaFile.findFirstOrThrow();
    expect(scan.status).toBe("COMPLETED_WITH_ERRORS");
    expect(scan.processedCount).toBe(1);
    expect(scan.failedCount).toBe(1);
    expect(file.metadataStatus).toBe("FAILED");
    expect(file.errorCode).toBe(code);
    expect(file.errorStage).toBe(stage);
    expect(file.errorAt).not.toBeNull();
  });

  it("continues after validation failure and finalizes with errors", async () => {
    const root = await createRoot();
    // Windows chmod behavior varies by host; use the same deterministic
    // directory-in-place-of-file validation approach as the existing test.
    await mkdir(path.join(root, "invalid.mp4"), { recursive: true });
    await createMedia(root, "valid.mp4", "valid");
    const now = new Date();
    const scan = await prisma.scanJob.create({
      data: { storageId, status: "PENDING", startedAt: now, queuedCount: 1 },
    });
    await prisma.mediaFile.create({
      data: {
        storageId,
        relativePath: "invalid.mp4",
        filename: "invalid.mp4",
        extension: ".mp4",
        fileSize: BigInt(0),
        modifiedAt: now,
        firstSeenAt: now,
        lastSeenAt: now,
        lastSeenScanId: scan.id,
        metadataStatus: "PENDING",
      },
    });

    await orchestrator(root, new MockAdapter()).run(storageId, scan.id);

    const completedScan = await prisma.scanJob.findUniqueOrThrow({ where: { id: scan.id } });
    const files = await prisma.mediaFile.findMany({ orderBy: { relativePath: "asc" } });
    expect(completedScan.status).toBe("COMPLETED_WITH_ERRORS");
    expect(completedScan.queuedCount).toBe(2);
    expect(completedScan.processedCount).toBe(2);
    expect(completedScan.failedCount).toBe(1);
    expect(files).toHaveLength(2);
    expect(files[0]?.metadataStatus).toBe("FAILED");
    expect(files[0]?.errorStage).toBe("VALIDATION");
    expect(files[1]?.metadataStatus).toBe("READY");
  });

  it("records validation failure for a directory in place of a file", async () => {
    const root = await createRoot();
    await mkdir(path.join(root, "bad.mp4"), { recursive: true });
    const now = new Date();
    const scan = await prisma.scanJob.create({
      data: { storageId, status: "RUNNING", startedAt: now, discoveryCompletedAt: now, queuedCount: 1 },
    });
    const bad = await prisma.mediaFile.create({
      data: {
        storageId,
        relativePath: "bad.mp4",
        filename: "bad.mp4",
        extension: ".mp4",
        fileSize: BigInt(0),
        modifiedAt: now,
        firstSeenAt: now,
        lastSeenAt: now,
        lastSeenScanId: scan.id,
        metadataStatus: "PENDING",
      },
    });
    const runner = new ExtractionRunner({ prisma, adapter: new MockAdapter(), storageRoot: root });

    await runner.drain(storageId, scan.id);

    const completedScan = await prisma.scanJob.findUniqueOrThrow({ where: { id: scan.id } });
    const failed = await prisma.mediaFile.findUniqueOrThrow({ where: { id: bad.id } });
    expect(completedScan.processedCount).toBe(1);
    expect(completedScan.failedCount).toBe(1);
    expect(failed.metadataStatus).toBe("FAILED");
    expect(failed.errorStage).toBe("VALIDATION");
  });

  it("leaves the source media tree byte-identical after scan and extraction", async () => {
    const root = await createRoot();
    await createMedia(root, "news/a.mp4", "source-a");
    await createMedia(root, "news/nested/b.mxf", "source-b");
    await createMedia(root, "notes.txt", "ignored");
    const before = await snapshotMediaTree(root);

    await orchestrator(root, new MockAdapter()).run(storageId);

    const after = await snapshotMediaTree(root);
    expect(after).toEqual(before);
  });

  it("claims concurrent pending files exactly once", async () => {
    const root = await createRoot();
    const paths = await Promise.all(
      ["one.mp4", "two.mp4", "three.mp4", "four.mp4", "five.mp4"].map((name) => createMedia(root, name, name)),
    );
    const adapter = new MockAdapter();

    await orchestrator(root, adapter).run(storageId);

    expect(adapter.attempts).toHaveLength(paths.length);
    expect(new Set(adapter.attempts).size).toBe(paths.length);
    expect((await prisma.mediaFile.findMany({ where: { metadataStatus: "READY" } }))).toHaveLength(paths.length);
  });

  it("sweeps interrupted processing and running scan state", async () => {
    const now = new Date();
    const scan = await prisma.scanJob.create({ data: { storageId, status: "RUNNING", startedAt: now } });
    const file = await prisma.mediaFile.create({ data: { storageId, relativePath: "stale.mp4", filename: "stale.mp4", extension: ".mp4", fileSize: BigInt(1), modifiedAt: now, firstSeenAt: now, lastSeenAt: now, lastSeenScanId: scan.id, metadataStatus: "PROCESSING" } });

    await sweepInterruptedState(prisma);

    const sweptFile = await prisma.mediaFile.findUniqueOrThrow({ where: { id: file.id } });
    const sweptScan = await prisma.scanJob.findUniqueOrThrow({ where: { id: scan.id } });
    expect(sweptFile.metadataStatus).toBe("FAILED");
    expect(sweptFile.errorCode).toBe("INTERRUPTED");
    expect(sweptScan.status).toBe("FAILED");
    expect(sweptScan.completedAt).not.toBeNull();
  });

  it("completes a zero-queued scan immediately", async () => {
    const root = await createRoot();
    await createMedia(root, "stable.mp4", "stable");
    const firstAdapter = new MockAdapter();
    await orchestrator(root, firstAdapter).run(storageId);
    const firstFile = await prisma.mediaFile.findFirstOrThrow();
    const extractedAt = firstFile.lastMetadataExtractedAt;

    await orchestrator(root, new MockAdapter()).run(storageId);

    const scans = await prisma.scanJob.findMany({ orderBy: { createdAt: "asc" } });
    const secondFile = await prisma.mediaFile.findFirstOrThrow();
    expect(scans[1]?.queuedCount).toBe(0);
    expect(scans[1]?.status).toBe("COMPLETED");
    expect(secondFile.lastMetadataExtractedAt?.getTime()).toBe(extractedAt?.getTime());
  });

  it("does not retry a failed file during a repeated drain", async () => {
    const root = await createRoot();
    const filePath = await createMedia(root, "failed.mp4", "failed");
    const now = new Date();
    const scan = await prisma.scanJob.create({ data: { storageId, status: "RUNNING", startedAt: now, discoveryCompletedAt: now, queuedCount: 1 } });
    await prisma.mediaFile.create({ data: { storageId, relativePath: "failed.mp4", filename: "failed.mp4", extension: ".mp4", fileSize: BigInt(6), modifiedAt: now, firstSeenAt: now, lastSeenAt: now, lastSeenScanId: scan.id } });
    const adapter = new MockAdapter(new Map([[filePath, adapterFailure("FFPROBE_FAILED", "FFPROBE")]]));
    const runner = new ExtractionRunner({ prisma, adapter, storageRoot: root });

    await runner.drain(storageId, scan.id);
    await runner.drain(storageId, scan.id);

    expect(adapter.attempts).toEqual([filePath]);
    expect((await prisma.mediaFile.findFirstOrThrow()).metadataStatus).toBe("FAILED");
  });

  it("persists NEW files and leaves discovery scans RUNNING", async () => {
    const root = await createRoot();
    await createMedia(root, "news/a.mp4", "a");
    await createMedia(root, "news/b.mxf", "bb");
    await createMedia(root, "notes.txt", "ignored");

    await orchestrator(root).run(storageId);

    const scan = await prisma.scanJob.findFirstOrThrow({ orderBy: { createdAt: "desc" } });
    const files = await prisma.mediaFile.findMany({ orderBy: { relativePath: "asc" } });
    expect(scan.status).toBe("RUNNING");
    expect(scan.discoveryCompletedAt).not.toBeNull();
    expect(scan.discoveredCount).toBe(2);
    expect(scan.newCount).toBe(2);
    expect(scan.queuedCount).toBe(2);
    expect(scan.unchangedCount).toBe(0);
    expect(files).toHaveLength(2);
    expect(files.every((file) => file.metadataStatus === "PENDING")).toBe(true);
    expect(files.every((file) => file.firstSeenAt.getTime() === file.lastSeenAt.getTime())).toBe(true);
    expect(files.every((file) => file.lastSeenScanId === scan.id)).toBe(true);
  });

  it("classifies the second scan as unchanged without changing extraction timestamps", async () => {
    const root = await createRoot();
    await createMedia(root, "same.mp4", "stable");
    await orchestrator(root).run(storageId);
    const firstFile = await prisma.mediaFile.findFirstOrThrow();
    const firstExtractedAt = new Date("2026-01-01T00:00:00.000Z");
    await prisma.mediaFile.update({
      where: { id: firstFile.id },
      data: { metadataStatus: "READY", lastMetadataExtractedAt: firstExtractedAt },
    });

    await orchestrator(root).run(storageId);

    const scans = await prisma.scanJob.findMany({ orderBy: { createdAt: "asc" } });
    const file = await prisma.mediaFile.findFirstOrThrow();
    expect(scans[1]?.newCount).toBe(0);
    expect(scans[1]?.unchangedCount).toBe(1);
    expect(scans[1]?.queuedCount).toBe(0);
    expect(file.metadataStatus).toBe("READY");
    expect(file.lastMetadataExtractedAt?.getTime()).toBe(firstExtractedAt.getTime());
    expect(file.lastSeenScanId).toBe(scans[1]?.id);
  });

  it("counts an attribute mismatch as UPDATED without changing stored attributes or queue state", async () => {
    const root = await createRoot();
    const filePath = await createMedia(root, "changed.mp4", "old");
    const originalMtime = new Date("2020-01-01T00:00:00.000Z");
    await utimes(filePath, originalMtime, originalMtime);
    await orchestrator(root).run(storageId);
    const storedBefore = await prisma.mediaFile.findFirstOrThrow();
    await writeFile(filePath, "new-content-with-different-size");
    const changedMtime = new Date("2021-01-01T00:00:00.000Z");
    await utimes(filePath, changedMtime, changedMtime);

    await orchestrator(root).run(storageId);

    const scans = await prisma.scanJob.findMany({ orderBy: { createdAt: "asc" } });
    const file = await prisma.mediaFile.findFirstOrThrow();
    expect(scans[1]?.updatedCount).toBe(1);
    expect(scans[1]?.queuedCount).toBe(0);
    expect(file.fileSize).toBe(storedBefore.fileSize);
    expect(file.modifiedAt.getTime()).toBe(storedBefore.modifiedAt.getTime());
    expect(file.status).toBe("ACTIVE");
    expect(file.lastSeenScanId).toBe(scans[1]?.id);
  });

  it("fails before discovery when the storage root is unavailable", async () => {
    const root = path.join(os.tmpdir(), "tmip-root-does-not-exist", `${Date.now()}`);
    await orchestrator(root).run(storageId);

    const scan = await prisma.scanJob.findFirstOrThrow({ orderBy: { createdAt: "desc" } });
    expect(scan.status).toBe("FAILED");
    expect(scan.discoveredCount).toBe(0);
    expect(await prisma.mediaFile.count()).toBe(0);
  });

  it("keeps an empty discovery scan RUNNING with zero counters", async () => {
    const root = await createRoot();
    await orchestrator(root).run(storageId);

    const scan = await prisma.scanJob.findFirstOrThrow({ orderBy: { createdAt: "desc" } });
    expect(scan.status).toBe("RUNNING");
    expect(scan.discoveryCompletedAt).not.toBeNull();
    expect(scan.discoveredCount).toBe(0);
    expect(scan.newCount).toBe(0);
    expect(scan.queuedCount).toBe(0);
  });

  it("enforces the storage/path unique constraint", async () => {
    const root = await createRoot();
    const modifiedAt = new Date("2020-01-01T00:00:00.000Z");
    const base = {
      storageId,
      relativePath: "duplicate.mp4",
      filename: "duplicate.mp4",
      extension: ".mp4",
      fileSize: BigInt(1),
      modifiedAt,
      firstSeenAt: modifiedAt,
      lastSeenAt: modifiedAt,
      lastSeenScanId: "scan-test",
    };
    await prisma.mediaFile.create({ data: base });
    await expect(prisma.mediaFile.create({ data: base })).rejects.toThrow();
    await rm(root, { recursive: true, force: true });
  });
});

describe("metadata reprocessing (integration)", () => {
  it("FAILED → reprocess → READY, clearing error fields, updating metadata, and leaving source media byte-identical", async () => {
    const root = await createRoot();
    const filePath = await createMedia(root, "clip.mp4", "clip");
    const failingAdapter = new MockAdapter(new Map([[filePath, adapterFailure("FFPROBE_FAILED", "FFPROBE")]]));

    await orchestrator(root, failingAdapter).run(storageId);
    const failedRow = await prisma.mediaFile.findFirstOrThrow();
    expect(failedRow.metadataStatus).toBe("FAILED");
    expect(failedRow.errorCode).toBe("FFPROBE_FAILED");
    const before = await snapshotMediaTree(root);

    await expect(reprocessor(root, new MockAdapter()).reprocessOne(failedRow.id)).resolves.toBe("STARTED");
    const readyRow = await waitForReady(failedRow.id);

    expect(readyRow.videoCodec).toBe("h264");
    expect(readyRow.technicalMetadata).toMatchObject({ containerFormat: "mock" });
    expect(readyRow.errorCode).toBeNull();
    expect(readyRow.errorMessage).toBeNull();
    expect(readyRow.errorStage).toBeNull();
    expect(readyRow.errorAt).toBeNull();
    expect(readyRow.lastMetadataExtractedAt).not.toBeNull();
    expect(await snapshotMediaTree(root)).toEqual(before);
  });

  it("records the new failure and keeps last known good metadata when reprocess fails again", async () => {
    const root = await createRoot();
    const filePath = await createMedia(root, "clip.mp4", "clip");

    await orchestrator(root, new MockAdapter()).run(storageId);
    const readyRow = await prisma.mediaFile.findFirstOrThrow();
    expect(readyRow.metadataStatus).toBe("READY");

    const failing = new MockAdapter(new Map([[filePath, adapterFailure("FFPROBE_TIMEOUT", "FFPROBE")]]));
    await expect(reprocessor(root, failing).reprocessOne(readyRow.id)).resolves.toBe("STARTED");

    const deadline = Date.now() + 5000;
    let failedRow = await prisma.mediaFile.findUniqueOrThrow({ where: { id: readyRow.id } });
    while (failedRow.metadataStatus !== "FAILED" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      failedRow = await prisma.mediaFile.findUniqueOrThrow({ where: { id: readyRow.id } });
    }
    expect(failedRow.metadataStatus).toBe("FAILED");
    expect(failedRow.errorCode).toBe("FFPROBE_TIMEOUT");
    expect(failedRow.videoCodec).toBe("h264");
    expect(failedRow.technicalMetadata).toMatchObject({ containerFormat: "mock" });
  });

  it("rejects PROCESSING, PENDING, and unknown ids", async () => {
    const root = await createRoot();
    await createMedia(root, "clip.mp4", "clip");
    await orchestrator(root, new MockAdapter()).run(storageId);
    const row = await prisma.mediaFile.findFirstOrThrow();

    await prisma.mediaFile.update({ where: { id: row.id }, data: { metadataStatus: "PROCESSING" } });
    await expect(reprocessor(root, new MockAdapter()).reprocessOne(row.id)).resolves.toBe("CONFLICT");

    await prisma.mediaFile.update({ where: { id: row.id }, data: { metadataStatus: "PENDING" } });
    await expect(reprocessor(root, new MockAdapter()).reprocessOne(row.id)).resolves.toBe("CONFLICT");

    await expect(reprocessor(root, new MockAdapter()).reprocessOne("does-not-exist")).resolves.toBe("NOT_FOUND");
  });

  it("runs exactly one attempt under concurrent reprocess requests", async () => {
    const root = await createRoot();
    await createMedia(root, "clip.mp4", "clip");
    await orchestrator(root, new MockAdapter()).run(storageId);
    const row = await prisma.mediaFile.findFirstOrThrow();

    const adapter = new MockAdapter();
    const shared = reprocessor(root, adapter);
    const results = await Promise.all([shared.reprocessOne(row.id), shared.reprocessOne(row.id)]);

    expect(results.filter((result) => result === "STARTED")).toHaveLength(1);
    expect(results.filter((result) => result === "CONFLICT")).toHaveLength(1);
    await waitForReady(row.id);
    expect(adapter.attempts).toHaveLength(1);
  });

  it("does not change ScanJob counters and leaves a subsequent scan classifying the file UNCHANGED", async () => {
    const root = await createRoot();
    const filePath = await createMedia(root, "clip.mp4", "clip");
    await orchestrator(root, new MockAdapter(new Map([[filePath, adapterFailure("FFPROBE_FAILED", "FFPROBE")]]))).run(storageId);

    const scanBefore = await prisma.scanJob.findFirstOrThrow({ orderBy: { createdAt: "desc" } });
    const row = await prisma.mediaFile.findFirstOrThrow();
    await expect(reprocessor(root, new MockAdapter()).reprocessOne(row.id)).resolves.toBe("STARTED");
    await waitForReady(row.id);

    const scanAfter = await prisma.scanJob.findUniqueOrThrow({ where: { id: scanBefore.id } });
    expect({ queued: scanAfter.queuedCount, processed: scanAfter.processedCount, failed: scanAfter.failedCount }).toEqual({
      queued: scanBefore.queuedCount,
      processed: scanBefore.processedCount,
      failed: scanBefore.failedCount,
    });

    const scanAdapter = new MockAdapter(new Map([[filePath, adapterFailure("FFPROBE_FAILED", "FFPROBE")]]));
    await orchestrator(root, scanAdapter).run(storageId);

    const secondScan = await prisma.scanJob.findFirstOrThrow({ orderBy: { createdAt: "desc" } });
    expect(secondScan.discoveredCount).toBe(1);
    expect(secondScan.unchangedCount).toBe(1);
    expect(secondScan.newCount).toBe(0);
    expect(scanAdapter.attempts).toHaveLength(0);

    const unchangedRow = await prisma.mediaFile.findUniqueOrThrow({ where: { id: row.id } });
    expect(unchangedRow.metadataStatus).toBe("READY");
  });

  it("does not reset a reprocess-held PROCESSING row during a concurrent scan", async () => {
    const root = await createRoot();
    await createMedia(root, "clip.mp4", "clip");
    await orchestrator(root, new MockAdapter()).run(storageId);
    const row = await prisma.mediaFile.findFirstOrThrow();

    // Represent an in-flight reprocess holding the row in PROCESSING.
    await prisma.mediaFile.update({ where: { id: row.id }, data: { metadataStatus: "PROCESSING" } });

    await orchestrator(root, new MockAdapter()).run(storageId);

    const after = await prisma.mediaFile.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.metadataStatus).toBe("PROCESSING");
  });

  it("recovers an interrupted reprocess through the startup sweep", async () => {
    const root = await createRoot();
    await createMedia(root, "clip.mp4", "clip");
    await orchestrator(root, new MockAdapter()).run(storageId);
    const row = await prisma.mediaFile.findFirstOrThrow();

    // Represent the process dying mid-reprocess.
    await prisma.mediaFile.update({ where: { id: row.id }, data: { metadataStatus: "PROCESSING" } });
    await sweepInterruptedState(prisma);

    const swept = await prisma.mediaFile.findUniqueOrThrow({ where: { id: row.id } });
    expect(swept.metadataStatus).toBe("FAILED");
    expect(swept.errorCode).toBe("INTERRUPTED");

    // The row remains reprocessable.
    await expect(reprocessor(root, new MockAdapter()).reprocessOne(row.id)).resolves.toBe("STARTED");
    await waitForReady(row.id);
  });
});

describe("bounded extraction retry (integration)", () => {
  it("retries a transient FFPROBE_TIMEOUT and reaches READY on the next attempt", async () => {
    const root = await createRoot();
    const filePath = await createMedia(root, "flaky.mp4", "flaky");
    const adapter = new SequenceAdapter(new Map([[filePath, [adapterFailure("FFPROBE_TIMEOUT", "FFPROBE"), null]]]));

    await retryOrchestrator(root, adapter, { maxRetries: 2 }).run(storageId);

    const file = await prisma.mediaFile.findFirstOrThrow({ orderBy: { createdAt: "desc" } });
    const scan = await prisma.scanJob.findFirstOrThrow({ orderBy: { createdAt: "desc" } });
    expect(adapter.attempts).toHaveLength(2);
    expect(file.metadataStatus).toBe("READY");
    expect(file.retryCount).toBe(0);
    expect(file.errorCode).toBeNull();
    expect(scan.status).toBe("COMPLETED");
    expect(scan.processedCount).toBe(1);
    expect(scan.failedCount).toBe(0);
  });

  it("retries a transient VALIDATION failure (file absent) and succeeds once the file appears", async () => {
    const root = await createRoot();
    const adapter = new SequenceAdapter();
    const runner = extractionRunner(root, adapter, {
      maxRetries: 2,
      retrySleep: async () => {
        // The file appears only after the first attempt fails validation.
        await createMedia(root, "late.mp4", "late");
      },
    });
    const { scanId, mediaFileId } = await createQueuedMedia("late.mp4");

    await runner.drain(storageId, scanId);

    const file = await prisma.mediaFile.findUniqueOrThrow({ where: { id: mediaFileId } });
    expect(file.metadataStatus).toBe("READY");
    expect(file.retryCount).toBe(0);
  });

  it("does not retry a permanent failure and records it once", async () => {
    const root = await createRoot();
    const filePath = await createMedia(root, "permanent.mp4", "permanent");
    const adapter = new SequenceAdapter(new Map([[filePath, [adapterFailure("INVALID_PROBE_OUTPUT", "NORMALIZATION")]]]));

    await retryOrchestrator(root, adapter, { maxRetries: 2 }).run(storageId);

    const file = await prisma.mediaFile.findFirstOrThrow({ orderBy: { createdAt: "desc" } });
    const scan = await prisma.scanJob.findFirstOrThrow({ orderBy: { createdAt: "desc" } });
    expect(adapter.attempts).toHaveLength(1);
    expect(file.metadataStatus).toBe("FAILED");
    expect(file.errorCode).toBe("INVALID_PROBE_OUTPUT");
    expect(file.errorStage).toBe("NORMALIZATION");
    expect(file.retryCount).toBe(0);
    expect(scan.status).toBe("COMPLETED_WITH_ERRORS");
    expect(scan.processedCount).toBe(1);
    expect(scan.failedCount).toBe(1);
  });

  it("exhausts the retry bound and ends in a deterministic FAILED state", async () => {
    const root = await createRoot();
    const filePath = await createMedia(root, "always-timeout.mp4", "always-timeout");
    const adapter = new SequenceAdapter(new Map([[filePath, [adapterFailure("FFPROBE_TIMEOUT", "FFPROBE")]]]));

    await retryOrchestrator(root, adapter, { maxRetries: 2 }).run(storageId);

    const file = await prisma.mediaFile.findFirstOrThrow({ orderBy: { createdAt: "desc" } });
    const scan = await prisma.scanJob.findFirstOrThrow({ orderBy: { createdAt: "desc" } });
    // 1 initial attempt + 2 retries.
    expect(adapter.attempts).toHaveLength(3);
    expect(file.metadataStatus).toBe("FAILED");
    expect(file.errorCode).toBe("FFPROBE_TIMEOUT");
    expect(file.retryCount).toBe(2);
    expect(scan.status).toBe("COMPLETED_WITH_ERRORS");
    expect(scan.processedCount).toBe(1);
    expect(scan.failedCount).toBe(1);
  });

  it("does not retry a transient failure when maxRetries is 0", async () => {
    const root = await createRoot();
    const filePath = await createMedia(root, "no-retry.mp4", "no-retry");
    const adapter = new SequenceAdapter(new Map([[filePath, [adapterFailure("FFPROBE_TIMEOUT", "FFPROBE")]]]));
    const runner = extractionRunner(root, adapter, { maxRetries: 0 });
    const { scanId, mediaFileId } = await createQueuedMedia("no-retry.mp4");

    await runner.drain(storageId, scanId);

    const file = await prisma.mediaFile.findUniqueOrThrow({ where: { id: mediaFileId } });
    expect(adapter.attempts).toHaveLength(1);
    expect(file.metadataStatus).toBe("FAILED");
    expect(file.errorCode).toBe("FFPROBE_TIMEOUT");
    expect(file.retryCount).toBe(0);
  });

  it("keeps the row PROCESSING during backoff so a concurrent reprocess conflicts", async () => {
    const root = await createRoot();
    const filePath = await createMedia(root, "busy-retry.mp4", "busy-retry");
    const adapter = new SequenceAdapter(new Map([[filePath, [adapterFailure("FFPROBE_TIMEOUT", "FFPROBE"), null]]]));
    let observedStatus: string | null = null;
    let concurrentReprocess: string | null = null;
    const runner = extractionRunner(root, adapter, {
      maxRetries: 2,
      retrySleep: async () => {
        observedStatus = (await prisma.mediaFile.findFirstOrThrow()).metadataStatus;
        concurrentReprocess = await reprocessor(root, new MockAdapter()).reprocessOne(
          (await prisma.mediaFile.findFirstOrThrow()).id,
        );
        // A second drain must not be able to claim the in-flight row.
        await extractionRunner(root, new MockAdapter(), { maxRetries: 0 }).drain(storageId, scanId);
      },
    });
    const { scanId, mediaFileId } = await createQueuedMedia("busy-retry.mp4");

    await runner.drain(storageId, scanId);

    expect(observedStatus).toBe("PROCESSING");
    expect(concurrentReprocess).toBe("CONFLICT");
    const file = await prisma.mediaFile.findUniqueOrThrow({ where: { id: mediaFileId } });
    expect(file.metadataStatus).toBe("READY");
    expect(adapter.attempts).toHaveLength(2);
  });

  it("resets retryCount on a fresh claim so a re-queued file gets the full retry budget again", async () => {
    const root = await createRoot();
    const filePath = await createMedia(root, "retry-reset.mp4", "retry-reset");
    // First pass exhausts retries and fails.
    const exhausting = new SequenceAdapter(new Map([[filePath, [adapterFailure("FFPROBE_TIMEOUT", "FFPROBE")]]]));
    const { scanId, mediaFileId } = await createQueuedMedia("retry-reset.mp4");
    await extractionRunner(root, exhausting, { maxRetries: 1 }).drain(storageId, scanId);

    const failed = await prisma.mediaFile.findUniqueOrThrow({ where: { id: mediaFileId } });
    expect(failed.metadataStatus).toBe("FAILED");
    expect(failed.retryCount).toBe(1);

    // Re-queueing an UPDATED file back to PENDING is deferred Phase 4 behavior
    // (orchestrator's UPDATED branch is observation-only), so simulate the
    // re-queue directly. The point under test is the claim-time reset: a fresh
    // claim must clear the exhausted retryCount and retry again.
    const recovery = new SequenceAdapter(new Map([[filePath, [adapterFailure("FFPROBE_TIMEOUT", "FFPROBE"), null]]]));
    const secondScanId = await createScan(1);
    await prisma.mediaFile.update({
      where: { id: mediaFileId },
      data: { metadataStatus: "PENDING", lastSeenScanId: secondScanId },
    });
    await extractionRunner(root, recovery, { maxRetries: 2 }).drain(storageId, secondScanId);

    const recovered = await prisma.mediaFile.findUniqueOrThrow({ where: { id: mediaFileId } });
    expect(recovery.attempts).toHaveLength(2);
    expect(recovered.metadataStatus).toBe("READY");
    expect(recovered.retryCount).toBe(0);
  });

  it("manual reprocess resets retryCount and succeeds", async () => {
    const root = await createRoot();
    await createMedia(root, "manual-reset.mp4", "manual-reset");
    await createQueuedMedia("manual-reset.mp4");
    const row = await prisma.mediaFile.findFirstOrThrow();
    await prisma.mediaFile.update({
      where: { id: row.id },
      data: {
        metadataStatus: "FAILED",
        retryCount: 2,
        errorCode: "FFPROBE_TIMEOUT",
        errorStage: "FFPROBE",
        errorMessage: "prior",
        errorAt: new Date(),
      },
    });

    const runner = extractionRunner(root, new MockAdapter(), { maxRetries: 2 });
    await expect(createExtractionReprocessor(runner).reprocessOne(row.id)).resolves.toBe("STARTED");
    await waitForReady(row.id);

    const recovered = await prisma.mediaFile.findUniqueOrThrow({ where: { id: row.id } });
    expect(recovered.retryCount).toBe(0);
    expect(recovered.errorCode).toBeNull();
  });

  it("sweeps a PROCESSING row left mid-retry to FAILED/INTERRUPTED and leaves it reprocessable", async () => {
    const root = await createRoot();
    await createMedia(root, "interrupted-retry.mp4", "interrupted-retry");
    const { mediaFileId } = await createQueuedMedia("interrupted-retry.mp4");

    // Represent the process dying after the claim but before the terminal write.
    await prisma.mediaFile.update({ where: { id: mediaFileId }, data: { metadataStatus: "PROCESSING", retryCount: 1 } });

    await sweepInterruptedState(prisma);

    const swept = await prisma.mediaFile.findUniqueOrThrow({ where: { id: mediaFileId } });
    expect(swept.metadataStatus).toBe("FAILED");
    expect(swept.errorCode).toBe("INTERRUPTED");

    const runner = extractionRunner(root, new MockAdapter(), { maxRetries: 2 });
    await expect(createExtractionReprocessor(runner).reprocessOne(mediaFileId)).resolves.toBe("STARTED");
    await waitForReady(mediaFileId);
  });

  it("still reaches a terminal state if the backoff sleep itself fails", async () => {
    const root = await createRoot();
    const filePath = await createMedia(root, "sleep-throws.mp4", "sleep-throws");
    const adapter = new SequenceAdapter(new Map([[filePath, [adapterFailure("FFPROBE_TIMEOUT", "FFPROBE"), null]]]));
    const runner = extractionRunner(root, adapter, {
      maxRetries: 2,
      retrySleep: async () => {
        throw new Error("sleep seam failure");
      },
    });
    const { scanId, mediaFileId } = await createQueuedMedia("sleep-throws.mp4");

    await runner.drain(storageId, scanId);

    const file = await prisma.mediaFile.findUniqueOrThrow({ where: { id: mediaFileId } });
    // The throwing sleep must not strand the row in PROCESSING: the retry runs
    // immediately and succeeds on attempt 2.
    expect(adapter.attempts).toHaveLength(2);
    expect(file.metadataStatus).toBe("READY");
  });

  it("leaves the source media tree byte-identical through a full retry sequence", async () => {
    const root = await createRoot();
    const filePath = await createMedia(root, "byte-stable.mp4", "byte-stable");
    const before = await snapshotMediaTree(root);
    const adapter = new SequenceAdapter(new Map([[filePath, [adapterFailure("FFPROBE_TIMEOUT", "FFPROBE"), null]]]));
    const runner = extractionRunner(root, adapter, { maxRetries: 2 });
    const { scanId } = await createQueuedMedia("byte-stable.mp4");

    await runner.drain(storageId, scanId);

    expect(await snapshotMediaTree(root)).toEqual(before);
  });
});

export type TestPrisma = PrismaClient;
