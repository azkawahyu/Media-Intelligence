# ARCHITECTURE.md

## 1. Purpose

This document defines the high-level architecture of TMIP v1.

Its purpose is to:

- define system boundaries
- define component responsibilities
- prevent accidental architectural drift
- preserve clean extension points
- avoid unnecessary coupling
- reduce future refactor cost

This document describes the intended structure of the system, not hypothetical future systems.

---

# 2. Architectural Goal

TMIP v1 must provide a reliable end-to-end metadata pipeline:

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

The architecture should optimize for:

- simplicity
- reliability
- recoverability
- observability
- low operational risk
- low refactor cost
- clear responsibility boundaries

TMIP v1 must not introduce unnecessary distributed-system complexity.

---

# 3. Deployment Context

TMIP runs on Server A.

The source video files are stored on Server B.

Conceptually:

```text
┌─────────────────────────────┐
│ Server B                    │
│                             │
│ Video Storage               │
│                             │
│ / Video Files               │
└──────────────┬──────────────┘
               │
               │ SMB / NFS
               │
               ▼
┌─────────────────────────────┐
│ Server A                    │
│                             │
│ Mounted Media Storage       │
│ /mnt/tmip-media             │
│                             │
│ Docker Compose              │
│                             │
│ ┌─────────┐  ┌───────────┐ │
│ │ Web     │  │ API       │ │
│ └─────────┘  └───────────┘ │
│                  │          │
│             ┌────▼─────┐    │
│             │ Scanner  │    │
│             └────┬─────┘    │
│                  │          │
│             ┌────▼─────┐    │
│             │ Queue    │    │
│             └────┬─────┘    │
│                  │          │
│             ┌────▼─────┐    │
│             │ Worker   │    │
│             │ ffprobe  │    │
│             └────┬─────┘    │
│                  │          │
│             ┌────▼─────┐    │
│             │PostgreSQL│    │
│             └──────────┘    │
└─────────────────────────────┘
```

---

# 4. Infrastructure Boundary

TMIP should not directly manage SMB or NFS connections inside application business logic.

Preferred model:

```text
Server B
    ↓
host-level SMB/NFS mount
    ↓
Server A filesystem
    ↓
Docker bind mount
    ↓
TMIP container
```

Example host path:

```text
/mnt/tmip-media
```

Example container path:

```text
/media
```

Example Docker bind mount:

```text
/mnt/tmip-media:/media:ro
```

The application should interact with the mounted filesystem as a normal read-only filesystem.

---

# 5. Read-Only Storage Principle

Source media storage must be mounted read-only whenever possible.

TMIP must never rely on write access to source media.

Source media operations are limited to:

- listing directories
- reading file attributes
- opening media files for inspection
- reading media contents through ffprobe

TMIP must not:

- rename files
- move files
- delete files
- overwrite files
- create sidecar files beside media
- modify source directories

---

# 6. Logical Architecture

TMIP v1 consists of the following logical components:

```text
Web
API
Scanner
Change Detection
Job Queue
Metadata Worker
FFprobe Adapter
Persistence Layer
PostgreSQL
Redis
```

These are logical responsibilities.

They do not necessarily require separate repositories or independent deployable services.

---

# 7. Web Application

Technology:

```text
Next.js
React
TypeScript
```

Responsibilities:

- present media inventory
- present media detail
- trigger manual scans
- present scan status
- present scan counters
- present processing failures
- perform basic search and filtering

The web application must not:

- scan the filesystem directly
- execute ffprobe
- contain storage credentials
- access PostgreSQL directly from browser code
- implement business rules independently from the backend

---

# 8. API Application

Technology:

```text
Node.js
Express
TypeScript
Zod
```

Responsibilities:

- expose TMIP functionality
- validate incoming requests
- trigger scan operations
- query persisted media data
- query scan state
- expose metadata results
- coordinate application services

The API should remain thin.

HTTP handlers should primarily perform:

```text
validate
→ authorize if required
→ call application service
→ return response
```

Do not embed complex scanning or metadata extraction logic inside route handlers.

---

# 9. Scanner

The scanner is responsible for filesystem discovery.

Responsibilities:

- traverse configured storage roots
- recursively enumerate files
- filter candidate media files
- collect filesystem attributes
- produce discovered file records

Example discovered information:

```text
storageId
relativePath
filename
extension
fileSize
modifiedAt
```

The scanner must not:

- execute ffprobe
- modify files
- decide how metadata is normalized
- contain UI logic
- contain database-specific business logic when avoidable

---

# 10. Change Detection

Change detection determines how discovered files relate to persisted state.

Expected states:

```text
NEW
UNCHANGED
UPDATED
MISSING
```

Inputs may include:

```text
storageId
relativePath
fileSize
modifiedAt
```

The initial strategy should remain inexpensive.

Do not calculate full content hashes by default.

---

# 11. Metadata Extraction Queue

Metadata extraction must run asynchronously.

The queue implementation may use:

```text
BullMQ
Redis
```

The queue is responsible for:

- holding pending extraction work
- retry coordination
- worker concurrency control
- job execution state

Redis is not the permanent source of truth.

Anything important for long-term application correctness must be persisted in PostgreSQL.

---

# 12. Metadata Worker

The worker processes metadata extraction jobs.

Responsibilities:

```text
receive job
    ↓
validate target file
    ↓
run ffprobe
    ↓
parse output
    ↓
normalize selected fields
    ↓
persist result
```

The worker should process files independently.

One file failure must not terminate the entire scan.

---

# 13. FFprobe Adapter

ffprobe is an external system dependency and should be isolated behind a dedicated boundary.

Conceptually:

```text
MetadataExtractionService
        ↓
FFprobeAdapter
        ↓
ffprobe binary
```

Responsibilities of the adapter may include:

- command construction
- process execution
- timeout handling
- output capture
- exit-code interpretation
- JSON parsing
- low-level ffprobe error mapping

The rest of the application should not repeatedly construct ffprobe shell commands.

---

# 14. Metadata Normalization

Raw ffprobe output must not become the application domain model directly.

A normalization layer should translate raw output into TMIP metadata.

Conceptually:

```text
ffprobe JSON
    ↓
FFprobe Parser
    ↓
Normalized Metadata
    ↓
Persistence
```

Example normalized fields:

```text
duration
width
height
videoCodec
frameRate
audioCodec
sampleRate
audioChannels
```

Raw ffprobe data may also be preserved separately.

---

# 15. PostgreSQL

PostgreSQL is the persistent source of truth.

It stores application state such as:

- storage definitions
- media records
- scan jobs
- discovery state
- metadata state
- normalized metadata
- raw metadata
- processing errors
- timestamps
- status fields

The system must remain functional even if Redis queue data is lost, provided persisted state is intact and recoverable.

---

# 16. PostgreSQL + JSONB Strategy

TMIP uses a hybrid relational model.

Stable and frequently queried fields should use relational columns.

Example:

```text
filename
relativePath
fileSize
duration
videoCodec
width
height
frameRate
status
modifiedAt
```

Flexible metadata should use JSONB.

Example:

```text
technicalMetadata
rawProbeData
```

This allows metadata evolution without turning the entire data model into unstructured JSON.

---

# 17. Redis

Redis is an infrastructure dependency for temporary queue state.

Redis may store:

- pending jobs
- retry state
- active jobs
- BullMQ internal structures

Redis must not be treated as the long-term authoritative source for:

- media records
- metadata
- scan history
- file state
- source inventory

---

# 18. Scan Job Architecture

A scan should have a persistent identity.

Conceptually:

```text
ScanJob
- id
- storageId
- status
- startedAt
- completedAt
- discoveredCount
- newCount
- updatedCount
- unchangedCount
- missingCount
- queuedCount
- processedCount
- failedCount
```

Exact fields may evolve.

The scan job gives the system a durable representation of scan progress.

---

# 19. Scan Execution Flow

The expected flow is:

```text
User starts scan
    ↓
API creates ScanJob
    ↓
Scanner traverses storage
    ↓
Discovered files are compared with database state
    ↓
NEW / UPDATED
    ↓
metadata jobs queued
    ↓
UNCHANGED
    ↓
skip metadata extraction
    ↓
scan discovery phase completes
    ↓
workers process queued metadata
    ↓
scan counters update
    ↓
ScanJob completes
```

---

# 20. Missing File Detection

Missing detection must only occur after a storage scan has completed sufficiently to make the result meaningful.

Do not immediately mark records as missing while directory traversal is still incomplete.

Preferred strategy:

```text
scan starts
    ↓
known files retain previous state
    ↓
files discovered during current scan receive current observation marker
    ↓
discovery completes
    ↓
known files not observed in this scan
    ↓
mark MISSING
```

This avoids false missing states during traversal.

---

# 21. Observation Identity

Each scan should have an identifier that can be used to track whether a file was observed.

Example conceptual field:

```text
lastSeenScanId
```

or equivalent timestamp-based strategy.

A scan-specific marker is preferred when it improves reliability.

Example:

```text
Scan 102 starts

media A → lastSeenScanId = 102
media B → lastSeenScanId = 102
media C → not found

scan completes

all active records where:
lastSeenScanId != 102

→ candidates for MISSING
```

The exact implementation belongs in the data model.

---

# 22. File Identity Strategy

The initial logical file identity should use:

```text
storageId + relativePath
```

Filename alone is not sufficient.

Absolute infrastructure paths should not be the primary domain identity.

Example:

```text
Storage:
SERVER_B_MEDIA

Root:
 /media

Relative path:
 News/2026/September/news-001.mxf
```

This allows the storage mount location to change without invalidating logical media identity.

---

# 23. Change Detection Strategy

The initial file change signature should use inexpensive filesystem attributes.

Example:

```text
fileSize
modifiedAt
```

Conceptually:

```text
same storage
+
same relative path
+
same size
+
same modified time

→ UNCHANGED
```

If size or modified timestamp changes:

```text
→ UPDATED
```

This strategy may later evolve if real-world testing proves it insufficient.

---

# 24. Partial File Safety

The scanner may encounter files still being copied into Server B.

The architecture should allow future protection against processing incomplete files.

Possible future strategies may include:

- minimum age before processing
- size stability over time
- temporary file naming rules
- configurable settling period

TMIP v1 should not introduce complex file-settling logic unless real storage behavior requires it.

The design should avoid making such an addition difficult later.

---

# 25. Concurrency Architecture

Worker concurrency must be configurable.

Example:

```text
METADATA_WORKER_CONCURRENCY=2
```

Concurrency should be conservative initially.

The system should avoid assuming Server B can safely serve many simultaneous ffprobe reads.

Concurrency tuning must be based on actual:

- network performance
- storage performance
- production impact
- Server A capacity

---

# 26. Retry Architecture

Retry behavior belongs at the worker/job level.

Retries should be:

- finite
- configurable
- visible

Example conceptual flow:

```text
ffprobe fails
    ↓
classify error
    ↓
retry if transient
    ↓
retry limit reached
    ↓
persist failure
```

Do not create infinite retries.

---

# 27. Failure Isolation

Failure boundaries should isolate problems as much as practical.

A failure in:

```text
one media file
```

must not automatically fail:

```text
all other media jobs
```

A worker process failure should be recoverable through queue semantics where possible.

---

# 28. Application State vs Infrastructure State

Persisted application state belongs in PostgreSQL.

Examples:

```text
media exists
metadata extracted
metadata failed
file missing
scan completed
```

Infrastructure state may temporarily exist in Redis.

Examples:

```text
job waiting
job active
retry delay
worker lock
```

Do not confuse these two categories.

---

# 29. Recommended Repository Structure

A simple monorepo structure may be used.

Example:

```text
tmip/
├── apps/
│   ├── web/
│   ├── api/
│   └── worker/
│
├── packages/
│   ├── database/
│   ├── contracts/
│   └── shared/
│
├── docs/
│   └── ADR/
│
├── AGENTS.md
├── PRD.md
├── SCOPE.md
├── ARCHITECTURE.md
├── DATA_MODEL.md
├── WORKFLOWS.md
├── TESTING.md
│
├── docker-compose.yml
└── package.json
```

This structure is a recommendation, not an excuse to create unnecessary packages.

Only create shared packages when code is genuinely shared.

---

# 30. API and Worker Code Sharing

The API and worker may share:

- Prisma client
- domain types
- validation schemas
- metadata normalization code
- status enums
- common error types

Avoid copy-pasting business rules between processes.

At the same time, do not create overly generic shared frameworks.

---

# 31. Contracts

Shared API contracts may be defined using Zod where beneficial.

Examples:

```text
StartScanRequest
ScanStatusResponse
MediaListQuery
MediaDetailResponse
```

Avoid exposing raw database entities directly as long-term API contracts when doing so would create unnecessary coupling.

---

# 32. Configuration Architecture

Configuration should be centralized.

Examples:

```text
DATABASE_URL
REDIS_URL
MEDIA_ROOT
FFPROBE_PATH
METADATA_WORKER_CONCURRENCY
SUPPORTED_MEDIA_EXTENSIONS
API_PORT
WEB_PORT
```

Configuration values should be validated at startup.

Missing critical configuration should cause clear startup failure.

---

# 33. Docker Architecture

A practical v1 Docker Compose layout is:

```text
web
api
worker
postgres
redis
```

Example relationship:

```text
web
  ↓
api
  ↓
postgres

api
  ↓
redis

worker
  ↓
redis
worker
  ↓
postgres
worker
  ↓
/media
```

The API may also need read access to `/media` if scanning is performed in the API process.

If scan traversal becomes expensive or operationally cleaner as background work, scanning may later move to a dedicated worker.

Do not create an additional scanner service unless needed.

---

# 34. Scanner Deployment Decision

For initial implementation, the scanner may run inside the API application if:

- scan triggering is asynchronous
- filesystem traversal does not block the HTTP response
- implementation remains simple
- the API remains responsive

If this becomes problematic, scanner execution may be moved into background jobs.

This should be an evolutionary decision rather than a premature service split.

---

# 35. HTTP Request Boundary

Long-running work must never require the client to keep one HTTP connection open.

Bad:

```text
POST /scan

HTTP request waits 45 minutes
```

Preferred:

```text
POST /scan
    ↓
202 Accepted
    ↓
scanId returned
```

Then:

```text
GET /scans/:id
```

returns progress.

---

# 36. API Shape

Exact endpoints may evolve, but a simple shape may include:

```text
POST /scans
GET  /scans
GET  /scans/:id

GET  /media
GET  /media/:id
```

Potential retry endpoint may be added if required:

```text
POST /media/:id/retry
```

Do not expand the API surface unnecessarily.

---

# 37. Polling vs Realtime Updates

TMIP v1 does not require WebSocket or realtime infrastructure.

Scan progress may initially be retrieved using polling.

Example:

```text
GET /scans/:id
every few seconds
```

Realtime technologies should only be added if polling becomes insufficient.

---

# 38. Search Architecture

Basic inventory search should use PostgreSQL queries.

Initial search may include:

```text
filename
relativePath
codec
extension
status
```

Do not introduce external search engines in v1.

Out of scope:

```text
Elasticsearch
OpenSearch
vector databases
semantic retrieval
```

unless a later measured requirement justifies them.

---

# 39. Database Indexing

Indexes should be introduced based on actual query patterns.

Likely candidates may include:

```text
storageId + relativePath
status
videoCodec
extension
modifiedAt
```

Do not create excessive speculative indexes.

---

# 40. Security Boundary

TMIP is intended as an internal application.

Initial security requirements should focus on:

- no media write access
- safe path handling
- validated API inputs
- no shell injection
- no arbitrary command execution
- no arbitrary filesystem traversal outside configured roots

ffprobe commands must not be constructed using unsafe shell interpolation.

Prefer process-spawn APIs with argument arrays.

---

# 41. Path Traversal Safety

Any user-supplied or externally supplied path must not allow access outside configured storage roots.

The application should not expose arbitrary filesystem browsing.

Media records should reference known, validated storage-relative paths.

---

# 42. Shell Execution Safety

ffprobe execution must avoid shell string concatenation.

Bad conceptual example:

```text
"ffprobe " + userControlledPath
```

Preferred model:

```text
spawn(
  ffprobeBinary,
  [
    "-v",
    "quiet",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    mediaPath
  ]
)
```

The exact implementation may vary.

---

# 43. Logging Architecture

Logs should provide enough context for troubleshooting.

Useful identifiers include:

```text
scanId
mediaId
jobId
storageId
relativePath
```

Do not log sensitive credentials.

Avoid excessively verbose per-frame or per-packet logs.

---

# 44. Health Architecture

Basic service health may expose:

```text
API process alive
database reachable
Redis reachable
```

Storage availability may be reported separately because a temporary Server B outage should not necessarily mean the entire application process is unhealthy.

---

# 45. Migration Philosophy

Database migrations should be:

- explicit
- reviewable
- additive where practical
- safe for existing metadata

Avoid destructive schema changes unless clearly justified.

JSONB should be used where flexibility is useful, but not as an excuse to eliminate relational structure.

---

# 46. Future Extension Boundaries

The architecture should permit future capabilities without implementing them now.

Potential future additions may attach after the persisted technical metadata layer.

Conceptually:

```text
                 ┌───────────────┐
                 │ AI Analysis   │
                 └───────▲───────┘
                         │
DISCOVER → EXTRACT → PostgreSQL
                         │
                 ┌───────▼───────┐
                 │ Technical QC  │
                 └───────────────┘
```

Future systems should consume stable persisted media identity and metadata.

They should not require replacing the discovery pipeline.

---

# 47. Architecture Anti-Patterns

Avoid:

- scanning directly from frontend code
- ffprobe inside HTTP request handlers
- Redis as the only record of completed work
- hardcoded Server B paths throughout the codebase
- filename-only identity
- writing metadata files into source folders
- processing every file on every scan
- one giant service containing scanning, ffprobe, database logic, and UI concerns
- microservices for each small concern
- event-bus architecture without a real requirement
- raw ffprobe JSON being used everywhere
- modifying source media to simplify application state

---

# 48. Current Architecture Summary

The intended v1 architecture is:

```text
Server B
Video Storage
    │
    │ SMB / NFS
    ▼
Server A
Mounted Read-Only Storage
    │
    ▼
Docker
    │
    ├── Next.js Web
    │
    ├── Express API
    │      │
    │      ├── Scanner
    │      ├── Change Detection
    │      └── Scan Orchestration
    │
    ├── BullMQ / Redis
    │
    ├── Metadata Worker
    │      │
    │      ├── FFprobe Adapter
    │      └── Metadata Normalizer
    │
    └── PostgreSQL
```

---

# 49. Architectural Success Criteria

The architecture is successful if:

- Server B can be replaced or remounted without rewriting core media records
- new metadata fields can be added without major redesign
- unchanged files can be skipped efficiently
- failed files can be retried independently
- ffprobe implementation can change without rewriting business logic
- source media cannot be modified by normal application operation
- scan progress survives beyond a single HTTP request
- the application remains understandable by one developer
- future capabilities can attach to stable media records without replacing the core pipeline

---

# 50. Final Architecture Principle

Prefer:

```text
simple components
+
clear boundaries
+
persistent state
+
safe extension points
```

over:

```text
complex infrastructure
+
speculative abstraction
+
future features implemented early
```

TMIP v1 should be architected to evolve, but built only for the problem that exists today. 