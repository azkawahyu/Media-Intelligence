"""Transcription module using faster-whisper.

TMIP Phase 14 adaptation of the source module
(docs/plans/006-ai-processor-integration.md §2.4). Deliberate fixes carried in
from ADR-006, each marked FIX below:

FIX 1 (ADR-002 / finding 1) — the source wrote progress and result JSON files
    into the media tree (`/media/.transcribe-progress-*.json`). That is a hidden
    write path into read-only source media and is REMOVED. Progress and results
    are held in process memory and returned over HTTP only; durable state lives
    in TMIP's PostgreSQL (`AiResult`).

FIX 2 (finding 2) — `get_background_status` returned `None` for a running job
    because the `RUNNING` branch built `progress` but never returned it (dead
    code after a misplaced `return`). It now returns
    `{"status": "RUNNING", "progress": {...}}` from an in-memory counter.

FIX 3 (finding 3) — `POST /transcribe` idempotency was unreliable and
    `start_background_transcribe` unconditionally wiped state. Starting a run is
    now guarded by a lock + liveness check so a duplicate in-flight request
    cannot start a second concurrent transcription, and a completed result is
    never wiped by a duplicate request (see `main.py` short-circuit).

FIX 4 (finding 4) — cancellation was not real: the daemon thread ran to
    completion. A per-job `threading.Event` is now checked in the segment loop
    and set by `cancel_background`.

The Whisper model remains a process-global singleton loaded on CPU (int8).
"""

import gc
import threading
import time
from datetime import datetime, timezone

from faster_whisper import WhisperModel

# Global model cache — loaded once, reused across requests
_whisper_model: WhisperModel | None = None
_whisper_model_name: str | None = None

# ── Background transcription state (in-memory only; FIX 1) ──────────────
# All of these are guarded by _state_lock so a claim/clear/status read cannot
# interleave and observe a half-updated job (FIX 3).
_state_lock = threading.Lock()
_background_jobs: dict[str, threading.Thread] = {}
_background_results: dict[str, dict] = {}
_background_errors: dict[str, str] = {}
_background_progress: dict[str, dict] = {}
_background_cancel: dict[str, threading.Event] = {}


class TranscriptionAlreadyRunningError(Exception):
    """Raised when a duplicate /transcribe arrives for an in-flight asset_id."""

    def __init__(self, asset_id: str) -> None:
        super().__init__(f"Transcription already running for asset {asset_id}")
        self.asset_id = asset_id


def _get_model(model_size: str = "small", cpu_threads: int = 8) -> WhisperModel:
    """Get or create the Whisper model singleton.

    NOTE (Phase 14 deviation from the source): the source set thread count via
    `torch.set_num_threads`, but torch is not a dependency of faster-whisper
    (which runs on CTranslate2) and was dropped from the trimmed MVP
    requirements. `WhisperModel` accepts `cpu_threads` directly, so the thread
    limit is applied there instead — no torch import is needed or available.
    """
    global _whisper_model, _whisper_model_name
    if _whisper_model is None or _whisper_model_name != model_size:
        print(f"Loading Whisper model '{model_size}'...")
        t0 = time.time()
        _whisper_model = WhisperModel(
            model_size, device="cpu", compute_type="int8", cpu_threads=cpu_threads,
        )
        print(f"Whisper model loaded in {time.time() - t0:.1f}s")
        _whisper_model_name = model_size
    return _whisper_model


def release_model():
    """Release Whisper model from memory (call after transcription is done)."""
    global _whisper_model, _whisper_model_name
    _whisper_model = None
    _whisper_model_name = None
    gc.collect()


def _record_progress(asset_id: str, last_end: float, segments_done: int, text: str) -> None:
    """Store the latest progress in memory (FIX 1: never touches /media)."""
    with _state_lock:
        _background_progress[asset_id] = {
            "last_end": round(last_end, 2),
            "segments_done": segments_done,
            "updated_at": datetime.now(timezone.utc).isoformat(),
            "text": text,
        }


def _transcribe_background(
    video_path: str,
    asset_id: str,
    model_size: str,
    language: str,
    cpu_threads: int = 8,
    cancel_event: threading.Event | None = None,
):
    """Run transcription in a background thread, keeping state in memory."""
    try:
        import os

        if not os.path.exists(video_path):
            raise FileNotFoundError(f"Video file not found: {video_path}")

        model = _get_model(model_size, cpu_threads)

        print(f"[bg] Starting transcription for asset {asset_id}: {video_path}")
        segments_info, info = model.transcribe(
            video_path, language=language, beam_size=5, word_timestamps=False,
        )

        result_segments = []
        full_text_parts = []

        for seg in segments_info:
            # FIX 4: cooperative cancel — stop between segments if requested.
            if cancel_event is not None and cancel_event.is_set():
                print(f"[bg] Transcription cancelled for asset {asset_id}")
                with _state_lock:
                    _background_jobs.pop(asset_id, None)
                    _background_cancel.pop(asset_id, None)
                    _background_progress.pop(asset_id, None)
                return

            seg_data = {"start": round(seg.start, 2), "end": round(seg.end, 2), "text": seg.text.strip()}
            result_segments.append(seg_data)
            full_text_parts.append(seg.text.strip())

            print(f"  [{seg.start:>7.1f}s - {seg.end:>7.1f}s] {seg.text.strip()}")
            _record_progress(asset_id, seg.end, len(result_segments), seg.text.strip())

        full_text = " ".join(full_text_parts)
        result = {
            "segments": result_segments,
            "full_text": full_text,
            "duration_sec": round(info.duration, 2) if info.duration else None,
            "language": info.language if info.language else language,
        }

        print(f"[bg] Transcription complete for asset {asset_id}: {len(result_segments)} segments")
        with _state_lock:
            _background_results[asset_id] = result
            _background_errors.pop(asset_id, None)
            _background_progress.pop(asset_id, None)

    except Exception as e:
        error_msg = str(e)
        print(f"[bg] Transcription FAILED for asset {asset_id}: {error_msg}")
        with _state_lock:
            _background_errors[asset_id] = error_msg
    finally:
        with _state_lock:
            _background_jobs.pop(asset_id, None)
            _background_cancel.pop(asset_id, None)


def start_background_transcribe(
    video_path: str,
    asset_id: str,
    model_size: str = "medium",
    language: str = "id",
    cpu_threads: int = 8,
) -> str:
    """Start transcription in a background thread. Returns asset_id as job_id.

    FIX 3: the start is guarded by a lock and a liveness check, so a duplicate
    request for an asset_id that is already running cannot start a second
    concurrent transcription. Stale terminal state from a *previous* run is
    cleared here (which is safe because the caller has already decided this is
    a genuinely new run; see `main.py`).
    """
    with _state_lock:
        existing = _background_jobs.get(asset_id)
        if existing is not None and existing.is_alive():
            raise TranscriptionAlreadyRunningError(asset_id)

        _background_results.pop(asset_id, None)
        _background_errors.pop(asset_id, None)
        _background_progress.pop(asset_id, None)

        cancel_event = threading.Event()
        _background_cancel[asset_id] = cancel_event
        thread = threading.Thread(
            target=_transcribe_background,
            args=(video_path, asset_id, model_size, language, cpu_threads, cancel_event),
            daemon=True,
        )
        _background_jobs[asset_id] = thread
        thread.start()

    print(f"Started background transcription job for asset {asset_id}")
    return asset_id


def get_background_status(asset_id: str) -> dict:
    """Get current status of a background transcription job.

    FIX 2: a running job now returns its progress instead of `None`.
    """
    with _state_lock:
        if asset_id in _background_errors:
            return {"status": "FAILED", "error": _background_errors[asset_id]}
        if asset_id in _background_results:
            return {"status": "COMPLETED", "result": _background_results[asset_id]}
        job = _background_jobs.get(asset_id)
        if job is not None and job.is_alive():
            return {"status": "RUNNING", "progress": _background_progress.get(asset_id)}
    return {"status": "NOT_FOUND"}


def cancel_background(asset_id: str) -> bool:
    """Cancel a running background transcription for the given asset_id.

    FIX 4: sets the cooperative cancel flag so the whisper segment loop exits
    early. Returns True if a running job was signalled, False if none was
    running. Terminal results are left intact (a cancel of a finished job is a
    no-op rather than a destructive delete).
    """
    with _state_lock:
        job = _background_jobs.get(asset_id)
        cancel_event = _background_cancel.get(asset_id)
        if job is None or not job.is_alive() or cancel_event is None:
            return False
        cancel_event.set()

    print(f"[bg] Cancel requested for asset {asset_id}")
    return True
