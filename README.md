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

TMIP runs on Server A and reads video files from Server B through mounted read-only storage. It is designed to support recurring incremental scans so that newly added or modified media files can be processed without unnecessarily reprocessing unchanged files.

## What This App Does

- **Discover** — recursively scans the mounted media storage for video files (`.mp4`, `.mov`, `.mxf`, `.mpg`, `.mpeg`, `.avi`, `.mkv`, `.ts`, `.mts` by default)
- **Detect change** — incremental scanning identifies new, changed, unchanged, and missing files so only what changed gets reprocessed
- **Extract metadata** — ffprobe pulls technical metadata (duration, codecs, resolution, frame rate, bit rate, pixel format, audio layout, container info) in a background worker
- **Store** — everything is persisted in PostgreSQL (Prisma-managed schema, JSONB for flexible metadata)
- **Display** — a Next.js web UI shows the media inventory, metadata details, scan progress, and AI enrichment results

## Tech Stack

| Layer | Technology |
|---|---|
| API | Node.js, TypeScript, Express 5, Zod |
| Web UI | Next.js 15, React 19, TypeScript |
| Database | PostgreSQL 16, Prisma ORM |
| Metadata extraction | FFmpeg / ffprobe |
| AI enrichment (optional) | Python, FastAPI, faster-whisper (transcription), Tesseract (lower-third OCR), any [OI]-compatible LLM API (summary/keywords/classification) |
| Infrastructure | Docker, Docker Compose |

Note: TMIP v1 does **not** use Redis or BullMQ — orchestration of metadata and AI jobs is PostgreSQL-backed (see `ADR/ADR-006`).

## Requirements

- Docker + Docker Compose (primary runtime mode), or Node.js 20+, pnpm, PostgreSQL and ffprobe for host development
- Access to the media storage as a host filesystem path (read-only)
- For AI enrichment: an [OI]-compatible LLM API key (e.g. OpenRouter)

## Step-by-Step Usage

### 1. Configure the environment

Copy `.env.example` to `.env` and set at minimum:

```dotenv
# Host path to your video storage (used ONLY as the read-only bind-mount source)
MEDIA_HOST_PATH=D:/DEVELOP/Media        # or /mnt/tmip-media on Server A
STORAGE_NAME=Server B Media

# Postgres credentials (defaults: tmip/tmip/tmip)
POSTGRES_USER=tmip
POSTGRES_PASSWORD=tmip
POSTGRES_DB=tmip

# Web UI origin
WEB_ORIGIN=http://localhost:3000
```

Important: `MEDIA_HOST_PATH` is the **host** path used by docker-compose as the read-only bind-mount source. `MEDIA_ROOT` is the **container-visible** path (always `/media`) — the two namespaces must not be mixed. `DATABASE_URL` / `FFPROBE_PATH` from `.env` are overridden by docker-compose.yml.

### 2. Start the stack

```bash
docker compose up -d --build
```

This starts four services:

- `web` — Next.js UI at <http://localhost:3000>
- `api` — Express API at <http://localhost:4000>
- `postgres` — PostgreSQL 16 (port 5432)
- `ai-processor` — internal-only Python/FastAPI ML service (not published to the host; started regardless, used only when AI is enabled)

### 3. Run a scan

Open <http://localhost:3000> and trigger a scan from the dashboard. The scanner walks the mounted storage recursively, records new/changed/unchanged/missing files, and queues metadata extraction for files that need it. Scan progress is tracked in the UI.

### 4. Browse the inventory

Each discovered file appears in the media inventory with its technical metadata (from ffprobe) on its detail page. Files that failed extraction transiently are retried automatically (bounded, `METADATA_MAX_RETRIES` default 2); the retry count shows as `retryCount` on the detail page. Use **Reprocess metadata** on a detail page (or `POST /media/:id/reprocess`) to manually re-extract.

### 5. (Optional) Enable AI enrichment

Add to `.env`, then rebuild:

```dotenv
AI_ENABLED=true
LLM_BASE_URL=https://openrouter.ai/api/v1
LLM_API_KEY=sk-or-...
LLM_MODEL=deepseek/deepseek-chat
```

```bash
docker compose up -d --build
```

When enabled, every NEW file that finishes metadata extraction gets `aiStatus = PENDING`; the runner then produces transcription (faster-whisper), summary/keywords/classification (LLM), and lower-third OCR (Tesseract, sampled at 5 points across the video). Each stage is stored as its own `AiResult` row; a later-stage failure keeps earlier results (`aiPartial = true`). Manual reprocess: media detail page or `POST /media/:id/ai-reprocess`. Cancel a running job: detail page or `POST /media/:id/ai-cancel` (cooperative, durable cancellation intent).

Provider errors are classified by HTTP status — 401/404 fail permanently; only timeouts, 429, and 5xx are retried (bounded by `AI_MAX_RETRIES`). The `ai-processor` container is internal-only and never writes to the media tree.

### 6. Operational access to PostgreSQL

```bash
docker compose exec postgres psql -U tmip -d tmip
```

Or any SQL client: host `localhost`, port `5432`, user/password/database from `.env` (defaults `tmip`).

```sql
-- Inspect scan records
SELECT id, status, "errorMessage" FROM "ScanJob" ORDER BY "createdAt" DESC;

-- Remove a single scan record (safe: nothing references it)
DELETE FROM "ScanJob" WHERE id = '<scan-id>';
```

TMIP v1 intentionally provides no record deletion through the API or UI. Reprocess metadata via the app (`POST /media/:id/reprocess`, see `WORKFLOWS.md` §52). Manual re-queue (only if the API/UI is unavailable): `UPDATE "MediaFile" SET "metadataStatus" = 'PENDING' WHERE "relativePath" = '<relative-path>';` then start a scan in the UI. Do not modify or delete rows you do not understand — the media inventory is the application's source of truth.

### Storage rootPath and runtime mode

`Storage.rootPath` lives in the **container/application namespace**: in the Docker stack it is always `/media` (same value as `MEDIA_ROOT`, never the host path). The api startup bootstrap requires `rootPath` to equal the environment's `MEDIA_ROOT` and refuses to rewrite it automatically:

- **Full Docker** (recommended): `rootPath` must be `/media`.
  ```bash
  docker compose exec postgres psql -U tmip -d tmip \
    -c "UPDATE \"Storage\" SET \"rootPath\" = '/media' WHERE name = '<STORAGE_NAME>';"
  ```
- **Host dev** (`pnpm --filter @tmip/api dev`) runs directly against the host filesystem, so `MEDIA_ROOT` / `rootPath` must be the host path (e.g. `D:\DEVELOP\Media`) — a different environment with a deliberately different value.

`MediaFile.relativePath` is always stored relative to the storage root, so switching the root does not invalidate the inventory. Do not alternate modes against the same database without updating the `Storage` row's `rootPath`.

## Design Principles

- source media remains read-only
- unchanged files are not unnecessarily reprocessed
- PostgreSQL is the persistent source of truth
- stable metadata uses relational columns; flexible metadata uses JSONB
- long-running work runs outside HTTP request handlers
- failures for individual files must not stop an entire scan
- architecture stays simple but easy to extend; no feature before the core pipeline is reliable

## Out of Scope for v1

TMIP v1 is intentionally not a full Digital Asset Management platform. Outside scope: automated technical QC, transcoding, proxy generation, file rename/move/deletion, archive lifecycle automation, advanced reporting, complex approval workflows, face recognition, and object detection. (AI transcription/summary/OCR exists as the additive v2 capability described above; semantic search and chatbot functionality remain out of scope.) These may be evaluated in future phases.

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
