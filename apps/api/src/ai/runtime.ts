import type { AiRunner } from "./runner.js";

/**
 * AI runner poll loop (ADR-006 §2, Plan 006 §5).
 *
 * A single in-process interval drains `PENDING` AI work with the runner's
 * configured concurrency. This mirrors the existing single-instance assumptions
 * (`StartScanMutex`, WORKFLOWS.md §46): one API process, one loop.
 *
 * The loop is inert unless AI is enabled — the caller only constructs it when
 * `config.ai.enabled` is true, so a deployment that has not opted in pays
 * nothing and `aiStatus = PENDING` simply means "not processed" (ADR-006 §1).
 */

export interface AiRuntimeOptions {
  runner: AiRunner;
  intervalMs: number;
  onError?: (error: unknown) => void;
}

export interface AiRuntime {
  /** Run one drain immediately (used by tests and for prompt first work). */
  tick(): Promise<void>;
  /** Start the interval loop. Idempotent. */
  start(): void;
  /** Stop the interval loop. Idempotent and awaited-safe. */
  stop(): void;
}

export function createAiRuntime(options: AiRuntimeOptions): AiRuntime {
  let timer: NodeJS.Timeout | undefined;
  let running = false;

  const tick = async (): Promise<void> => {
    // Guard against overlap: a slow AI job must not stack drains.
    if (running) return;
    running = true;
    try {
      await options.runner.drainOnce();
    } catch (error) {
      options.onError?.(error);
    } finally {
      running = false;
    }
  };

  return {
    tick,
    start(): void {
      if (timer !== undefined) return;
      timer = setInterval(() => void tick(), options.intervalMs);
      // Do not keep the event loop alive solely for AI polling.
      timer.unref?.();
    },
    stop(): void {
      if (timer === undefined) return;
      clearInterval(timer);
      timer = undefined;
    },
  };
}
