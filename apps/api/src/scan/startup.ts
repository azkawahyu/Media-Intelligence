import type { PrismaClient } from "@prisma/client";

export type StartupSweepDatabase = Pick<PrismaClient, "mediaFile" | "scanJob">;

/**
 * Explicitly fail interrupted state on startup. `INTERRUPTED` is a deliberate
 * extension of DATA_MODEL.md §46's non-exhaustive extraction error vocabulary;
 * Phase 6 does not auto-resume stale work (WORKFLOWS.md §46, Annex A D1).
 */
export async function sweepInterruptedState(prisma: StartupSweepDatabase): Promise<{
  processingMediaFiles: number;
  runningScans: number;
}> {
  const now = new Date();
  const media = await prisma.mediaFile.updateMany({
    where: { metadataStatus: "PROCESSING" },
    data: {
      metadataStatus: "FAILED",
      errorCode: "INTERRUPTED",
      errorMessage: "Metadata extraction was interrupted by application restart",
      errorStage: "PERSISTENCE",
      errorAt: now,
    },
  });
  const scans = await prisma.scanJob.updateMany({
    where: { status: "RUNNING" },
    data: {
      status: "FAILED",
      completedAt: now,
      errorMessage: "Scan was interrupted by application restart",
    },
  });

  if (media.count > 0 || scans.count > 0) {
    console.warn(
      `Startup sweep marked ${media.count} PROCESSING media file(s) and ${scans.count} RUNNING scan(s) as interrupted`,
    );
  }
  return { processingMediaFiles: media.count, runningScans: scans.count };
}
