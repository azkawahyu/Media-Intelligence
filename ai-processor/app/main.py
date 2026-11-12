"""AI Processor — FastAPI application (TMIP Phase 14 MVP).

Serves as the REST API backend for AI media processing tasks that TMIP's
`AiRunner` drives over the internal Docker network. TMIP Phase 14 registers the
text pipeline only: transcription, summarization, and OCR
(docs/plans/006-ai-processor-integration.md §2.1). The scene/CLIP/YOLO vision
pipeline (`/analyze-scenes`) is deferred to Phase 15.

All heavy model dependencies (Whisper/Torch/OpenCV/Tesseract) live here, isolated
from the Node.js API container (ADR-006 §2).

Media safety (ADR-006 §9, Plan 006 §2.4 item 5): every `video_path` is rejected
unless it is absolute and — when `MEDIA_ROOT` is set — resolves inside that root.
This is defense-in-depth on top of TMIP's own `resolveInsideRoot` containment;
the service is additionally bound to the internal network only (ADR-006 §10).
"""

import os

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from .handlers.ocr import (
    _extract_frame,
    extract_lower_third_text,
    parse_presenter_info,
    sample_lower_third_text,
)
from .handlers.openrouter import LlmProviderError
from .handlers.text_llm import summarize
from .handlers.transcribe import (
    TranscriptionAlreadyRunningError,
    cancel_background,
    get_background_status,
    start_background_transcribe,
)

app = FastAPI(title="TMIP AI Processor", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Media root inside the container. The compose mount is `/media:ro`
# (ADR-006 §10). When unset, containment degrades to "must be absolute".
MEDIA_ROOT = os.environ.get("MEDIA_ROOT", "").strip() or None


# ── Request/Response models ──────────────────────────────────────

class TranscribeRequest(BaseModel):
    video_path: str
    asset_id: str
    model_size: str = "medium"
    language: str = "id"


class SummarizeRequest(BaseModel):
    full_text: str


class OcrRequest(BaseModel):
    video_path: str
    timestamp_sec: float = 0.0
    # Known media duration; when present and positive, OCR samples up to five
    # frames across the video instead of trusting one frame (ADR-006 §17).
    duration_sec: float | None = None
    lower_third_height_ratio: float = 0.25
    lang: str = "ind+eng"


class HealthResponse(BaseModel):
    status: str
    openrouter_available: bool
    llm_available: bool
    llm_base_url: str
    llm_model: str


# ── Media path containment (defense-in-depth) ────────────────────

def _assert_contained(video_path: str) -> str:
    """Return the real path of `video_path`, rejecting anything unsafe.

    Rejects a non-absolute path, and — when MEDIA_ROOT is configured — a path
    that does not resolve inside it. `os.path.realpath` is used so symlinks
    cannot escape the root.
    """
    if not os.path.isabs(video_path):
        raise HTTPException(400, "video_path must be an absolute path")

    resolved = os.path.realpath(video_path)
    if MEDIA_ROOT is not None:
        root = os.path.realpath(MEDIA_ROOT)
        if resolved != root and not resolved.startswith(root + os.sep):
            raise HTTPException(403, "video_path is outside the configured media root")
    return resolved


# ── Endpoints ─────────────────────────────────────────────────────

@app.get("/health", response_model=HealthResponse)
def health():
    """Health check endpoint. Reports the configured LLM endpoint and model.

    The base URL and model are non-secret and make misconfiguration diagnosable
    (ADR-006 §11). The API key is NEVER exposed here.
    """
    from .handlers.openrouter import LLM_BASE_URL, LLM_MODEL, is_available

    available = is_available()
    return HealthResponse(
        status="ok",
        # Retained for backward compatibility with existing callers/health checks.
        openrouter_available=available,
        llm_available=available,
        llm_base_url=LLM_BASE_URL,
        llm_model=LLM_MODEL,
    )


@app.post("/transcribe")
async def api_transcribe(req: TranscribeRequest):
    """Start transcription in a background thread and return immediately.

    TMIP polls `/transcribe/status/{asset_id}` for progress. The request's
    `asset_id` is TMIP's `aiExternalJobId` (ADR-006 §3), so a re-dispatch after
    a TMIP restart correlates with the same logical job.

    Idempotency (FIX 3): an in-flight `asset_id` returns `ALREADY_RUNNING`, and
    an already-`COMPLETED` job is NOT restarted (a duplicate must never wipe a
    completed result). A previously `FAILED` job is allowed to run again, which
    is what a manual reprocess or an attempt-increment retry needs.
    """
    resolved = _assert_contained(req.video_path)
    if not os.path.exists(resolved):
        raise HTTPException(404, f"File not found: {req.video_path}")

    current = (get_background_status(req.asset_id) or {}).get("status")
    if current in ("RUNNING", "COMPLETED"):
        return {"ok": True, "data": {"job_id": req.asset_id, "status": "ALREADY_RUNNING"}}

    try:
        job_id = start_background_transcribe(
            video_path=resolved,
            asset_id=req.asset_id,
            model_size=req.model_size,
            language=req.language,
        )
    except TranscriptionAlreadyRunningError:
        # Lost a race with a concurrent duplicate request; treat as ALREADY_RUNNING.
        return {"ok": True, "data": {"job_id": req.asset_id, "status": "ALREADY_RUNNING"}}

    return {"ok": True, "data": {"job_id": job_id, "status": "STARTED"}}


@app.get("/transcribe/status/{asset_id}")
def api_transcribe_status(asset_id: str):
    """Poll transcription status: RUNNING (with progress), COMPLETED, FAILED, or NOT_FOUND."""
    status = get_background_status(asset_id) or {}
    return {"ok": True, "data": status}


@app.get("/transcribe/result/{asset_id}")
def api_transcribe_result(asset_id: str):
    """Get a completed transcription result. Errors while still running/unknown."""
    status = get_background_status(asset_id) or {}
    if status.get("status") == "COMPLETED":
        return {"ok": True, "data": status.get("result")}
    if status.get("status") == "FAILED":
        return {"ok": True, "data": None, "message": status.get("error", "Transcription failed")}
    raise HTTPException(
        404,
        "Belum selesai atau tidak ditemukan. Cek /transcribe/status/{asset_id} dulu.",
    )


@app.post("/transcribe/cancel/{asset_id}")
def api_transcribe_cancel(asset_id: str):
    """Request cancellation of a running background transcription job."""
    cancelled = cancel_background(asset_id)
    return {"ok": True, "data": {"asset_id": asset_id, "cancelled": cancelled}}


@app.post("/summarize")
def api_summarize(req: SummarizeRequest):
    """Generate summary, keywords, and category from transcript text (one LLM call).

    Failure mapping (ADR-006 §12): a configured-but-failing provider is reported
    with the status that matches its cause, not a blanket 503, so TMIP's error
    classification stays accurate:

      - no key configured   -> 503 (LLM stages degrade gracefully; retryable)
      - transient (timeout, 429, 5xx, network) -> 503 (retryable)
      - authentication (401) -> 502 (permanent; fix the key)
      - quota/billing (402)  -> 402
      - forbidden/model (403/404) -> 403/404
      - bad request (400)    -> 400
    """
    try:
        result = summarize(req.full_text)
    except LlmProviderError as error:
        if error.failure_class == "TRANSIENT":
            raise HTTPException(503, error.args[0])
        # Permanent provider error: surface the provider's own status when it is
        # a 4xx we can pass through, otherwise 502 (bad gateway to the provider).
        status = error.status_code if error.status_code in (400, 401, 402, 403, 404) else 502
        raise HTTPException(status, error.args[0])

    if result is None:
        raise HTTPException(503, "LLM provider is not configured (no API key)")
    return {"ok": True, "data": result}


@app.post("/ocr")
def api_ocr(req: OcrRequest):
    """Extract lower-third text (Tesseract), then parse the presenter.

    Multi-frame (ADR-006 §17): when `duration_sec` is a valid positive value,
    up to five frames are sampled across the video and the best-scoring text is
    used, because a single frame (often the opening black/title frame) is
    unreliable. Without a duration the endpoint falls back to one frame — the
    `timestamp_sec` the caller supplied, or t=0. The video is read-only.
    """
    resolved = _assert_contained(req.video_path)
    if not os.path.exists(resolved):
        raise HTTPException(404, f"File not found: {req.video_path}")

    if req.duration_sec is not None and req.duration_sec > 0:
        sampled = sample_lower_third_text(
            resolved,
            duration_sec=req.duration_sec,
            height_ratio=req.lower_third_height_ratio,
            lang=req.lang,
        )
        raw_text = sampled["raw_text"]
        sampled_count = sampled["sampled_count"]
        best_timestamp_sec = sampled["best_timestamp_sec"]
    else:
        # Fallback: honour the caller's timestamp (default t=0) with one frame.
        # Extraction goes through the FFmpeg CLI, not cv2.VideoCapture, which
        # returned a frozen frame for every timestamp on a real broadcast file
        # (see ocr.py module docstring).
        frame = _extract_frame(resolved, req.timestamp_sec)
        if frame is None:
            raise HTTPException(400, "Could not read frame at specified timestamp")

        raw_text = extract_lower_third_text(
            frame,
            height_ratio=req.lower_third_height_ratio,
            lang=req.lang,
        )
        sampled_count = 1
        best_timestamp_sec = req.timestamp_sec

    presenter = parse_presenter_info(raw_text) if raw_text else None

    return {
        "ok": True,
        "data": {
            "raw_text": raw_text,
            "presenter": presenter,
            "sampled_count": sampled_count,
            "best_timestamp_sec": best_timestamp_sec,
        },
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
