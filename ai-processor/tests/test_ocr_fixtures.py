"""Deterministic OCR tests against small committed synthetic fixtures.

Unlike `test_ocr.py` (which stubs cv2/pytesseract), these run the REAL OCR path
over real decoded frames using the tiny fixtures in `tests/fixtures/` — with no
external AI, no network, and no production media.

They exercise exactly the behavior the ADR-006 §20 decision relies on:
  - frame extraction yields real frames (regression guard for the frozen-frame
    bug) and the caption present in the fixture is actually read;
  - the five-frame sampling grid reads a caption that is only on screen for a
    window, and reads nothing when the window is not covered.

Skipped (with a recorded reason) when cv2/pytesseract or the fixtures are absent,
matching TMIP's env-gated pattern; the hermetic unit suite still runs everywhere.
Run inside the ai-processor image for real coverage:

    docker exec tmip-ai sh -c 'cd /app && python -m pytest tests -q'
"""

import os
import sys

import pytest

# `test_ocr.py` injects stub `cv2`/`pytesseract` modules into `sys.modules` (to
# keep the unit suite hermetic). Those stubs persist across the session, so a
# plain `importorskip("cv2")` would pass falsely here and then run OCR against a
# stub. A real extension module has a `__file__`; the `types.ModuleType` stub
# does not, so require `__file__` to be present.
def _is_real_module(name: str, attr: str) -> bool:
    try:
        mod = __import__(name)
    except Exception:
        return False
    return hasattr(mod, attr) and getattr(mod, "__file__", None) is not None


FIXTURES_DIR = os.path.join(os.path.dirname(__file__), "fixtures")
CAPTION_ALWAYS = os.path.join(FIXTURES_DIR, "caption_always.mp4")
CAPTION_WINDOW = os.path.join(FIXTURES_DIR, "caption_window.mp4")

pytestmark = [
    pytest.mark.skipif(not _is_real_module("cv2", "imdecode"), reason="real cv2 not installed"),
    pytest.mark.skipif(
        not _is_real_module("pytesseract", "image_to_string"),
        reason="real pytesseract not installed",
    ),
    pytest.mark.skipif(
        not (os.path.exists(CAPTION_ALWAYS) and os.path.exists(CAPTION_WINDOW)),
        reason="synthetic fixtures missing (run tests/fixtures/generate_fixtures.py)",
    ),
]

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))


@pytest.fixture(scope="module")
def ocr():
    """Import the handler lazily so collection never fails without cv2.

    The module-level skipif marks are evaluated at import, but importing
    `app.handlers.ocr` itself needs cv2; deferring it into a fixture keeps the
    module collectable (and skippable) on hosts without the ML stack.
    """
    from app.handlers import ocr as _ocr
    return _ocr


def _norm(text: str) -> str:
    """Alphanumeric-only, upper-cased: OCR spacing noise must not flake a test."""
    return "".join(ch for ch in (text or "").upper() if ch.isalnum())


def test_fixture_caption_is_read(ocr):
    """The burned-in caption of the 'always' fixture is read by the pipeline."""
    result = ocr.sample_lower_third_text(CAPTION_ALWAYS, duration_sec=6.0)
    assert _norm("TMIPCAPTION") in _norm(result["raw_text"])
    assert result["sampled_count"] == len(ocr.SAMPLE_FRACTIONS)


def test_fixture_frames_are_distinct(ocr):
    """Distinct timestamps decode to distinct pixels (frozen-frame regression)."""
    import hashlib

    import numpy as np

    hashes = []
    for ts in (0.5, 2.0, 5.0):
        frame = ocr._extract_frame(CAPTION_ALWAYS, ts)
        assert frame is not None
        hashes.append(hashlib.md5(np.ascontiguousarray(frame).tobytes()).hexdigest())
    assert len(set(hashes)) == len(hashes)


def test_fixture_windowed_caption_read_deterministically(ocr):
    """A caption visible only in t=4..6 is read inside and absent outside."""
    inside = ocr.extract_lower_third_text(ocr._extract_frame(CAPTION_WINDOW, 5.0))
    outside = ocr.extract_lower_third_text(ocr._extract_frame(CAPTION_WINDOW, 1.0))
    assert _norm("TMIPLOWERTHIRD") in _norm(inside)
    assert _norm("TMIPLOWERTHIRD") not in _norm(outside)


def test_fixture_sampling_reads_the_window(ocr):
    """Five-frame sampling over the windowed fixture still finds the caption.

    The caption spans 4..6 s of a 10 s clip, so the 50% sample (t=5) lands inside
    it; this is what makes the fixture a usable deterministic OCR target.
    """
    result = ocr.sample_lower_third_text(CAPTION_WINDOW, duration_sec=10.0)
    assert _norm("TMIPLOWERTHIRD") in _norm(result["raw_text"])
