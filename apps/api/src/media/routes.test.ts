import http from "node:http";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import type { MediaReprocessor } from "./reprocess.js";

const now = new Date("2026-09-30T12:00:00.000Z");

interface TestMedia {
  id: string;
  storageId: string;
  relativePath: string;
  filename: string;
  extension: string;
  fileSize: bigint;
  modifiedAt: Date;
  status: string;
  metadataStatus: string;
  durationSeconds: number | null;
  videoCodec: string | null;
  width: number | null;
  height: number | null;
  frameRateNumerator: number | null;
  frameRateDenominator: number | null;
  audioCodec: string | null;
  audioSampleRate: number | null;
  audioChannels: number | null;
  technicalMetadata: unknown;
  rawProbeData: unknown;
  errorCode: string | null;
  errorMessage: string | null;
  errorStage: string | null;
  errorAt: Date | null;
  retryCount: number;
  firstSeenAt: Date;
  lastSeenAt: Date;
  lastSeenScanId: string;
  lastMetadataExtractedAt: Date | null;
  aiStatus: string;
  aiPartial: boolean;
  aiAttempt: number;
  aiExternalJobId: string | null;
  aiErrorCode: string | null;
  aiErrorMessage: string | null;
  aiErrorAt: Date | null;
  aiProcessedAt: Date | null;
  aiCancelRequestedAt: Date | null;
  aiResults?: {
    stage: string;
    status: string;
    payload: unknown;
    errorCode: string | null;
    errorMessage: string | null;
    attemptedAt: Date;
  }[];
  createdAt: Date;
  updatedAt: Date;
}

function makeMedia(id: string, overrides: Partial<TestMedia> = {}): TestMedia {
  return {
    id,
    storageId: "storage-1",
    relativePath: `${id}/file.mp4`,
    filename: `${id}.mp4`,
    extension: ".mp4",
    fileSize: BigInt(1234567890123),
    modifiedAt: now,
    status: "ACTIVE",
    metadataStatus: "READY",
    durationSeconds: 12.5,
    videoCodec: "h264",
    width: 1920,
    height: 1080,
    frameRateNumerator: 30000,
    frameRateDenominator: 1001,
    audioCodec: "aac",
    audioSampleRate: 48000,
    audioChannels: 2,
    technicalMetadata: { containerFormat: "mp4" } as unknown,
    rawProbeData: { format: { filename: "source.mp4" } } as unknown,
    errorCode: null,
    errorMessage: null,
    errorStage: null,
    errorAt: null,
    retryCount: 0,
    firstSeenAt: now,
    lastSeenAt: now,
    lastSeenScanId: "scan-1",
    lastMetadataExtractedAt: now,
    aiStatus: "PENDING",
    aiPartial: false,
    aiAttempt: 0,
    aiExternalJobId: null,
    aiErrorCode: null,
    aiErrorMessage: null,
    aiErrorAt: null,
    aiProcessedAt: null,
    aiCancelRequestedAt: null,
    aiResults: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function createMediaDatabase(media: TestMedia[]) {
  return {
    $queryRaw: async () => [{ result: 1 }],
    storage: { findUnique: async () => null },
    scanJob: { findFirst: async () => null, create: async () => makeMedia("unused"), findUnique: async () => null, findMany: async () => [] },
    mediaFile: {
      findMany: async ({ skip, take }: { skip: number; take: number }) => media.slice(skip, skip + take),
      count: async () => media.length,
      findUnique: async ({ where }: { where: { id: string } }) => media.find((item) => item.id === where.id) ?? null,
      updateMany: async ({ where, data }: { where: { id: string; metadataStatus?: { in: string[] } }; data: { metadataStatus: string } }) => {
        const item = media.find((entry) => entry.id === where.id);
        if (item === undefined) return { count: 0 };
        const allowed = where.metadataStatus?.in;
        if (allowed !== undefined && !allowed.includes(item.metadataStatus)) return { count: 0 };
        item.metadataStatus = data.metadataStatus;
        return { count: 1 };
      },
    },
  };
}

async function withServer(app: ReturnType<typeof createApp>, test: (baseUrl: string) => Promise<void>) {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("server did not bind");
  try {
    await test(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

const appConfig = { mediaRoot: "/unused", storageName: "Configured", supportedMediaExtensions: [".mp4"] };

describe("media API", () => {
  it("returns deterministic paginated list rows with string file sizes", async () => {
    const database = createMediaDatabase([makeMedia("a"), makeMedia("b"), makeMedia("c")]);
    await withServer(createApp({ prisma: database as never, config: appConfig }), async (baseUrl) => {
      const response = await fetch(`${baseUrl}/media?page=2&pageSize=1`);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        items: [{ id: "b", fileSize: "1234567890123", modifiedAt: now.toISOString() }],
        pagination: { page: 2, pageSize: 1, total: 3 },
      });
    });
  });

  it("returns an empty page for an empty database", async () => {
    await withServer(createApp({ prisma: createMediaDatabase([]) as never, config: appConfig }), async (baseUrl) => {
      const response = await fetch(`${baseUrl}/media`);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ items: [], pagination: { page: 1, pageSize: 20, total: 0 } });
    });
  });

  it.each(["0", "-1", "abc"]) ("rejects invalid page %s", async (page) => {
    await withServer(createApp({ prisma: createMediaDatabase([]) as never, config: appConfig }), async (baseUrl) => {
      expect((await fetch(`${baseUrl}/media?page=${page}`)).status).toBe(400);
    });
  });

  it.each(["0", "-1", "abc", "101"]) ("rejects invalid pageSize %s", async (pageSize) => {
    await withServer(createApp({ prisma: createMediaDatabase([]) as never, config: appConfig }), async (baseUrl) => {
      expect((await fetch(`${baseUrl}/media?pageSize=${pageSize}`)).status).toBe(400);
    });
  });

  it("returns complete persisted detail data, including JSONB and failure fields", async () => {
    const ready = makeMedia("ready");
    const failed = makeMedia("failed", {
      metadataStatus: "FAILED",
      technicalMetadata: null,
      rawProbeData: null,
      errorCode: "FFPROBE_FAILED",
      errorMessage: "probe failed",
      errorStage: "FFPROBE",
      errorAt: now,
      lastMetadataExtractedAt: null,
    });
    const database = createMediaDatabase([ready, failed]);
    await withServer(createApp({ prisma: database as never, config: appConfig }), async (baseUrl) => {
      const response = await fetch(`${baseUrl}/media/ready`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        id: "ready", storageId: "storage-1", relativePath: "ready/file.mp4", filename: "ready.mp4", extension: ".mp4",
        fileSize: "1234567890123", modifiedAt: now.toISOString(), status: "ACTIVE", metadataStatus: "READY",
        durationSeconds: 12.5, videoCodec: "h264", width: 1920, height: 1080, frameRateNumerator: 30000, frameRateDenominator: 1001,
        audioCodec: "aac", audioSampleRate: 48000, audioChannels: 2, technicalMetadata: { containerFormat: "mp4" },
        rawProbeData: { format: { filename: "source.mp4" } }, errorCode: null, errorMessage: null, errorStage: null, errorAt: null, retryCount: 0,
        firstSeenAt: now.toISOString(), lastSeenAt: now.toISOString(), lastSeenScanId: "scan-1", lastMetadataExtractedAt: now.toISOString(),
        aiStatus: "PENDING", aiPartial: false, aiAttempt: 0, aiExternalJobId: null,
        aiErrorCode: null, aiErrorMessage: null, aiErrorAt: null, aiProcessedAt: null, aiCancelRequestedAt: null,
        ai: { stages: [] },
        createdAt: now.toISOString(), updatedAt: now.toISOString(),
      });
      expect(await (await fetch(`${baseUrl}/media/failed`)).json()).toMatchObject({ metadataStatus: "FAILED", errorCode: "FFPROBE_FAILED", errorStage: "FFPROBE" });
      expect((await fetch(`${baseUrl}/media/unknown`)).status).toBe(404);
    });
  });

  it("accepts a reprocess request with 202 and detaches the work", async () => {
    const calls: string[] = [];
    const reprocessor = {
      reprocessOne: async (id: string) => {
        calls.push(id);
        return "STARTED" as const;
      },
    } as MediaReprocessor;
    const database = createMediaDatabase([makeMedia("a")]);
    await withServer(createApp({ prisma: database as never, config: appConfig, reprocessor }), async (baseUrl) => {
      const response = await fetch(`${baseUrl}/media/a/reprocess`, { method: "POST" });
      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({ mediaFileId: "a", metadataStatus: "PROCESSING" });
      expect(calls).toEqual(["a"]);
    });
  });

  it("returns 404 for an unknown media id and 409 for a conflicting reprocess", async () => {
    const results = new Map<string, "STARTED" | "CONFLICT" | "NOT_FOUND">([
      ["missing", "NOT_FOUND"],
      ["busy", "CONFLICT"],
    ]);
    const reprocessor = {
      reprocessOne: async (id: string) => results.get(id) ?? ("STARTED" as const),
    } as MediaReprocessor;
    const database = createMediaDatabase([makeMedia("busy")]);
    await withServer(createApp({ prisma: database as never, config: appConfig, reprocessor }), async (baseUrl) => {
      expect((await fetch(`${baseUrl}/media/missing/reprocess`, { method: "POST" })).status).toBe(404);
      expect((await fetch(`${baseUrl}/media/busy/reprocess`, { method: "POST" })).status).toBe(409);
    });
  });

  it("returns 500 when no reprocessor is configured", async () => {
    const database = createMediaDatabase([makeMedia("a")]);
    await withServer(createApp({ prisma: database as never, config: appConfig }), async (baseUrl) => {
      expect((await fetch(`${baseUrl}/media/a/reprocess`, { method: "POST" })).status).toBe(500);
    });
  });

  it("returns 500 when the reprocessor throws unexpectedly", async () => {
    const reprocessor = {
      reprocessOne: async () => {
        throw new Error("unexpected");
      },
    } as MediaReprocessor;
    const database = createMediaDatabase([makeMedia("a")]);
    await withServer(createApp({ prisma: database as never, config: appConfig, reprocessor }), async (baseUrl) => {
      expect((await fetch(`${baseUrl}/media/a/reprocess`, { method: "POST" })).status).toBe(500);
    });
  });
});
