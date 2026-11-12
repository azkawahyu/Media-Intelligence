import type { PrismaClient } from "@prisma/client";
import type { CancelOutcome } from "./runner.js";

/**
 * Explicit, user-initiated AI reprocessing boundary (ADR-006 §16).
 *
 * A thin seam over a direct `MediaFile` update so the HTTP layer depends on a
 * small interface (mirroring `MediaReprocessor`) and tests can substitute a fake
 * without pulling in Prisma.
 *
 * Semantics (ADR-006 §16, deliberate divergence from ADR-004 metadata reprocess):
 *   - NOT_FOUND when the media file does not exist.
 *   - CONFLICT only when `aiStatus = PROCESSING` (a live claim exists).
 *   - A PENDING row is NOT a conflict: resetting AI work to PENDING **is** the
 *     requested action and is idempotent, so it also returns STARTED (202).
 *   - On success: aiStatus = PENDING, aiAttempt = 0, aiError* cleared. Existing
 *     AiResult rows are left in place; they are overwritten per-stage on the run.
 */
export interface AiReprocessor {
  reprocessOne(mediaFileId: string): Promise<"STARTED" | "CONFLICT" | "NOT_FOUND">;
}

/**
 * Cancellation boundary (ADR-006 §18). A small seam so the HTTP layer depends on
 * an interface rather than the concrete `AiRunner`, mirroring `AiReprocessor`.
 */
export interface AiCanceller {
  cancel(mediaFileId: string): Promise<CancelOutcome>;
}

export type AiReprocessDatabase = Pick<PrismaClient, "mediaFile">;

class PrismaAiReprocessor implements AiReprocessor {
  public constructor(private readonly prisma: AiReprocessDatabase) {}

  public async reprocessOne(
    mediaFileId: string,
  ): Promise<"STARTED" | "CONFLICT" | "NOT_FOUND"> {
    // Atomic compare-and-set: only a row that is not PROCESSING is reset. The
    // `in` list is the guard; PROCESSING is excluded so a live claim is never
    // clobbered. CANCELLED is included: a stopped run is explicitly resettable
    // (ADR-006 §16, §18).
    const result = await this.prisma.mediaFile.updateMany({
      where: {
        id: mediaFileId,
        aiStatus: { in: ["PENDING", "READY", "FAILED", "SKIPPED", "CANCELLED"] },
      },
      data: {
        aiStatus: "PENDING",
        aiAttempt: 0,
        aiPartial: false,
        aiExternalJobId: null,
        aiErrorCode: null,
        aiErrorMessage: null,
        aiErrorAt: null,
        // Clear any stale cancellation intent atomically with the reset.
        aiCancelRequestedAt: null,
      },
    });

    if (result.count === 1) {
      return "STARTED";
    }

    // No row updated: either it does not exist, or it is PROCESSING.
    const existing = await this.prisma.mediaFile.findUnique({
      where: { id: mediaFileId },
      select: { aiStatus: true },
    });
    if (existing === null) {
      return "NOT_FOUND";
    }
    return "CONFLICT";
  }
}

export function createAiReprocessor(prisma: AiReprocessDatabase): AiReprocessor {
  return new PrismaAiReprocessor(prisma);
}
