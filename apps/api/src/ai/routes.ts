import express, { type Request, type Response, type Router } from "express";
import type { AiCanceller, AiReprocessor } from "./reprocess.js";

/**
 * AI routes (ADR-006 §16/§17, Plan 006 §2.2).
 *
 * `POST /media/:id/ai-reprocess` — mirrors the metadata reprocess handler in
 * `media/routes.ts` (same trust boundary; TMIP v1 has no auth yet):
 *   - 404 when the media file does not exist,
 *   - 409 when `aiStatus = PROCESSING` (a live claim is in flight),
 *   - 202 otherwise (PENDING/READY/FAILED/SKIPPED are all resettable; resetting
 *     an already-PENDING row is idempotent — ADR-006 §16).
 *   - 409 "disabled" when the AI subsystem is not enabled, so a caller cannot
 *     queue work that will never run.
 *
 * The reset itself is a DB write; the AI work is detached and drained by the
 * `AiRunner` poll loop (AGENTS.md §8 — no model work inside the request handler).
 */
export interface AiRouteOptions {
  reprocessor?: AiReprocessor;
  /** Cancellation boundary (ADR-006 §18). */
  canceller?: AiCanceller;
  enabled: boolean;
}

export function createAiRouter(options: AiRouteOptions): Router {
  const router = express.Router();

  router.post("/media/:id/ai-reprocess", async (req: Request, res: Response): Promise<void> => {
    if (!options.enabled) {
      res.status(409).json({ error: "AI processing is disabled" });
      return;
    }

    const reprocessor = options.reprocessor;
    if (reprocessor === undefined) {
      res.status(500).json({ error: "AI reprocessing is not available" });
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
      res.status(500).json({ error: "AI reprocessing failed to start" });
      return;
    }

    if (result === "NOT_FOUND") {
      res.status(404).json({ error: "Media not found" });
      return;
    }
    if (result === "CONFLICT") {
      res.status(409).json({ error: "AI processing is already in progress for this media file" });
      return;
    }
    res.status(202).json({ mediaFileId: id, aiStatus: "PENDING" });
  });

  /**
   * `POST /media/:id/ai-cancel` — request cancellation of an in-flight AI job
   * (ADR-006 §18).
   *
   * Durability over optimism: the response reports `aiStatus: "PROCESSING"` with
   * `cancelRequested: true`, NOT a terminal `CANCELLED`. The runner observes the
   * persisted intent, stops before the next stage, keeps succeeded stages, and
   * finalizes `CANCELLED` itself. A client must keep polling to observe the
   * terminal state; the button succeeding is not proof the job stopped.
   *
   *   - 202: intent persisted (idempotent — repeating is safe).
   *   - 404: media does not exist.
   *   - 409: not PROCESSING and no active intent (nothing to cancel).
   */
  router.post("/media/:id/ai-cancel", async (req: Request, res: Response): Promise<void> => {
    const id = typeof req.params.id === "string" ? req.params.id : undefined;
    if (id === undefined) {
      res.status(404).json({ error: "Media not found" });
      return;
    }

    const canceller = options.canceller;
    if (canceller === undefined) {
      res.status(500).json({ error: "AI cancellation is not available" });
      return;
    }

    let result;
    try {
      result = await canceller.cancel(id);
    } catch {
      res.status(500).json({ error: "AI cancellation failed to start" });
      return;
    }

    if (result === "NOT_FOUND") {
      res.status(404).json({ error: "Media not found" });
      return;
    }
    if (result === "NOT_PROCESSING") {
      res.status(409).json({ error: "AI processing is not in progress for this media file" });
      return;
    }
    res.status(202).json({ mediaFileId: id, aiStatus: "PROCESSING", cancelRequested: true });
  });

  return router;
}
