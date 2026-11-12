"""Tests for OCR lower-third scoring and multi-frame sampling (ADR-006 §17).

These run without the heavy ML stack: `cv2`, `numpy`, and `pytesseract` are
stubbed via `sys.modules` before importing the handler, so the suite is fast and
does not need a real video. Frame extraction itself (the FFmpeg CLI path) is
unit-tested here with a stubbed `subprocess.run`; real decode distinctness is
covered by `test_ocr_frames_integration.py` (env-gated) and the Docker E2E pass.
"""

import os
import subprocess
import sys
import types

import pytest

# ── Stub cv2 / numpy / pytesseract BEFORE importing the handler ─────────────
_cv2 = types.ModuleType("cv2")
_cv2.IMREAD_COLOR = 1
_cv2.COLOR_BGR2GRAY = 6
_cv2.THRESH_BINARY = 0
_cv2.THRESH_OTSU = 8
_cv2.cvtColor = lambda img, code: img
_cv2.threshold = lambda gray, a, b, flag: (0, gray)
# Decoding is stubbed to a marker so `_extract_frame` has a return value.
_cv2.imdecode = lambda buf, flag: {"decoded": True, "bytes": len(buf)}
sys.modules.setdefault("cv2", _cv2)

_np = types.ModuleType("numpy")
_np.uint8 = "uint8"
_np.frombuffer = lambda buf, dtype=None: buf
sys.modules.setdefault("numpy", _np)

_pytesseract = types.ModuleType("pytesseract")
_pytesseract.image_to_string = lambda img, config="": "STUB"
sys.modules.setdefault("pytesseract", _pytesseract)

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app.handlers import ocr as ocr_module  # noqa: E402


# ── text_quality_score ──────────────────────────────────────────────────────

def test_empty_and_whitespace_score_zero():
    assert ocr_module.text_quality_score("") == 0.0
    assert ocr_module.text_quality_score("   \n  ") == 0.0
    assert ocr_module.text_quality_score(None) == 0.0


def test_real_text_beats_noise():
    real = "Pesona Indonesia Babad Kopi Banten TVRI Jakarta"
    noise = "oa 3 ara pa = aes \"3 P =e oes"
    assert ocr_module.text_quality_score(real) > ocr_module.text_quality_score(noise)


def test_repetition_is_penalized():
    repeated = "aaa aaa aaa aaa aaa aaa aaa aaa"
    varied = "berita pagi nasional hari ini jakarta utama"
    assert ocr_module.text_quality_score(varied) > ocr_module.text_quality_score(repeated)


def test_very_long_text_is_tapered_not_rewarded_blindly():
    short_real = "Dokter Spesialis Anak"
    long_garbage = "x" * 5000
    assert ocr_module.text_quality_score(short_real) > ocr_module.text_quality_score(long_garbage)


# ── timestamp clamping ──────────────────────────────────────────────────────

def test_clamp_timestamp_stays_in_range():
    assert ocr_module._clamp_timestamp(-5, 100) == 0.0
    assert ocr_module._clamp_timestamp(50, 100) == 50
    # Never seek exactly to EOF (no frame there).
    assert ocr_module._clamp_timestamp(100, 100) <= 100
    assert ocr_module._clamp_timestamp(1e9, 100) <= 100


def test_clamp_timestamp_without_duration():
    assert ocr_module._clamp_timestamp(42, None) == 42


# ── frame extraction via the FFmpeg CLI ─────────────────────────────────────

class _Proc:
    def __init__(self, returncode=0, stdout=b"PNGDATA", stderr=b""):
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


def _capture_run(monkeypatch, proc=None, exc=None):
    """Replace subprocess.run in the handler; return the captured argv list."""
    calls = []

    def fake_run(cmd, **kwargs):
        calls.append(cmd)
        if exc is not None:
            raise exc
        return proc

    monkeypatch.setattr(ocr_module.subprocess, "run", fake_run)
    return calls


def test_extract_frame_uses_ffmpeg_with_seek_before_input(monkeypatch):
    calls = _capture_run(monkeypatch, proc=_Proc())
    frame = ocr_module._extract_frame("/media/a.mp4", 123.5)

    assert frame == {"decoded": True, "bytes": len(b"PNGDATA")}
    cmd = calls[0]
    assert cmd[0] == ocr_module.FFMPEG_BIN
    # `-ss` must precede `-i`: after it, FFmpeg decodes from the start and slow
    # seeks exceed the timeout (observed on a real 24-minute file).
    assert cmd.index("-ss") < cmd.index("-i")
    assert cmd[cmd.index("-ss") + 1] == "123.500"
    assert cmd[cmd.index("-i") + 1] == "/media/a.mp4"


def test_extract_frame_missing_executable_returns_none(monkeypatch):
    _capture_run(monkeypatch, exc=FileNotFoundError("ffmpeg not found"))
    assert ocr_module._extract_frame("/media/a.mp4", 10.0) is None


def test_extract_frame_timeout_returns_none(monkeypatch):
    _capture_run(monkeypatch, exc=subprocess.TimeoutExpired(cmd="ffmpeg", timeout=30))
    assert ocr_module._extract_frame("/media/a.mp4", 10.0) is None


def test_extract_frame_nonzero_exit_returns_none(monkeypatch):
    _capture_run(monkeypatch, proc=_Proc(returncode=1, stdout=b"", stderr=b"boom"))
    assert ocr_module._extract_frame("/media/a.mp4", 10.0) is None


def test_extract_frame_empty_output_returns_none(monkeypatch):
    _capture_run(monkeypatch, proc=_Proc(returncode=0, stdout=b""))
    assert ocr_module._extract_frame("/media/a.mp4", 10.0) is None


# ── sampling ────────────────────────────────────────────────────────────────

def _stub_frames(monkeypatch, texts_by_ts):
    """Patch `_extract_frame` to a marker and OCR to a per-timestamp text."""
    def fake_frame(video_path, ts):
        return {"ts": ts}

    def fake_extract(frame, height_ratio=0.25, lang="ind+eng"):
        return texts_by_ts(frame["ts"])

    monkeypatch.setattr(ocr_module, "_extract_frame", fake_frame)
    monkeypatch.setattr(ocr_module, "extract_lower_third_text", fake_extract)


def test_sampling_uses_all_configured_fractions(monkeypatch):
    seen = []
    monkeypatch.setattr(ocr_module, "_extract_frame", lambda p, ts: {"ts": ts})

    def fake_extract(frame, height_ratio=0.25, lang="ind+eng"):
        seen.append(frame["ts"])
        return f"text-{frame['ts']}"

    monkeypatch.setattr(ocr_module, "extract_lower_third_text", fake_extract)

    result = ocr_module.sample_lower_third_text("/media/a.mp4", duration_sec=100.0)
    assert result["sampled_count"] == len(ocr_module.SAMPLE_FRACTIONS)
    assert len(seen) == len(ocr_module.SAMPLE_FRACTIONS)


def test_adopted_sampling_is_five_frames_at_10_30_50_70_90(monkeypatch):
    """OD-11 regression: the adopted strategy is exactly five fixed fractions.

    Pins the decision recorded in ADR-006 §20 so a sampling change cannot happen
    silently. This asserts the *decision*, not detection accuracy.
    """
    assert ocr_module.SAMPLE_FRACTIONS == (0.10, 0.30, 0.50, 0.70, 0.90)

    seen = []
    monkeypatch.setattr(ocr_module, "_extract_frame", lambda p, ts: seen.append(ts) or {"ts": ts})
    monkeypatch.setattr(ocr_module, "extract_lower_third_text", lambda *a, **k: "text")

    result = ocr_module.sample_lower_third_text("/media/a.mp4", duration_sec=100.0)
    assert result["sampled_count"] == 5
    assert seen == [10.0, 30.0, 50.0, 70.0, 90.0]


def test_sampling_timestamps_are_distinct_and_in_range(monkeypatch):
    """Sampled timestamps must be unique, ascending, and inside the video."""
    seen = []
    monkeypatch.setattr(ocr_module, "_extract_frame", lambda p, ts: seen.append(ts) or {"ts": ts})
    monkeypatch.setattr(ocr_module, "extract_lower_third_text", lambda *a, **k: "text")

    duration = 1000.0
    ocr_module.sample_lower_third_text("/media/a.mp4", duration_sec=duration)

    assert len(seen) == len(ocr_module.SAMPLE_FRACTIONS)
    assert seen == sorted(seen), "timestamps must be ascending"
    assert len(set(seen)) == len(seen), "timestamps must be unique"
    assert all(0.0 < ts < duration for ts in seen), "must stay strictly inside the video"


def test_sampling_picks_best_scoring_frame(monkeypatch):
    # The first sampled frame is noise; any later frame has real text and wins.
    first_ts = 100.0 * ocr_module.SAMPLE_FRACTIONS[0]

    def texts(ts):
        return "oa 3 ara pa = aes" if abs(ts - first_ts) < 1e-6 else "Pesona Indonesia Babad Kopi Banten TVRI"

    _stub_frames(monkeypatch, texts)
    result = ocr_module.sample_lower_third_text("/media/a.mp4", duration_sec=100.0)
    assert result["raw_text"] == "Pesona Indonesia Babad Kopi Banten TVRI"
    assert abs(result["best_timestamp_sec"] - first_ts) > 1e-6


def test_fallback_single_frame_when_duration_missing(monkeypatch):
    calls = []
    monkeypatch.setattr(ocr_module, "_extract_frame", lambda p, ts: calls.append(ts) or {"ts": ts})
    monkeypatch.setattr(ocr_module, "extract_lower_third_text", lambda *a, **k: "single frame text")

    result = ocr_module.sample_lower_third_text("/media/a.mp4", duration_sec=None)
    assert result["sampled_count"] == 1
    assert calls == [0.0]
    assert result["best_timestamp_sec"] == 0.0


def test_fallback_for_invalid_duration(monkeypatch):
    monkeypatch.setattr(ocr_module, "_extract_frame", lambda p, ts: {"ts": ts})
    monkeypatch.setattr(ocr_module, "extract_lower_third_text", lambda *a, **k: "text")
    for bad in (0, -1, None):
        result = ocr_module.sample_lower_third_text("/media/a.mp4", duration_sec=bad)
        assert result["sampled_count"] == 1


def test_extreme_duration_does_not_crash(monkeypatch):
    monkeypatch.setattr(ocr_module, "_extract_frame", lambda p, ts: {"ts": ts})
    monkeypatch.setattr(ocr_module, "extract_lower_third_text", lambda *a, **k: "text")
    result = ocr_module.sample_lower_third_text("/media/a.mp4", duration_sec=1e9)
    assert result["sampled_count"] == len(ocr_module.SAMPLE_FRACTIONS)


def test_ocr_error_on_one_frame_is_skipped(monkeypatch):
    calls = {"n": 0}
    monkeypatch.setattr(ocr_module, "_extract_frame", lambda p, ts: {"ts": ts})

    def flaky_extract(frame, height_ratio=0.25, lang="ind+eng"):
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("tesseract blew up")
        return "recovered text"

    monkeypatch.setattr(ocr_module, "extract_lower_third_text", flaky_extract)

    result = ocr_module.sample_lower_third_text("/media/a.mp4", duration_sec=100.0)
    # The failing frame is skipped; the rest still produce a result.
    assert result["raw_text"] == "recovered text"
    assert result["sampled_count"] == len(ocr_module.SAMPLE_FRACTIONS) - 1


def test_undecodable_frames_return_empty_not_crash(monkeypatch):
    # Every frame fails to decode (missing ffmpeg / bad media): empty, no raise.
    monkeypatch.setattr(ocr_module, "_extract_frame", lambda p, ts: None)
    result = ocr_module.sample_lower_third_text("/media/a.mp4", duration_sec=100.0)
    assert result["raw_text"] == ""
    assert result["sampled_count"] == 0
