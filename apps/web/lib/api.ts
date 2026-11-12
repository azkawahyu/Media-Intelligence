export const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

export type MediaListItem = {
  id: string;
  storageId: string;
  relativePath: string;
  filename: string;
  extension: string;
  fileSize: string;
  modifiedAt: string;
  status: string;
  metadataStatus: string;
  durationSeconds: number | null;
  videoCodec: string | null;
  width: number | null;
  height: number | null;
  frameRateNumerator: number | null;
  frameRateDenominator: number | null;
  firstSeenAt: string;
  lastSeenAt: string;
  lastMetadataExtractedAt: string | null;
  aiStatus: string;
  aiPartial: boolean;
  aiProcessedAt: string | null;
};

export type AiStageResult = {
  stage: string;
  status: string;
  payload: unknown;
  errorCode: string | null;
  errorMessage: string | null;
  attemptedAt: string;
};

export type MediaDetail = MediaListItem & {
  audioCodec: string | null;
  audioSampleRate: number | null;
  audioChannels: number | null;
  technicalMetadata: unknown;
  rawProbeData: unknown;
  errorCode: string | null;
  errorMessage: string | null;
  errorStage: string | null;
  errorAt: string | null;
  retryCount: number;
  lastSeenScanId: string;
  aiStatus: string;
  aiPartial: boolean;
  aiAttempt: number;
  aiExternalJobId: string | null;
  aiErrorCode: string | null;
  aiErrorMessage: string | null;
  aiErrorAt: string | null;
  aiProcessedAt: string | null;
  /** Non-null while a cancellation is pending (ADR-006 §18). */
  aiCancelRequestedAt: string | null;
  ai: { stages: AiStageResult[] };
  createdAt: string;
  updatedAt: string;
};

export type Scan = {
  scanId: string;
  storageId: string;
  status: "PENDING" | "RUNNING" | "COMPLETED" | "COMPLETED_WITH_ERRORS" | "FAILED";
  counters: {
    discoveredCount: number;
    newCount: number;
    updatedCount: number;
    unchangedCount: number;
    missingCount: number;
    queuedCount: number;
    processedCount: number;
    failedCount: number;
  };
  startedAt: string;
  discoveryCompletedAt: string | null;
  completedAt: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
};

type MediaListResponse = { items: MediaListItem[]; pagination: { page: number; pageSize: number; total: number } };
type ScanListResponse = { scans: Scan[] };

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = typeof body === "object" && body !== null && "error" in body && typeof body.error === "string"
      ? body.error
      : `API request failed (${response.status})`;
    throw new ApiError(response.status, message, body);
  }
  return body as T;
}

export function getMedia(page: number, pageSize = 20): Promise<MediaListResponse> {
  return request<MediaListResponse>(`/media?page=${page}&pageSize=${pageSize}`);
}

export function getMediaDetail(id: string): Promise<MediaDetail> {
  return request<MediaDetail>(`/media/${encodeURIComponent(id)}`);
}

export function reprocessMedia(id: string): Promise<{ mediaFileId: string; metadataStatus: string }> {
  return request<{ mediaFileId: string; metadataStatus: string }>(`/media/${encodeURIComponent(id)}/reprocess`, { method: "POST" });
}

export function aiReprocessMedia(id: string): Promise<{ mediaFileId: string; aiStatus: string }> {
  return request<{ mediaFileId: string; aiStatus: string }>(`/media/${encodeURIComponent(id)}/ai-reprocess`, { method: "POST" });
}

/**
 * Request cancellation of an in-flight AI job (ADR-006 §18). The response
 * reports `aiStatus: "PROCESSING"` + `cancelRequested: true` — NOT a terminal
 * state; the caller must keep polling until the server reports the terminal
 * status.
 */
export function cancelAiProcessing(id: string): Promise<{ mediaFileId: string; aiStatus: string; cancelRequested: boolean }> {
  return request<{ mediaFileId: string; aiStatus: string; cancelRequested: boolean }>(
    `/media/${encodeURIComponent(id)}/ai-cancel`,
    { method: "POST" },
  );
}

export function startScan(): Promise<{ scanId: string }> {
  return request<{ scanId: string }>("/scans", { method: "POST", body: "{}" });
}

export function getScan(id: string): Promise<Scan> {
  return request<Scan>(`/scans/${encodeURIComponent(id)}`);
}

export function getScans(): Promise<ScanListResponse> {
  return request<ScanListResponse>("/scans");
}
