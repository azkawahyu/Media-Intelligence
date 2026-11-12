"""Integration test: FFmpeg CLI frame extraction yields DISTINCT frames.

This is the regression guard for the bug that motivated Priority 2 (2026-10-13):
`cv2.VideoCapture` returned the SAME frame for every timestamp on a real H.264
broadcast file, so multi-frame OCR was reading one frame five times. The fix
extracts frames with the FFmpeg CLI.

Runs only when a real media file and the FFmpeg CLI are available:
  - env `TMIP_TEST_VIDEO`  : path to a video (must be > 20 s, multiple scenes)
  - env `TMIP_TEST_FFMPEG` : path to ffmpeg (optional; default "ffmpeg")

Skipped (with a recorded reason) when the video is absent or ffmpeg cannot be
run, matching TMIP's env-gated pattern: the unit suite stays hermetic, and the
real decode path is verified in the container (`docker exec tmip-ai pytest`).
"""

import hashlib
import os
import shutil

import numpy as np
import pytest

from app.handlers import ocr

VIDEO = os.environ.get("TMIP_TEST_VIDEO", "")
FFMPEG = os.environ.get("TMIP_TEST_FFMPEG", "ffmpeg")

pytestmark = pytest.mark.skipif(
    not VIDEO or not os.path.exists(VIDEO),
    reason="TMIP_TEST_VIDEO not set to an existing file",
)


def _frame_hash(frame) -> str:
    return hashlib.md5(np.ascontiguousarray(frame).tobytes()).hexdigest()


@pytest.fixture(scope="module", autouse=True)
def _require_ffmpeg():
    if shutil.which(FFMPEG) is None and not os.path.exists(FFMPEG):
        pytest.skip(f"ffmpeg not found at {FFMPEG}")


def test_frames_at_different_timestamps_are_distinct():
    """The regression: different timestamps MUST decode to different pixels."""
    timestamps = [30.0, 120.0, 300.0, 600.0]
    frames = [ocr._extract_frame(VIDEO, ts) for ts in timestamps]

    assert all(f is not None for f in frames), "ffmpeg failed to decode a frame"
    for frame in frames:
        assert frame.ndim == 3 and frame.shape[2] == 3, "expected BGR HxWx3"

    hashes = [_frame_hash(f) for f in frames]
    assert len(set(hashes)) == len(hashes), (
        f"frames are identical across timestamps: {hashes} "
        "(the OpenCV frozen-frame bug regressed)"
    )


def test_consecutive_extractions_are_distinct():
    """Adjacent sample points must also differ (not one frame reused)."""
    frames = [ocr._extract_frame(VIDEO, ts) for ts in (500.0, 505.0, 510.0)]
    hashes = [_frame_hash(f) for f in frames if f is not None]
    assert len(hashes) == 3
    assert len(set(hashes)) == 3


def test_sampling_reports_correct_timestamps():
    """Multi-frame sampling returns distinct best timestamps within range."""
    duration = 1443.0
    result = ocr.sample_lower_third_text(VIDEO, duration_sec=duration)
    assert result["sampled_count"] == len(ocr.SAMPLE_FRACTIONS)
    assert 0.0 <= result["best_timestamp_sec"] <= duration


def test_extract_missing_file_returns_none():
    assert ocr._extract_frame("/media/does-not-exist-xyz.mp4", 0.0) is None


# ── P3: colour ROI reads the lower-third the binarized path destroyed ───────

# Ground-truth lower-third window (presenter name + "bawa acara") on the test
# video, established 2026-10-13: visible only at t≈618–620 s.
LOWER_THIRD_TS = float(os.environ.get("TMIP_TEST_LOWER_THIRD_TS", "620"))

_CAPTION_WORDS = ("zabela", "bawa acara", "pembawa acara")


def _has_caption(text: str) -> bool:
    low = (text or "").lower()
    return any(word in low for word in _CAPTION_WORDS)


def test_colour_roi_reads_the_lower_third():
    """The presenter lower-third is recovered from the COLOUR ROI.

    Regression guard for the P3 defect: the source grayscale+Otsu path read
    only the 'INDONESIA' watermark fragment and lost the presenter name. The
    colour path must recover a caption word at the ground-truth timestamp.
    """
    frame = ocr._extract_frame(VIDEO, LOWER_THIRD_TS)
    assert frame is not None, "ffmpeg failed to decode the lower-third frame"

    colour_text = ocr.extract_lower_third_text(frame, height_ratio=0.25)
    assert _has_caption(colour_text), (
        f"expected a lower-third caption in the colour ROI, got {colour_text!r}"
    )


def test_binarized_roi_loses_the_lower_third():
    """Documents the defect being fixed: grayscale+Otsu loses the caption.

    If this ever starts passing, the assumption behind the colour change is
    wrong and must be revisited — do NOT delete it to go green.
    """
    import cv2

    frame = ocr._extract_frame(VIDEO, LOWER_THIRD_TS)
    assert frame is not None

    h = frame.shape[0]
    roi = frame[int(h * 0.75):h, :]
    gray = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)
    _, thresh = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)

    import pytesseract

    binarized_text = pytesseract.image_to_string(thresh, config="--psm 6 -l ind+eng")
    assert not _has_caption(binarized_text), (
        "grayscale+Otsu unexpectedly recovered the caption; the P3 rationale "
        f"(colour beats binarization) no longer holds: {binarized_text!r}"
    )


def test_no_presenter_false_positive_on_plainer_frames():
    """Frames without a lower-third must not yield a presenter caption."""
    for ts in (100.0, 300.0, 900.0, 1200.0):
        frame = ocr._extract_frame(VIDEO, ts)
        if frame is None:
            continue
        text = ocr.extract_lower_third_text(frame, height_ratio=0.25)
        assert not _has_caption(text), f"false-positive caption at t={ts}: {text!r}"

