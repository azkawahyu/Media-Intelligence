import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { PrismaClient } from "@prisma/client";
import { ScanOrchestrator } from "./orchestrator.js";
import type { Router, Request, Response } from "express";
import express from "express";

const startScanBodySchema = z
  .object({ storageId: z.string().trim().min(1).optional() })
  .strict();

const activeStatuses = ["PENDING", "RUNNING"] as const;

type ScanApiDatabase = Pick<PrismaClient, "storage" | "scanJob">;
export type ScanRouteDatabase = ScanApiDatabase & Pick<PrismaClient, "mediaFile" | "$transaction">;

export interface ScanRouteDependencies {
  prisma: ScanRouteDatabase;
  config: Pick<AppConfig, "mediaRoot" | "supportedMediaExtensions" | "storageName">;
}

export interface ScanRouteOptions extends ScanRouteDependencies {
  orchestrator?: ScanOrchestrator;
}

function serializeScan(scan: {
  id: string;
  storageId: string;
  status: string;
  startedAt: Date;
  discoveryCompletedAt: Date | null;
  completedAt: Date | null;
  discoveredCount: number;
  newCount: number;
  updatedCount: number;
  unchangedCount: number;
  missingCount: number;
  queuedCount: number;
  processedCount: number;
  failedCount: number;
  errorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    scanId: scan.id,
    storageId: scan.storageId,
    status: scan.status,
    counters: {
      discoveredCount: scan.discoveredCount,
      newCount: scan.newCount,
      updatedCount: scan.updatedCount,
      unchangedCount: scan.unchangedCount,
      missingCount: scan.missingCount,
      queuedCount: scan.queuedCount,
      processedCount: scan.processedCount,
      failedCount: scan.failedCount,
    },
    startedAt: scan.startedAt,
    discoveryCompletedAt: scan.discoveryCompletedAt,
    completedAt: scan.completedAt,
    errorMessage: scan.errorMessage,
    createdAt: scan.createdAt,
    updatedAt: scan.updatedAt,
  };
}

function sendBadRequest(res: Response, message: string): void {
  res.status(400).json({ error: message });
}

/**
 * A process-local mutex serializes the active-scan check and ScanJob create.
 * Annex A D1 explicitly scopes this guard to one API instance.
 */
class StartScanMutex {
  private tail: Promise<void> = Promise.resolve();

  public async run<T>(operation: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const turn = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this.tail;
    this.tail = previous.then(() => turn);
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

export function createScanRouter(options: ScanRouteOptions): Router {
  const router = express.Router();
  const mutex = new StartScanMutex();
  const orchestrator = options.orchestrator ?? new ScanOrchestrator({
    prisma: options.prisma,
    config: options.config,
  });

  router.post("/scans", async (req: Request, res: Response): Promise<void> => {
    const parsed = startScanBodySchema.safeParse(req.body === undefined ? {} : req.body);
    if (!parsed.success) {
      sendBadRequest(res, "Request body must contain only an optional storageId string");
      return;
    }
    const body = parsed.data;

    await mutex.run(async () => {
      const configuredStorage = await options.prisma.storage.findUnique({
        where: { name: options.config.storageName },
      });
      if (configuredStorage === null || !configuredStorage.enabled) {
        sendBadRequest(res, "Configured storage is unavailable");
        return;
      }
      if (body.storageId !== undefined && body.storageId !== configuredStorage.id) {
        sendBadRequest(res, "storageId does not match the configured storage");
        return;
      }

      const active = await options.prisma.scanJob.findFirst({
        where: {
          storageId: configuredStorage.id,
          status: { in: [...activeStatuses] },
        },
        orderBy: { createdAt: "desc" },
      });
      if (active !== null) {
        res.status(409).json({ error: "A scan is already pending or running for this storage" });
        return;
      }

      const scan = await options.prisma.scanJob.create({
        data: {
          storageId: configuredStorage.id,
          status: "PENDING",
          startedAt: new Date(),
        },
      });
      res.status(202).json({ scanId: scan.id });
      void orchestrator.run(configuredStorage.id, scan.id);
    });
  });

  router.get("/scans/:id", async (req: Request, res: Response): Promise<void> => {
    const scanId = typeof req.params.id === "string" ? req.params.id : undefined;
    const scan = scanId === undefined
      ? null
      : await options.prisma.scanJob.findUnique({ where: { id: scanId } });
    if (scan === null) {
      res.status(404).json({ error: "Scan not found" });
      return;
    }
    res.status(200).json(serializeScan(scan));
  });

  router.get("/scans", async (_req: Request, res: Response): Promise<void> => {
    const scans = await options.prisma.scanJob.findMany({
      orderBy: { createdAt: "desc" },
      take: 20,
    });
    res.status(200).json({ scans: scans.map(serializeScan) });
  });

  return router;
}

export { serializeScan };
