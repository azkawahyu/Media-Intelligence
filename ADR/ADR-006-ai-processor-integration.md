# ADR-006: AI Processor Integration Architecture

## Status

Accepted (Phase 13 — Assessment & Integration Architecture, 2026-10-07)

This ADR is architecture-only. It authorizes **no** code in Phase 13. Phase 14 implements the decisions recorded here. The source AI Processor project (`D:\DEVELOP\tvri-media-intelligence-platform`) is not modified or copied during Phase 13.

**Implementation status (updated 2026-10-13):** Phase 14 is **implemented and merged**
(`apps/api/src/ai/*`, the `AiResult` model and `aiStatus` lifecycle, migrations
`20261007140000_add_ai_enrichment` and `20261009090000_add_ai_cancellation`, the
`ai-processor` service, the AI endpoints, and the media-detail UI). The decisions
below remain as recorded. The product scope of this work is established separately
by `ADR/ADR-007-mvp2-ai-enrichment-scope.md` (MVP 2, additive layer).
**§20's OCR sampling is now reconciled** (the code was returned to the five-frame
grid this ADR specifies) — see the resolution note there.

## Context

TMIP v1 currently delivers one vertical pipeline: Server B media → discovery → change detection → ffprobe technical metadata → PostgreSQL → display (`AGENTS.md §2`, `ARCHITECTURE.md §48`). Technical metadata is modeled on `MediaFile` with a single `metadataStatus` lifecycle (`PENDING | PROCESSING | READY | FAILED`) and an in-process `ExtractionRunner` claim model backed by PostgreSQL (`PENDING`/`PROCESSING` rows are the durable work signal — there is no queue).

A separate, working AI subsystem already exists in another project (`D:\DEVELOP\tvri-media-intelligence-platform`, commit `05fdf14`). It is a Python/FastAPI service that performs speech-to-text transcription (faster-whisper), OpenRouter LLM summarization/keywords/classification, Tesseract lower-third OCR, and a PySceneDetect + CLIP + YOLO scene/location pipeline. It is orchestrated today by a Node/BullMQ/Redis worker in that same project.

The owner has decided to bring this AI capability into TMIP as a later phase (Phase 14/15). Phase 13 must produce an architecture specific enough that Phase 14 can implement without re-deciding architecture mid-code.

This ADR records the audit findings that constrain the design, and the final decisions.

### Audit findings that shape the decision (evidence)

These are the facts established by reading the actual source, not the plan's assumptions.

1. **The AI Processor has no durable job state.** Transcription job state (`_background_jobs`, `_background_results`, `_background_errors`, `apps/ai-processor/app/handlers/transcribe.py`) is held in **process memory only**. Progress and results are additionally written to files **inside the media tree** (`/media/.transcribe-progress-<asset_id>.json`, `/media/.transcribe-result-<asset_id>.json`). On restart, all in-memory state is lost and `/transcribe/status/{asset_id}` returns `NOT_FOUND` for a job that was running. Results written to the media tree also violate read-only media handling (ADR-002) and pollute the source volume.

2. **`get_background_status` is broken for running jobs (dead code).** At the end of `get_background_status` the `RUNNING` branch builds a `progress` variable but **never returns it**; the sibling `return {"status": "RUNNING", "progress": progress}` is misplaced after `_clear_result`'s `return`, at module scope, as unreachable/dead code (`transcribe.py` lines ~167–181 and ~210–217). Net effect: while a job is actually running the endpoint returns `None`/empty data. The existing Node poller only tolerates this because it treats any non-`COMPLETED`/`FAILED` status as "keep waiting".

3. **`asset_id` idempotency is partial and dangerous.** `POST /transcribe` checks status and returns `ALREADY_RUNNING` if **and only if** `get_background_status` reports `RUNNING` — which, per finding 2, is unreliable. `start_background_transcribe` unconditionally clears progress/result and starts a **new** thread keyed by `asset_id`. So a second `/transcribe` can (a) start a second concurrent transcription of the same asset, and (b) wipe the result of a finished one. `asset_id` alone is **not** a safe idempotency key.

4. **Cancellation is not real.** `cancel_background` merely drops dict references and deletes files; the daemon thread **keeps running to completion** (the docstring even admits "can't kill forcefully"). The whisper loop never checks a cancel flag. Cancellation also deletes the stored result. Cancellation therefore leaks CPU and is not safe to build a lifecycle on.

5. **No external job id beyond `asset_id`.** The processor's own "job_id" is just the caller-supplied `asset_id` echoed back. There is no server-generated, restart-survivable job identity.

6. **The Node orchestration is a long blocking poll.** `ai-client.ts#transcribe` polls every 10 s for up to **150 minutes**, with a 10-minute no-progress "stuck" heuristic. This is a synchronous, in-worker wait — not a resumable job. If the Node worker restarts mid-poll, the transcription is orphaned with no recovery path.

7. **BullMQ/Redis is used only as an ephemeral dispatch layer.** In the source project, Redis holds queue state; the durable record is still Prisma (`ProcessingJob` rows). Redis is explicitly "not the source of truth" (`ARCHITECTURE.md §11`, `AGENTS.md §8`). Nothing in the source design *requires* Redis — it is a dispatch convenience.

8. **OCR / summarize / keywords / classify / analyze-scenes are synchronous request/response** over the *same* media path passed by the caller. They are stateless pure functions of their input except for the LLM call to OpenRouter.

9. **`/ocr` and `/analyze-scenes` also take `video_path` and do file I/O in the request handler**, opening the video with OpenCV. They are CPU/GPU heavy and synchronous, so they block a worker thread.

10. **Media path is caller-supplied and unchecked.** `video_path` is accepted verbatim; the service only checks `os.path.exists`. There is **no containment** to a media root. In the source project containment is enforced by the Node caller (`backend/src/lib/media-path.ts`), not by the Python service. In TMIP, containment is enforced by `apps/api/src/paths.ts#resolveInsideRoot`.

11. **Secrets are read from env only** (`OPENROUTER_API_KEY`, comma-separated multi-key round-robin; `OPENROUTER_MODEL`; `OPENROUTER_TIMEOUT`; `OPENROUTER_MAX_RETRIES`). No secret is embedded in source. The source `.env` is not committed (only `CORS_ORIGIN` is set there; the API key is supplied by the runtime environment).

12. **Resource profile.** Whisper runs on **CPU** (`device="cpu"`, `compute_type="int8"`, `torch.set_num_threads(8)`), model loaded as a process-global singleton and released after use. CLIP (`ViT-B-32`) and YOLO (`yolov8n.pt`) are lazy singletons that pick CUDA if available, else CPU. Model weights download at first use (`HF_HOME=/model-cache`, a persisted volume in the source compose). A 45-minute video is estimated at ~3× realtime on CPU (hence the 150-minute ceiling in the poller).

13. **Source Dockerfile** installs `ffmpeg`, `tesseract-ocr`, `tesseract-ocr-ind`, and Python ML deps into a `python:3.11-slim` image; it also `COPY`s a corporate SSL-inspection CA cert (`certs/SecurityAppliance_SSL_CA.pem`) and runs `update-ca-certificates`. The CA cert is environment-specific and **must not** be carried into TMIP.

### Divergence from Plan 005 assumptions

- Plan 005 §5.1 asks whether job state is durable — it is **not**; the assumption baked into the legacy design (poll-until-done) does not survive restart and must be replaced.
- Plan 005 implies `asset_id` might be idempotent — it is **not** reliably so (findings 2–3).
- Plan 005 lists `POST /summarize`, `/keywords`, `/classify` as separate endpoints — they exist, but `/keywords` and `/classify` are thin wrappers that internally re-run the **same** `/summarize` logic (one LLM call each). Treating them as three independent stages would triple LLM cost; the source's own worker calls a single `summarize`.
- Plan 005 §5.1's "preferred strategy" (persist external id, resume polling) is adopted, but with the correction that the external id must be **TMIP-owned and minted before dispatch**, because the legacy service returns no durable id of its own.

## Decision

### 1. AI lifecycle

A **separate** lifecycle from technical metadata, stored on `MediaFile` as a new `aiStatus` enum, plus separate AI error/retry columns. AI never writes to `metadataStatus` and vice-versa.

```text
aiStatus: PENDING | PROCESSING | READY | FAILED | SKIPPED | CANCELLED
```

| Transition | Trigger | Actor |
|---|---|---|
| → `PENDING` | row created / scan detects NEW file / manual reprocess requested | ScanOrchestrator (on enqueue) or API |
| `PENDING` → `PROCESSING` | worker atomically claims the row | AiRunner (DB claim) |
| `PROCESSING` → `READY` | all in-scope stages reach terminal state and at least one produced output | AiRunner |
| `PROCESSING` → `FAILED` | a stage failed permanently, or retries exhausted, **and** no partial output worth keeping | AiRunner |
| `PROCESSING` → `READY` (partial) | some stages succeeded, others failed permanently | AiRunner (see §8) |
| `PROCESSING` → `PENDING` | retryable failure and retry budget remains **and** job uses the delayed-retry path | AiRunner (see §6) |
| any → `SKIPPED` | processing decided not applicable (e.g. `MEDIA_ROOT` unset/disabled, feature flag off, or media marked MISSING before processing) | API/Runner |
| `PROCESSING` → `CANCELLED` | an operator requested a stop and the runner observed it (see §18) | AiRunner |
| `FAILED`/`READY`/`SKIPPED`/`CANCELLED` → `PENDING` | manual reprocess (`POST /media/:id/ai-reprocess`) | API |

The lifecycle is stored on `MediaFile` (`aiStatus`), not in memory and not in Redis. This mirrors the proven `metadataStatus` claim model.

### 2. AI Runner architecture

An in-process **`AiRunner`** that mirrors `ExtractionRunner`, sharing the same PostgreSQL claim model:

- Durable work signal is `MediaFile.aiStatus = PENDING`.
- Runner claims a row with an atomic `updateMany({ where: { id, aiStatus: 'PENDING' }, data: { aiStatus: 'PROCESSING', ... } })` and checks the affected count (identical pattern to the existing extractor).
- Runner is triggered by two paths only:
  1. **scan-driven enqueue** — after a NEW/UPDATED file reaches `metadataStatus = READY` (technical metadata always precedes AI, per `ARCHITECTURE.md §46`), the scan sets `aiStatus = PENDING`.
  2. **manual reprocess** — an authenticated API call sets `aiStatus = PENDING`.
- A small polling loop inside the API process (same process as the metadata worker; same lifecycle as `sweepInterruptedState`) drains `PENDING` rows with configurable concurrency.
- The Runner calls the AI Processor over **internal HTTP** and persists results to PostgreSQL.

**No Redis, no BullMQ, no new queue** (see §4 and the Alternatives section).

The AI Processor **stays a separate Python service** (`ai-processor`) — it owns the heavy ML deps (Whisper/Torch/OpenCV) that must not bloat or crash the Node API image. TMIP does **not** rewrite it in TypeScript.

### 3. External job identity

TMIP mints the identity. On claim, the Runner generates and persists:

```text
MediaFile.aiExternalJobId  String?   // TMIP-generated, e.g. `${mediaFileId}:${aiAttempt}`
```

The `aiExternalJobId` is sent to the AI Processor as the request's job key (mapped to the legacy `asset_id` field for the transcription background API), so:

- TMIP can correlate a request with processor-side progress.
- A deterministic value derived from `mediaFileId` + attempt means the same logical job is recognizable after restart.

Because the processor's own id is non-durable (finding 1/5), TMIP **never** treats the processor as the authority on job existence. `aiExternalJobId` is a correlation handle, not a resumption token. **The correct mental model: if TMIP does not have the result persisted, the job is (re)run; TMIP's DB is the only source of job truth.**

### 4. Job durability & restart recovery

- **Durability:** job state lives in PostgreSQL (`aiStatus`, `aiAttempt`, `aiExternalJobId`, `aiCancelRequestedAt`, results). The processor is stateless-with-respect-to-durability.
- **Recovery on TMIP restart:** a startup sweep (`sweepInterruptedAiState`) handles every `MediaFile.aiStatus = PROCESSING` row and increments nothing (the attempt is only consumed on failure):
  - a row **with** a pending cancellation intent (`aiCancelRequestedAt IS NOT NULL`) is finalized as `CANCELLED` — a stop the operator requested before the crash is honored, never resurrected (§18);
  - a row **without** intent is set back to `PENDING` for a safe re-run.
  This is chosen over "mark FAILED/INTERRUPTED" because AI work is idempotent-by-re-run and expensive; resuming is safe and desirable.
- **Rationale:** the technical-metadata sweep marks `PROCESSING → FAILED(INTERRUPTED)` because a half-written technical record is worse than a clear failure. For AI, the result is written **once, atomically, at the end** of a successful stage set, so a restart simply means the work did not happen — safe to redo, and we do not burn a retry.
- **Orphan safety:** if the processor actually finishes an orphaned job after TMIP restarted, TMIP will have already set the row back to `PENDING` and will re-dispatch. The processor's `ALREADY_RUNNING` response (once fixed to actually report it) makes this a no-op wait; the re-run overwrites the same deterministic `aiExternalJobId`. Duplicate *results* are prevented because TMIP writes results keyed by `mediaFileId` (upsert), not append.
- **TMIP restart cannot cause duplicate AI *results*** because persistence is an upsert on a unique `(mediaFileId, aiStage)` key (§9).

### 5. Manual vs automatic trigger

- **Automatic (default: enabled):** a file that reaches `metadataStatus = READY` **and** is NEW or UPDATED gets `aiStatus = PENDING`. Unchanged files do **not** re-trigger AI (`AGENTS.md §10`). Controlled by `AI_ENABLED` (default `false` in Phase 14 until verified — see §16).
- **Manual:** `POST /api/media/:id/ai-reprocess` (authenticated later; TMIP v1 currently has no auth, so Phase 14 exposes it unauthenticated on the same trust boundary as the existing metadata reprocess endpoint) resets `aiStatus = PENDING`, clears `aiError*`, and resets `aiAttempt = 0`. Mirrors `POST /media/:id/reprocess`.
- No automatic AI on scan by default until the owner explicitly enables it; auto-enqueue is gated behind `AI_ENABLED`.

### 6. Retry policy

AI retry is **policy-independent** from technical metadata retry (`failure-classification.ts` is untouched).

A new pure module `apps/api/src/ai/ai-failure-classification.ts` classifies AI failures, **fail-closed to PERMANENT**:

| Cause | Class | Rationale |
|---|---|---|
| HTTP 429 (rate limit) | TRANSIENT | provider/backpressure, clears |
| HTTP 5xx | TRANSIENT | upstream transient |
| HTTP timeout (`AbortError`) | TRANSIENT | network/storage slowness |
| Connection failure / `ai-processor` unreachable | TRANSIENT | container starting / restarted |
| HTTP 400/422 (invalid request we built) | **PERMANENT** | our bug — do not loop |
| HTTP 401/403 (bad/absent API key) | **PERMANENT** | config error; retrying wastes time |
| Invalid/unparseable processor response | **PERMANENT** | deterministic |
| `UNSUPPORTED_MEDIA` (processor 422 / codec) | **PERMANENT** | retry cannot help |
| Corrupt media (`FFPROBE`-style failure surfaced) | **PERMANENT** | retry cannot help |
| Unknown code | **PERMANENT** | fail-closed (`AGENTS.md §19`) |

- **Mechanism:** retries are **in-process and bounded inside the same `AiRunner` claim**, exactly like `ExtractionRunner` (ADR-005). Because a single AI job can take minutes, in-process retry is used only for **fast failures** (dispatch/HTTP errors). Long jobs are *not* waited on within the claim — instead the Runner dispatches, then waits on the processor's own status with a bounded per-job deadline (§14), and on timeout classifies TRANSIENT.
- **Config:** `AI_MAX_RETRIES` (default `2`), `AI_RETRY_BACKOFF_MS` (default `5000`, exponential, capped). `aiAttempt` is the persisted counter (`MediaFile.aiAttempt`).
- **Reset:** manual reprocess resets `aiAttempt = 0` and clears `aiError*`.
- **Distinction from durable resume:** a TRANSIENT failure that exhausts `AI_MAX_RETRIES` sets `aiStatus = FAILED` with `aiErrorCode` = the cause; it does **not** resurrect via the restart sweep (the sweep only touches `PROCESSING`).

### 7. Partial results

**Successful partial results are kept.** The Runner records per-stage outcomes, and each successful stage's output is persisted immediately on that stage's success (not withheld until the whole pipeline ends). If a later stage fails permanently, earlier successful stages remain in the DB, `aiStatus` becomes `READY` (with `aiPartial = true`) **if at least one stage succeeded**, otherwise `FAILED`.

This requires the per-stage model in §9. Rationale: transcription is the expensive step; discarding a completed transcript because OCR failed is wasteful and would force full re-runs (`AGENTS.md §26`, avoid needless work).

### 8. Result storage

Results are stored as **per-stage rows**, not one opaque blob, so §7 works and so partial failures are representable:

New model `AiResult`:

```text
id              String   @id            // cuid
mediaFileId     String                  // FK → MediaFile
stage           AiStage                 // TRANSCRIPTION | SUMMARY | KEYWORDS | CLASSIFICATION | OCR | SCENE_ANALYSIS
status          AiStageStatus           // READY | FAILED
payload         Json?                   // stage output (segments, summary text, keyword array, category, scenes…)
errorCode       String?
errorMessage    String?
attemptedAt     DateTime
createdAt       DateTime @default(now())
updatedAt       DateTime @updatedAt

@@unique([mediaFileId, stage])
@@index([mediaFileId])
```

- **Upsert on `(mediaFileId, stage)`** guarantees idempotency and no duplicate results across restarts/re-runs.
- **JSONB payload** because the shapes are format-specific and evolving (`AGENTS.md §11`); promoted to columns later only if a field becomes filterable/sortable (e.g. a future `aiCategory` on `MediaFile`).
- Raw processor response for transcription may additionally be preserved (like `rawProbeData`) but is not required for MVP.
- `MediaFile` gains denormalized *hot* fields only where listing/filtering needs them: `aiStatus` (indexed), `aiErrorCode`, `aiErrorMessage`, `aiErrorAt`, `aiAttempt`, `aiExternalJobId`, `aiProcessedAt`, `aiPartial` (bool). Everything verbose lives in `AiResult.payload`.

### 9. Media path security

- **The API/Runner never sends a host path or a user path.** It sends `relativePath` (already stored, POSIX, storage-relative) — never an absolute path. It resolves to an absolute path **inside TMIP** with `resolveInsideRoot(config.mediaRoot, relativePath)` (`apps/api/src/paths.ts`), the same containment check used for ffprobe.
- The resolved absolute path is passed to the processor as `video_path`. Containment is therefore enforced by TMIP before the request leaves the API (the processor is on the internal network and trusts TMIP, exactly as `ai-client.ts` trusts its caller today).
- **Defense in depth:** the processor is bound to the internal Docker network and not exposed to the host by default (§10); the request handler additionally rejects any `video_path` that is not absolute and, when a `MEDIA_ROOT` env is set in the processor, re-verifies containment (`os.path.realpath` prefix check). This is a hardening addition made in Phase 14, not present in the legacy service.
- **Read-only preserved:** the processor's media mount is **`:ro`** (`/media:ro`), identical to the API's. The legacy processor wrote progress/result files into `/media` (finding 1) — **that behavior is removed**; progress/results are returned over HTTP and persisted in PostgreSQL, never written to the media volume. This also removes the hidden media-write path that ADR-002 forbids.
- The processor must never receive a path outside `MEDIA_ROOT`. No user-supplied path reaches it: `ai-reprocess` takes only a `MediaFile.id`; the server derives `relativePath` from the DB.

### 10. Docker networking

```text
tmip-api ──(http://ai-processor:8000, internal network)──► ai-processor
```

- Service name: **`ai-processor`**; internal URL `http://ai-processor:8000` via `AI_PROCESSOR_URL`.
- **Do not publish `8000` to the host by default.** Use `expose: ["8000"]` (internal-only). Host publishing only via a documented, opt-in override for debugging.
- `depends_on: ai-processor` on `api` is **not** `condition: service_healthy` for a hard gate, because the Runner tolerates an unavailable processor by treating it as TRANSIENT; but `api` should still `depends_on: [ai-processor]` for startup ordering and add a depends-on healthcheck once §13 healthcheck lands.
- Media mount on the processor: `${MEDIA_ROOT}:/media:ro` (read-only, same host dir as the API).
- **Model cache volume:** named volume `ai-model-cache` mounted at `/model-cache` with `HF_HOME=/model-cache`, so Whisper/CLIP/YOLO weights survive restarts and are not re-downloaded. Not a secret, not media.
- No `certs/` SSL-inspection CA is carried over (finding 13); if the target environment needs one it is supplied at deploy time, out of TMIP source.

### 11. LLM provider configuration & secret handling

The LLM stages (summary/keywords/classification, OCR presenter parsing) target an **OpenAI-compatible `/chat/completions` endpoint**, not OpenRouter specifically. Any compatible provider (OpenRouter, OpenAgentic, a local gateway) works by pointing the base URL at it.

**Configuration (generic-first, backward compatible):**

| Setting | Precedence | Default |
|---|---|---|
| base URL | `LLM_BASE_URL` > `OPENROUTER_BASE_URL` | `https://openrouter.ai/api/v1` |
| API key | `LLM_API_KEY` > `OPENROUTER_API_KEY` | (none) |
| model | `LLM_MODEL` > `OPENROUTER_MODEL` | `deepseek/deepseek-chat` |

The generic `LLM_*` names win when both are set, so an existing `OPENROUTER_*`-only deployment keeps working unchanged. The request URL is built as `f"{base.rstrip('/')}/chat/completions"`, so a trailing slash can never produce a double slash. There is no hardcoded provider URL on the request path.

- **Keys are never copied** into TMIP source, git, migrations, ADRs, plans, `.env.example`, or images (owner directive; `AGENTS.md §21`, Plan 005 §14).
- `api`/`ai-processor` read keys only from the **runtime environment**. `.env.example` documents only the **key names** and safe non-secret defaults:
  ```text
  AI_ENABLED=false
  AI_PROCESSOR_URL=http://ai-processor:8000
  AI_MODEL_SIZE=medium
  LLM_BASE_URL=https://openrouter.ai/api/v1
  # LLM_API_KEY=                  # supply at runtime, never commit
  # LLM_MODEL=deepseek/deepseek-chat
  AI_MAX_RETRIES=2
  AI_RETRY_BACKOFF_MS=5000
  AI_REQUEST_TIMEOUT_MS=30000
  AI_POLL_INTERVAL_MS=10000
  AI_STAGE_TIMEOUT_MS=900000
  AI_JOB_DEADLINE_MS=5400000
  AI_CONCURRENCY=1
  ```
- Missing key degrades gracefully: the LLM stages are skipped with a non-fatal reason; transcription/OCR-text still run. `/health` exposes `llm_available` (and `openrouter_available` for compatibility), plus the non-secret `llm_base_url` and `llm_model` so a misconfiguration is diagnosable. The key is **never** returned by `/health`.

### 12. Provider error classification

Provider failures are classified by HTTP status — **not** collapsed into a single generic error — so TMIP's TRANSIENT/PERMANENT decision stays accurate (aligns with §6):

| Provider status | Kind | Class |
|---|---|---|
| 400 | BAD_REQUEST | PERMANENT |
| 401 | AUTHENTICATION | PERMANENT |
| 402 | QUOTA | PERMANENT |
| 403 | FORBIDDEN | PERMANENT |
| 404 | NOT_FOUND (endpoint/model) | PERMANENT |
| 408 | TIMEOUT | TRANSIENT |
| 429 | RATE_LIMITED | TRANSIENT |
| 5xx | PROVIDER_ERROR | TRANSIENT |
| timeout / network error | TIMEOUT / NETWORK | TRANSIENT |

`/summarize` maps the class to a status: transient → 503 (retryable); permanent → the provider's own 4xx where meaningful, otherwise 502. Error messages carry the provider's own `error.message` (sanitized and truncated) but **never** the API key, request headers, or the raw provider body. The TMIP adapter then classifies the processor's 4xx as PERMANENT and 5xx/429 as TRANSIENT (§6), so a bad key surfaces as a permanent, actionable error instead of a retry loop.

### 13. Healthcheck

- Processor: `GET /health` returning `{ status: "ok", llm_available: bool, llm_base_url: str, llm_model: str, openrouter_available: bool }`. Compose `healthcheck` uses a minimal Python/curl probe:
  ```yaml
  healthcheck:
    test: ["CMD", "python", "-c", "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=3).status==200 else 1)"]
    interval: 15s
    timeout: 5s
    retries: 5
    start_period: 30s   # model/cold-start tolerance
  ```
- `start_period` is deliberately generous because first-run model download is slow.
- API does not hard-fail if the processor is unhealthy; it surfaces the condition through AI job failures classified TRANSIENT and via `/health` aggregation (optional, non-MVP).

### 14. Timeout / deadline

**Do not adopt the legacy 150-minute constant blindly.** TMIP configures four independent, configurable values (all in ms, validated by Zod, sane defaults chosen from the audited CPU-only profile):

```text
AI_REQUEST_TIMEOUT_MS  = 30000     // single HTTP request to the processor (start/status/cancel); short calls only
AI_POLL_INTERVAL_MS    = 10000     // status poll cadence
AI_STAGE_TIMEOUT_MS    = 900000    // 15 min ceiling for one synchronous stage call (OCR frame / CLIP-YOLO scene pass)
AI_JOB_DEADLINE_MS     = 5400000   // 90 min absolute ceiling for one AI job end-to-end
```

Rationale: the legacy 150 min was tuned for a specific 45-min asset at ~3× realtime with a 10-min stuck heuristic. TMIP makes the ceiling explicit and configurable; on deadline exceeded the failure is classified TRANSIENT (retryable), and `aiAttempt` bounds the loop. `AI_STAGE_TIMEOUT_MS` also prevents a hung OpenRouter/OpenCV call from blocking the Runner forever.

### 15. Resource / concurrency

- Measured/known profile: Whisper `medium` on **CPU int8, 8 threads** → roughly 2–3× realtime for a 45-min asset; CLIP `ViT-B-32` + YOLO `yolov8n` are CPU-capable but slow, GPU-optional. Peak RAM dominated by the Whisper model + Torch.
- **Initial concurrency: `AI_CONCURRENCY = 1`** (one AI job at a time). Media is read over SMB/NFS; parallel heavy reads + CPU-bound inference destabilize Server B and the host (`AGENTS.md §20`: start conservatively).
- The processor itself runs one job per process by default; **do not** raise processor worker count before measuring. If concurrency is needed later, scale the *runner* dispatch, not the model threads, and record a new ADR.
- Model cache must be a persisted volume (§10). GPU is optional and not assumed; if present, `device="cuda"` is auto-selected by the existing code.

### 16. MVP scope

**Phase 14 MVP = text pipeline only:**

- **IN:** transcription (faster-whisper) → summary → keywords → classification; OCR (lower-third text + presenter parse).
- **DEFERRED (Phase 15+):** PySceneDetect scene detection, CLIP location classification, YOLO object detection, transcript-fusion scene merging (`/analyze-scenes`).

Rationale: the text pipeline is one linear dependency chain (transcription feeds the LLM stages), has the highest value, and has modest resource needs. The vision pipeline (CLIP+YOLO over every shot) is the most expensive, most format-specific, and its output model (scene list) is the least settled; it belongs in a follow-up with its own ADR. This also honors `AGENTS.md §38` (smaller, complete pipeline beats more features).

### 17. Manual reprocess

`POST /api/media/:id/ai-reprocess`:
- `404` if the media file does not exist.
- `409` if `aiStatus = PROCESSING` (a workflow is already in flight) — mirrors metadata reprocess conflict.
- On success: set `aiStatus = PENDING`, `aiAttempt = 0`, clear `aiErrorCode/aiErrorMessage/aiErrorAt`, leave existing `AiResult` rows in place (they are overwritten per-stage on the new run) → `202 { mediaFileId, aiStatus: "PENDING" }`.

**Deliberate divergence from ADR-004 metadata reprocess:** the metadata reprocess path returns `409` for **both** `PENDING` and `PROCESSING` (a `PENDING` metadata row already has a worker about to act on it, per ADR-004). The AI path returns `202` for an already-`PENDING` `aiStatus` because resetting AI work to `PENDING` **is** the requested action and is idempotent — there is no in-flight claim to protect (the runner claims `PENDING→PROCESSING` atomically, so a redundant `202` is harmless). Only a live `PROCESSING` claim is a genuine conflict (`409`). This is recorded here so Phase 14 does not re-decide it.

### 18. API contract (TMIP-side)

AI status/result are surfaced on the **existing** media endpoints (additive; `AGENTS.md §32`):

- `GET /api/media` list items gain `aiStatus`, `aiPartial`, `aiProcessedAt` (nullable).
- `GET /api/media/:id` detail gains the above plus `aiErrorCode`, `aiErrorMessage`, `aiErrorAt`, `aiAttempt`, `aiCancelRequestedAt` (nullable; §19), and — under a new key — an `ai` object with per-stage results (transcript text/segments, summary, keywords, category, OCR presenter). Verbose payload may be returned from a dedicated `GET /api/media/:id/ai` if detail payload size is a concern.
- `POST /api/media/:id/ai-reprocess` (§17).
- `POST /api/media/:id/ai-cancel` (§19).
- Processor contract consumed by TMIP (unchanged in spirit): `GET /health`, `POST /transcribe` + `GET /transcribe/status/{id}` + `GET /transcribe/result/{id}` + `POST /transcribe/cancel/{id}` (for transcription), `POST /summarize`, `POST /ocr`; `POST /analyze-scenes` reserved for Phase 15.
- The legacy `/keywords` and `/classify` endpoints are **not** called separately — one `/summarize` call yields summary+keywords+category (finding: they re-run the same logic).

### 19. Cancellation (durable stop)

Cancellation is **not** implemented as "abort the HTTP request and write `CANCELLED`". Aborting a request does not stop the processor's computation, and a terminal write from the request handler races a late worker. Instead:

- **Durable intent.** `MediaFile.aiCancelRequestedAt` (nullable timestamp) records the request. `POST /api/media/:id/ai-cancel` persists it with a conditional update (`WHERE aiStatus = 'PROCESSING'`) and returns **`202 { aiStatus: "PROCESSING", cancelRequested: true }`** — deliberately NOT a terminal state. `404` when the media is unknown; `409` when the row is not PROCESSING and carries no active intent. The request is idempotent.
- **Runner drives the transition.** The `AiRunner` checks the intent before every stage, before every retry, and before finalizing. When observed it stops before the next stage, **keeps already-succeeded stage rows**, and finalizes `CANCELLED` (with `aiPartial = true`).
- **In-memory `AbortController` is a fast-path only.** It aborts local work promptly but is *not* the source of truth; a lost controller (e.g. another process claimed the row) still cancels because the intent is in the database. The signal is threaded into the adapter's `fetch` calls.
- **Race safety (compare-and-set).** Every terminal write is guarded by `aiStatus = 'PROCESSING'` (`finalize`, `finalizeCancelled`, the crash handler). A late worker therefore cannot overwrite a finalized `CANCELLED` (or `READY`/`FAILED`) state. Stage persistence is likewise gated: succeeded stages are always kept, while a *failed* stage is not recorded once cancellation is requested (the failure is an abort artifact, not a defect).
- **Remote transcription cancel.** `cancel()` also calls the processor's `POST /transcribe/cancel/{asset_id}` (best-effort). The `asset_id` is TMIP's `aiExternalJobId` (`${mediaFileId}:${attempt}`); the mapping is verified in tests, not assumed.
- **Restart recovery.** `sweepInterruptedAiState` finalizes a `PROCESSING` row that carries the intent as `CANCELLED` (never re-queues it); rows without the intent return to `PENDING` (§4).
- **Manual reprocess after cancel** clears `aiCancelRequestedAt` atomically with the reset (§17).

**Limitation (documented, not hidden):** cancellation is cooperative. Whisper transcription stops between segments on request, but OCR and LLM calls are single synchronous request/response operations whose provider side may run to completion even after TMIP aborts the HTTP call. TMIP guarantees only that such results are **not written** once cancellation is terminal — it cannot force the remote provider to stop working.

### 20. OCR lower-third sampling

The source OCR takes one frame. In practice that frame is often the opening black/title card, producing noise (`"oa 3 ara pa = aes"`). TMIP therefore samples:

- when the caller supplies a valid `duration_sec`, up to **five** frames at 10/30/50/70/90 % of the duration, clamped inside the video's real range;
- when duration is missing/invalid, a single safe fallback frame at `timestamp_sec` (default t=0);
- never a full-video scan; frames are processed in memory and nothing is written into the media tree (ADR-002).

Frame selection uses a `text_quality_score` that combines alphanumeric ratio, plausible-length tapering, word quality (with implausibly long tokens capped so a noise run cannot win), and a repetition penalty — deliberately more than a raw character count. A per-frame OCR error is skipped rather than failing the stage. The response adds `sampled_count` and `best_timestamp_sec` for observability.

**Known limitation — the five-frame grid is a heuristic, not a guarantee (measured 2026-10-13).** On the Phase 14 reference broadcast (1443 s), using the current pipeline (FFmpeg-CLI frame extraction, colour-ROI OCR):

- A presenter lower-third stays on screen only ~2–3 s: at 1 s spacing, only 2–3 of 13 frames within a burst read it.
- It recurs rather than appearing once — three bursts were located (~84 s, ~619 s, ~1244 s) — yet the 5-frame grid at 10/30/50/70/90 % hit none of them.
- Recall is not monotonic in frame count: a 20-frame grid caught a burst while a 40-frame grid missed it, because the outcome depends on where the grid lands, not on its density.
- The transcript is **not** a reliable guide to the caption: at ~613–625 s the narration names a person ("Kang Ebeng") different from the one on the lower-third, so segment timestamps cannot be used to predict a caption.
- Cost is Tesseract-dominated at ~0.8 s/frame (single-pass stream) to ~1.4 s/frame (per-frame seek), so widening the grid adds linear cost without a matching gain in recall.
- No false positives were observed: across 13 verified caption-free frames the watermark "Pesona Indonesia" was never mistaken for a presenter.

**Decision: the five-frame strategy is retained unchanged.** Increasing the count would add linear cost without a demonstrable, reliable gain, and a genuine improvement needs broadcast-moment detection (e.g. scene/overlay changes) — that is Phase 15 vision work (§16) and would require its own ADR. The limitation is recorded here rather than silently tolerated. Test scope: a single video; the 5 s distribution scan may itself have missed further bursts, and the OCR spelling of the detected name is not confirmed.

**Resolution note (2026-10-13):** a 14-frame evenly-spaced grid had been merged
(`SAMPLE_FRACTIONS = tuple(i / 15 for i in range(1, 15))`), which was inconsistent
with the five-frame decision above. It has been **reverted to the five-frame grid**
(`SAMPLE_FRACTIONS = (0.10, 0.30, 0.50, 0.70, 0.90)`). The revert is justified by
the measurements recorded above: on the reference video the five-frame and
14-frame grids each caught **0 of 3** verified lower-third bursts, so the wider grid
added per-frame cost (~1.4 s/frame measured) without a reliable detection gain.
The revert does **not** claim the five-frame grid detects lower-thirds better — the
available evidence establishes no such improvement for either grid; it only restores
consistency between the code and this ADR and avoids unproven cost. A regression
assertion pins the adopted fractions in `ai-processor/tests/test_ocr.py`. This closes
**OD-11** in `docs/mvp2-ai-metadata/05-open-decisions.md`.


## Consequences

**Positive**
- AI state is durable in PostgreSQL; restart recovery is deterministic and safe (re-run, not lose).
- No Redis/BullMQ is introduced into TMIP; one claim model, one source of truth.
- Media stays strictly read-only and contained; the legacy hidden media-write path is removed.
- Partial results are preserved and cheap re-runs are avoided.
- AI failure never affects `metadataStatus`.

**Negative / accepted cost**
- AI jobs are effectively "at-least-once": a crash mid-job re-runs the whole job. Acceptable because re-run upserts and AI outputs are deterministic given the same media.
- Duplicate results cannot be fully prevented at the processor side; TMIP's upsert makes them harmless.
- Whisper CPU-only makes the first MVP slow; the model cache volume and conservative concurrency are the mitigations.

## Required source fixes carried into Phase 14 (not Phase 13)

These are corrected during the copy/adapt step, tracked so they are not silently inherited:

1. Fix `get_background_status` dead-code/`RUNNING` return (finding 2).
2. Stop writing progress/result files into `/media` (finding 1/9) — return over HTTP only.
3. Make `POST /transcribe` truly idempotent via `aiExternalJobId` (finding 3).
4. Make cancellation set a cooperative stop flag checked in the whisper loop, or drop the cancel endpoint from MVP (finding 4).
5. Add `MEDIA_ROOT` containment re-check to `video_path` (finding 10/§9 defense-in-depth).
6. Remove the embedded corporate CA cert from the image (finding 13).

## Alternatives considered

- **Keep BullMQ/Redis and port the source worker.** Rejected. TMIP has no queue today; `metadataStatus`/`aiStatus` in PostgreSQL is the proven durable signal. Redis would add an infrastructure dependency with no new capability (`AGENTS.md §7`, §23, §25; `ARCHITECTURE.md §11` says Redis is not the source of truth). This is the explicit "do not add Redis because the old project used it" decision required by the Phase 13 mandate.
- **Rewrite the processor in TypeScript/Node.** Rejected. Python owns the ML ecosystem (faster-whisper, torch, open_clip, ultralytics, pytesseract); a rewrite is large, risky, and out of scope. A separate container is also the correct isolation boundary for heavy/GPU deps.
- **Use the legacy "poll inline for up to 150 min" model.** Rejected. Not restart-survivable and couples the API worker's lifetime to a single long job (finding 6).
- **Store AI output in one JSONB blob on `MediaFile`.** Rejected for MVP because it cannot represent partial per-stage success/failure cleanly (§7/§8). Per-stage rows cost little and model reality.
- **Mark interrupted AI jobs FAILED(INTERRUPTED) like technical metadata.** Rejected: re-running AI is safe and valuable; failing it burns user effort for no correctness gain.

## Related documents

- `AGENTS.md §8, §11, §12, §16, §17, §18, §19, §20, §21, §32, §38`
- `SCOPE.md` (AI remains **out of v1 scope**; this ADR is additive v2 architecture and does not change v1 scope)
- `ARCHITECTURE.md §11, §12, §46, §48`
- `DATA_MODEL.md` (MediaFile, status enums; AI additions are additive)
- `WORKFLOWS.md §33, §46, §51, §52`
- `ADR-002` (read-only storage), `ADR-004` (reprocessing), `ADR-005` (bounded retry — mirrored pattern)
- `docs/plans/005-ai-processor-migration.md`, `docs/plans/006-ai-processor-integration.md`
