import type { ExtractionRunner } from "../scan/extractor.js";

/**
 * Explicit, user-initiated metadata reprocessing boundary (WORKFLOWS.md §52).
 *
 * This is deliberately a thin seam over `ExtractionRunner.reprocessOne` so the
 * HTTP layer depends on a small interface (mirroring how `ScanOrchestrator` is
 * injected into the scan router) and tests can substitute a fake without
 * pulling in ffprobe or Prisma.
 */
export interface MediaReprocessor {
  reprocessOne(mediaFileId: string): Promise<"STARTED" | "CONFLICT" | "NOT_FOUND">;
}

class ExtractionRunnerReprocessor implements MediaReprocessor {
  public constructor(private readonly extractor: ExtractionRunner) {}

  public reprocessOne(mediaFileId: string): Promise<"STARTED" | "CONFLICT" | "NOT_FOUND"> {
    return this.extractor.reprocessOne(mediaFileId);
  }
}

export function createExtractionReprocessor(extractor: ExtractionRunner): MediaReprocessor {
  return new ExtractionRunnerReprocessor(extractor);
}
