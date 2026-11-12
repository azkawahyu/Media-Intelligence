# 02 — Enrichment Workflow

Status: **description of implemented behavior** (AI enrichment as it exists in
TMIP today, additive v2) plus the mapping to MVP 1. Grounded in
`apps/api/src/ai/runner.ts`, `routes.ts`, `reprocess.ts`, `startup.ts`,
`runtime.ts`, and `ADR-006`. Where a step is a **proposal** it is labelled.

Provenance for the *shape* of this workflow: adapted from the team repository
`docs/05-business-workflow.md` (AI Integration Points). The queue mechanics
(BullMQ/Redis) in the team model are **reference-only** and not adopted.

## 1. Relationship to the MVP 1 pipeline

AI is a **separate, additive** stage that runs *after* technical metadata, and
never mutates it.

```text
MVP 1 (unchanged)
  DISCOVER → DETECT CHANGE → EXTRACT (ffprobe) → STORE → DISPLAY
                                   │
                                   │ metadataStatus = READY
                                   ▼
MVP 2 (additive, AI_ENABLED)
  CLAIM (aiStatus PENDING→PROCESSING) → TRANSCRIPTION → LLM (SUMMARY/KEYWORDS/
  CLASSIFICATION) → OCR → PERSIST → aiStatus = READY
```

Boundary rules (`ADR-006`):

- AI never writes `metadataStatus`; a metadata failure never blocks AI and vice versa.
- AI runs only for files whose row is claimable (metadata READY), and only when
  `AI_ENABLED=true`.
- AI results live in `AiResult`; technical metadata lives on `MediaFile`.

## 2. Trigger

Manual only in the current implementation (`ADR-006 §5`):

- `POST /media/:id/ai-reprocess` resets the row to `PENDING`, clears the error
  state and `aiAttempt=0`, and leaves existing `AiResult` rows in place (they are
  upserted on the new run). `404` if the file is gone; `409` if `aiStatus=PROCESSING`;
  `202` otherwise.
- A **proposal** (OD-01) exists to trigger AI automatically for NEW/UPDATED files
  after metadata READY. Not implemented.

> Team reference: the team runs a BullMQ worker with a repeating scan
> (`docs/05`). TMIP does **not** introduce Redis/BullMQ (`ADR-006`).

## 3. Claim model (durable, no queue)

From `runner.ts`:

- Durable work signal: `MediaFile.aiStatus = PENDING`.
- Claim: atomic `updateMany({ where: { id, aiStatus: "PENDING" }, data: { aiStatus:
  "PROCESSING", ... } })`; only the caller that flips the row proceeds.
- `aiExternalJobId` is set deterministically to `` `${mediaFileId}:${attempt}` ``.
- No Redis; PostgreSQL is the only source of job truth (`ADR-006 §2`).

## 4. Stage execution and I/O

| # | Stage | Inputs | Processor call | Output (`AiResult.payload`) |
|---|---|---|---|---|
| 1 | `TRANSCRIPTION` | `video_path` (contained), `asset_id` = `aiExternalJobId`, `model_size`, `language` | `POST /transcribe` then poll `GET /transcribe/status/{id}` → `GET /transcribe/result/{id}` | `segments`, `full_text`, `duration_sec`, `language` |
| 2 | `SUMMARY` | `full_text` from stage 1 | `POST /summarize` (one call) | `summary` |
| 3 | `KEYWORDS` | same response as stage 2 | (same `/summarize` call) | `keywords` |
| 4 | `CLASSIFICATION` | same response as stage 2 | (same `/summarize` call) | `category` |
| 5 | `OCR` | `video_path`, `duration_sec` (from stage 1) | `POST /ocr` | `raw_text`, `presenter`, `sampled_count`, `best_timestamp_sec` |

Stages 2–4 are **one** `/summarize` call split into three persisted rows
(`ADR-006 §18`). Each stage is persisted immediately on success, so a later
failure keeps the earlier stages (`ADR-006 §7`).

Metadata contract for each payload: `01-ai-metadata-contract.md`.

## 5. Status transitions

```text
PENDING ──claim──▶ PROCESSING ──all stages ok──▶ READY
                        │
                        ├── some ok, some FAILED ──▶ READY (aiPartial = true)
                        ├── permanent failure ─────▶ FAILED
                        ├── transient, budget left ─▶ PROCESSING (retry, aiAttempt++)
                        ├── transient, budget out ──▶ FAILED
                        └── cancel requested ──────▶ CANCELLED
SKIPPED  (reserved; not produced by the current runner)
```

- `CANCELLED` is terminal and is **not** a failure (`ADR-006 §19`).
- On restart, a `PROCESSING` row with `aiCancelRequestedAt` set → `CANCELLED`;
  otherwise → `PENDING` for a safe re-run (no retry consumed) (`startup.ts`).
- A late writer is guarded by a compare-and-set so it cannot overwrite a terminal
  `CANCELLED`/`READY` row (`runner.ts`).

## 6. Failure handling and classification

- One failed file never fails a batch; failures are per-file, per-stage.
- Classification (`ai-failure-classification.ts`), fail-closed:
  - **TRANSIENT** (retried): `AI_PROCESSOR_TIMEOUT`, `AI_PROCESSOR_UNAVAILABLE`,
    `AI_DEADLINE_EXCEEDED`.
  - **PERMANENT** (not retried): `AI_PROCESSOR_BAD_REQUEST`,
    `AI_PROCESSOR_INVALID_RESPONSE`, `AI_FILE_NOT_FOUND`, `AI_PATH_INVALID`,
    `AI_STAGE_FAILED`, `AI_INTERRUPTED`.
- Stage-specific: the processor returns a controlled TRANSIENT failure for an
  empty/incomplete summary response (`EMPTY_RESPONSE`/`INCOMPLETE_RESPONSE`) so a
  bounded retry can recover — see `ai-processor/app/handlers/text_llm.py`.

## 7. Retry and idempotency

- **Bounded** in-claim retry (`ADR-006 §6`): a TRANSIENT failure with budget left
  keeps `PROCESSING`, increments `aiAttempt`, backs off, re-runs. Exhaustion →
  `FAILED` with the cause.
- Config (defaults), from `config.ts`: `AI_MAX_RETRIES=2`,
  `AI_RETRY_BACKOFF_MS=5000`, `AI_STAGE_TIMEOUT_MS=900000`,
  `AI_JOB_DEADLINE_MS=5400000`, `AI_POLL_INTERVAL_MS=10000`,
  `AI_REQUEST_TIMEOUT_MS=30000`, `AI_CONCURRENCY=1`.
- **Idempotency:** re-running upserts `AiResult` on `(mediaFileId, stage)`, so no
  duplicate rows; re-running is safe because outputs are deterministic given the
  same media (models are non-deterministic in wording, but the *set* of rows is
  stable).

## 8. Cancellation (durable stop)

- `POST /media/:id/ai-cancel` records a durable intent (`aiCancelRequestedAt`) and
  returns `202`, leaving the row `PROCESSING`; the runner stops before the next
  stage and finalizes `CANCELLED`, keeping results from completed stages.
- Cooperative (`ADR-006 §19`): a provider call already in flight may finish on its
  side; TMIP guarantees it will not be written once cancellation is terminal.

## 9. Security and filesystem policy

- The processor receives only an **absolute, contained** `video_path`; TMIP
  resolves it with `resolveInsideRoot` before the request (`ADR-006 §9`); the
  processor re-checks containment against `MEDIA_ROOT`.
- Media mount is **read-only** (`/media:ro`); no AI stage writes to the media tree
  (`ADR-002`).
- The processor is on the internal compose network only; port `8000` is not
  published (`ADR-006 §10`).

## 10. Observability

- `GET /media` list items: `aiStatus`, `aiPartial`, `aiProcessedAt`.
- `GET /media/:id` detail: the above plus `aiErrorCode/aiErrorMessage/aiErrorAt`,
  `aiAttempt`, `aiCancelRequestedAt`, and an `ai` object with per-stage results
  (`ADR-006 §18`).
- Processor `GET /health`: `status`, `openrouter_available`, `llm_available`,
  `llm_base_url`, `llm_model`.
