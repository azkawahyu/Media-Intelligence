import type { PrismaClient } from "@prisma/client";

/**
 * AI restart recovery (ADR-006 §4, §18). Deliberately different from the
 * metadata sweep in `scan/startup.ts`: every `aiStatus = PROCESSING` row is
 * reset to `PENDING` (not FAILED), because AI results are written once,
 * atomically, at the end of a successful stage set — a restart simply means the
 * work did not happen, so re-running is safe and desirable and does not consume
 * a retry (`aiAttempt` is untouched).
 *
 * Cancellation intent survives a restart (ADR-006 §18): a PROCESSING row that
 * carries `aiCancelRequestedAt` is finalized as `CANCELLED` instead of being
 * re-queued, so a stop the operator requested before the crash is honored.
 *
 * The row's `aiExternalJobId` is left in place; the runner overwrites it with the
 * deterministic value for the current attempt on the next claim. If the
 * processor finished an orphaned job after the restart, its result is discarded
 * (TMIP never reads results it did not persist) and the re-run overwrites the
 * same per-stage rows via upsert — no duplicate results.
 */
export async function sweepInterruptedAiState(
  prisma: Pick<PrismaClient, "mediaFile">,
): Promise<{ processingAiFiles: number; cancelledAiFiles: number }> {
  // Honor a durable cancellation intent first: do not resurrect a stopped job.
  const cancelled = await prisma.mediaFile.updateMany({
    where: { aiStatus: "PROCESSING", aiCancelRequestedAt: { not: null } },
    data: {
      aiStatus: "CANCELLED",
      aiPartial: true,
      aiProcessedAt: null,
      aiErrorCode: "AI_CANCELLED",
      aiErrorMessage: "AI processing was cancelled (recovered after restart)",
      aiErrorAt: new Date(),
    },
  });

  const result = await prisma.mediaFile.updateMany({
    where: { aiStatus: "PROCESSING", aiCancelRequestedAt: null },
    data: { aiStatus: "PENDING" },
  });

  if (cancelled.count > 0) {
    console.warn(
      `Startup sweep finalized ${cancelled.count} cancelled AI media file(s) as CANCELLED`,
    );
  }
  if (result.count > 0) {
    console.warn(
      `Startup sweep reset ${result.count} PROCESSING AI media file(s) to PENDING for re-run`,
    );
  }
  return { processingAiFiles: result.count, cancelledAiFiles: cancelled.count };
}
