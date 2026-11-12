import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ExtractionRunner } from "../scan/extractor.js";
import { createExtractionReprocessor } from "./reprocess.js";
import type { FFprobeAdapter, FFprobeResult } from "../metadata/ffprobe-adapter.js";
import { InvalidProbeOutputError } from "../metadata/ffprobe-adapter.js";

interface FakeMediaRow {
  id: string;
  relativePath: string;
  metadataStatus: string;
  lastSeenScanId: string;
  durationSeconds: number | null;
  videoCodec: string | null;
  width: number | null;
  height: number | null;
  frameRateNumerator: number | null;
  frameRateDenominator: number | null;
  technicalMetadata: unknown;
  rawProbeData: unknown;
  errorCode: string | null;
  errorMessage: string | null;
  errorStage: string | null;
  errorAt: Date | null;
  lastMetadataExtractedAt: Date | null;
}

function makeRow(id: string, metadataStatus: string, overrides: Partial<FakeMediaRow> = {}): FakeMediaRow {
  return {
    id,
    relativePath: `${id}.mp4`,
    metadataStatus,
    lastSeenScanId: "scan-1",
    durationSeconds: null,
    videoCodec: null,
    width: null,
    height: null,
    frameRateNumerator: null,
    frameRateDenominator: null,
    technicalMetadata: null,
    rawProbeData: null,
    errorCode: null,
    errorMessage: null,
    errorStage: null,
    errorAt: null,
    lastMetadataExtractedAt: null,
    ...overrides,
  };
}

/**
 * Minimal in-memory Prisma stand-in. It models only the compare-and-set
 * operations `reprocessOne` uses so the claim decision table can be exercised
 * without a database. `scanJob.update` throws to prove reprocess never touches
 * scan counters.
 */
function createFakePrisma(rows: FakeMediaRow[]) {
  const scanJobUpdates: string[] = [];
  const prisma = {
    mediaFile: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        rows.find((row) => row.id === where.id) ?? null,
      updateMany: async ({
        where,
        data,
      }: {
        where: { id: string; metadataStatus?: { in: string[] } };
        data: { metadataStatus: string };
      }) => {
        const row = rows.find((item) => item.id === where.id);
        if (row === undefined) return { count: 0 };
        const allowed = where.metadataStatus?.in;
        if (allowed !== undefined && !allowed.includes(row.metadataStatus)) return { count: 0 };
        row.metadataStatus = data.metadataStatus;
        return { count: 1 };
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = rows.find((item) => item.id === where.id);
        if (row === undefined) throw new Error(`unknown media file ${where.id}`);
        Object.assign(row, data);
        return row;
      },
    },
    scanJob: {
      findFirst: async () => null,
      update: async ({ where }: { where: { id: string } }) => {
        scanJobUpdates.push(where.id);
        throw new Error("reprocess must not touch ScanJob counters");
      },
    },
  };
  return { prisma, rows, scanJobUpdates };
}

const probeResult: FFprobeResult = {
  parsed: {
    format: { duration: "12.5", format_name: "mock" },
    streams: [{ codec_type: "video", codec_name: "h264", width: 1920, height: 1080, r_frame_rate: "30000/1001" }],
  },
  rawJson: JSON.stringify({ format: { duration: "12.5", format_name: "mock" }, streams: [] }),
};

class FakeAdapter implements FFprobeAdapter {
  public constructor(private readonly mode: "success" | "failure" = "success") {}

  public async probe(): Promise<FFprobeResult> {
    if (this.mode === "failure") {
      throw new InvalidProbeOutputError("mock invalid probe output");
    }
    return probeResult;
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out waiting for condition");
}

let root: string;

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "tmip-reprocess-"));
  for (const name of ["ready.mp4", "failed.mp4", "pending.mp4", "processing.mp4", "failing.mp4"]) {
    await writeFile(path.join(root, name), "media");
  }
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

function runner(rows: FakeMediaRow[], mode: "success" | "failure" = "success") {
  const fake = createFakePrisma(rows);
  const extractor = new ExtractionRunner({
    prisma: fake.prisma as never,
    adapter: new FakeAdapter(mode),
    storageRoot: root,
  });
  return { extractor, ...fake };
}

describe("ExtractionRunner.reprocessOne", () => {
  it("accepts a READY row, re-runs extraction, and leaves it READY", async () => {
    const rows = [makeRow("ready", "READY", { videoCodec: "old" })];
    const { extractor } = runner(rows);

    await expect(extractor.reprocessOne("ready")).resolves.toBe("STARTED");
    await waitFor(() => rows[0]?.metadataStatus === "READY" && rows[0]?.videoCodec === "h264");

    expect(rows[0]?.metadataStatus).toBe("READY");
    expect(rows[0]?.videoCodec).toBe("h264");
    expect(rows[0]?.errorCode).toBeNull();
  });

  it("accepts a FAILED row and clears previous error fields on success", async () => {
    const rows = [makeRow("failed", "FAILED", {
      errorCode: "FFPROBE_FAILED",
      errorMessage: "old failure",
      errorStage: "FFPROBE",
      errorAt: new Date("2020-01-01T00:00:00.000Z"),
    })];
    const { extractor } = runner(rows);

    await expect(extractor.reprocessOne("failed")).resolves.toBe("STARTED");
    await waitFor(() => rows[0]?.metadataStatus === "READY");

    expect(rows[0]?.metadataStatus).toBe("READY");
    expect(rows[0]?.errorCode).toBeNull();
    expect(rows[0]?.errorMessage).toBeNull();
    expect(rows[0]?.errorStage).toBeNull();
    expect(rows[0]?.errorAt).toBeNull();
    expect(rows[0]?.lastMetadataExtractedAt).not.toBeNull();
  });

  it("records the new failure when the reprocess probe fails again", async () => {
    const rows = [makeRow("failing", "FAILED", { errorCode: "FFPROBE_FAILED", errorStage: "FFPROBE" })];
    const { extractor } = runner(rows, "failure");

    await expect(extractor.reprocessOne("failing")).resolves.toBe("STARTED");
    await waitFor(() => rows[0]?.errorCode === "INVALID_PROBE_OUTPUT");

    expect(rows[0]?.metadataStatus).toBe("FAILED");
    expect(rows[0]?.errorCode).toBe("INVALID_PROBE_OUTPUT");
    expect(rows[0]?.errorStage).toBe("NORMALIZATION");
    expect(rows[0]?.errorAt).not.toBeNull();
  });

  it.each(["PENDING", "PROCESSING"])("rejects a %s row with CONFLICT without probing", async (status) => {
    const rows = [makeRow("pending", status)];
    const { extractor } = runner(rows);

    await expect(extractor.reprocessOne("pending")).resolves.toBe("CONFLICT");
    // The rejected row keeps its status; no claim, no extraction.
    expect(rows[0]?.metadataStatus).toBe(status);
    expect(rows[0]?.lastMetadataExtractedAt).toBeNull();
  });

  it("returns NOT_FOUND for an unknown id", async () => {
    const { extractor } = runner([]);
    await expect(extractor.reprocessOne("missing")).resolves.toBe("NOT_FOUND");
  });

  it("never touches ScanJob counters and never rewrites lastSeenScanId", async () => {
    const rows = [makeRow("ready", "READY")];
    const { extractor, scanJobUpdates } = runner(rows);

    await extractor.reprocessOne("ready");
    await waitFor(() => rows[0]?.metadataStatus === "READY");

    expect(scanJobUpdates).toEqual([]);
    expect(rows[0]?.lastSeenScanId).toBe("scan-1");
  });
});

describe("MediaReprocessor", () => {
  it("delegates to ExtractionRunner.reprocessOne", async () => {
    const rows = [makeRow("ready", "READY")];
    const { extractor } = runner(rows);
    const reprocessor = createExtractionReprocessor(extractor);

    await expect(reprocessor.reprocessOne("ready")).resolves.toBe("STARTED");
    await waitFor(() => rows[0]?.metadataStatus === "READY");
    await expect(reprocessor.reprocessOne("missing")).resolves.toBe("NOT_FOUND");
  });
});
