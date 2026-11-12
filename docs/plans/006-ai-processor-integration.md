# Plan 006 — Phase 14: AI Processor Integration Foundation

- **Status:** Implemented and merged (2026-10-13). Originally `Proposed`; the plan below is retained as the historical implementation record. Verified runtime state is recorded in `ADR/ADR-006` (Implementation status) and surfaced on the media list/detail endpoints.
- **Phase:** 14 (product scope: **MVP 2** — see `ADR/ADR-007-mvp2-ai-enrichment-scope.md`)
- **Scope:** Copy/adapt the existing AI Processor into TMIP as a separate Docker service, and add a PostgreSQL-backed AI Runner in the API. Text pipeline only (transcription → summary → keywords → classification → OCR).
- **Review basis:** `AGENTS.md` (§2, §5, §7, §8, §10, §11, §12, §16, §17, §18, §19, §20, §21, §23, §25, §29–§32, §36–§38), `SCOPE.md` (AI out of v1 — additive v2), `ARCHITECTURE.md` (§11, §12, §46, §48), `DATA_MODEL.md`, `WORKFLOWS.md` (§33, §46, §51, §52), `TESTING.md`, `ADR/ADR-002`, `ADR/ADR-004`, `ADR/ADR-005`, `ADR/ADR-006`, `docs/plans/005-ai-processor-migration.md`.
- **Authorizing decision:** `ADR/ADR-006-ai-processor-integration.md` (this plan implements it; it does not re-open any decision recorded there).
- **Predecessor:** Phase 13 assessment complete (this plan is its deliverable). Phases 1–12 complete and verified (metadata pipeline + reprocessing + bounded retry).
- **Non-goals:** no Redis/BullMQ, no scene/CLIP/YOLO, no automatic AI on every scan until enabled, no media writes, no secrets in repo, no changes to the technical metadata pipeline.

**Mission:** Stand up the AI subsystem inside TMIP so that a `MediaFile` can be enriched with transcription, summary, keywords, classification, and OCR through a durable, restart-safe, read-only-safe, database-driven pipeline — without Redis and without rewriting the existing Python AI service.

---

## 1. Documented requirements this plan satisfies

- **ADR-006** — all 18 recorded decisions (lifecycle, runner, identity, durability, recovery, retry, triggers, partial results, result storage, path security, Docker networking, secrets, healthcheck, timeouts, concurrency, MVP scope, reprocess, API contract).
- **`AGENTS.md §8`** — the API must not run long filesystem/model work inside request handlers; AI work is detached and DB-driven.
- **`AGENTS.md §10`** — discovery/extraction separation; AI runs only for NEW/UPDATED, never on unchanged files.
- **`AGENTS.md §16`** — the external AI service is behind an adapter boundary (like `FFprobeAdapter`).
- **`AGENTS.md §18/§19`** — one file's failure must not fail the batch; bounded, classified retry.
- **`AGENTS.md §20`** — conservative, configurable concurrency.
- **`AGENTS.md §21`** — env-var configuration, validated (Zod), no secrets committed.
- **`AGENTS.md §25`** — no premature abstraction; reuse `ExtractionRunner`'s proven claim model rather than build a queue.
- **`AGENTS.md §32`** — additive schema/API changes; existing records/callers keep working.
- **`ADR-002`** — media mount read-only; no writes to source media (this plan removes the legacy `/media` progress-file writes).
- **`WORKFLOWS.md §33`** — bounded retry, transient vs permanent.
- **`WORKFLOWS.md §46`** — application restart handling (extended to AI jobs).

## 2. Files/folders created or changed

### 2.1 New: AI Processor service (copied + adapted from source)

Source root: `D:\DEVELOP\tvri-media-intelligence-platform\ai-processor`.
Target root: `D:\DEVELOP\Media-Intelligence\ai-processor`.

| Target file | Origin | Action |
|---|---|---|
| `ai-processor/Dockerfile` | source `ai-processor/Dockerfile` | **Adapt** — remove corporate `certs/SecurityAppliance_SSL_CA.pem` COPY + `update-ca-certificates`; keep ffmpeg + tesseract + `tesseract-ocr-ind`; keep multi-stage. |
| `ai-processor/requirements.txt` | source | **Trim** — MVP deps only: `faster-whisper`, `opencv-python-headless`, `pytesseract`, `fastapi`, `uvicorn[standard]`, `httpx`, `pydantic`. **Drop** `torch`, `torchvision`, `open_clip_torch`, `ultralytics`, `scenedetect[opencv]` (Phase 15). `torch` is **not** optional to drop-and-lose: `transcribe.py` calls `import torch` and `faster-whisper` depends on it, so torch still installs **transitively via `faster-whisper`** — dropping the explicit pin only removes the direct dependency, it does not remove torch from the image. Verify `import torch` still resolves after the trim (it will, via faster-whisper). Keep `requests`/`tqdm` only if still referenced. |
| `ai-processor/app/main.py` | source `app/main.py` | **Adapt** — register only MVP endpoints (`/health`, `/transcribe`, `/transcribe/status/{id}`, `/transcribe/result/{id}`, `/summarize`, `/ocr`); remove `analyze-scenes` import/router for MVP; remove `scene` import. |
| `ai-processor/app/handlers/transcribe.py` | source | **Adapt + fix** — see §2.4 source fixes: no `/media` progress/result files, fix `get_background_status`, real idempotency, cooperative cancel. |
| `ai-processor/app/handlers/text_llm.py` | source | **Copy as-is** (summarize/keywords/classify; single LLM call). |
| `ai-processor/app/handlers/openrouter.py` | source | **Copy as-is** (env-driven; multi-key round-robin; 429/backoff). |
| `ai-processor/app/handlers/ocr.py` | source | **Copy as-is** (Tesseract + presenter parse). |
| `ai-processor/app/handlers/scene.py` | source | **NOT copied in Phase 14** (deferred to Phase 15). |
| `ai-processor/app/handlers/__init__.py` | source | copy (empty). |
| `ai-processor/.dockerignore` | new | exclude `__pycache__`, `*.pyc`, `.venv`, certs. |

`main.py` request models stay as in the source (`TranscribeRequest` with `video_path`, `asset_id`, `model_size`, `language`). TMIP sends `aiExternalJobId` **as** `asset_id` (ADR-006 §3), so no contract break.

### 2.2 New: TMIP API AI module

| Target file | Purpose |
|---|---|
| `apps/api/src/ai/adapter.ts` | `AiProcessorAdapter` interface + `HttpAiProcessorAdapter` (fetch-based) — the external-tool boundary (`AGENTS.md §16`), mirrors `FFprobeAdapter`. Methods: `health()`, `startTranscription(...)`, `transcriptionStatus(jobId)`, `transcriptionResult(jobId)`, `summarize(text)`, `ocr(path, ts)`. |
| `apps/api/src/ai/adapter.test.ts` | Unit tests with an injected fake `fetch`. |
| `apps/api/src/ai/ai-failure-classification.ts` | Pure, fail-closed classifier (`TRANSIENT`/`PERMANENT`) + AI error codes (ADR-006 §6). |
| `apps/api/src/ai/ai-failure-classification.test.ts` | Unit tests for every code + unknown → PERMANENT. |
| `apps/api/src/ai/runner.ts` | `AiRunner`: DB claim (`PENDING→PROCESSING`), dispatch pipeline, poll with deadline, persist per-stage results, bounded retry, terminal transitions. |
| `apps/api/src/ai/runner.test.ts` | Unit tests with fakes (claim, success, partial, transient retry, permanent fail, deadline). |
| `apps/api/src/ai/reprocess.ts` | `AiReprocessor` seam mirroring `media/reprocess.ts` (`PENDING` reset + `409` guard). |
| `apps/api/src/ai/routes.ts` | `POST /media/:id/ai-reprocess` router (mirrors `media/routes.ts` reprocess handler; 202/404/409). |
| `apps/api/src/ai/routes.test.ts` | Route tests (202/404/409, disabled behavior). |
| `apps/api/src/ai/startup.ts` | `sweepInterruptedAiState`: `PROCESSING → PENDING` on restart (ADR-006 §4). |
| `apps/api/src/ai/startup.test.ts` | Sweep tests. |

### 2.3 Changed: TMIP API

| File | Change |
|---|---|
| `apps/api/prisma/schema.prisma` | Add `AiStatus`, `AiStage`, `AiStageStatus` enums; add `AiResult` model; add AI columns to `MediaFile` (§3). |
| `apps/api/prisma/migrations/<ts>_add_ai_enrichment/` | Additive migration (new enum types, new table, nullable/defaulted columns). |
| `apps/api/src/config.ts` | Add AI env parsing/validation (Zod) with defaults (§4). |
| `apps/api/src/config.test.ts` | Add AI config tests. |
| `apps/api/src/app.ts` | Mount `createAiRouter`; wire `AiReprocessor`; pass AI config through `AppDependencies`. |
| `apps/api/src/server.ts` | Construct `HttpAiProcessorAdapter` + `AiRunner`; run `sweepInterruptedAiState` at startup; start the runner poll loop. |
| `apps/api/src/media/routes.ts` | Extend list/detail serialization with `aiStatus`, `aiPartial`, `aiProcessedAt`, `aiErrorCode`, `aiErrorMessage`, `aiErrorAt`, `aiAttempt`; add `ai` object on detail (per-stage results). |
| `apps/api/src/media/routes.test.ts` | Extend for new fields. |
| `apps/api/src/scan/orchestrator.ts` | When a file reaches `metadataStatus = READY` (or is NEW/UPDATED), set `aiStatus = PENDING` **only if** `AI_ENABLED` (see §5). Must **not** touch `ScanJob.queuedCount`/`processedCount` (see §5 note). |
| `.env.example` | Add AI variable names + safe defaults (no secret). |
| `docker-compose.yml` | Add `ai-processor` service (internal-only, `:ro` media, model-cache volume, healthcheck); add AI env to `api` (§6). |
| `README.md` | Document AI setup, runtime secret, endpoints, and the read-only/internal-network guarantees. |

### 2.4 Source fixes carried into the copy (from ADR-006)

1. **Remove media-tree writes.** Delete `PROGRESS_DIR = "/media"` file writing (`_write_progress`, `_write_result`, `_clear_progress`, `_clear_result`) from `transcribe.py`. Progress/results are held in memory and returned over HTTP only. This removes the ADR-002 violation and the hidden write path.
2. **Fix `get_background_status`.** Correct the dead-code branch so a running job returns `{"status":"RUNNING","progress":{...}}` (progress from an in-memory counter, not a file).
3. **Real idempotency.** `POST /transcribe` must reliably return `ALREADY_RUNNING` for an in-flight `asset_id`; `start_background_transcribe` must not wipe a completed result when a duplicate arrives. Guard by a lock + status check.
4. **Cooperative cancel.** Add a per-job `threading.Event`; the whisper segment loop checks it and exits early; `cancel_background` sets it. If the effort is disproportionate, drop `/transcribe/cancel` from MVP and document it (Phase 15). **Preferred: implement the flag** (small).
5. **Containment defense-in-depth.** In `main.py`, reject a `video_path` that is not absolute and, when `MEDIA_ROOT` is set, that does not resolve inside it (`os.path.realpath` prefix check).
6. **No CA cert** in the image.

## 3. Prisma changes

```prisma
enum AiStatus { PENDING PROCESSING READY FAILED SKIPPED }
enum AiStage { TRANSCRIPTION SUMMARY KEYWORDS CLASSIFICATION OCR }
enum AiStageStatus { READY FAILED }

model AiResult {
  id           String        @id @default(cuid())
  mediaFileId  String
  stage        AiStage
  status       AiStageStatus
  payload      Json?
  errorCode    String?
  errorMessage String?
  attemptedAt  DateTime      @db.Timestamptz(6)
  createdAt    DateTime      @default(now()) @db.Timestamptz(6)
  updatedAt    DateTime      @updatedAt @db.Timestamptz(6)
  mediaFile    MediaFile     @relation(fields: [mediaFileId], references: [id])

  @@unique([mediaFileId, stage])
  @@index([mediaFileId])
}

model MediaFile {
  // ...existing fields unchanged...
  aiStatus        AiStatus  @default(PENDING)
  aiPartial       Boolean   @default(false)
  aiAttempt       Int       @default(0)
  aiExternalJobId String?
  aiErrorCode     String?
  aiErrorMessage  String?
  aiErrorAt       DateTime? @db.Timestamptz(6)
  aiProcessedAt   DateTime? @db.Timestamptz(6)
  aiResults       AiResult[]

  @@index([aiStatus])
}
```

Notes:
- All additive; existing rows default `aiStatus = PENDING`, `aiAttempt = 0` (`AGENTS.md §32`).
- `aiStatus` default `PENDING` means "not yet processed" (not "must process now"). The runner only processes when `AI_ENABLED` is true; otherwise the poll loop is inert.
- No denormalized summary/keyword/category columns in Phase 14; verbose output stays in `AiResult.payload` (JSONB). Promote later only if filtered/sorted.
- `aiPartial` is declared exactly once above (hot field summary); the `AiResult` model is the per-stage truth.

## 4. Configuration (Zod-validated, additive to `config.ts`)

```text
AI_ENABLED                 bool    default false   // master switch; false ⇒ runner inert, reprocess returns 409/disabled
AI_PROCESSOR_URL           string  default "http://ai-processor:8000"
AI_MODEL_SIZE              enum    default "medium"   // small|medium|large-v3
AI_LANGUAGE                string  default "id"
AI_CONCURRENCY             int     default 1
AI_MAX_RETRIES             int     default 2
AI_RETRY_BACKOFF_MS        int     default 5000
AI_REQUEST_TIMEOUT_MS      int     default 30000
AI_POLL_INTERVAL_MS        int     default 10000
AI_STAGE_TIMEOUT_MS        int     default 900000
AI_JOB_DEADLINE_MS         int     default 5400000
```

Follow the existing `parseMetadata*` pattern (pure parse functions + tests). `OPENROUTER_API_KEY`/`OPENROUTER_MODEL` are **not** read by the API at all — they live only in the `ai-processor` runtime env.

## 5. Runner behavior (concrete)

**Claim**
```text
findFirst({ where: { aiStatus: PENDING, status: ACTIVE, metadataStatus: READY }, orderBy: id asc })
updateMany({ where: { id, aiStatus: PENDING }, data: {
  aiStatus: PROCESSING, aiAttempt: 0,
  aiExternalJobId: `${id}:${attempt}`,
  aiErrorCode: null, aiErrorMessage: null, aiErrorAt: null,
  aiProcessedAt: null,
}})
→ proceed only if count === 1
```

**Enqueue isolation (must not corrupt scan semantics).** AI enqueue is **detached** from scan accounting. Setting `aiStatus = PENDING` from `scan/orchestrator.ts` must **not** increment `ScanJob.queuedCount`/`processedCount` (or any other `ScanJob` counter) — those counters describe the **metadata** pipeline and drive the scan completion gate (`processedCount < queuedCount`, `orchestrator.ts:105`). Mixing AI work into them would make a scan appear incomplete/complete incorrectly and could stall the completion gate. Concretely: the existing code queues **NEW** files (`orchestrator.ts:192`); **UPDATED** is observation-only in Phase 4 (`orchestrator.ts:172`). Phase 14 therefore enqueues AI when a file is NEW, and — if UPDATED re-extraction is enabled later — when a re-extracted file reaches `metadataStatus = READY`. The AI runner keeps its own concurrency and does not participate in the scan's `processedCount`/`queuedCount` gate. (Mirrors ADR-004's rule that reprocessing must not corrupt scan-progress semantics.)

**Pipeline (MVP)**
1. Resolve `relativePath` → absolute via `resolveInsideRoot(config.mediaRoot, relativePath)`; if it escapes or is missing → `AiResult{TRANSCRIPTION, FAILED}` + terminal `FAILED` with `AI_MEDIA_NOT_FOUND`/`AI_VALIDATION_FAILED`.
2. **TRANSCRIPTION** — `POST /transcribe` with `asset_id = aiExternalJobId`; poll `status` every `AI_POLL_INTERVAL_MS` until `COMPLETED`/`FAILED` or `AI_JOB_DEADLINE_MS`. On success → upsert `AiResult{TRANSCRIPTION, READY, payload:{segments,full_text,duration_sec,language}}`.
3. **SUMMARY** — `POST /summarize { full_text }` → upsert `AiResult{SUMMARY, READY, payload:{summary,keywords,category}}`. Also upsert `KEYWORDS` and `CLASSIFICATION` rows from the same response (one LLM call yields all three — do **not** call `/keywords` + `/classify` separately).
4. **OCR** — `POST /ocr { video_path, timestamp_sec: 0 }` → upsert `AiResult{OCR, READY, payload:{raw_text,presenter}}`.
5. Terminal: if ≥1 stage READY → `aiStatus = READY`, `aiPartial = (some stage FAILED)`, `aiProcessedAt = now()`. If **no** stage READY → `aiStatus = FAILED` with the first/primary `aiErrorCode`.
6. `aiAttempt` is left at its persisted value (0 on success; N when retries were used before a terminal failure).

**Transient retry** — a TRANSIENT failure (per `ai-failure-classification.ts`) with `aiAttempt < AI_MAX_RETRIES` increments `aiAttempt` and retries the failed stage with exponential backoff (`AI_RETRY_BACKOFF_MS`), keeping `aiStatus = PROCESSING`. Exhausted → `FAILED`.

**Concurrency** — an in-process semaphore of size `AI_CONCURRENCY`; one poll loop per API process. Single API instance assumption matches the existing scan mutex (`scan/routes.ts` StartScanMutex) and `WORKFLOWS.md §46` scope.

**Restart** — `sweepInterruptedAiState` sets `PROCESSING → PENDING` at boot (ADR-006 §4). No `aiAttempt` consumption.

## 6. Docker changes

```yaml
  ai-processor:
    build:
      context: ./ai-processor
      dockerfile: Dockerfile
    container_name: tmip-ai
    restart: unless-stopped
    environment:
      OPENROUTER_API_KEY: ${OPENROUTER_API_KEY:-}   # runtime only; empty ⇒ LLM stages degrade
      OPENROUTER_MODEL: ${OPENROUTER_MODEL:-deepseek/deepseek-chat}
      MEDIA_ROOT: /media
      HF_HOME: /model-cache
    expose:
      - "8000"                # internal only — NOT published to host
    volumes:
      - ${MEDIA_ROOT}:/media:ro            # read-only, same source as api
      - ai-model-cache:/model-cache
    healthcheck:
      test: ["CMD", "python", "-c", "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=3).status==200 else 1)"]
      interval: 15s
      timeout: 5s
      retries: 5
      start_period: 60s

volumes:
  ai-model-cache:
```

`api` gains:
```yaml
    environment:
      AI_ENABLED: ${AI_ENABLED:-false}
      AI_PROCESSOR_URL: http://ai-processor:8000
      AI_MODEL_SIZE: ${AI_MODEL_SIZE:-medium}
      AI_LANGUAGE: ${AI_LANGUAGE:-id}
      AI_CONCURRENCY: ${AI_CONCURRENCY:-1}
      AI_MAX_RETRIES: ${AI_MAX_RETRIES:-2}
      AI_RETRY_BACKOFF_MS: ${AI_RETRY_BACKOFF_MS:-5000}
      AI_REQUEST_TIMEOUT_MS: ${AI_REQUEST_TIMEOUT_MS:-30000}
      AI_POLL_INTERVAL_MS: ${AI_POLL_INTERVAL_MS:-10000}
      AI_STAGE_TIMEOUT_MS: ${AI_STAGE_TIMEOUT_MS:-900000}
      AI_JOB_DEADLINE_MS: ${AI_JOB_DEADLINE_MS:-5400000}
    depends_on:
      postgres:
        condition: service_healthy
      ai-processor:
        condition: service_started
```

Notes: `depends_on` uses `service_started` (not `service_healthy`) so a slow first model download does not block the API; the runner tolerates an unavailable processor as TRANSIENT.

## 7. Frontend changes

- `apps/web/app/media/[id]/page.tsx`: add an **AI enrichment** card — `aiStatus` badge, `aiProcessedAt`, per-stage results (transcript, summary, keywords, category, OCR presenter), and `aiErrorCode`/`aiErrorMessage` when failed.
- New `apps/web/app/media/[id]/AiReprocessAction.tsx` (mirror `ReprocessAction.tsx`): button calls `POST /media/:id/ai-reprocess`, shows 202/409/404 outcomes.
- `apps/web/lib/api.ts`: add `aiReprocessMedia(id)`; extend `MediaDetail` type with the AI fields.
- No new page/route beyond this (keeps v1 UI footprint small).

## 8. Testing strategy

**Unit (no Docker/network)**
- `ai-failure-classification.test.ts`: every code maps correctly; unknown → PERMANENT (fail-closed).
- `ai/adapter.test.ts`: fake `fetch`; status/result/summarize/ocr parse; timeout/429/5xx → classified errors.
- `ai/runner.test.ts`: claim CAS; success writes all stage rows + `READY`; partial (transcription OK, OCR fails) → `READY` + `aiPartial=true` + OCR row FAILED; permanent fail → `FAILED` + code; transient retry counts and stops at `AI_MAX_RETRIES`; deadline exceeded → TRANSIENT.
- `ai/routes.test.ts`: 202 on PENDING reset; 409 when PROCESSING; 404 unknown id; disabled behavior when `AI_ENABLED=false`.
- `ai/startup.test.ts`: `PROCESSING → PENDING` sweep; does not touch `READY`/`FAILED`.
- `config.test.ts`: AI env defaults + validation errors.

**Integration (Postgres, no processor)**
- `AiRunner` against a real DB with a fake adapter: verify upsert idempotency (run twice → one `AiResult` per stage), and restart sweep behavior.

**Docker E2E (manual/CI, optional in Phase 14)**
- Bring up `docker compose up`; enable `AI_ENABLED=true`; trigger `ai-reprocess` on a small fixture; assert `aiStatus=READY` and stage rows exist; assert `/media` gained **no** new files (read-only proof); assert `8000` is not reachable from the host.

**Media safety (mandatory)**
- Test that the processor rejects a `video_path` outside `MEDIA_ROOT` (defense-in-depth).
- Test that the API never sends an absolute host path outside the resolved root.

## 9. Verification commands (run after Phase 14 implementation)

```bash
pnpm --filter @tmip/api test
pnpm --filter @tmip/api typecheck
pnpm --filter @tmip/api lint
pnpm --filter @tmip/web typecheck
pnpm -r build
# Docker E2E (manual):
docker compose build ai-processor api
docker compose up -d
curl -s http://localhost:4000/health
```

## 10. Rollout / migration notes

- Migration is additive; existing rows get `aiStatus=PENDING` but nothing runs until `AI_ENABLED=true`.
- Deploy order: build `ai-processor` → run `prisma migrate deploy` → start `api`. The runner tolerates the processor being absent.
- The legacy source project (`D:\DEVELOP\tvri-media-intelligence-platform`) is **not** deleted or modified; it remains the reference until Phase 14 is verified. This plan copies files **out of** it into TMIP.
- Runtime secret `OPENROUTER_API_KEY` is supplied via the deployment environment only.

## 11. Out of scope for Phase 14 (explicit)

- Scene detection, CLIP, YOLO, `/analyze-scenes` (Phase 15).
- Automatic AI on scan by default (`AI_ENABLED` default false; enabling is an operator choice after verification).
- AI-driven search/recommendation/semantic features (Phase 16+).
- Auth/RBAC for the AI endpoint (v1 has no auth; endpoint sits on the same trust boundary as existing reprocess).
- GPU provisioning.
