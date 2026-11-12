"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ApiError, getMedia, getScan, getScans, startScan, type MediaListItem, type Scan } from "../lib/api";

const terminalStatuses = new Set(["COMPLETED", "COMPLETED_WITH_ERRORS", "FAILED"]);

function formatDuration(seconds: number | null): string {
  if (seconds === null) return "—";
  const total = Math.round(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}
function formatSize(value: string): string {
  const bytes = Number(value);
  if (!Number.isFinite(bytes)) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let amount = bytes;
  let index = -1;
  do { amount /= 1024; index += 1; } while (amount >= 1024 && index < units.length - 1);
  return `${amount.toFixed(amount >= 10 ? 0 : 1)} ${units[index]}`;
}
function badgeClass(value: string): string { return `badge ${value.toLowerCase()}`; }
function scanLabel(scan: Scan): string {
  if (scan.status === "COMPLETED") return "Scan completed successfully.";
  if (scan.status === "COMPLETED_WITH_ERRORS") return `Scan completed with ${scan.counters.failedCount} failed file(s).`;
  if (scan.status === "FAILED") return scan.errorMessage ? `Scan failed: ${scan.errorMessage}` : "Scan failed.";
  return "Scan is running.";
}

function Progress({ scan }: { scan: Scan }) {
  const c = scan.counters;
  return <section className="card" aria-live="polite">
    <div className="toolbar"><h2>Scan progress</h2><span className={badgeClass(scan.status)}>{scan.status}</span></div>
    <p>{scanLabel(scan)}</p>
    <div className="grid">
      <div><dt>Discovered</dt><dd>{c.discoveredCount}</dd></div><div><dt>New</dt><dd>{c.newCount}</dd></div>
      <div><dt>Updated</dt><dd>{c.updatedCount}</dd></div><div><dt>Unchanged</dt><dd>{c.unchangedCount}</dd></div>
      <div><dt>Queued</dt><dd>{c.queuedCount}</dd></div><div><dt>Processed</dt><dd>{c.processedCount}</dd></div>
      <div><dt>Failed</dt><dd>{c.failedCount}</dd></div>
    </div>
  </section>;
}

export default function HomePage() {
  const [items, setItems] = useState<MediaListItem[]>([]);
  const [pagination, setPagination] = useState({ page: 1, pageSize: 20, total: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [scan, setScan] = useState<Scan | null>(null);
  const [scanMessage, setScanMessage] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  const loadMedia = useCallback(async (page = pagination.page) => {
    setLoading(true); setError(null);
    try { const result = await getMedia(page); setItems(result.items); setPagination(result.pagination); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to load media."); }
    finally { setLoading(false); }
  }, [pagination.page]);

  useEffect(() => { void loadMedia(1); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    let cancelled = false;
    async function loadLatest() { try { const result = await getScans(); if (!cancelled && result.scans[0]) setScan(result.scans[0]); } catch { /* list errors are shown when a scan is started */ } }
    void loadLatest(); return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    if (!scan || terminalStatuses.has(scan.status)) return;
    const timer = window.setInterval(async () => { try { setScan(await getScan(scan.scanId)); void loadMedia(); } catch { /* retain the last visible progress */ } }, 3000);
    return () => window.clearInterval(timer);
  }, [scan, loadMedia]);

  async function handleStartScan() {
    setStarting(true); setScanMessage(null);
    try { const result = await startScan(); setScanMessage(`Scan ${result.scanId} has started.`); setScan(await getScan(result.scanId)); }
    catch (reason) {
      if (reason instanceof ApiError && reason.status === 409) setScanMessage("A scan is already running. Please wait for it to finish.");
      else setScanMessage(reason instanceof Error ? reason.message : "Unable to start scan.");
    } finally { setStarting(false); }
  }

  return <main>
    <div className="toolbar"><div><h1>TMIP Media Inventory</h1><p>Technical metadata for discovered media files.</p></div><button onClick={handleStartScan} disabled={starting || scan?.status === "RUNNING" || scan?.status === "PENDING"}>{starting ? "Starting…" : "Start Scan"}</button></div>
    {scanMessage && <p className="notice" aria-live="polite">{scanMessage}</p>}
    {scan && <Progress scan={scan} />}
    <section className="card"><h2>Media</h2>
      {loading ? <p aria-live="polite">Loading media…</p> : error ? <p className="notice error">{error}</p> : items.length === 0 ? <p>There is no media yet — start a scan.</p> : <div className="table-wrap"><table><thead><tr><th>Filename</th><th>Relative path</th><th>Duration</th><th>Resolution</th><th>Video codec</th><th>Size</th><th>Status</th><th>Metadata</th></tr></thead><tbody>{items.map((item) => <tr key={item.id}><td><Link href={`/media/${item.id}`}>{item.filename}</Link></td><td className="path">{item.relativePath}</td><td>{formatDuration(item.durationSeconds)}</td><td>{item.width !== null && item.height !== null ? `${item.width}×${item.height}` : "—"}</td><td>{item.videoCodec ?? "—"}</td><td>{formatSize(item.fileSize)}</td><td><span className={badgeClass(item.status)}>{item.status}</span></td><td><span className={badgeClass(item.metadataStatus)}>{item.metadataStatus}</span></td></tr>)}</tbody></table></div>}
      <div className="pagination"><button disabled={loading || pagination.page <= 1} onClick={() => void loadMedia(pagination.page - 1)}>Previous</button><span>Page {pagination.page} of {Math.max(1, Math.ceil(pagination.total / pagination.pageSize))}</span><button disabled={loading || pagination.page * pagination.pageSize >= pagination.total} onClick={() => void loadMedia(pagination.page + 1)}>Next</button></div>
    </section>
  </main>;
}
