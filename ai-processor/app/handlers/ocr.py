"""
OCR lower-third text extraction from video frames.

TMIP Phase 14 (ADR-006 §17). Uses Tesseract OCR plus an optional LLM call to
parse presenter/guest names from lower-third graphics.

Multi-frame sampling: a single frame (the source behaviour) is unreliable — the
first frame of a broadcast is frequently black or a title card, so OCR on it
yields noise. When the caller supplies a valid duration, five frames are sampled
at 10/30/50/70/90 % of the duration (see SAMPLE_FRACTIONS) and the best-scoring
text is returned. This is a bounded heuristic, not a guarantee of catching a
short lower-third (ADR-006 §20). No frame is written anywhere: the video is
opened read-only and frames are processed in memory (ADR-002).

Frame extraction uses the FFmpeg CLI, not `cv2.VideoCapture`. Reason (recorded
evidence, 2026-10-13): with the image's OpenCV 5.0.0 + FFmpeg 7.x, OpenCV
returned the SAME frame for every timestamp on a real H.264 broadcast file
(identical pixel hashes across 30 s/300 s/700 s/1200 s, and even on
consecutive `grab()` reads), so multi-frame sampling was effectively reading
one frame five times. The FFmpeg CLI seeks correctly: `-ss` before `-i` yields
distinct frames at every sample point. FFmpeg is already a hard dependency of
this image (used by the metadata pipeline), so this adds no new dependency.
"""

import os
import re
import subprocess

import cv2
import numpy as np
import pytesseract

from .openrouter import call_openrouter, is_available

# Sampling fractions of the total duration (ADR-006 §17, §20). The adopted
# strategy is five frames at 10/30/50/70/90 % — a deliberate, bounded scan that
# is never the whole video (ADR-006 §20). A denser 14-frame grid was trialled
# (2026-10-13) and reverted: it did not reliably improve lower-third detection
# and added per-frame cost (see ADR-006 §20 for the measured evidence).
SAMPLE_FRACTIONS = (0.10, 0.30, 0.50, 0.70, 0.90)

# FFmpeg executable. Overridable for environments where it is not on PATH; the
# image installs it at /usr/bin/ffmpeg (see ai-processor/Dockerfile).
FFMPEG_BIN = os.environ.get("FFMPEG_BIN", "ffmpeg")

# Per-frame extraction ceiling. A seek + single-frame decode is well under a
# second in practice (5 frames ≈ 3 s measured); this only bounds a hung ffmpeg
# so one bad frame cannot block the OCR stage (ADR-006 §14 rationale).
FRAME_EXTRACT_TIMEOUT_SEC = 30

# A plausible lower-third is short. Very long "text" is almost always OCR noise
# over a busy frame, so it is penalized rather than rewarded.
_PLAUSIBLE_MIN = 3
_PLAUSIBLE_MAX = 120

_WORD_RE = re.compile(r"[A-Za-zÀ-ÿ]{2,}")

# A real word is short. A "word" longer than this is a run of noise characters,
# so its contribution is capped instead of being summed into a huge score.
_MAX_PLAUSIBLE_WORD = 20


def _word_score(words: list[str]) -> float:
    """Credit plausible words, cap implausibly long tokens (noise runs)."""
    total = 0.0
    for word in words:
        if len(word) <= _MAX_PLAUSIBLE_WORD:
            total += len(word)
        else:
            # A 5000-character "word" is not text; give it minimal credit so a
            # long noise run cannot outscore a short real caption.
            total += 2.0
    return total


def extract_lower_third_text(
    frame,
    height_ratio: float = 0.25,
    lang: str = "ind+eng",
) -> str:
    """
    Extract text from the lower portion of a video frame (lower-third region).

    Args:
        frame: numpy array (H, W, 3) BGR image
        height_ratio: fraction of the frame bottom to crop (default 0.25 = bottom 25%)
        lang: Tesseract language string

    Returns:
        Extracted text string (may be empty if nothing found)

    The ROI is passed to Tesseract in COLOUR, without the grayscale + Otsu
    binarization the source used. Reason (recorded evidence, 2026-10-13): on a
    real broadcast lower-third, binarization DESTROYED the caption. A factor
    sweep at the confirmed lower-third frame (t=620 s) gave the presenter name
    in 12/12 colour combinations and 0/12 grayscale-or-Otsu combinations —
    colour reads `Zanz zabela` / `bawa Acara` (= "Pembawa Acara") while
    grayscale/Otsu recover only the `INDONESIA` watermark fragment. Tesseract
    already thresholds internally, and Otsu over a whole lower-third band
    (bright logo + thin caption text) picks a global cut that erases the text.
    """
    h, w = frame.shape[:2]
    crop_y = int(h * (1 - height_ratio))
    roi = frame[crop_y:h, :]

    config = f"--psm 6 -l {lang}"
    text = pytesseract.image_to_string(roi, config=config)

    return text.strip()


def text_quality_score(text: str) -> float:
    """Score OCR output so the best frame can be chosen (ADR-006 §17).

    Character count alone is a poor signal: a noisy frame produces plenty of
    junk characters. This combines several cheap, independent signals:

      - alphanumeric ratio (real text is mostly letters/digits/space/punctuation),
      - plausible length (short-but-real beats long-and-garbage),
      - dictionary-free word quality (2+ letter words that look like words),
      - repetition/noise penalty (OCR garbage repeats tokens and symbols).

    Returns a non-negative float; 0 means "no usable text".
    """
    if text is None:
        return 0.0
    stripped = text.strip()
    if stripped == "":
        return 0.0

    alnum = sum(1 for ch in stripped if ch.isalnum())
    total = len(stripped)
    alnum_ratio = alnum / total

    # Words of 2+ alphabetic characters are a strong signal of real text.
    words = _WORD_RE.findall(stripped)
    word_score = _word_score(words)

    # Repetition penalty: a token repeated many times ("aaa aaa aaa") is noise.
    lowered = [word.lower() for word in words]
    unique_ratio = (len(set(lowered)) / len(lowered)) if lowered else 0.0

    # Plausible-length factor: peak inside [_PLAUSIBLE_MIN, _PLAUSIBLE_MAX],
    # tapering off for very short or very long outputs.
    if total < _PLAUSIBLE_MIN:
        length_factor = total / _PLAUSIBLE_MIN
    elif total <= _PLAUSIBLE_MAX:
        length_factor = 1.0
    else:
        length_factor = _PLAUSIBLE_MAX / total

    return (alnum_ratio**2) * length_factor * (word_score + unique_ratio * 10.0)


def _clamp_timestamp(seconds: float, duration: float | None) -> float:
    """Keep a sample timestamp inside the video's real range."""
    if seconds < 0:
        return 0.0
    if duration is not None and duration > 0:
        # Stay a hair inside the end; seeking exactly to EOF returns no frame.
        return min(seconds, max(0.0, duration - 0.05))
    return seconds


def _extract_frame(video_path: str, timestamp_sec: float):
    """Decode one frame at a timestamp via the FFmpeg CLI.

    Returns a BGR (H, W, 3) uint8 array, or None when the frame cannot be
    decoded (missing executable, timeout, bad media, empty output). A PNG is
    streamed over stdout and decoded in memory — nothing is written to disk, so
    the source media tree stays untouched (ADR-002).

    `-ss` is placed BEFORE `-i` for fast, accurate seeking: placing it after
    forces FFmpeg to decode from the start and made a 20-minute file's later
    seeks exceed a 60 s bound in testing.
    """
    cmd = [
        FFMPEG_BIN, "-nostdin",
        "-ss", f"{timestamp_sec:.3f}",
        "-i", video_path,
        "-frames:v", "1",
        "-f", "image2pipe", "-vcodec", "png",
        "pipe:1",
    ]
    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            timeout=FRAME_EXTRACT_TIMEOUT_SEC,
        )
    except (OSError, subprocess.TimeoutExpired):
        # Missing/unusable executable or a hung decode: this frame is skipped,
        # never fatal to the stage (mirrors the read failure contract).
        return None

    if proc.returncode != 0 or not proc.stdout:
        return None

    frame = cv2.imdecode(np.frombuffer(proc.stdout, dtype=np.uint8), cv2.IMREAD_COLOR)
    return frame


def sample_lower_third_text(
    video_path: str,
    duration_sec: float | None = None,
    height_ratio: float = 0.25,
    lang: str = "ind+eng",
    fractions=SAMPLE_FRACTIONS,
) -> dict:
    """Sample frames at the configured fractions and return the best-scoring text.

    With the adopted default (`SAMPLE_FRACTIONS`) this samples five frames at
    10/30/50/70/90 % of the duration (ADR-006 §20).

    Returns a dict:
        raw_text          best text found ("" when nothing usable)
        sampled_count     frames actually decoded and OCR'd
        best_timestamp_sec  timestamp of the winning frame (0.0 when fallback)

    Falls back to a single frame at t=0 when the duration is missing or invalid,
    so the contract stays valid for callers that cannot supply one. Never raises
    for an unreadable frame: an empty result is a valid outcome.
    """
    valid_duration = duration_sec if (duration_sec is not None and duration_sec > 0) else None

    if valid_duration is None:
        # Fallback: single frame at the start (previous behaviour).
        timestamps = [0.0]
    else:
        timestamps = [_clamp_timestamp(valid_duration * f, valid_duration) for f in fractions]

    best_text = ""
    best_score = 0.0
    best_ts = timestamps[0] if timestamps else 0.0
    sampled = 0

    for ts in timestamps:
        frame = _extract_frame(video_path, ts)
        if frame is None:
            continue
        try:
            text = extract_lower_third_text(frame, height_ratio=height_ratio, lang=lang)
        except Exception:
            # A single unreadable frame must not fail the whole stage; it is
            # not counted as a successful sample.
            continue
        sampled += 1
        score = text_quality_score(text)
        if score > best_score:
            best_score = score
            best_text = text
            best_ts = ts

    return {
        "raw_text": best_text,
        "sampled_count": sampled,
        "best_timestamp_sec": best_ts,
    }


def parse_presenter_info(lower_third_text: str) -> dict | None:
    """
    Parse lower-third text into presenter name and role using LLM.

    Returns dict with:
        - name: str | None
        - role: str | None
    Returns None if the LLM is not configured or parsing fails.
    """
    if not lower_third_text or not is_available():
        return None

    # Clean and truncate OCR text
    cleaned = lower_third_text.replace("\n", " ").strip()[:300]

    prompt = (
        f"Teks dari lower-third (teks grafis di bagian bawah layar video) berikut:\n"
        f"\"{cleaned}\"\n\n"
        f"TUGAS: Parse teks ini menjadi nama pembawa acara/presenter/narasumber dan jabatannya "
        f"(kalau ada, misal: 'Dokter', 'Ahli', 'Ketua', dll).\n\n"
        f"Format jawaban persis:\n"
        f"NAMA: <nama, atau 'tidak terdeteksi' jika tidak jelas>\n"
        f"JABATAN: <jabatan, atau 'tidak terdeteksi' jika tidak jelas>\n"
    )

    try:
        response = call_openrouter(prompt, max_tokens=100)
    except Exception:
        # Presenter parsing is a nice-to-have; never fail the OCR stage for it.
        return None
    if not response:
        return None

    name, role = None, None
    for line in response.splitlines():
        line = line.strip()
        if line.upper().startswith("NAMA:"):
            val = line.split(":", 1)[1].strip()
            name = None if val.lower() in ("tidak terdeteksi", "none", "") else val
        elif line.upper().startswith("JABATAN:"):
            val = line.split(":", 1)[1].strip()
            role = None if val.lower() in ("tidak terdeteksi", "none", "") else val

    return {"name": name, "role": role}
