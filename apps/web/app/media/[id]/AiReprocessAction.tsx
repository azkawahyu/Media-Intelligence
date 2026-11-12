"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  aiReprocessMedia,
  cancelAiProcessing,
  getMediaDetail,
  type MediaDetail,
} from "../../../lib/api";
import { AiProgress } from "./AiProgress";

const terminalAiStatuses = new Set(["READY", "FAILED", "SKIPPED", "CANCELLED"]);

/**
 * AI processing card (ADR-006 §16, §18) — the action/status card, rendered ABOVE
 * the results card so the live state and the controls come first.
 *
 * Start via the API (202 + detached work), then poll the media detail endpoint
 * until a terminal state is observed. Stop is honest about its two-phase
 * nature: the button only records a cancellation *intent*, so the UI shows
 * "Stopping…" and keeps polling until the server reports the terminal
 * `CANCELLED` — it never paints a terminal state from the button's success.
 */
export function AiReprocessAction({
  id,
  media,
  onUpdated,
}: {
  id: string;
  media: MediaDetail;
  onUpdated: (media: MediaDetail) => void;
}) {
  const aiStatus = media.aiStatus;
  const cancelRequested = media.aiCancelRequestedAt !== null;
  const [processing, setProcessing] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<number | null>(null);

  const stopPolling = useCallback((): void => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const pollOnce = useCallback(async (): Promise<void> => {
    try {
      const latest = await getMediaDetail(id);
      onUpdated(latest);
      if (terminalAiStatuses.has(latest.aiStatus)) {
        setProcessing(false);
        setStopping(false);
        if (latest.aiStatus === "CANCELLED") {
          setMessage("AI processing was stopped. Results from completed stages are kept.");
        } else if (latest.aiStatus === "READY" && latest.aiPartial) {
          setMessage("AI processing finished with partial results. See the AI stages below.");
        } else if (latest.aiStatus === "READY") {
          setMessage("AI processing completed successfully.");
        } else if (latest.aiStatus === "FAILED") {
          setMessage("AI processing failed. See the failure details below.");
        } else {
          setMessage("AI processing was skipped for this media file.");
        }
      }
    } catch {
      // Retain the last visible state and retry on the next tick.
    }
  }, [id, onUpdated]);

  useEffect(() => {
    if (aiStatus !== "PROCESSING") {
      stopPolling();
      return stopPolling;
    }
    timerRef.current = window.setInterval(() => void pollOnce(), 3000);
    return stopPolling;
  }, [aiStatus, pollOnce, stopPolling]);

  async function handleReprocess(): Promise<void> {
    stopPolling();
    setProcessing(true);
    setError(null);
    setMessage("Starting AI processing…");
    try {
      await aiReprocessMedia(id);
    } catch (reason) {
      setProcessing(false);
      setMessage(null);
      if (reason instanceof ApiError && reason.status === 409) {
        const body = reason.body;
        const disabled = typeof body === "object" && body !== null && "error" in body && body.error === "AI processing is disabled";
        setError(disabled ? "AI processing is disabled on this server." : "AI processing is already in progress for this media file.");
      } else {
        setError(reason instanceof Error ? reason.message : "Unable to start AI processing.");
      }
      return;
    }
    await pollOnce();
  }

  async function handleStop(): Promise<void> {
    setStopping(true);
    setError(null);
    setMessage("Stopping AI processing…");
    try {
      // The response is intentionally NOT terminal: it confirms the intent was
      // recorded. Polling (already running) will surface the final CANCELLED.
      await cancelAiProcessing(id);
    } catch (reason) {
      setStopping(false);
      setMessage(null);
      if (reason instanceof ApiError && reason.status === 409) {
        setError("AI processing is not in progress for this media file.");
      } else {
        setError(reason instanceof Error ? reason.message : "Unable to stop AI processing.");
      }
      return;
    }
    // Refresh once so the "Stopping…" state reflects the persisted intent.
    await pollOnce();
  }

  const busy = processing || aiStatus === "PROCESSING";
  const canStop = aiStatus === "PROCESSING" && !cancelRequested && !stopping;

  return (
    <section className="card">
      <div className="toolbar">
        <div>
          <h2>AI processing</h2>
          <p>Run, monitor, or stop transcription, summary, keywords, classification and OCR.</p>
        </div>
        <div>
          <span className={badgeClass(aiStatus)}>{aiStatus}</span>
          {media.aiPartial && <span className="badge">PARTIAL</span>}
        </div>
      </div>

      <AiProgress status={aiStatus} stages={media.ai.stages} />

      <dl className="grid">
        <div><dt>Attempts</dt><dd>{media.aiAttempt}</dd></div>
        <div><dt>Processed at</dt><dd>{media.aiProcessedAt ? new Date(media.aiProcessedAt).toLocaleString() : "—"}</dd></div>
      </dl>

      <div className="toolbar">
        <button onClick={() => void handleReprocess()} disabled={busy}>
          {busy ? "Processing…" : "Reprocess AI"}
        </button>
        {aiStatus === "PROCESSING" && (
          <button className="danger" onClick={() => void handleStop()} disabled={!canStop}>
            {cancelRequested || stopping ? "Stopping…" : "Stop processing"}
          </button>
        )}
      </div>

      {message && <p className="notice" aria-live="polite">{message}</p>}
      {error && <p className="notice error" aria-live="polite">{error}</p>}
    </section>
  );
}

function badgeClass(value: string): string {
  return `badge ${value.toLowerCase()}`;
}
