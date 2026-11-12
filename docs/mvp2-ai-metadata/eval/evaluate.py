"""Deterministic evaluation harness for MVP 2 AI metadata — CONTRACT + FIXTURE checks.

Purpose
-------
Provide a small, reproducible evaluation foundation for the AI enrichment stages
(transcription, summary, keywords, classification, OCR) that:
  - runs WITHOUT any external AI call (no LLM, no Whisper, no network),
  - validates the *shape* of stage payloads against the canonical contract
    (`docs/mvp2-ai-metadata/01-ai-metadata-contract.md`),
  - checks OCR/frame behaviour deterministically against tiny synthetic fixtures,
  - and defines the machine-readable evaluation sample format used to record
    human reference data, produced output, and human judgment separately.

It does NOT and CANNOT judge semantic quality. Contract/fixture checks passing is
not evidence that summaries, transcripts, keywords, or OCR are *accurate*; that
requires human review against reference data (see `09-quality-evaluation.md`).

Usage
-----
    python evaluate.py --self-test          # run contract checks on synthetic payloads
    python evaluate.py --ocr-fixtures DIR   # run fixture-based OCR checks (needs cv2/pytesseract)
    python evaluate.py --sample FILE.json   # validate an evaluation sample file

The module is import-safe: importing it pulls no heavy dependency. OCR fixture
checks import `app.handlers.ocr` lazily and are skipped if it is unavailable.
"""

from __future__ import annotations

import argparse
import json
import os
import sys

# ── Canonical contract checks (pure, dependency-free) ───────────────────────
# These mirror `01-ai-metadata-contract.md` §3. They validate SHAPE only.

STAGE_NAMES = ("TRANSCRIPTION", "SUMMARY", "KEYWORDS", "CLASSIFICATION", "OCR")


def _is_str(v) -> bool:
    return isinstance(v, str)


def check_transcription(payload: dict) -> list[str]:
    errs: list[str] = []
    segs = payload.get("segments")
    if not isinstance(segs, list):
        errs.append("segments must be a list")
    else:
        for i, s in enumerate(segs):
            if not isinstance(s, dict) or not {"start", "end", "text"} <= set(s):
                errs.append(f"segment[{i}] must have start/end/text")
                continue
            if not isinstance(s["start"], (int, float)) or not isinstance(s["end"], (int, float)):
                errs.append(f"segment[{i}] start/end must be numeric")
            elif s["start"] > s["end"]:
                errs.append(f"segment[{i}] start > end")
            if not _is_str(s["text"]):
                errs.append(f"segment[{i}] text must be a string")
    if not _is_str(payload.get("full_text")):
        errs.append("full_text must be a string")
    if "duration_sec" in payload and payload["duration_sec"] is not None:
        d = payload["duration_sec"]
        if not isinstance(d, (int, float)) or d < 0:
            errs.append("duration_sec must be a non-negative number or null")
    if "language" in payload and payload["language"] is not None and not _is_str(payload["language"]):
        errs.append("language must be a string or null")
    return errs


def check_summary(payload: dict) -> list[str]:
    errs: list[str] = []
    if not _is_str(payload.get("summary")) or payload["summary"].strip() == "":
        errs.append("summary must be a non-empty string")
    return errs


def check_keywords(payload: dict) -> list[str]:
    errs: list[str] = []
    kws = payload.get("keywords")
    if not isinstance(kws, list):
        errs.append("keywords must be a list (an empty list is valid)")
    else:
        for i, k in enumerate(kws):
            if not _is_str(k) or k.strip() == "":
                errs.append(f"keyword[{i}] must be a non-empty string")
    return errs


def check_classification(payload: dict) -> list[str]:
    errs: list[str] = []
    if not _is_str(payload.get("category")) or payload["category"].strip() == "":
        errs.append("category must be a non-empty string")
    return errs


def check_ocr(payload: dict) -> list[str]:
    errs: list[str] = []
    if not _is_str(payload.get("raw_text")):
        errs.append("raw_text must be a string")
    if "presenter" not in payload:
        errs.append("presenter key must be present")
    else:
        pres = payload["presenter"]
        if pres is not None:
            if not isinstance(pres, dict) or not {"name", "role"} <= set(pres):
                errs.append("presenter must be null or an object with name/role")
            else:
                for key in ("name", "role"):
                    if pres[key] is not None and not _is_str(pres[key]):
                        errs.append(f"presenter.{key} must be a string or null")
    if "sampled_count" in payload and payload["sampled_count"] is not None:
        sc = payload["sampled_count"]
        if not isinstance(sc, int) or isinstance(sc, bool) or sc < 0:
            errs.append("sampled_count must be a non-negative integer")
    if "best_timestamp_sec" in payload and payload["best_timestamp_sec"] is not None:
        bt = payload["best_timestamp_sec"]
        if not isinstance(bt, (int, float)) or bt < 0:
            errs.append("best_timestamp_sec must be a non-negative number")
    return errs


CHECKERS = {
    "TRANSCRIPTION": check_transcription,
    "SUMMARY": check_summary,
    "KEYWORDS": check_keywords,
    "CLASSIFICATION": check_classification,
    "OCR": check_ocr,
}


def check_stage(stage: str, payload: dict) -> list[str]:
    if stage not in CHECKERS:
        return [f"unknown stage {stage!r}"]
    if not isinstance(payload, dict):
        return [f"{stage} payload must be an object"]
    return CHECKERS[stage](payload)


# ── Fixture-based OCR checks (lazy import; no external AI) ──────────────────

CAPTION_ALWAYS = "TMIPCAPTION"
CAPTION_WINDOW = "TMIPLOWERTHIRD"


def _normalise(text: str) -> str:
    """Collapse whitespace/case so OCR spacing noise does not flake the check.

    OCR sometimes inserts spaces inside a token ("TMIPCAP TION"); this compares
    the alphanumeric content only.
    """
    return "".join(ch for ch in (text or "").upper() if ch.isalnum())


def run_ocr_fixture_checks(fixtures_dir: str) -> list[tuple[str, bool, str]]:
    """Return (name, ok, detail) for deterministic OCR/fixture checks.

    Requires cv2 + pytesseract (present in the ai-processor image). Callers that
    lack them should skip rather than fail.
    """
    # Make `app.handlers.ocr` importable. When run inside the ai-processor image
    # the app is at /app; from the repo we add the ai-processor directory.
    here = os.path.dirname(os.path.abspath(__file__))
    for candidate in (
        "/app",
        os.path.abspath(os.path.join(here, "..", "..", "..", "ai-processor")),
    ):
        if os.path.isdir(os.path.join(candidate, "app")):
            if candidate not in sys.path:
                sys.path.insert(0, candidate)
            break
    from app.handlers import ocr  # lazy: heavy deps

    results: list[tuple[str, bool, str]] = []

    f_always = os.path.join(fixtures_dir, "caption_always.mp4")
    f_window = os.path.join(fixtures_dir, "caption_window.mp4")

    if os.path.exists(f_always):
        res = ocr.sample_lower_third_text(f_always, duration_sec=6.0)
        ok = _normalise(CAPTION_ALWAYS) in _normalise(res["raw_text"])
        results.append(("ocr_fixture_caption_always_read", ok, repr(res["raw_text"][:40])))
    else:
        results.append(("ocr_fixture_caption_always_read", False, "fixture missing"))

    if os.path.exists(f_window):
        # Frame inside the caption window (t=5) must read it; frames outside
        # (t=1, t=9) must not.
        inside = ocr.extract_lower_third_text(ocr._extract_frame(f_window, 5.0))
        outside = ocr.extract_lower_third_text(ocr._extract_frame(f_window, 1.0))
        ok = (_normalise(CAPTION_WINDOW) in _normalise(inside)
              and _normalise(CAPTION_WINDOW) not in _normalise(outside))
        results.append(("ocr_fixture_window_respected", ok,
                        f"inside={inside[:24]!r} outside={outside[:24]!r}"))
    else:
        results.append(("ocr_fixture_window_respected", False, "fixture missing"))

    return results


# ── Evaluation sample format ────────────────────────────────────────────────

SAMPLE_REQUIRED_KEYS = {"sample_id", "reference", "produced", "human_judgment"}


def validate_sample(sample: dict, allow_unfilled: bool = False) -> list[str]:
    """Validate the machine-readable evaluation sample structure.

    The sample separates (a) human REFERENCE data, (b) machine PRODUCED output,
    and (c) human JUDGMENT — so a contract check can never masquerade as a
    quality score. See `09-quality-evaluation.md` for the field meanings.

    With `allow_unfilled=True` the checker validates STRUCTURE only and tolerates
    empty placeholder values (used for the template/example file). Without it,
    empty required values are errors (used for real recorded samples).
    """
    errs: list[str] = []
    if not isinstance(sample, dict):
        return ["sample must be an object"]
    missing = SAMPLE_REQUIRED_KEYS - set(sample)
    if missing:
        errs.append(f"missing keys: {sorted(missing)}")
    ref = sample.get("reference")
    if ref is not None:
        if not isinstance(ref, dict):
            errs.append("reference must be an object")
        else:
            allowed = {"transcript_excerpt", "keywords", "category", "caption_text"}
            extra = set(ref) - allowed
            if extra:
                errs.append(f"reference has unknown keys: {sorted(extra)}")
            if "keywords" in ref and not isinstance(ref["keywords"], list):
                errs.append("reference.keywords must be a list")
    produced = sample.get("produced")
    if produced is not None:
        if not isinstance(produced, dict):
            errs.append("produced must be an object (stage -> payload)")
        else:
            for stage, payload in produced.items():
                if stage in CHECKERS:
                    stage_errs = check_stage(stage, payload)
                    if allow_unfilled:
                        # Template mode: only structural problems (wrong types)
                        # are reported; empty values are acceptable placeholders.
                        stage_errs = [e for e in stage_errs if "non-empty" not in e]
                    errs.extend(f"produced.{stage}: {e}" for e in stage_errs)
    judgment = sample.get("human_judgment")
    if judgment is not None:
        if not isinstance(judgment, dict):
            errs.append("human_judgment must be an object")
        elif not allow_unfilled:
            # Judgment is explicitly human-supplied; a real sample must name the
            # reviewer so a synthesized label can never pass as human judgment.
            if "reviewer" not in judgment or not _is_str(judgment.get("reviewer", "")):
                errs.append("human_judgment.reviewer is required (string)")
    return errs


# ── CLI ─────────────────────────────────────────────────────────────────────

def _self_test() -> int:
    """Run contract checks against synthetic payloads (no deps, no AI)."""
    cases = {
        "TRANSCRIPTION": {"segments": [{"start": 0, "end": 1.5, "text": "halo"}],
                          "full_text": "halo", "duration_sec": 1.5, "language": "id"},
        "SUMMARY": {"summary": "Ringkasan contoh."},
        "KEYWORDS": {"keywords": ["kopi", "banten"]},
        "CLASSIFICATION": {"category": "Dokumenter"},
        "OCR": {"raw_text": "TMIPCAPTION", "presenter": None,
                "sampled_count": 5, "best_timestamp_sec": 3.0},
    }
    ok = True
    for stage, payload in cases.items():
        errs = check_stage(stage, payload)
        print(f"[{'OK ' if not errs else 'BAD'}] {stage} {'; '.join(errs)}")
        ok = ok and not errs
    # Empty keywords are valid; a malformed OCR presenter is not.
    assert not check_stage("KEYWORDS", {"keywords": []})
    assert check_stage("OCR", {"raw_text": "", "presenter": {"name": 1, "role": None}})
    print("self-test:", "PASS" if ok else "FAIL")
    return 0 if ok else 1


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--self-test", action="store_true",
                        help="run contract checks on synthetic payloads")
    parser.add_argument("--ocr-fixtures", metavar="DIR",
                        help="run fixture-based OCR checks against DIR")
    parser.add_argument("--sample", metavar="FILE",
                        help="validate an evaluation sample JSON file")
    parser.add_argument("--template", action="store_true",
                        help="with --sample: validate structure only (allow empty placeholders)")
    args = parser.parse_args(argv)

    ran = False
    exit_code = 0

    if args.self_test:
        ran = True
        exit_code |= _self_test()

    if args.ocr_fixtures:
        ran = True
        for name, ok, detail in run_ocr_fixture_checks(args.ocr_fixtures):
            print(f"[{'OK ' if ok else 'FAIL'}] {name} :: {detail}")
            if not ok:
                exit_code = 1

    if args.sample:
        ran = True
        with open(args.sample, encoding="utf-8") as fh:
            sample = json.load(fh)
        errs = validate_sample(sample, allow_unfilled=args.template)
        print(f"[{'OK ' if not errs else 'BAD'}] sample {args.sample}")
        for e in errs:
            print("   -", e)
        if errs:
            exit_code = 1

    if not ran:
        parser.print_help()
        return 2
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
