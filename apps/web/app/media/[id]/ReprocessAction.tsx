"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, getMediaDetail, reprocessMedia, type MediaDetail } from "../../../lib/api";

const terminalMetadataStatuses = new Set(["READY", "FAILED"]);

/**
 * Explicit metadata reprocessing action for a single media file. Starts the
 * reprocess via the API (which returns 202 and detaches the work), then polls
 * the media detail endpoint while the status is PROCESSING until the terminal
 * READY/FAILED state is observed, mirroring the existing scan-progress polling
 * idiom (WORKFLOWS.md §52). The terminal failure card on the page is unchanged.
 */
export function ReprocessAction({
  id,
  metadataStatus,
  onUpdated,
}: {
  id: string;
  metadataStatus: string;
  onUpdated: (media: MediaDetail) => void;
}) {
  const [processing, setProcessing] = useState(false);
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
      if (terminalMetadataStatuses.has(latest.metadataStatus)) {
        setProcessing(false);
        setMessage(
          latest.metadataStatus === "READY"
            ? "Metadata reprocessed successfully."
            : "Metadata reprocessing failed. See the failure details below.",
        );
      }
    } catch {
      // Retain the last visible state and retry on the next tick.
    }
  }, [id, onUpdated]);

  // Poll while the file is PROCESSING (either just requested here or already
  // in flight when the page loaded, e.g. after a browser refresh).
  useEffect(() => {
    if (metadataStatus !== "PROCESSING") {
      stopPolling();
      return stopPolling;
    }
    timerRef.current = window.setInterval(() => void pollOnce(), 3000);
    return stopPolling;
  }, [metadataStatus, pollOnce, stopPolling]);

  async function handleReprocess(): Promise<void> {
    stopPolling();
    setProcessing(true);
    setError(null);
    setMessage("Reprocessing metadata…");
    try {
      await reprocessMedia(id);
    } catch (reason) {
      setProcessing(false);
      setMessage(null);
      if (reason instanceof ApiError && reason.status === 409) {
        setError("Reprocessing is already in progress for this media file.");
      } else {
        setError(reason instanceof Error ? reason.message : "Unable to start reprocessing.");
      }
      return;
    }
    // The row is PROCESSING on the server now; refresh to pick it up and let
    // the effect above start polling until terminal.
    await pollOnce();
  }

  const busy = processing || metadataStatus === "PROCESSING";

  return (
    <section className="card">
      <div className="toolbar">
        <div>
          <h2>Metadata reprocessing</h2>
          <p>Re-run ffprobe for this file even when it has not changed.</p>
        </div>
        <button onClick={() => void handleReprocess()} disabled={busy}>
          {busy ? "Reprocessing…" : "Reprocess metadata"}
        </button>
      </div>
      {message && <p className="notice" aria-live="polite">{message}</p>}
      {error && <p className="notice error" aria-live="polite">{error}</p>}
    </section>
  );
}
