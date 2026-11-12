import { access, constants, stat } from "node:fs/promises";
import type { AppConfig } from "../config.js";
import type { DiscoveredFile } from "../scanner.js";
import { scanStorage } from "../scanner.js";
import { classifyDiscoveredFile } from "./classify.js";
import type { PrismaClient } from "@prisma/client";
import type { ExtractionRunner } from "./extractor.js";

export type ScanDatabase = Pick<
  PrismaClient,
  "scanJob" | "mediaFile" | "$transaction"
>;

export interface ScanOrchestratorOptions {
  prisma: ScanDatabase;
  config: Pick<AppConfig, "mediaRoot" | "supportedMediaExtensions">;
  extractor?: ExtractionRunner;
  /**
   * AI auto-enqueue gate (ADR-006 §5, Plan 006 §5). When true, a NEW file is
   * explicitly marked `aiStatus = PENDING` at discovery time so the AiRunner can
   * pick it up once its technical metadata is READY. Defaults to false.
   *
   * Enqueue is deliberately detached from scan accounting: it never increments
   * `ScanJob.queuedCount`/`processedCount` (those describe the metadata pipeline
   * and drive the scan completion gate). See Plan 006 §5 "Enqueue isolation".
   */
  aiEnabled?: boolean;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Runs discovery and persists each observation independently. The optional
 * scanId is used by the HTTP boundary, which creates the PENDING row before
 * detaching this long-running operation.
 */
export class ScanOrchestrator {
  private readonly prisma: ScanDatabase;
  private readonly config: ScanOrchestratorOptions["config"];
  private readonly extractor?: ExtractionRunner;
  private readonly aiEnabled: boolean;

  public constructor(options: ScanOrchestratorOptions) {
    this.prisma = options.prisma;
    this.config = options.config;
    this.extractor = options.extractor;
    this.aiEnabled = options.aiEnabled ?? false;
  }

  public async run(storageId: string, scanId?: string): Promise<void> {
    let activeScanId = scanId;

    try {
      if (activeScanId === undefined) {
        const scan = await this.prisma.scanJob.create({
          data: {
            storageId,
            status: "PENDING",
            startedAt: new Date(),
          },
        });
        activeScanId = scan.id;
      }

      await this.prisma.scanJob.update({
        where: { id: activeScanId },
        data: { status: "RUNNING", startedAt: new Date() },
      });

      await this.ensureStorageAvailable();

      await scanStorage(this.config, storageId, async (discovered) => {
        await this.persistObservation(activeScanId as string, discovered);
      });

      await this.prisma.scanJob.update({
        where: { id: activeScanId },
        data: { discoveryCompletedAt: new Date() },
      });

      // The in-process runner is the Phase 6 D1 queue implementation. If an
      // older caller omits it, discovery remains inspectable as RUNNING rather
      // than silently claiming metadata work was drained.
      if (this.extractor !== undefined) {
        const scan = await this.prisma.scanJob.findUniqueOrThrow({
          where: { id: activeScanId },
          select: { queuedCount: true },
        });
        if (scan.queuedCount > 0) {
          await this.extractor.drain(storageId, activeScanId);
        }
        await this.finalize(activeScanId);
      }
    } catch (error) {
      if (activeScanId !== undefined) {
        try {
          await this.prisma.scanJob.updateMany({
            where: { id: activeScanId, status: { in: ["PENDING", "RUNNING"] } },
            data: { status: "FAILED", completedAt: new Date(), errorMessage: errorMessage(error) },
          });
        } catch {
          // The detached operation must never leak an exception if failure
          // persistence itself is unavailable.
        }
      }
    }
  }

  private async finalize(scanId: string): Promise<void> {
    const scan = await this.prisma.scanJob.findUnique({
      where: { id: scanId },
      select: { status: true, failedCount: true, queuedCount: true, processedCount: true },
    });
    if (scan === null || scan.status !== "RUNNING") return;
    if (scan.processedCount < scan.queuedCount) {
      throw new Error("Metadata extraction did not reach a terminal state for every queued item");
    }

    // Derive the terminal state from durable counters and guard the transition
    // so a duplicate finalizer cannot overwrite an already-terminal scan.
    await this.prisma.scanJob.updateMany({
      where: { id: scanId, status: "RUNNING" },
      data: {
        status: scan.failedCount > 0 ? "COMPLETED_WITH_ERRORS" : "COMPLETED",
        completedAt: new Date(),
      },
    });
  }

  private async ensureStorageAvailable(): Promise<void> {
    await access(this.config.mediaRoot, constants.R_OK);
    const attributes = await stat(this.config.mediaRoot);
    if (!attributes.isDirectory()) {
      throw new Error(`Configured media root is not a directory: ${this.config.mediaRoot}`);
    }
  }

  private async persistObservation(
    scanId: string,
    discovered: DiscoveredFile,
  ): Promise<void> {
    const existing = await this.prisma.mediaFile.findUnique({
      where: {
        storageId_relativePath: {
          storageId: discovered.storageId,
          relativePath: discovered.relativePath,
        },
      },
    });
    const classification = classifyDiscoveredFile(discovered, existing);
    const observedAt = new Date();

    await this.prisma.$transaction(async (transaction) => {
      if (classification === "NEW") {
        await transaction.mediaFile.upsert({
          where: {
            storageId_relativePath: {
              storageId: discovered.storageId,
              relativePath: discovered.relativePath,
            },
          },
          create: {
            storageId: discovered.storageId,
            relativePath: discovered.relativePath,
            filename: discovered.filename,
            extension: discovered.extension,
            fileSize: BigInt(discovered.fileSize),
            modifiedAt: discovered.modifiedAt,
            status: "ACTIVE",
            metadataStatus: "PENDING",
            firstSeenAt: observedAt,
            lastSeenAt: observedAt,
            lastSeenScanId: scanId,
            // AI auto-enqueue for NEW files (ADR-006 §5, Plan 006 §5). The
            // AiRunner only claims a row once metadataStatus = READY, so this
            // does not start AI before technical metadata exists. Detached from
            // ScanJob counters below. When AI is disabled the column keeps its
            // DB default (PENDING = "not processed"); the runner loop is inert.
            ...(this.aiEnabled ? { aiStatus: "PENDING" as const } : {}),
          },
          update: {
            lastSeenAt: observedAt,
            lastSeenScanId: scanId,
            status: "ACTIVE",
          },
        });
      } else {
        // UPDATED is deliberately observation-only in Phase 4 (Annex A D2):
        // retaining stored attributes keeps the mismatch visible on the next
        // scan and avoids pretending metadata was refreshed.
        await transaction.mediaFile.update({
          where: {
            storageId_relativePath: {
              storageId: discovered.storageId,
              relativePath: discovered.relativePath,
            },
          },
          data: {
            lastSeenAt: observedAt,
            lastSeenScanId: scanId,
            status: "ACTIVE",
          },
        });
      }

      const counterData = {
        discoveredCount: { increment: 1 },
        ...(classification === "NEW" ? { newCount: { increment: 1 }, queuedCount: { increment: 1 } } : {}),
        ...(classification === "UNCHANGED" ? { unchangedCount: { increment: 1 } } : {}),
        ...(classification === "UPDATED" ? { updatedCount: { increment: 1 } } : {}),
      };
      await transaction.scanJob.update({ where: { id: scanId }, data: counterData });
    });
  }
}

export async function runScan(
  options: ScanOrchestratorOptions,
  storageId: string,
  scanId?: string,
): Promise<void> {
  await new ScanOrchestrator(options).run(storageId, scanId);
}
