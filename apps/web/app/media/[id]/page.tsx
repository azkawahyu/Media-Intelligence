"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ApiError, getMediaDetail, type MediaDetail } from "../../../lib/api";
import { ReprocessAction } from "./ReprocessAction";
import { AiReprocessAction } from "./AiReprocessAction";

function formatSize(value: string): string { const bytes = Number(value); if (!Number.isFinite(bytes)) return "—"; if (bytes < 1024) return `${bytes} B`; const units = ["KB", "MB", "GB", "TB"]; let amount = bytes; let index = -1; do { amount /= 1024; index += 1; } while (amount >= 1024 && index < units.length - 1); return `${amount.toFixed(amount >= 10 ? 0 : 1)} ${units[index]}`; }
function value(value: unknown): string { return value === null || value === undefined || value === "" ? "—" : String(value); }
function date(valueToFormat: string | null): string { return valueToFormat ? new Date(valueToFormat).toLocaleString() : "—"; }
function duration(seconds: number | null): string { return seconds === null ? "—" : `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, "0")}`; }
function badgeClass(status: string): string { return `badge ${status.toLowerCase()}`; }

function stagePayloadText(payload: unknown): string {
  if (payload === null || payload === undefined) return "—";
  if (typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    if (typeof record.full_text === "string") return record.full_text;
    if (typeof record.summary === "string") return record.summary;
    if (Array.isArray(record.keywords)) return record.keywords.join(", ");
    if (typeof record.category === "string") return record.category;
    if (typeof record.raw_text === "string") return record.raw_text;
  }
  return JSON.stringify(payload);
}

/** AI results card (ADR-006 §17): per-stage outcomes and any terminal error. */
function AiResultsSection({ media }: { media: MediaDetail }) {
  const stages = media.ai.stages;
  return (
    <section className="card">
      <div className="toolbar">
        <h2>AI results</h2>
        <div>
          <span className={badgeClass(media.aiStatus)}>{media.aiStatus}</span>
          {media.aiPartial && <span className="badge">PARTIAL</span>}
        </div>
      </div>
      <dl className="grid">
        <div><dt>Processed at</dt><dd>{date(media.aiProcessedAt)}</dd></div>
        <div><dt>Attempts</dt><dd>{media.aiAttempt}</dd></div>
      </dl>
      {(media.aiStatus === "FAILED" || media.aiStatus === "CANCELLED") && (
        <dl className="grid">
          <div><dt>Error code</dt><dd>{value(media.aiErrorCode)}</dd></div>
          <div><dt>Error at</dt><dd>{date(media.aiErrorAt)}</dd></div>
          <div><dt>Message</dt><dd>{value(media.aiErrorMessage)}</dd></div>
        </dl>
      )}
      {stages.length === 0
        ? <p>No AI results yet.</p>
        : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Stage</th><th>Status</th><th>Result</th></tr></thead>
              <tbody>
                {stages.map((stage) => (
                  <tr key={stage.stage}>
                    <td>{stage.stage}</td>
                    <td><span className={badgeClass(stage.status)}>{stage.status}</span></td>
                    <td className="path">{stage.status === "READY" ? stagePayloadText(stage.payload) : value(stage.errorCode)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
    </section>
  );
}

export default function MediaDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const [media, setMedia] = useState<MediaDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { let active = true; void params.then(({ id }) => getMediaDetail(id).then((result) => { if (active) setMedia(result); }).catch((reason) => { if (!active) return; if (reason instanceof ApiError && reason.status === 404) setNotFound(true); else setError(reason instanceof Error ? reason.message : "Unable to load media."); }).finally(() => { if (active) setLoading(false); })); return () => { active = false; }; }, [params]);
  if (loading) return <main><p aria-live="polite">Loading media detail…</p></main>;
  if (notFound) return <main><section className="card"><h1>Media not found</h1><p>The requested media record could not be found.</p><Link href="/">Back to media list</Link></section></main>;
  if (error || !media) return <main><section className="card"><p className="notice error">{error ?? "Unable to load media."}</p><Link href="/">Back to media list</Link></section></main>;
  return <main><p><Link href="/">← Back to media list</Link></p><h1>{media.filename}</h1><section className="card"><div className="toolbar"><h2>Identity and status</h2><div><span className={badgeClass(media.status)}>{media.status}</span> <span className={badgeClass(media.metadataStatus)}>{media.metadataStatus}</span></div></div><dl className="grid"><div><dt>Relative path</dt><dd>{media.relativePath}</dd></div><div><dt>Extension</dt><dd>{media.extension}</dd></div><div><dt>Size</dt><dd>{formatSize(media.fileSize)}</dd></div><div><dt>Modified</dt><dd>{date(media.modifiedAt)}</dd></div><div><dt>Retries</dt><dd>{media.retryCount}</dd></div></dl></section>
    <section className="card"><h2>Technical metadata</h2><dl className="grid"><div><dt>Duration</dt><dd>{duration(media.durationSeconds)}</dd></div><div><dt>Resolution</dt><dd>{media.width !== null && media.height !== null ? `${media.width}×${media.height}` : "—"}</dd></div><div><dt>Video codec</dt><dd>{value(media.videoCodec)}</dd></div><div><dt>Frame rate</dt><dd>{media.frameRateNumerator !== null && media.frameRateDenominator !== null ? `${media.frameRateNumerator}/${media.frameRateDenominator}` : "—"}</dd></div><div><dt>Audio codec</dt><dd>{value(media.audioCodec)}</dd></div><div><dt>Audio sample rate</dt><dd>{media.audioSampleRate === null ? "—" : `${media.audioSampleRate} Hz`}</dd></div><div><dt>Audio channels</dt><dd>{value(media.audioChannels)}</dd></div></dl>{media.technicalMetadata ? <><h3>Additional technical metadata</h3><pre>{JSON.stringify(media.technicalMetadata, null, 2)}</pre></> : <p>No additional technical metadata.</p>}</section>
    <ReprocessAction id={media.id} metadataStatus={media.metadataStatus} onUpdated={setMedia} />
    {media.metadataStatus === "FAILED" && <section className="card"><h2>Metadata extraction failure</h2><dl className="grid"><div><dt>Error code</dt><dd>{value(media.errorCode)}</dd></div><div><dt>Stage</dt><dd>{value(media.errorStage)}</dd></div><div><dt>Error at</dt><dd>{date(media.errorAt)}</dd></div><div><dt>Message</dt><dd>{value(media.errorMessage)}</dd></div></dl></section>}
    {/* AI processing (action/status) above AI results — ADR-006 §18 UX ordering. */}
    <AiReprocessAction id={media.id} media={media} onUpdated={setMedia} />
    <AiResultsSection media={media} />
    <section className="card"><h2>Observation timestamps</h2><dl className="grid"><div><dt>First seen</dt><dd>{date(media.firstSeenAt)}</dd></div><div><dt>Last seen</dt><dd>{date(media.lastSeenAt)}</dd></div><div><dt>Last metadata extraction</dt><dd>{date(media.lastMetadataExtractedAt)}</dd></div></dl></section></main>;
}
