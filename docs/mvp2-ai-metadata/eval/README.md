# MVP 2 Evaluation Foundation

Deterministic, offline evaluation tooling for AI metadata enrichment. **No
external AI calls** (no LLM, no Whisper, no network). This foundation validates
*contract shape* and *fixture-based OCR/frame behavior* only; it does **not**
judge semantic quality (see `../09-quality-evaluation.md`).

## Contents

| Path | Purpose |
|---|---|
| `evaluate.py` | Harness: contract checks, fixture OCR checks, sample-file validation |
| `sample.example.json` | Machine-readable evaluation sample format (placeholders only) |
| `samples/` | Recorded evaluation samples (human review; may be qualitative-only) |
| `ai-processor/tests/fixtures/generate_fixtures.py` | Regenerates the tiny synthetic fixtures |
| `ai-processor/tests/fixtures/*.mp4` | Committed fixtures (each < 12 KB) |
| `ai-processor/tests/test_ocr_fixtures.py` | Real-OCR checks over the fixtures |

## Running

Contract self-test (dependency-free):

```bash
python docs/mvp2-ai-metadata/eval/evaluate.py --self-test
```

Fixture OCR checks (needs cv2 + pytesseract — run inside the ai-processor image):

```bash
docker exec tmip-ai sh -c 'cd /app && python /tmp/evaluate.py --ocr-fixtures /tmp/fixtures'
```

Validate a sample file against the evaluation format:

```bash
python docs/mvp2-ai-metadata/eval/evaluate.py --sample docs/mvp2-ai-metadata/eval/sample.example.json
```

## Regenerating fixtures (byte-deterministic)

```bash
python ai-processor/tests/fixtures/generate_fixtures.py --ffmpeg <ffmpeg> [--font <ttf>]
```

Generation uses `-fflags +bitexact -flags +bitexact` plus fixed encoding
parameters, so the same ffmpeg build produces identical bytes. Fixtures are tiny,
synthetic, non-confidential, and safe to commit (`TESTING.md §33`).

## What this does NOT do

- It does not run live enrichment (no LLM/Whisper/paid services).
- It does not compute quality scores from contract checks.
- It does not set pass thresholds; quality baselines require human-judged
  reference data (`../09-quality-evaluation.md`).
