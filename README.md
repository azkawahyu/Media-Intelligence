# TMIP — Technical Media Inventory Platform

TMIP is a focused internal application for discovering video files stored on remote media storage, extracting their technical metadata, and maintaining a reliable searchable inventory.

The current version intentionally focuses on one complete workflow:

```text
DISCOVER
    ↓
DETECT CHANGE
    ↓
EXTRACT METADATA
    ↓
STORE
    ↓
DISPLAY
```

TMIP runs on Server A and reads video files from Server B through mounted read-only storage.

It is designed to support recurring incremental scans so that newly added or modified media files can be processed without unnecessarily reprocessing unchanged files.

## Current Scope

TMIP v1 focuses on:

- recursive video file discovery
- incremental scanning
- new file detection
- changed file detection
- unchanged file skipping
- missing file detection
- technical metadata extraction using ffprobe
- PostgreSQL metadata persistence
- flexible metadata storage using JSONB
- background metadata processing
- bounded automatic retry of transient extraction failures
- manual metadata reprocessing
- scan progress tracking
- basic media inventory and metadata viewing

## Technical Metadata

TMIP may extract metadata such as:

- filename
- relative path
- file size
- modified timestamp
- duration
- video codec
- resolution
- frame rate
- bit rate
- pixel format
- audio codec
- sample rate
- audio channels
- container information

Raw ffprobe metadata may also be preserved for future use.

## Architecture

```text
Server B
Video Storage
    │
    │ SMB / NFS
    ▼
Server A
Read-Only Mounted Storage
    │
    ▼
Docker
    │
    ├── Next.js Web
    ├── Express API
    ├── Scanner
    ├── BullMQ / Redis
    ├── Metadata Worker
    │      └── ffprobe
    └── PostgreSQL
```

## Technology Stack

- TypeScript
- Node.js
- Express
- Next.js
- React
- Zod
- PostgreSQL
- Prisma
- Redis
- BullMQ
- FFmpeg / ffprobe
- Docker
- Docker Compose

## Design Principles

TMIP is designed around the following principles:

- source media remains read-only
- unchanged files are not unnecessarily reprocessed
- PostgreSQL is the persistent source of truth
- stable metadata uses relational columns
- flexible metadata uses PostgreSQL JSONB
- long-running work runs outside HTTP request handlers
- failures for individual files must not stop an entire scan
- architecture should remain simple but easy to extend
- future features should not be implemented before the core metadata pipeline is reliable

## Out of Scope for v1

TMIP v1 is intentionally not a complete Digital Asset Management platform.

The following are currently outside the project scope:

- AI-generated metadata
- transcription
- OCR
- face recognition
- object detection
- semantic search
- chatbot functionality
- automated technical QC
- transcoding
- proxy generation
- file rename, move, or deletion
- archive lifecycle automation
- advanced reporting
- complex approval workflows

These capabilities may be evaluated in future phases after the core metadata inventory pipeline is stable.

## Running TMIP

The primary runtime mode is the full Docker stack:

```bash
docker compose up -d --build
```

- Web UI: http://localhost:3000
- API: http://localhost:4000
- Trigger scans from the dashboard UI.

The stack reads its configuration from `.env` (see `.env.example`). Media paths
use two separate namespaces that must not be mixed:

- `MEDIA_HOST_PATH` — the **host** filesystem path. Used only by
  docker-compose.yml as the read-only bind-mount source
  (`${MEDIA_HOST_PATH}:/media:ro`, ADR-002). It is never read by the application.
- `MEDIA_ROOT` — the **container-visible** path. Always `/media` inside the api
  and ai-processor containers, and it matches the bind-mount target and
  `Storage.rootPath`.

`DATABASE_URL` / `FFPROBE_PATH` from `.env` are overridden by docker-compose.yml.

Canonical Server A deployment:

```text
Server B                        (media storage)
    ↓ SMB/NFS
Server A  /mnt/tmip-media       (host mount, read-only)
    ↓ Docker bind mount :ro
Containers  /media              (MEDIA_ROOT, Storage.rootPath)
```

For development on Windows the same shape applies with
`MEDIA_HOST_PATH=D:/DEVELOP/Media`.

### Bounded metadata retry

A metadata extraction that fails for a plausibly transient reason (ffprobe
timeout, a file momentarily unreadable or absent, temporary storage/network
unavailability) is retried automatically inside the same worker, with bounded
exponential backoff, before a final `FAILED` is recorded. Permanent failures
(corrupt/unsupported media, invalid structure, deterministic validation errors)
are never retried automatically. Both knobs are optional:

- `METADATA_MAX_RETRIES` (default `2`) — extra attempts after the first; `0`
  disables automatic retry.
- `METADATA_RETRY_BACKOFF_MS` (default `250`) — base backoff, doubling per
  retry and capped at 5 s.

The retry count is visible as `retryCount` on the media detail page. Manual
reprocessing from the media detail page still works and resets the retry state.
See `WORKFLOWS.md §33` and `ADR/ADR-005-bounded-extraction-retry.md`.

### AI enrichment (additive v2 capability)

TMIP can optionally enrich a media file with AI results — transcription,
summary, keywords, content classification, and lower-third OCR. This is an
**additive v2 capability**: it does not change TMIP v1 behavior or acceptance
criteria, and it is **disabled by default**.

The AI Processor is a separate Python/FastAPI service (`ai-processor/`) that owns
the heavy ML dependencies (faster-whisper, Torch, OpenCV, Tesseract) so the Node
API image stays small. TMIP orchestrates it through a PostgreSQL-backed runner —
**no Redis and no BullMQ are introduced** (`ADR/ADR-006-ai-processor-integration.md`).

Enabling it:

```bash
# .env
AI_ENABLED=true
# LLM provider for the summary/keywords/classification stages (and OCR presenter
# parsing). Any [OI]-compatible /chat/completions API works. Never commit a key.
LLM_BASE_URL=https://openrouter.ai/api/v1
LLM_API_KEY=sk-or-...
LLM_MODEL=deepseek/deepseek-chat
```

```bash
docker compose up -d --build
```

The generic `LLM_*` names take precedence over the legacy `OPENROUTER_*` names
(kept for backward compatibility), so an existing OpenRouter-only setup keeps
working unchanged. Provider errors are classified by HTTP status — a bad key
(401) or a missing model (404) fails permanently and is not retried; only
timeouts, 429, and 5xx are retried.

How it works:

- The `ai-processor` service runs on the internal compose network only. Its port
  is **not published to the host** (`expose: ["8000"]`), and its media mount is
  **read-only** (`${MEDIA_HOST_PATH}:/media:ro`), identical to the api service.
- The AI Processor **never writes into the media tree**. Progress and results are
  returned over HTTP and persisted in PostgreSQL.
- When `AI_ENABLED=true`, a media file that becomes `metadataStatus = READY` and
  is NEW gets `aiStatus = PENDING`; the AI Runner drains those rows with
  `AI_CONCURRENCY` (default `1`).
- Each stage's result is stored as its own `AiResult` row. If a later stage
  fails, earlier successful stages are kept and `aiStatus = READY` with
  `aiPartial = true`.
- OCR samples up to five frames across the video (10/30/50/70/90 % of the
  duration) and keeps the best-scoring lower-third text, instead of trusting a
  single — often black — opening frame.
- AI failures are retried only when plausibly transient, bounded by
  `AI_MAX_RETRIES`. Permanent failures (unsupported/corrupt media, bad request,
  auth, missing model) are never retried.
- On restart, a `PROCESSING` row with a pending cancellation intent becomes
  `CANCELLED`; any other `PROCESSING` row is reset to `PENDING` and re-run.
  TMIP's database is the only source of job truth.

Manual AI reprocessing from the media detail page (or
`POST /media/:id/ai-reprocess`) resets a file to `PENDING` and clears its error
state. `409` means either a run is already in flight or AI is disabled.

Stopping a run (media detail page, or `POST /media/:id/ai-cancel`) records a
**durable cancellation intent** and returns `202` with the row still
`PROCESSING` — the runner then stops before the next stage and finalizes
`CANCELLED`, keeping results from stages that already completed. The UI shows
"Stopping…" until the server confirms the terminal state. Cancellation is
cooperative: TMIP stops writing results immediately, but a remote provider call
already in flight may still finish on its side.

The AI lifecycle is fully separate from technical metadata: AI never writes
`metadataStatus` and the ffprobe pipeline is unaffected whether AI is enabled or
not. With `AI_ENABLED` unset, `aiStatus = PENDING` simply means "not processed".
See `ADR/ADR-006-ai-processor-integration.md` and
`docs/plans/006-ai-processor-integration.md`.

### Storage rootPath and runtime mode

`Storage.rootPath` lives in the **container/application namespace**, so in the
Docker stack it is always `/media` — the same value as `MEDIA_ROOT`, never the
host path (`MEDIA_HOST_PATH`). The api startup bootstrap requires the `Storage`
row's `rootPath` to equal the `MEDIA_ROOT` of the environment it runs in, and
refuses to rewrite it automatically:

- **Full Docker** (recommended): `rootPath` must be `/media`.
  ```bash
  docker compose exec postgres psql -U tmip -d tmip \
    -c "UPDATE \"Storage\" SET \"rootPath\" = '/media' WHERE name = '<STORAGE_NAME>';"
  ```
- **Host dev** (`pnpm --filter @tmip/api dev`) runs the application directly
  against the host filesystem, so for that environment `MEDIA_ROOT` — and
  therefore `rootPath` — must be the host path (e.g. `D:\DEVELOP\Media`). This
  is a different environment with a deliberately different value.

Media records are safe either way — `MediaFile.relativePath` is always stored
relative to the storage root and is never rewritten to an absolute path, so
switching the root does not invalidate the inventory. Do not alternate modes
against the same database without updating the `Storage` row's `rootPath`.

## Accessing PostgreSQL

TMIP v1 does not provide record deletion through the API or UI; this is an intentional v1 scope decision. Explicit metadata reprocessing *is* provided — use the "Reprocess metadata" action on a media detail page, or `POST /media/:id/reprocess` (see `WORKFLOWS.md` §52). For local operational cleanup that is not covered by the application, connect to the database directly.

Using the built-in `psql` client inside the Docker container (no extra installation):

```bash
docker compose exec postgres psql -U tmip -d tmip
```

Or connect any SQL client (pgAdmin, DBeaver, ...) using the compose credentials:

```text
host: localhost
port: 5432
user: tmip        (POSTGRES_USER from .env)
password: tmip    (POSTGRES_PASSWORD from .env)
database: tmip    (POSTGRES_DB from .env)
```

Useful operational queries:

```sql
-- Inspect scan records
SELECT id, status, "errorMessage" FROM "ScanJob" ORDER BY "createdAt" DESC;

-- Remove a single scan record (safe: nothing references it)
DELETE FROM "ScanJob" WHERE id = '<scan-id>';
```

To reprocess a single file's metadata, prefer the application action described above. The equivalent manual SQL (only needed if the API/UI is unavailable) is to re-queue the row and then start a scan in the UI:

```sql
-- Re-queue a file for metadata extraction, then start a scan in the UI.
-- Extraction will fail again until ffprobe is available (host install or Docker stack).
UPDATE "MediaFile" SET "metadataStatus" = 'PENDING' WHERE "relativePath" = '<relative-path>';
```

Do not modify or delete rows you do not understand; the media inventory is the application's source of truth.

## Project Documentation

Project behavior and development rules are defined in:

```text
AGENTS.md
PRD.md
SCOPE.md
ARCHITECTURE.md
DATA_MODEL.md
WORKFLOWS.md
TESTING.md
ADR/
```

## Primary Goal

TMIP v1 is considered successful when:

> A video stored on Server B can be discovered from Server A, identified as new or changed, inspected with ffprobe, stored in PostgreSQL, and displayed in the web application without modifying the original media file.