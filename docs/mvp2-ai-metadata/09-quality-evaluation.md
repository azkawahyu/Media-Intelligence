# 09 — AI Quality Evaluation Strategy

Status: **deterministic foundation implemented** (2026-10-13); semantic quality
evaluation remains **open** (OD-07). No quality number is claimed. This document
defines *how* MVP 2 AI quality is evaluated and what has actually been built.

## 0. What is implemented now (deterministic foundation)

The offline, dependency-light foundation lives in `docs/mvp2-ai-metadata/eval/`:

| Artifact | What it does | Runs |
|---|---|---|
| `eval/evaluate.py --self-test` | Contract-shape checks for the five stages on synthetic payloads | Anywhere (no cv2/LLM) |
| `eval/evaluate.py --ocr-fixtures DIR` | Real OCR/frame checks over the tiny fixtures | ai-processor image (cv2 + pytesseract) |
| `eval/evaluate.py --sample FILE` | Validates the machine-readable evaluation sample format | Anywhere |
| `eval/sample.example.json` | The sample format (reference / produced / human_judgment), placeholders only | — |
| `ai-processor/tests/fixtures/generate_fixtures.py` | Byte-deterministic regeneration of the fixtures | Needs ffmpeg |
| `ai-processor/tests/test_ocr_fixtures.py` | Real-OCR pytest checks over the fixtures (env-gated) | ai-processor image |

Fixtures are tiny synthetic videos with a **known burned-in caption**
(`caption_always.mp4` 7.5 KB; `caption_window.mp4` 11.5 KB), safe to commit per
`TESTING.md §33`. They exercise frame distinctness, caption read, and
window-respecting sampling — deterministically, with **no external AI call**.

## 1. Problem

AI enrichment output (transcript, summary, keywords, category, OCR) is
non-deterministic in wording. There is **no golden dataset** in TMIP or in the
team repository (verified: no `golden`/`expected` artifacts beyond this set).
Contract parity between TMIP and the team pipeline is covered by tests
(`ai-processor/tests/test_team_parity.py`); **live output/quality parity is
unmeasured**.

## 2. Constraints that shape the strategy

- `TESTING.md §33`: repository test media must be small, non-confidential, legally
  usable, stable; avoid committing large production media.
- LLM/OCR output is non-deterministic → byte-for-byte comparison is meaningless;
  evaluation must be **semantic** and human-judged where needed.
- No quality threshold may be set before a measured baseline exists.
- Any live evaluation needs a real LLM key and CPU time (Whisper is slow); it
  therefore cannot be a mandatory CI gate.

## 3. Tiered strategy

### Tier 1 — Contract & behavior tests (deterministic, already the backbone)

- Inputs: synthetic ffprobe JSON fixtures (`apps/api/src/metadata/fixtures/`) and
  stubbed processors.
- Asserts: response **shape** against the canonical contract, error
  classification, bounded retry, idempotent upsert, partial-result folding,
  cancellation transitions.
- No LLM, no video. Runs in CI. This is what guards regressions today.

### Tier 2 — Deterministic media fixtures (IMPLEMENTED)

- Tiny **generated** videos with a known burned-in caption
  (`ai-processor/tests/fixtures/caption_always.mp4`, `caption_window.mp4`), built
  byte-deterministically by `generate_fixtures.py` (`-fflags +bitexact -flags +bitexact`).
- Asserts (no LLM): frames at different timestamps are **distinct** (frozen-frame
  regression guard); OCR reads the known caption; a caption visible only in a time
  window is read inside and absent outside; the sampling grid reads the window.
- Real-OCR checks live in `ai-processor/tests/test_ocr_fixtures.py` (env-gated:
  skipped where cv2/pytesseract are absent) and in `eval/evaluate.py --ocr-fixtures`.
  Verified in the ai-processor container against the five-frame grid.
- Committed as tiny fixtures (7.5 KB + 11.5 KB), consistent with `TESTING.md §33`.

### Tier 3 — Live quality evaluation (opt-in, gated, manual) — NOT implemented

- A small **golden set** (3–5 short, non-confidential clips) with **human-recorded
  expectations**: a reference transcript excerpt, the gist of the summary, the
  intended keywords/category, and the visible presenter caption (where one exists).
- Run manually with a real LLM key; results compared **semantically** (human
  review), and recorded as a report — **not** a pass/fail CI gate.
- Because one real test video is already available locally for manual checks
  (`Pesona Indonesia…mp4`), it may be used for manual evaluation but **must not** be
  committed (size/confidentiality).
- **Not started.** It needs a real LLM key and CPU time; per task constraints no
  live call was made.

## 3a. Evaluation sample format (machine-readable)

A sample separates three concerns so an automated check can never masquerade as a
quality score (`eval/sample.example.json` is the template):

```jsonc
{
  "sample_id": "...",
  "source":    { "kind": "...", "ref": "...", "duration_sec": 0 },
  "reference": { "transcript_excerpt": null, "keywords": [], "category": null, "caption_text": null },
  "produced":  { "TRANSCRIPTION": {...}, "SUMMARY": {...}, "KEYWORDS": {...},
                 "CLASSIFICATION": {...}, "OCR": {...} },
  "human_judgment": { "reviewer": null, "reviewed_at": null,
                      "summary_score": null, "keyword_precision": null,
                      "keyword_recall": null, "category_match": null,
                      "transcript_wer": null, "ocr_match": null, "notes": null }
}
```

- `reference` and `human_judgment` are **human-supplied**; the validator requires a
  `reviewer` for a real (non-template) sample so a synthesized label cannot pass as
  human judgment.
- `produced` is machine output and is checked for **shape** against the contract.
- Validate with: `python eval/evaluate.py --sample FILE` (add `--template` for
  structure-only checks of the placeholder file).

## 3b. Execution procedure (offline)

```bash
# Contract checks (no dependencies, no AI):
python docs/mvp2-ai-metadata/eval/evaluate.py --self-test

# Real OCR/fixture checks (inside the ai-processor container):
docker cp docs/mvp2-ai-metadata/eval/evaluate.py tmip-ai:/tmp/evaluate.py
docker exec tmip-ai mkdir -p /tmp/fx
docker cp ai-processor/tests/fixtures/caption_always.mp4 tmip-ai:/tmp/fx/
docker cp ai-processor/tests/fixtures/caption_window.mp4 tmip-ai:/tmp/fx/
docker exec tmip-ai sh -c 'cd /app && python /tmp/evaluate.py --ocr-fixtures /tmp/fx'

# Regenerate fixtures (byte-deterministic):
python ai-processor/tests/fixtures/generate_fixtures.py --ffmpeg <ffmpeg> [--font <ttf>]
```

## 4. Candidate metrics (to be chosen only after a baseline is measured)

| Stage | Candidate metric | Notes |
|---|---|---|
| TRANSCRIPTION | WER / CER against a reference transcript | Needs a human reference; language-aware |
| SUMMARY | Human relevance score (rubric 1–5) | Non-deterministic; human-judged |
| KEYWORDS | Overlap with a human keyword set (precision/recall) | Set comparison, order-insensitive |
| CLASSIFICATION | Agreement with a human-chosen category | Single label |
| OCR | Exact/partial match of a known caption | Only where a caption is known to exist |

**No threshold is set here.** Thresholds are defined only after Tier-3 produces a
measured baseline, and any threshold is recorded with the evidence that justified
it.

## 4a. Known limitations of the implemented foundation

- The fixtures are **synthetic**: a large clean caption on a flat background. They
  verify plumbing (frames decode distinctly, the caption is read, the window is
  respected) — **not** real-broadcast OCR accuracy. Real lower-third detection
  remains unmeasured (see `ADR-006 §20`).
- Contract checks validate **shape**, never semantic correctness. A passing
  `--self-test` says nothing about whether summaries/keywords are accurate.
- `test_ocr_fixtures.py` is **env-gated**: on the host venv (no cv2/pytesseract) it
  skips; real coverage requires the ai-processor image. The image ships no pytest,
  so the fixture checks are run via `eval/evaluate.py --ocr-fixtures`.
- No web (UI) test runner exists, so the AI UI is still untested (NEW-4).

## 5. What this strategy deliberately does not do

- It does not claim any quality improvement (none measured).
- It does not make live LLM evaluation a CI requirement (cost, non-determinism).
- It does not add a golden dataset to the repository without an approved size/
  confidentiality review.

## 6. Prerequisites before Tier 3 runs

1. A real LLM provider key available in the evaluation environment.
2. A small, legally usable golden clip set with human-recorded expectations.
3. Agreement on the metric(s) and the meaning of "acceptable".

Until these exist, MVP 2 quality remains **contract-verified, quality-unmeasured**.
