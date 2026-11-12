# TMIP Plan 001 — First Vertical Slice

- **Status:** Approved — plan-reviewer verdict APPROVE_WITH_REVISIONS; all required revisions and recommended improvements applied (2026-09-30)
- **Scope:** First vertical slice only. Implementation has not started.
- **Review basis:** `SCOPE.md`, `ARCHITECTURE.md`, `DATA_MODEL.md`, `WORKFLOWS.md`, `TESTING.md`, `ADR/ADR-001-postgresql-jsonb.md`, `ADR/ADR-002-storage-read-only.md`, `ADR/ADR-003-incremental-scanning.md`, `AGENTS.md`
- **Deviations:** All intentional scope reductions are recorded in **Annex A — Documented deviations and deferred items**. Nothing is silent.

**Mission:** A video file present in a configured read-only media directory can be (1) discovered, (2) inspected with ffprobe, (3) stored in PostgreSQL, (4) exposed through the API, and (5) displayed in the web application — with minimal idempotency (a repeated scan creates no duplicates and does not re-run ffprobe on unchanged files).

---

## 1. Relevant documented requirements used

Citations use document + section heading. All headings verified against the current files.

**AGENTS.md**
- "2. Project Mission" and "37. TMIP v1 Product Completion Rule" — the DISCOVER → DETECT CHANGE → EXTRACT → STORE → DISPLAY pipeline is the deliverable; reliability over feature count.
- "4. Current In-Scope Capabilities" — the slice implements the minimum supporting set: discovery, new/changed/unchanged handling, ffprobe extraction, persistence, scan tracking, background processing, basic listing/detail/progress, manual triggering.
- "8. Separation of Responsibilities" — Scanner / Change Detection / Metadata Extractor / Worker / API / Database boundaries; "The scanner MUST NOT perform expensive metadata extraction directly"; ffprobe must not run inside HTTP handlers.
- "9. Scanning Rules", "10. Discovery Is Not Extraction" — idempotency contract; extraction only for new/changed files.
- "11. Database Strategy" (Relational Columns / JSONB) and "13. Raw Metadata Preservation" — hybrid model; preserve raw ffprobe output as JSONB.
- "14. File Identity", "15. Path Handling" — identity = `storageId + relativePath`; relative paths; no hardcoded server paths.
- "16. External Tool Boundary", "17. Validation" — ffprobe behind an adapter; Zod validation of inputs and probe output.
- "18. Failure Handling", "19. Retry Behavior" — per-file failure records (category, message, stage, timestamp); retries bounded. (Slice: no retry loops at all, per owner constraint.)
- "20. Concurrency", "21. Configuration", "22. Supported Media Types" — configurable conservative concurrency, validated env configuration, centralized extension list.
- "23. Technology Stack" — TypeScript, Next.js, Express, Zod, PostgreSQL, Prisma, BullMQ/Redis, ffprobe, Docker (BullMQ/Redis deferred — see Annex A, D1).
- "25. Avoid Premature Abstraction", "27. Observability", "28. Testing Requirements", "30. Existing Implementation First".
- "6. Media Storage Safety" — read-only storage; no writes of any kind to source media.

**PRD.md**
- "9.1 Storage Access" through "9.8 Scan Tracking" — storage access via mounted path, recursive discovery, incremental scan states, ffprobe metadata set (file/video/audio), raw probe preservation, PostgreSQL persistence, background processing outside HTTP lifecycle, scan job states and counters.
- "12. Manual Scanning" — manual trigger is the initial operational model.
- "13.1 Media List", "13.2 Media Detail", "13.3 Scan Control", "13.4 Scan Progress" — the four minimum UI views.
- "15. Data Safety Requirements", "16.1 File-Level Isolation", "16.2 Repeatability".
- "20. Storage Flexibility Requirement" — `Storage {id, name, rootPath}` abstraction, relative paths.
- "23. Technology Constraints" — documented stack.
- "25. Minimum End-to-End Acceptance Scenario" — NEW scan then UNCHANGED rescan is the acceptance core (the UPDATED leg of §25 is deferred; see Annex A, D2).

**SCOPE.md**
- "34. Current Minimum Deliverable" — this slice is exactly §34's two flows: NEW → ffprobe → PostgreSQL → UI; second scan → UNCHANGED → ffprobe skipped.
- "4.2 Storage Configuration", "4.3 Recursive File Discovery", "4.4 Supported Media Detection".
- "5. Incremental Scanning" intro plus "5.1 New Files", "5.2 Unchanged Files" (5.3/5.4 deferred — see Annex A, D2).
- "6. File Change Detection" — size + modified time is sufficient; no hashing.
- "10. PostgreSQL Persistence", "11. Prisma", "12. Background Jobs".
- "13. Manual Scan Triggering", "14. Scan Progress", "16. Media List", "17. Media Detail".
- "21. Worker Concurrency", "22. Application Configuration", "23. Docker Deployment" (service separation may simplify), "25. Health Checks", "26. Tests".
- "29. Flexibility That Is In Scope" — storage abstraction, relative paths, JSONB, configurable extensions/concurrency, ffprobe adapter boundary, separation of discovery and extraction.

**ARCHITECTURE.md**
- "5. Read-Only Storage Principle", "4. Infrastructure Boundary" — bind-mount `:ro`, read-only operations only.
- "6. Logical Architecture" — components are logical responsibilities, not mandatory separate services.
- "8. API Application", "9. Scanner", "10. Change Detection", "13. FFprobe Adapter", "14. Metadata Normalization".
- "15. PostgreSQL", "16. PostgreSQL + JSONB Strategy".
- "18. Scan Job Architecture", "19. Scan Execution Flow" — discovery phase completes, then queued metadata is processed.
- "22. File Identity Strategy", "23. Change Detection Strategy".
- "25. Concurrency Architecture" — `METADATA_WORKER_CONCURRENCY`, start conservative.
- "27. Failure Isolation", "29. Recommended Repository Structure" (with its explicit caveat: "Only create shared packages when code is genuinely shared").
- "32. Configuration Architecture", "33. Docker Architecture", "34. Scanner Deployment Decision" (scanner may run inside the API if triggering is asynchronous — the legal basis for the in-process design), "35. HTTP Request Boundary" (202 + scanId), "36. API Shape", "37. Polling vs Realtime Updates".
- "40. Security Boundary", "41. Path Traversal Safety", "42. Shell Execution Safety" — argument-array spawn, path containment.
- "44. Health Architecture", "47. Architecture Anti-Patterns".

**DATA_MODEL.md**
- "3. Core Entities", "5. Storage", "6. Storage Identity", "8. MediaFile Identity" (`UNIQUE(storageId, relativePath)`).
- "9. MediaFile Suggested Fields", "10. Media Status" (ACTIVE/MISSING; FAILED is not a presence status), "11. Metadata Status" (PENDING/PROCESSING/READY/FAILED).
- "15. ScanJob Suggested Fields", "16. ScanJob Status", "17. Scan Failure Meaning".
- "30. Frame Rate Representation", "31. Duration Representation", "32. File Size Representation" (BIGINT).
- "36. lastSeenScanId", "37. lastMetadataExtractedAt" (only changes on successful extraction).
- "43. Database Constraints", "46. Metadata Extraction Error Model" (error categories; the documented list is explicitly non-exhaustive — "may include"), "48. Scan Counters", "50. Idempotency Requirements".
- "55. Minimal First Implementation" — the explicit permission to start with Storage + MediaFile + ScanJob and defer ScanItem/MetadataExtraction.

**WORKFLOWS.md**
- "4. Start Scan Workflow" (202, no waiting), "6. Concurrent Scan Policy", "7. Storage Availability Check" (root check; FAILED scan must not imply files are missing).
- "8. Discovery Workflow", "9. Unsupported Files", "10. Discovered File Input".
- "11. Change Detection Workflow", "12. NEW File Workflow", "13. UNCHANGED File Workflow" (never touch `lastMetadataExtractedAt`), "16. Discovery Observation" (`lastSeenScanId`/`lastSeenAt` always updated).
- "24. Worker Start Workflow", "25. Worker File Validation" (exists, readable, still inside root), "28. FFprobe Workflow" (safe process execution), "29. Metadata Normalization Workflow".
- "30. Successful Metadata Extraction", "31. Failed Metadata Extraction" (processedCount counts terminal attempts), "32. Failure Isolation".
- "35. Scan Progress Workflow", "36. Scan Completion Conditions", "37. Successful Scan Completion", "38. Completed With Errors", "39. Failed Scan", "40. Zero New File Scan".
- "41. First-Ever Scan" (respect concurrency), "43. Database Transaction Boundaries" (no scan-wide transaction; atomic per-file units).
- "46. Application Restart During Scan" — "Initial implementation may choose the simpler explicit failure approach" (basis for the startup sweep).
- "48. Media Detail Workflow", "49. Media List Workflow" (list/detail never touch the filesystem), "58. End-to-End Acceptance Workflow" (steps 1–2 in scope; steps 3–5 deferred).

**TESTING.md**
- "2. Testing Principles" (mockable externals, no Server B, deterministic), "3. Testing Layers", "4. Unit Tests".
- "5. Change Detection Tests" (5.1–5.5 as a pure classifier), "6. Media Identity Tests", "7. Path Handling Tests", "8. Path Traversal Safety Tests", "9. Supported Extension Tests".
- "10. FFprobe Parser Tests", "11. Frame Rate Tests", "12. Duration Tests", "13. Audio Metadata Tests", "14. Malformed FFprobe Output", "16. FFprobe Command Safety".
- "17. Database Integration Tests", "18. Unique Media Constraint Test", "20. JSONB Tests", "21. Scan Orchestration Integration Tests", "22. First Scan Test", "23. Second Unchanged Scan Test", "31. Scan Idempotency Test", "40. Scan Completion Tests", "41. Zero-Work Scan Test".
- "35. Worker Failure Isolation Test", "44. API Tests", "45. Start Scan API Test", "46. Concurrent Scan API Test", "47. Media List Tests", "48. Media Detail Tests".
- "49. Source Media Safety Tests", "50. Read-Only Deployment Test", "51. Permission Failure Tests", "52. Storage Root Failure Test", "63. Test Isolation", "65. Test Environment Safety", "72. Test Priority Order".
- "32. Metadata Extraction Integration Test", "15. FFprobe Process Failure Tests", "58. End-to-End Acceptance Test", "70. Required Tests Before TMIP v1 Completion" — partially environment-gated/deferred (see section 7 and Annex A).

**ADRs**
- ADR-001 "Decision", "Raw ffprobe Preservation" — PostgreSQL + relational core + JSONB; preserve latest successful raw probe.
- ADR-002 "Decision", "Application Restrictions", "Failure Behavior", "Testing Requirement" — read-only storage; storage-unavailable ≠ all-missing; verify against a genuinely read-only mount.
- ADR-003 "Decision", "Unchanged File", "Idempotency Requirement", "Failed Discovery Safety" — rediscover cheaply, reprocess only what changed.

---

## 2. Current repository assessment

Verified 2026-09-30 (git status clean on `main`, tracking `origin/main`):

| Present | Files |
|---|---|
| Governance/product docs | `AGENTS.md`, `PRD.md`, `SCOPE.md` |
| Technical docs | `ARCHITECTURE.md`, `DATA_MODEL.md`, `WORKFLOWS.md`, `TESTING.md` |
| ADRs | `ADR/ADR-001-postgresql-jsonb.md`, `ADR/ADR-002-storage-read-only.md`, `ADR/ADR-003-incremental-scanning.md` |
| Other | `README.md`, `.gitignore` |

**Absent (confirmed by full-tree search):** no `package.json`, `tsconfig.json`, `pnpm-workspace.yaml`, Prisma schema, Docker/compose files, source directories, or tests anywhere in the tree.

**Host toolchain (verified):** Node v24.16.0, npm 11.13.0, pnpm 11.23.0, Docker 29.6.2 (Windows 10, Git Bash). ffprobe and ffmpeg are **not** on the host PATH.

**Reusable assets:** documentation only. There is no existing implementation to extend (`AGENTS.md → "30. Existing Implementation First"` is trivially satisfied); `.gitignore` already covers Node artifacts.

---

## 3. Gaps between the current repository and this vertical slice

Every step of the pipeline must be created from zero:

1. **Build/workspace** — no package management, TypeScript config, lint/typecheck, or test runner.
2. **Persistence** — no PostgreSQL service, no Prisma schema/migrations, no `Storage`/`MediaFile`/`ScanJob` models.
3. **Configuration** — no validated env configuration (`DATABASE_URL`, `MEDIA_ROOT`, `FFPROBE_PATH`, `METADATA_WORKER_CONCURRENCY`, `SUPPORTED_MEDIA_EXTENSIONS`, ports).
4. **Scanner** — no recursive read-only traversal, extension filtering, attribute collection, or path-containment utility.
5. **Change detection** — no NEW/UNCHANGED classifier (UPDATED computed but not acted on; MISSING deferred).
6. **Extraction** — no ffprobe adapter (argument-array spawn, timeout, Zod-validated output), no normalizer, no raw-output preservation.
7. **Background processing** — no in-process job runner; nothing prevents ffprobe from being wired into handlers.
8. **API** — no Express app, no scan/media endpoints, no concurrent-scan guard, no health endpoint.
9. **UI** — no Next.js app, no list/detail/scan-control/progress views.
10. **Docker** — no images or compose topology; no read-only media mount.
11. **Tests** — no unit, integration, or acceptance tests; no fixtures.

---

## 4. Small sequential implementation phases

Each phase is independently verifiable. All work stays inside `AGENTS.md → "3. Scope Discipline"`.

**Phase 1 — Workspace and runtime scaffold.**
Create `pnpm-workspace.yaml`, root `package.json` (scripts: `typecheck`, `test`, `build`, `dev`), `apps/api` (Express + TypeScript + Zod, single `GET /health` returning process-alive; DB ping added in Phase 2), `apps/web` (Next.js placeholder page). Add `docker-compose.yml` with a `postgres:16-alpine` service and a named volume; `.env.example`. Test runner: Vitest (dev tooling justified in Annex A).
*Verify:* `pnpm install && pnpm typecheck` clean; `docker compose up -d postgres` healthy; `GET /health` returns 200; web serves placeholder.

**Phase 2 — Configuration, Prisma schema, migration, storage bootstrap.**
Zod-validated config module (startup fails loudly on missing/invalid values — `ARCHITECTURE.md → "32. Configuration Architecture"`). Prisma schema exactly as in section 5 below; `prisma migrate dev` creates it. Idempotent startup bootstrap: ensure the single `Storage` row exists for the configured `MEDIA_ROOT` and `rootPath` matches the env value (safe: identity is `storageId + relativePath` per `DATA_MODEL.md → "6. Storage Identity"`). Health endpoint gains DB ping.
*Verify:* migration applies on an empty DB; unique/index constraints visible in DB; unit test proves invalid env produces a clear startup failure; `/health` reports DB reachable.

**Phase 3 — Scanner and path utilities (pure, no DB).**
Recursive async traversal using Node `fs/promises` with a per-file callback (no giant in-memory array); centralized supported-extension list from validated config (`AGENTS.md → "22. Supported Media Types"`); discovered-record shape `{storageId, relativePath, filename, extension, fileSize, modifiedAt}` (`ARCHITECTURE.md → "9. Scanner"`); `resolveInsideRoot(root, relativePath)` containment utility (`ARCHITECTURE.md → "41. Path Traversal Safety"`).
*Verify:* unit tests for extensions incl. case handling ("9. Supported Extension Tests"), nested/spaces/Unicode paths ("7. Path Handling Tests"), traversal rejection ("8. Path Traversal Safety Tests"). No DB, no ffprobe needed.

**Phase 4 — Scan orchestration, classification, idempotent persistence, scan API.**
`ScanOrchestrator`: create `ScanJob` PENDING → RUNNING; storage availability check (`WORKFLOWS.md → "7. Storage Availability Check"`; root unusable → `FAILED`, no per-file inference); traverse; classify each discovered file — NEW (no record), UNCHANGED (record exists, same `fileSize` + `modifiedAt` per `ARCHITECTURE.md → "23. Change Detection Strategy"`), attribute-mismatch (counted `updatedCount` only — see Annex A, D2). Persist NEW via per-file atomic unit (upsert `MediaFile` with `metadataStatus=PENDING`, `firstSeenAt`/`lastSeenAt`/`lastSeenScanId`; `WORKFLOWS.md → "12. NEW File Workflow"`, "43. Database Transaction Boundaries"); UNCHANGED updates only observation fields (`WORKFLOWS.md → "13. UNCHANGED File Workflow"`). UPDATED-classified files still receive their observation updates (`lastSeenAt`, `lastSeenScanId`, `status=ACTIVE`) per `WORKFLOWS.md → "16. Discovery Observation"`; only their stored `fileSize`/`modifiedAt` and metadata remain untouched so the mismatch stays visible for the next phase. Update counters; set `discoveryCompletedAt`. API: `POST /scans` → 202 + scanId (validates optional storageId; 409 if a PENDING/RUNNING scan exists for the storage — `WORKFLOWS.md → "6. Concurrent Scan Policy"`, `TESTING.md → "46. Concurrent Scan API Test"`); `GET /scans/:id`; `GET /scans` (short list). The handler only creates the row and detaches the async orchestration (`ARCHITECTURE.md → "35. HTTP Request Boundary"`).
*Verify:* integration tests against the compose Postgres with a temp media dir and ffprobe absent (queued items simply remain PENDING; scan stays RUNNING — final states arrive in Phase 6): "22. First Scan Test" counters, "23. Second Unchanged Scan Test", "31. Scan Idempotency Test", "18. Unique Media Constraint Test", "52. Storage Root Failure Test", zero-work classification.

**Phase 5 — FFprobe adapter and metadata normalizer (pure).**
`FFprobeAdapter` interface + spawn implementation: `spawn(ffprobePath, ["-v","error","-print_format","json","-show_format","-show_streams", absolutePath], { shell: false })` with timeout, stdout/stderr capture, exit-code interpretation (`ARCHITECTURE.md → "13. FFprobe Adapter"`, "42. Shell Execution Safety"; `WORKFLOWS.md → "28. FFprobe Workflow"`). Zod schema for ffprobe JSON (strict on consumed fields, passthrough for the rest). `MetadataNormalizer`: `format.duration` → `durationSeconds` ("12. Duration Tests"); video stream `r_frame_rate` → `frameRateNumerator`/`frameRateDenominator` ("30. Frame Rate Representation", "11. Frame Rate Tests"); first video/first audio stream → codec/width/height/sampleRate/channels ("13. Audio Metadata Tests" — no audio is not a failure); remaining useful fields (pixel format, profile, container format, tags) → `technicalMetadata` JSONB; malformed output → `INVALID_PROBE_OUTPUT` ("14. Malformed FFprobe Output"). Raw output preserved verbatim as `rawProbeData` (`AGENTS.md → "13. Raw Metadata Preservation"`; ADR-001 "Raw ffprobe Preservation").
*Verify:* unit tests with committed ffprobe JSON fixtures (MP4/H.264, MOV, MXF, MPEG-2, H.265, interlaced, incomplete metadata, multi-audio, no-audio, odd frame rate, malformed — "10. FFprobe Parser Tests"); command-safety test asserting the argv array for filenames like `Program #01.mxf` and `test & demo.mp4` ("16. FFprobe Command Safety").

**Phase 6 — Extraction runner, failure recording, scan completion.**
In-process single-concurrency `ExtractionRunner` (Annex A, D1): polls `MediaFile` where `metadataStatus=PENDING`; claims one (PENDING → PROCESSING); validates file exists/readable and resolved path stays inside the storage root (`WORKFLOWS.md → "25. Worker File Validation"`); runs the adapter via the injected interface; on success persists normalized + `technicalMetadata` + `rawProbeData`, `metadataStatus=READY`, `lastMetadataExtractedAt=now` (`WORKFLOWS.md → "30. Successful Metadata Extraction"`); on failure persists `metadataStatus=FAILED` + `errorCode`/`errorMessage`/`errorStage`/`errorAt` (`AGENTS.md → "18. Failure Handling"`; categories from `DATA_MODEL.md → "46. Metadata Extraction Error Model"`); increments `processedCount`/`failedCount`; never throws out of the per-file loop (`WORKFLOWS.md → "32. Failure Isolation"`). `METADATA_WORKER_CONCURRENCY` read from config, default 1 (`ARCHITECTURE.md → "25. Concurrency Architecture"`). Orchestrator finalization after `discoveryCompletedAt`: drain queued items, then `COMPLETED` / `COMPLETED_WITH_ERRORS` (`WORKFLOWS.md → "36. Scan Completion Conditions"` through "38. Completed With Errors"); zero-queue scans complete immediately ("40. Zero New File Scan"). Startup sweep: `PROCESSING` media from a dead process → `FAILED(INTERRUPTED)` — `INTERRUPTED` extends the non-exhaustive category list in `DATA_MODEL.md → "46. Metadata Extraction Error Model"`; orphan `RUNNING` scans → `FAILED` (`WORKFLOWS.md → "46. Application Restart During Scan"`, explicit-failure option). No retries anywhere (`AGENTS.md → "19. Retry Behavior"` bounds honored by absence).
*Verify:* integration tests with a mock adapter: failure isolation (one failing file, others continue — "35. Worker Failure Isolation Test"), permission failure on an unreadable file does not crash the scan ("51. Permission Failure Tests"), completion states ("40. Scan Completion Tests"), success path persists columns + JSONB ("20. JSONB Tests"), error categories mapped ("14. Malformed FFprobe Output", "15. FFprobe Process Failure Tests" via mock), source-dir tree+hash unchanged before/after ("49. Source Media Safety Tests").

**Phase 7 — Media read API.**
`GET /media` (paginated list; BigInt-safe serializer — `fileSize` serialized as string) and `GET /media/:id` (detail: identity, filesystem attrs, normalized metadata, `technicalMetadata`, `rawProbeData`, `metadataStatus`, failure details, observation timestamps). Both read PostgreSQL only (`WORKFLOWS.md → "49. Media List Workflow"`, "48. Media Detail Workflow"). Zod response contracts (minimal).
*Verify:* API tests — 200/pagination, 404 unknown id, invalid query 400, list/detail never trigger ffprobe or traversal ("44. API Tests", "47. Media List Tests", "48. Media Detail Tests").

**Phase 8 — Web UI.**
Next.js App Router, two pages only:
- `/` — media list table (filename, relativePath, duration, resolution, codec, size, status, metadataStatus — `PRD.md → "13.1 Media List"`) plus scan control (Start Scan button → `POST /scans`, clear started indication — "13.3 Scan Control") and scan progress panel polling `GET /scans/:id` every few seconds with distinct states for running/completed/completed-with-errors/failed (`PRD.md → "13.4 Scan Progress"`; `ARCHITECTURE.md → "37. Polling vs Realtime Updates"`; `TESTING.md → "57. UI Loading State Tests"`).
- `/media/[id]` — detail view incl. failure details when applicable (`PRD.md → "13.2 Media Detail"`; `SCOPE.md → "17. Media Detail"`).

Web never touches the filesystem, ffprobe, or PostgreSQL (`ARCHITECTURE.md → "7. Web Application"`). API base URL from validated env.
*Verify:* manual black-box verification against the compose stack (automated frontend tests deferred — Annex A, D5).

**Phase 9 — Docker packaging and acceptance verification.**
Dockerfiles: `api` image = Node base + ffmpeg/ffprobe installed via apt (`FFPROBE_PATH=/usr/bin/ffprobe`); `web` image = Next.js standalone build. Compose services: `web`, `api`, `postgres`; media bind mount `${MEDIA_ROOT}:/media:ro` (`ARCHITECTURE.md → "33. Docker Architecture"` simplified; ADR-002 "Decision"). Enable environment-gated tests in-container (Annex A, D4): real-ffprobe extraction test using a tiny ffmpeg-generated fixture ("32. Metadata Extraction Integration Test", "33. Test Media Fixtures"), read-only-mount scan ("50. Read-Only Deployment Test"; ADR-002 "Testing Requirement"), and the slice's E2E acceptance: scan 1 → NEW → metadata visible in UI → `COMPLETED`; scan 2 → UNCHANGED → ffprobe skipped (assert via unchanged `lastMetadataExtractedAt` and stable `processedCount`) → `COMPLETED` (`TESTING.md → "58. End-to-End Acceptance Test"` steps 1–2; `SCOPE.md → "34. Current Minimum Deliverable"`).
*Verify:* full acceptance checklist passes through the UI against a read-only-mounted local media folder; no source mutation.

---

## 5. Minimum database schema required

Three tables — exactly the subset `DATA_MODEL.md → "55. Minimal First Implementation"` permits. Prisma is the schema/migration tool (`SCOPE.md → "11. Prisma"`).

**`Storage`**
- `id` (cuid, PK), `name` (unique), `rootPath`, `enabled` (default true), `createdAt`, `updatedAt`.
- Single row bootstrapped from env; no storage CRUD or UI (`SCOPE.md → "4.2 Storage Configuration"` minimum).

**`MediaFile`** (identity: `UNIQUE(storageId, relativePath)` — `DATA_MODEL.md → "8. MediaFile Identity"`)
- Identity: `id` PK, `storageId` FK → Storage, `relativePath`, `filename`, `extension`.
- Filesystem state: `fileSize` (BigInt — `DATA_MODEL.md → "32. File Size Representation"`), `modifiedAt` (timestamptz).
- Presence: `status` enum `ACTIVE | MISSING` (default `ACTIVE`; `MISSING` value reserved, unused in slice — `DATA_MODEL.md → "10. Media Status"`).
- Extraction state: `metadataStatus` enum `PENDING | PROCESSING | READY | FAILED` (`DATA_MODEL.md → "11. Metadata Status"`).
- Normalized technical columns (exactly the fields the slice displays/queries, per `AGENTS.md → "11. Database Strategy" → Relational Columns`): `durationSeconds` Float?, `videoCodec`, `width`, `height`, `frameRateNumerator`, `frameRateDenominator` (`DATA_MODEL.md → "30. Frame Rate Representation"` — rational, no lossy 30000/1001→30), `audioCodec`, `audioSampleRate`, `audioChannels`.
- JSONB: `technicalMetadata Json?` (flexible normalized extras: container format, pixel format, profile, tags), `rawProbeData Json?` (latest successful raw ffprobe output — `AGENTS.md → "13. Raw Metadata Preservation"`, ADR-001 "JSONB Data").
- Observation: `firstSeenAt` (never overwritten — `DATA_MODEL.md → "34. firstSeenAt"`), `lastSeenAt`, `lastSeenScanId` (`DATA_MODEL.md → "36. lastSeenScanId"`; written every observation per `WORKFLOWS.md → "16. Discovery Observation"`, consumed by nothing yet — enables MISSING next phase), `lastMetadataExtractedAt` (set only on extraction success — `DATA_MODEL.md → "37. lastMetadataExtractedAt"`).
- Failure record (fields per `DATA_MODEL.md → "46. Metadata Extraction Error Model"`): `errorCode` (category), `errorMessage`, `errorStage` (`VALIDATION | FFPROBE | NORMALIZATION | PERSISTENCE`), `errorAt`.
- Operational: `createdAt`, `updatedAt`.
- Indexes: `@@unique([storageId, relativePath])`; `@@index([metadataStatus])` (runner polling); `@@index([storageId, status])`.

**`ScanJob`** (`DATA_MODEL.md → "15. ScanJob Suggested Fields"`, "16. ScanJob Status")
- `id` PK, `storageId` FK → Storage, `status` enum `PENDING | RUNNING | COMPLETED | COMPLETED_WITH_ERRORS | FAILED`, `startedAt`, `discoveryCompletedAt?`, `completedAt?`.
- Counters (default 0): `discoveredCount`, `newCount`, `updatedCount`, `unchangedCount`, `missingCount` (always 0 in slice — column retained for additive stability), `queuedCount`, `processedCount`, `failedCount` (`DATA_MODEL.md → "48. Scan Counters"`; `processedCount` counts terminal extraction attempts per `WORKFLOWS.md → "31. Failed Metadata Extraction"`).
- `errorMessage?`, `createdAt`, `updatedAt`.
- Index: `@@index([storageId, status])` (concurrent-scan guard).

**Deferred entities (with justification):**
- **`ScanItem`** (`DATA_MODEL.md → "18. ScanItem"`) — deferred: per-scan observation history is not needed while the slice classifies only NEW/UNCHANGED and idempotency is enforced by `MediaFile`'s unique constraint plus scan counters; `DATA_MODEL.md → "55. Minimal First Implementation"` explicitly defers it. The schema leaves room for additive addition (unique `(scanJobId, mediaFileId)` later).
- **`MetadataExtraction`** (`DATA_MODEL.md → "22. MetadataExtraction"`) — deferred: the slice performs at most one extraction attempt per file with no retries, so attempt history has no consumer; failure details live on `MediaFile` reusing §46's error-category vocabulary. Migration to a history table later is additive; responsibilities are kept separable per §55's caveat.
- Per-file `lastScannedAt` is collapsed into `lastSeenAt` for this slice (they coincide when extraction-status bookkeeping is separate per `DATA_MODEL.md → "37. lastMetadataExtractedAt"`).

---

## 6. Minimum API and UI required

**API (Express, Zod-validated; shape follows `ARCHITECTURE.md → "36. API Shape"`):**

| Endpoint | Behavior |
|---|---|
| `POST /scans` | Validates optional body (storageId must match the configured storage). Rejects with 409 if a PENDING/RUNNING scan exists for the storage. Creates `ScanJob`, detaches async orchestration, returns **202** + `{scanId}` (`ARCHITECTURE.md → "35. HTTP Request Boundary"`). |
| `GET /scans/:id` | Scan status + all counters + timestamps (`WORKFLOWS.md → "35. Scan Progress Workflow"`). 404 if unknown. |
| `GET /scans` | Short newest-first scan history (supports UI reload; part of documented API shape). |
| `GET /media` | Paginated media list from PostgreSQL only. `fileSize` serialized as string. |
| `GET /media/:id` | Media detail incl. `technicalMetadata`, `rawProbeData`, failure fields. 404 if unknown. Never runs ffprobe. |
| `GET /health` | Process alive + DB reachable (`SCOPE.md → "25. Health Checks"`; `ARCHITECTURE.md → "44. Health Architecture"`). |

No retry endpoint, no write endpoints, no storage CRUD, no media-list search/filter in this slice (see Annex A, D6).

**UI (Next.js, two pages, no component framework):**
- `/` — media list (PRD "13.1 Media List") + scan control ("13.3 Scan Control") + polling scan progress ("13.4 Scan Progress"), with visually distinct scan states ("57. UI Loading State Tests").
- `/media/[id]` — media detail incl. failure details (PRD "13.2 Media Detail").

The web app only calls the API (`ARCHITECTURE.md → "7. Web Application"` prohibitions all hold).

---

## 7. Test and verification plan

Test runner: Vitest. Layers per `TESTING.md → "3. Testing Layers"`. All tests use temp directories and a dedicated test database — never Server B (`TESTING.md → "63. Test Isolation"`, "65. Test Environment Safety"; `AGENTS.md → "28. Testing Requirements"`). The ffprobe adapter is injected behind an interface so every non-gated test runs with a mock (`TESTING.md → "2. Testing Principles"`).

**Unit (no DB, no ffprobe):**
- Change classification: NEW / UNCHANGED / size-changed / mtime-changed / both-changed (`TESTING.md → "5. Change Detection Tests"` 5.1–5.5).
- Media identity: the same filename in different folders/storages yields distinct records ("6. Media Identity Tests"); combined with the unique-constraint test below.
- Extension detection incl. case handling and ignored unsupported files ("9. Supported Extension Tests").
- Path normalization: nested, spaces, Unicode ("7. Path Handling Tests"); traversal rejection ("8. Path Traversal Safety Tests").
- FFprobe parser/normalizer over committed JSON fixtures: MP4/H.264, MOV, MXF, MPEG-2, H.265, interlaced, incomplete metadata, multi-audio, no-audio, odd frame rate, malformed ("10. FFprobe Parser Tests", "11. Frame Rate Tests", "12. Duration Tests", "13. Audio Metadata Tests", "14. Malformed FFprobe Output").
- Command safety: argv array, no shell, special-character filenames ("16. FFprobe Command Safety").
- Env config validation (missing/invalid → clear failure).

**Integration (compose Postgres + temp media dirs + mock adapter):**
- First scan counters and records ("22. First Scan Test" — extraction eligibility asserted as `metadataStatus=PENDING` + `queuedCount`); second unchanged scan ("23. Second Unchanged Scan Test"); idempotency over repeated scans ("31. Scan Idempotency Test"); unique constraint ("18. Unique Media Constraint Test"); JSONB round-trip ("20. JSONB Tests"); zero-work completion ("41. Zero-Work Scan Test"); completion states ("40. Scan Completion Tests"); failure isolation ("35. Worker Failure Isolation Test"); permission failure — unreadable file does not crash the scan ("51. Permission Failure Tests"); storage-root failure → FAILED with no per-file inference ("52. Storage Root Failure Test"; `WORKFLOWS.md → "7. Storage Availability Check"`); source media safety — directory tree + hashes unchanged ("49. Source Media Safety Tests"); extraction success/failure persistence incl. `errorCode`/`errorStage`/`errorAt` via mock adapter errors ("15. FFprobe Process Failure Tests" semantics, mocked).
- API: `POST /scans` returns 202 immediately ("45. Start Scan API Test"); concurrent scan → deterministic 409 ("46. Concurrent Scan API Test"); media list pagination + not-found + invalid input ("44. API Tests", "47. Media List Tests"); detail does not probe ("48. Media Detail Tests").

**Environment-gated (run only where ffprobe exists — executed inside the Phase 9 Docker verification; skipped with a documented skip reason on the dev host, per `TESTING.md → "71. Testing Anti-Patterns"` prohibition on silent skips):**
- Real ffprobe extraction against a tiny ffmpeg-generated fixture: duration, codec, resolution, frame rate ("32. Metadata Extraction Integration Test"); real process failures: bad file, timeout, non-zero exit ("15. FFprobe Process Failure Tests").
- Read-only mount scan ("50. Read-Only Deployment Test"; ADR-002 "Testing Requirement").
- E2E acceptance steps 1–2 (`TESTING.md → "58. End-to-End Acceptance Test"`; `SCOPE.md → "34. Current Minimum Deliverable"`).

**Deferred tests (with justification):** updated-file re-extraction ("24. Updated File Test"), missing detection ("26. Missing File Test", "27. Missing File Safety Test"), reappearance ("28. Reappearance Test"), rename ("29. Rename Behavior Test"), stale-job ("38. Stale Job Test") — all exercise behavior deliberately excluded by owner constraint 1 (Annex A, D2); retry/permanent-failure tests ("36. Retry Test", "37. Permanent Failure Test") — no retry logic in slice; Redis/queue-integration tests ("34. Queue Integration Tests", "54. Redis Failure Tests") — no Redis in slice (D1); frontend automated tests ("56. Frontend Tests") — manual verification in slice (D5); large-directory simulation ("42. Large Directory Simulation") and real-environment acceptance ("59. Real Environment Acceptance Test") — next phase, after slice behavior is proven on a local mount.

Mapping to `TESTING.md → "70. Required Tests Before TMIP v1 Completion"`: in-slice items (first scan, unchanged second scan, repeated-scan idempotency, real ffprobe extraction [gated], ffprobe failure handling, one-file-failure isolation, storage-failure safety, source files unchanged, scan progress visible, media visible in app) are covered by the plan above; updated/missing/reappearance items are deferred with D2 and remain on the v1 completion checklist.

---

## 8. Risks or genuine blockers only

1. **ffprobe absent on the development host (verified).** Real extraction and real process-failure behavior cannot be verified natively on Windows. *Resolution:* Phase 9 runs all ffprobe-dependent verification inside Docker (ffmpeg installed in the `api` image; Docker 29.6.2 confirmed available). This is the only genuine external dependency: if Docker Desktop is unavailable at verification time, slice acceptance blocks.
2. **Windows filesystem timestamp precision** could make "modified file" simulation flaky in tests. *Mitigation:* tests set explicit `modifiedAt` values via `utimes` with distinct coarse timestamps and classify against stored values; the classifier is a pure function over persisted attributes.
3. **Prisma `BigInt` is not JSON-serializable** in API responses. *Mitigation:* serializers convert `fileSize` to string; contracts are Zod-typed so this is caught at the boundary (Phase 7).

All intentional scope reductions relative to the governing documents are recorded in **Annex A**.

---

## 9. Final execution order

1. Scaffold pnpm workspace (`apps/api`, `apps/web`), root scripts, Vitest, compose with Postgres; typecheck + `/health` + web placeholder green.
2. Zod env config; Prisma schema (Storage / MediaFile / ScanJob, section 5) + migration on empty DB; idempotent Storage bootstrap; DB-pinging health.
3. Scanner (recursive read-only traversal, centralized extensions, attribute collection) + path-containment utility; unit tests green.
4. Scan orchestration: availability check, NEW/UNCHANGED classification, observation updates for every discovered file (incl. UPDATED-classified), idempotent upserts with `lastSeen*`/`lastSeenScanId`, counters, `updatedCount`-only for mismatches; `POST /scans` (202/409), `GET /scans/:id`, `GET /scans`; integration tests green.
5. FFprobe adapter (argv-array spawn, timeout, Zod parsing) + normalizer (rational frame rate, duration, audio optional, `INVALID_PROBE_OUTPUT`, JSONB extras); fixture-based unit tests green.
6. In-process single-concurrency ExtractionRunner with per-file failure records (`errorCode`/`errorMessage`/`errorStage`/`errorAt`), scan completion states (COMPLETED / COMPLETED_WITH_ERRORS / FAILED), zero-work completion, startup stale-state sweep; integration tests (mock adapter) green.
7. `GET /media` + `GET /media/:id` with BigInt-safe Zod contracts; API tests green.
8. Web UI: `/` (list + scan control + polling progress) and `/media/[id]`; manual verification against compose.
9. Docker images (api includes ffprobe; `:ro` media mount), enable environment-gated tests in-container, run acceptance: NEW scan visible in UI → `COMPLETED`; second scan UNCHANGED, ffprobe skipped, no duplicates; source tree unchanged; record any doc updates required by the deviations in Annex A.

---

## Annex A — Documented deviations and deferred items

Every item below is intentional, owner-mandated or owner-approved, and recorded — never silent.

- **D1 — In-process background processing instead of BullMQ/Redis/separate worker.** A single-concurrency in-process `ExtractionRunner` lives in the API process; scan orchestration and extraction are detached from HTTP handlers (`ARCHITECTURE.md → "34. Scanner Deployment Decision"` explicitly permits the scanner inside the API when triggering is asynchronous; `SCOPE.md → "23. Docker Deployment"` permits service simplification). Deviates from `ARCHITECTURE.md → "11. Metadata Extraction Queue"`, "17. Redis", "33. Docker Architecture", `WORKFLOWS.md → "21. Metadata Queue Workflow"`, `SCOPE.md → "12. Background Jobs"`, `AGENTS.md → "23. Technology Stack"`. Queue state is PostgreSQL (`metadataStatus=PENDING`), which keeps work recoverable and preserves the source-of-truth invariant; startup marks interrupted `PROCESSING` work and orphan `RUNNING` scans as `FAILED` per the explicit-failure option in `WORKFLOWS.md → "46. Application Restart During Scan"` (no auto-resume). BullMQ/Redis are deferred until a separate worker process or cross-restart queue durability is required; the runner/adapter boundaries are kept so the migration is additive. Consequence: the concurrent-scan guard is valid for a single API instance only.
- **D2 — UPDATED / MISSING / reappearance handling deferred.** The classifier computes NEW/UNCHANGED/UPDATED (tested per `TESTING.md → "5. Change Detection Tests"`), but the slice acts only on NEW (queue extraction) and UNCHANGED (skip; update observation fields). A known file whose size or mtime differs is counted in `updatedCount` only — no re-extraction is queued. Per `WORKFLOWS.md → "16. Discovery Observation"` such files still receive `lastSeenAt`/`lastSeenScanId` and remain `status=ACTIVE`; their stored `fileSize`/`modifiedAt` and metadata are left untouched so the mismatch stays visible for the next phase. No `MISSING` marking, no reappearance logic, no rename semantics. Deferred per owner constraint 1; next phase wires the re-extraction and missing-detection paths described in `WORKFLOWS.md → "14. UPDATED File Workflow"`, "19. MISSING File Detection Workflow", "20. File Reappearance Workflow" and `TESTING.md → "58. End-to-End Acceptance Test"` steps 3–5. The `missingCount` column and `lastSeenScanId` field are kept so those paths need no migration.
- **D3 — DATA_MODEL.md entities deferred:** `ScanItem` and `MetadataExtraction` (justifications in section 5). Per `DATA_MODEL.md → "55. Minimal First Implementation"`.
- **D4 — Environment-gated real-ffprobe tests.** Tests requiring the real ffprobe binary run only in the Docker verification stage (dev host has no ffprobe); on the dev host they are skipped with an explicit, documented gate. Mock-adapter tests cover the same logic deterministically everywhere, honoring `TESTING.md → "2. Testing Principles"` ("Real ffprobe behavior should still be tested separately").
- **D5 — Frontend automated tests deferred** (`TESTING.md → "56. Frontend Tests"`): the slice verifies the UI by manual black-box verification against the compose stack; automated UI tests come with the next phase.
- **D6 — Additional scope reductions per owner constraint 1:** no retry logic (bounded or otherwise — `SCOPE.md → "20. Retry Handling"` and `WORKFLOWS.md → "33. Retry Workflow"` deferred), no manual retry/reprocess endpoints (`WORKFLOWS.md → "51. Manual Retry Workflow"`, "52. Manual Reprocess Workflow" deferred), no scheduling, no media-list search/filter — although `SCOPE.md → "18. Basic Search and Filtering"` places basic search/filtering in scope, it is deferred to keep the slice minimal (the UI serves the `PRD.md → "13.1 Media List"` minimum), no notification/RBAC/auth, no restart auto-resume. **Superseded in part (Phase 11):** the deferral of the manual reprocess endpoint (`WORKFLOWS.md → "52. Manual Reprocess Workflow"`) is lifted by `docs/plans/003-metadata-reprocessing.md`. **Superseded in part (Phase 12):** the deferral of bounded retry (`SCOPE.md → "20. Retry Handling"`, `WORKFLOWS.md → "33. Retry Workflow"`) is lifted by `docs/plans/004-failure-classification-bounded-retry.md` and `ADR/ADR-005-bounded-extraction-retry.md`, which add bounded in-process retry of explicitly transient failures only. The manual retry endpoint ("51. Manual Retry Workflow") and all other D6 reductions remain deferred.
- **D7 — Storage bootstrap from environment.** The single `Storage` row is created/kept aligned from validated env at startup instead of any storage management surface — the minimum honoring `SCOPE.md → "4.2 Storage Configuration"` and `PRD.md → "20. Storage Flexibility Requirement"`.

**Tooling note:** Vitest and the pnpm workspace are development tooling required to fulfill `AGENTS.md → "28. Testing Requirements"` and multi-service development; they do not alter the runtime stack mandated by `AGENTS.md → "23. Technology Stack"`.
