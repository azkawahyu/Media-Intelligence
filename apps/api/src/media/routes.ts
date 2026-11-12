import express, { type Request, type Response, type Router } from "express";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import type { MediaReprocessor } from "./reprocess.js";

const mediaListQuerySchema = z.object({
  page: z.string().regex(/^\d+$/, "page must be a positive integer").transform(Number).pipe(z.number().int().min(1)),
  pageSize: z.string().regex(/^\d+$/, "pageSize must be a positive integer").transform(Number).pipe(z.number().int().min(1).max(100)),
}).partial().strict().default({});

const isoDateSchema = z.string().datetime({ offset: true });
const nullableIsoDateSchema = isoDateSchema.nullable();
const nullableNumberSchema = z.number().nullable();
const nullableStringSchema = z.string().nullable();

const mediaListItemSchema = z.object({
  id: z.string(),
  storageId: z.string(),
  relativePath: z.string(),
  filename: z.string(),
  extension: z.string(),
  fileSize: z.string(),
  modifiedAt: isoDateSchema,
  status: z.string(),
  metadataStatus: z.string(),
  durationSeconds: nullableNumberSchema,
  videoCodec: nullableStringSchema,
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  frameRateNumerator: z.number().int().nullable(),
  frameRateDenominator: z.number().int().nullable(),
  firstSeenAt: isoDateSchema,
  lastSeenAt: isoDateSchema,
  lastMetadataExtractedAt: nullableIsoDateSchema,
  aiStatus: z.string(),
  aiPartial: z.boolean(),
  aiProcessedAt: nullableIsoDateSchema,
});

const mediaListResponseSchema = z.object({
  items: z.array(mediaListItemSchema),
  pagination: z.object({ page: z.number().int(), pageSize: z.number().int(), total: z.number().int() }),
});

/** Per-stage AI result row as exposed on the detail endpoint (ADR-006 §17). */
const aiStageResultSchema = z.object({
  stage: z.string(),
  status: z.string(),
  payload: z.unknown().nullable(),
  errorCode: nullableStringSchema,
  errorMessage: nullableStringSchema,
  attemptedAt: isoDateSchema,
});

const mediaDetailSchema = z.object({
  id: z.string(),
  storageId: z.string(),
  relativePath: z.string(),
  filename: z.string(),
  extension: z.string(),
  fileSize: z.string(),
  modifiedAt: isoDateSchema,
  status: z.string(),
  metadataStatus: z.string(),
  durationSeconds: nullableNumberSchema,
  videoCodec: nullableStringSchema,
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  frameRateNumerator: z.number().int().nullable(),
  frameRateDenominator: z.number().int().nullable(),
  audioCodec: nullableStringSchema,
  audioSampleRate: z.number().int().nullable(),
  audioChannels: z.number().int().nullable(),
  technicalMetadata: z.unknown().nullable(),
  rawProbeData: z.unknown().nullable(),
  errorCode: nullableStringSchema,
  errorMessage: nullableStringSchema,
  errorStage: nullableStringSchema,
  errorAt: nullableIsoDateSchema,
  retryCount: z.number().int().nonnegative(),
  firstSeenAt: isoDateSchema,
  lastSeenAt: isoDateSchema,
  lastSeenScanId: z.string(),
  lastMetadataExtractedAt: nullableIsoDateSchema,
  aiStatus: z.string(),
  aiPartial: z.boolean(),
  aiAttempt: z.number().int().nonnegative(),
  aiExternalJobId: nullableStringSchema,
  aiErrorCode: nullableStringSchema,
  aiErrorMessage: nullableStringSchema,
  aiErrorAt: nullableIsoDateSchema,
  aiProcessedAt: nullableIsoDateSchema,
  /** Durable cancellation intent (ADR-006 §18): non-null while a stop is pending. */
  aiCancelRequestedAt: nullableIsoDateSchema,
  ai: z.object({
    stages: z.array(aiStageResultSchema),
  }),
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema,
});

type MediaRouteDatabase = Pick<PrismaClient, "mediaFile">;
export interface MediaRouteOptions {
  prisma: MediaRouteDatabase;
  reprocessor?: MediaReprocessor;
}

function serializeDate(value: Date): string {
  return value.toISOString();
}

function serializeListItem(media: {
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
  firstSeenAt: Date;
  lastSeenAt: Date;
  lastMetadataExtractedAt: Date | null;
  aiStatus: string;
  aiPartial: boolean;
  aiProcessedAt: Date | null;
}) {
  return {
    id: media.id,
    storageId: media.storageId,
    relativePath: media.relativePath,
    filename: media.filename,
    extension: media.extension,
    fileSize: media.fileSize.toString(),
    modifiedAt: serializeDate(media.modifiedAt),
    status: media.status,
    metadataStatus: media.metadataStatus,
    durationSeconds: media.durationSeconds,
    videoCodec: media.videoCodec,
    width: media.width,
    height: media.height,
    frameRateNumerator: media.frameRateNumerator,
    frameRateDenominator: media.frameRateDenominator,
    firstSeenAt: serializeDate(media.firstSeenAt),
    lastSeenAt: serializeDate(media.lastSeenAt),
    lastMetadataExtractedAt: media.lastMetadataExtractedAt === null ? null : serializeDate(media.lastMetadataExtractedAt),
    aiStatus: media.aiStatus,
    aiPartial: media.aiPartial,
    aiProcessedAt: media.aiProcessedAt === null ? null : serializeDate(media.aiProcessedAt),
  };
}

function serializeDetail(media: {
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
}) {
  return {
    id: media.id,
    storageId: media.storageId,
    relativePath: media.relativePath,
    filename: media.filename,
    extension: media.extension,
    fileSize: media.fileSize.toString(),
    modifiedAt: serializeDate(media.modifiedAt),
    status: media.status,
    metadataStatus: media.metadataStatus,
    durationSeconds: media.durationSeconds,
    videoCodec: media.videoCodec,
    width: media.width,
    height: media.height,
    frameRateNumerator: media.frameRateNumerator,
    frameRateDenominator: media.frameRateDenominator,
    audioCodec: media.audioCodec,
    audioSampleRate: media.audioSampleRate,
    audioChannels: media.audioChannels,
    technicalMetadata: media.technicalMetadata,
    rawProbeData: media.rawProbeData,
    errorCode: media.errorCode,
    errorMessage: media.errorMessage,
    errorStage: media.errorStage,
    errorAt: media.errorAt === null ? null : serializeDate(media.errorAt),
    retryCount: media.retryCount,
    firstSeenAt: serializeDate(media.firstSeenAt),
    lastSeenAt: serializeDate(media.lastSeenAt),
    lastSeenScanId: media.lastSeenScanId,
    lastMetadataExtractedAt: media.lastMetadataExtractedAt === null ? null : serializeDate(media.lastMetadataExtractedAt),
    aiStatus: media.aiStatus,
    aiPartial: media.aiPartial,
    aiAttempt: media.aiAttempt,
    aiExternalJobId: media.aiExternalJobId,
    aiErrorCode: media.aiErrorCode,
    aiErrorMessage: media.aiErrorMessage,
    aiErrorAt: media.aiErrorAt === null ? null : serializeDate(media.aiErrorAt),
    aiProcessedAt: media.aiProcessedAt === null ? null : serializeDate(media.aiProcessedAt),
    aiCancelRequestedAt: media.aiCancelRequestedAt === null ? null : serializeDate(media.aiCancelRequestedAt),
    ai: {
      stages: (media.aiResults ?? []).map((result) => ({
        stage: result.stage,
        status: result.status,
        payload: result.payload ?? null,
        errorCode: result.errorCode,
        errorMessage: result.errorMessage,
        attemptedAt: serializeDate(result.attemptedAt),
      })),
    },
    createdAt: serializeDate(media.createdAt),
    updatedAt: serializeDate(media.updatedAt),
  };
}

export function createMediaRouter(options: MediaRouteOptions): Router {
  const router = express.Router();

  router.get("/media", async (req: Request, res: Response): Promise<void> => {
    const parsed = mediaListQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Query parameters page and pageSize must be positive integers; pageSize must be at most 100" });
      return;
    }
    const page = parsed.data.page ?? 1;
    const pageSize = parsed.data.pageSize ?? 20;
    const [media, total] = await Promise.all([
      options.prisma.mediaFile.findMany({
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      options.prisma.mediaFile.count(),
    ]);
    const response = mediaListResponseSchema.parse({
      items: media.map(serializeListItem),
      pagination: { page, pageSize, total },
    });
    res.status(200).json(response);
  });

  router.get("/media/:id", async (req: Request, res: Response): Promise<void> => {
    const id = typeof req.params.id === "string" ? req.params.id : undefined;
    const media = id === undefined
      ? null
      : await options.prisma.mediaFile.findUnique({
          where: { id },
          include: {
            aiResults: {
              orderBy: { stage: "asc" },
            },
          },
        });
    if (media === null) {
      res.status(404).json({ error: "Media not found" });
      return;
    }
    const response = mediaDetailSchema.parse(serializeDetail(media));
    res.status(200).json(response);
  });

  router.post("/media/:id/reprocess", async (req: Request, res: Response): Promise<void> => {
    const reprocessor = options.reprocessor;
    if (reprocessor === undefined) {
      res.status(500).json({ error: "Reprocessing is not available" });
      return;
    }
    const id = typeof req.params.id === "string" ? req.params.id : undefined;
    if (id === undefined) {
      res.status(404).json({ error: "Media not found" });
      return;
    }
    let result: "STARTED" | "CONFLICT" | "NOT_FOUND";
    try {
      result = await reprocessor.reprocessOne(id);
    } catch {
      res.status(500).json({ error: "Reprocessing failed to start" });
      return;
    }
    if (result === "NOT_FOUND") {
      res.status(404).json({ error: "Media not found" });
      return;
    }
    if (result === "CONFLICT") {
      res.status(409).json({ error: "Metadata reprocessing is already in progress for this media file" });
      return;
    }
    res.status(202).json({ mediaFileId: id, metadataStatus: "PROCESSING" });
  });

  return router;
}

export { mediaListQuerySchema, mediaListResponseSchema, mediaDetailSchema, serializeDetail, serializeListItem };
