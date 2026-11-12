# WORKFLOWS.md

## 1. Purpose

This document defines the runtime workflows and state transitions for TMIP v1.

Its goals are to:

- define how scans behave
- define how files move through the pipeline
- keep discovery separate from metadata extraction
- ensure repeated scans remain idempotent
- prevent premature or incorrect missing-file detection
- define failure and retry behavior
- provide consistent behavior across API, worker, and database layers

The main pipeline is:

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

---

# 2. Workflow Principles

All workflows must follow these principles:

1. Source media is read-only.
2. Discovery does not modify source files.
3. Discovery and metadata extraction are separate concerns.
4. Unchanged files should not be reprocessed.
5. One file failure must not stop the entire scan.
6. Scan completion must be based on explicit state.
7. Missing files must only be determined after successful discovery.
8. Repeated scans must not create duplicate media records.
9. Queue jobs may be retried safely.
10. PostgreSQL remains the persistent source of truth.
11. Redis remains temporary infrastructure state.
12. Long-running work must not remain inside one HTTP request.

---

# 3. High-Level Scan Workflow

The expected end-to-end scan flow is:

```text
User starts scan
    ↓
Create ScanJob
    ↓
Validate storage availability
    ↓
Start discovery
    ↓
Traverse storage recursively
    ↓
Discover supported media files
    ↓
Compare each discovered file with stored state
    ↓
Classify:
NEW / UNCHANGED / UPDATED
    ↓
Persist scan observations
    ↓
Queue metadata extraction for NEW / UPDATED
    ↓
Discovery completes
    ↓
Detect MISSING files
    ↓
Workers process queued metadata jobs
    ↓
Update scan progress
    ↓
Determine final ScanJob state
    ↓
Display result
```

---

# 4. Start Scan Workflow

## Trigger

The user initiates a scan manually.

Example API:

```text
POST /scans
```

Expected behavior:

```text
request received
    ↓
validate request
    ↓
validate storage exists and is enabled
    ↓
check whether a conflicting scan is already active
    ↓
create ScanJob
    ↓
start asynchronous scan execution
    ↓
return scan identifier
```

The HTTP request must not wait for the full scan to complete.

---

# 5. Scan Creation

A new scan should initially use:

```text
status = PENDING
```

Before discovery begins:

```text
status = RUNNING
startedAt = current time
```

Initial counters should be zero.

Example:

```text
discoveredCount = 0
newCount = 0
updatedCount = 0
unchangedCount = 0
missingCount = 0
queuedCount = 0
processedCount = 0
failedCount = 0
```

---

# 6. Concurrent Scan Policy

TMIP should avoid multiple simultaneous scans of the same storage unless there is a proven operational need.

Preferred v1 behavior:

```text
Storage A has RUNNING scan
        ↓
new scan requested for Storage A
        ↓
reject or return existing active scan
```

A scan against another independent storage may be allowed if future requirements justify it.

Do not introduce complex scan concurrency coordination prematurely.

---

# 7. Storage Availability Check

Before recursive discovery begins, TMIP must verify that the configured storage root is accessible.

Checks may include:

```text
path exists
path is readable
path is a directory
```

If the storage root is unavailable:

```text
ScanJob.status = FAILED
```

and the scan must stop.

Important:

> A storage-level failure must not mark all known media files as MISSING.

Missing detection only occurs after discovery completes successfully.

---

# 8. Discovery Workflow

The scanner recursively traverses the configured storage root.

Conceptually:

```text
storage root
    ↓
directory
    ↓
child entries
    ↓
directory?
    ├── yes → recurse
    └── no
         ↓
       file?
         ↓
 supported extension?
    ├── no → ignore
    └── yes → process discovery
```

The scanner must not execute ffprobe directly.

---

# 9. Unsupported Files

Files with unsupported extensions should normally be ignored.

Example:

```text
/media/document.pdf
/media/readme.txt
/media/image.jpg
```

They should not create `MediaFile` records unless future scope explicitly requires non-video assets.

Unsupported files should not be treated as errors.

---

# 10. Discovered File Input

For each discovered candidate file, collect at minimum:

```text
storageId
relativePath
filename
extension
fileSize
modifiedAt
```

These values form the input for change detection.

---

# 11. Change Detection Workflow

For each discovered file:

```text
lookup MediaFile by:
storageId + relativePath
```

Then classify.

---

# 12. NEW File Workflow

Condition:

```text
no existing MediaFile
for storageId + relativePath
```

Behavior:

```text
file discovered
    ↓
create MediaFile
    ↓
status = ACTIVE
metadataStatus = PENDING
    ↓
set:
firstSeenAt
lastSeenAt
lastSeenScanId
    ↓
store filesystem attributes
    ↓
create ScanItem with NEW
    ↓
queue metadata extraction
    ↓
increment:
discoveredCount
newCount
queuedCount
```

The file must not be probed synchronously during discovery.

---

# 13. UNCHANGED File Workflow

Condition:

```text
existing media record
+
same fileSize
+
same modifiedAt
```

Behavior:

```text
file discovered
    ↓
classify UNCHANGED
    ↓
update:
lastSeenAt
lastSeenScanId
status = ACTIVE
    ↓
create ScanItem with UNCHANGED
    ↓
do NOT queue ffprobe
    ↓
increment:
discoveredCount
unchangedCount
```

`lastMetadataExtractedAt` must not change.

---

# 14. UPDATED File Workflow

Condition:

```text
existing media record
+
fileSize changed
OR
modifiedAt changed
```

Behavior:

```text
file discovered
    ↓
classify UPDATED
    ↓
update filesystem attributes
    ↓
status = ACTIVE
metadataStatus = PENDING
    ↓
update:
lastSeenAt
lastSeenScanId
    ↓
create ScanItem with UPDATED
    ↓
queue metadata extraction
    ↓
increment:
discoveredCount
updatedCount
queuedCount
```

Existing metadata may remain visible until replacement metadata succeeds, depending on UI policy.

Do not erase previously valid metadata before a new extraction succeeds.

---

# 15. Preserve Last Known Good Metadata

When an UPDATED file is detected:

```text
existing valid metadata
```

should not necessarily be cleared immediately.

Preferred behavior:

```text
metadataStatus = PENDING
```

while keeping the last known successful metadata.

After successful extraction:

```text
replace current metadata
metadataStatus = READY
```

If extraction fails:

```text
metadataStatus = FAILED
```

but previous metadata may remain stored as the last known successful result.

The UI should clearly distinguish current extraction state from previously stored metadata when necessary.

---

# 16. Discovery Observation

Every successfully discovered file should receive:

```text
lastSeenScanId = currentScanId
lastSeenAt = current time
```

This is critical for safe missing-file detection.

---

# 17. Discovery Completion

Discovery is complete only after:

- recursive traversal finishes
- all discovered supported files have been classified
- scan observations have been persisted
- fatal traversal errors have been evaluated

Then:

```text
discoveryCompletedAt = current time
```

Only after this point may missing detection begin.

---

# 18. Partial Discovery Failure

If discovery cannot reliably complete because of a storage-level failure, such as:

- network storage disconnect
- root mount disappears
- permission suddenly denied across storage
- fatal traversal failure

then the scan must not perform missing detection.

Preferred behavior:

```text
ScanJob = FAILED
```

or another explicit incomplete state if later introduced.

Do not infer that unseen files are missing when discovery itself was incomplete.

---

# 19. MISSING File Detection Workflow

After successful discovery:

```text
find MediaFile records where:
storageId = current storage
status = ACTIVE
lastSeenScanId != currentScanId
```

These become missing candidates.

For each valid missing candidate:

```text
status = MISSING
```

Optionally:

```text
create ScanItem
discoveryState = MISSING
```

Increment:

```text
missingCount
```

Do not delete the record.

---

# 20. File Reappearance Workflow

If a previously MISSING file appears again at the same:

```text
storageId + relativePath
```

reuse the existing `MediaFile`.

Then compare filesystem state.

Possible cases:

```text
same size + same modifiedAt
→ ACTIVE
→ normally no extraction required
```

or:

```text
changed size / modifiedAt
→ ACTIVE
→ UPDATED
→ queue extraction
```

Do not create a second media record.

---

# 21. Metadata Queue Workflow

NEW and UPDATED files should create metadata extraction work.

Conceptually:

```text
MediaFile
    ↓
MetadataExtraction record
    ↓
BullMQ job
    ↓
Worker
```

Persist important application state before or alongside queue creation.

Do not rely solely on Redis to remember that extraction is required.

---

# 22. Queue Job Payload

Keep queue payloads small.

Preferred payload:

```text
metadataExtractionId
mediaFileId
scanJobId
```

Avoid placing entire ffprobe results or large metadata blobs in Redis job payloads.

The worker should load authoritative state from PostgreSQL.

---

# 23. Metadata Extraction Creation

Before queueing, create a persistent extraction record.

Example:

```text
status = PENDING
sourceFileSize = current file size
sourceModifiedAt = current modified timestamp
attemptNumber = 1
```

This helps detect stale jobs later.

---

# 24. Worker Start Workflow

When the worker receives a job:

```text
load MetadataExtraction
    ↓
load MediaFile
    ↓
validate record state
    ↓
set extraction = PROCESSING
metadataStatus = PROCESSING
startedAt = now
```

Then resolve the actual media path from:

```text
Storage.rootPath
+
MediaFile.relativePath
```

---

# 25. Worker File Validation

Before running ffprobe, validate that:

```text
file exists
file is readable
file is still within configured storage root
```

Optionally re-read:

```text
fileSize
modifiedAt
```

and compare them with the source state captured when the job was created.

---

# 26. Stale Job Detection

A job may become stale if the file changes after discovery but before processing.

Example:

```text
scan detects:
size = A
modifiedAt = T1

job waits in queue

file replaced

worker sees:
size = B
modifiedAt = T2
```

The worker should not blindly save metadata from an outdated assumption.

Preferred behavior:

```text
detected source state mismatch
    ↓
do not treat old job as authoritative
    ↓
mark current extraction as stale/cancelled/failed with clear reason
    ↓
queue fresh extraction if appropriate
```

The exact status name may be kept simple in v1.

The important rule is:

> Do not persist metadata as current if the source file changed during processing.

---

# 27. File Changes During ffprobe

A file may change while ffprobe is running.

When practical, compare source attributes again after extraction.

Conceptually:

```text
stat before
    ↓
ffprobe
    ↓
stat after
```

If size or modified time changed:

```text
result may be stale
```

Do not commit it as current metadata without reprocessing.

This behavior may be implemented when real-world file-copy behavior makes it necessary.

---

# 28. FFprobe Workflow

Expected execution:

```text
worker
    ↓
FFprobeAdapter
    ↓
ffprobe process
    ↓
JSON output
    ↓
validate JSON
    ↓
MetadataNormalizer
```

ffprobe should use safe process execution with argument arrays.

Do not build unsafe shell strings.

---

# 29. Metadata Normalization Workflow

Raw ffprobe output should be transformed into:

```text
normalized stable fields
+
flexible technicalMetadata JSONB
+
rawProbeData JSONB
```

Example:

```text
codec_name
→ videoCodec

width
→ width

height
→ height

r_frame_rate
→ frame rate representation
```

Normalization logic must live in one clear boundary.

Do not spread ffprobe field interpretation throughout the application.

---

# 30. Successful Metadata Extraction

On success:

```text
persist normalized metadata
    ↓
persist flexible metadata
    ↓
persist latest raw probe data
    ↓
metadataStatus = READY
    ↓
lastMetadataExtractedAt = now
    ↓
MetadataExtraction.status = SUCCEEDED
completedAt = now
```

Update relevant scan counters.

Example:

```text
processedCount += 1
```

---

# 31. Failed Metadata Extraction

If ffprobe or normalization fails:

```text
MetadataExtraction.status = FAILED
metadataStatus = FAILED
```

Persist:

```text
errorCode
errorMessage
completedAt
```

Increment:

```text
failedCount
processedCount
```

where `processedCount` represents completed extraction attempts, not only successful ones.

The exact counter semantics must remain documented and consistent.

---

# 32. Failure Isolation

A failed extraction must not:

- terminate the worker process unnecessarily
- fail unrelated jobs
- cancel the entire scan automatically

Example:

```text
100 extraction jobs

98 succeed
2 fail
```

The expected scan result is:

```text
COMPLETED_WITH_ERRORS
```

not necessarily:

```text
FAILED
```

---

# 33. Retry Workflow

Retries should apply only when appropriate.

Potentially transient failures:

```text
temporary file access failure
temporary network interruption
ffprobe timeout
temporary storage unavailability
```

Likely permanent failures:

```text
corrupt media
unsupported format
invalid media structure
```

Retry behavior:

```text
failure occurs
    ↓
classify retry eligibility
    ↓
retryable?
    ├── yes → retry within configured limit
    └── no → final FAILED
```

Retries must be finite.

---

**Status: implemented (Phase 12).** See `docs/plans/004-failure-classification-bounded-retry.md` and `ADR/ADR-005-bounded-extraction-retry.md`. A failure is classified by its `errorCode` (fail-closed: anything unrecognized is PERMANENT). Only TRANSIENT failures retry automatically, up to `METADATA_MAX_RETRIES` extra attempts (config default 2; `0` disables retry), with bounded exponential backoff (`METADATA_RETRY_BACKOFF_MS`, default 250 ms, capped at 5 s). The retry loop wraps the whole attempt (validate → probe → normalise) and runs inside the same worker; the row stays `PROCESSING` between attempts, so no scan or reprocess can claim the same file concurrently. The retry count is persisted as `MediaFile.retryCount` (reset to 0 on every fresh claim and on success). After the bound is exhausted the last failure is persisted exactly as §31 and the scan counters are incremented once per claim. Manual reprocessing (§52) still works and resets `retryCount`.

---

# 34. Retry Attempt Tracking

Each attempt should be distinguishable.

Possible approaches:

```text
one MetadataExtraction row
with attemptNumber updates
```

or:

```text
one MetadataExtraction row per attempt
```

The implementation should favor whichever keeps debugging and code simplest.

Do not build a complex retry audit model unless needed.

---

**Status: implemented (Phase 12).** The simplest option was chosen: retries are tracked with a single additive `MediaFile.retryCount` column (`DATA_MODEL.md §47`), not a new attempt-history entity. The bound itself comes from configuration, and intermediate attempts are visible through `retryCount` while the row remains `PROCESSING`.

---

# 35. Scan Progress Workflow

The UI should be able to request scan progress independently from worker execution.

Example:

```text
GET /scans/:id
```

Response may include:

```text
status
discoveredCount
newCount
updatedCount
unchangedCount
missingCount
queuedCount
processedCount
failedCount
startedAt
completedAt
```

Initial implementation may use polling.

---

# 36. Scan Completion Conditions

A scan should not be marked complete immediately when directory traversal finishes if metadata work is still pending.

Conceptually, completion requires:

```text
discovery completed
AND
all metadata jobs created by this scan have reached terminal state
```

Terminal metadata states:

```text
SUCCEEDED
FAILED
```

Then evaluate final scan state.

---

# 37. Successful Scan Completion

If:

```text
discovery completed successfully
AND
all extraction jobs completed
AND
failedCount = 0
```

then:

```text
ScanJob.status = COMPLETED
completedAt = now
```

---

# 38. Completed With Errors

If:

```text
discovery completed successfully
AND
all metadata jobs reached terminal state
AND
one or more file-level extraction failures exist
```

then:

```text
ScanJob.status = COMPLETED_WITH_ERRORS
completedAt = now
```

This means the scan itself worked but some media could not be processed.

---

# 39. Failed Scan

Use:

```text
FAILED
```

for scan-level failures that prevent reliable completion.

Examples:

- storage root inaccessible before scanning
- fatal scanner crash
- database failure preventing scan state persistence
- discovery aborted before reliable missing detection
- unrecoverable orchestration failure

Individual corrupt media files should not normally produce scan-level `FAILED`.

---

# 40. Zero New File Scan

A scan may legitimately discover:

```text
newCount = 0
updatedCount = 0
```

Example:

```text
23,000 discovered
23,000 unchanged
0 queued
```

Expected behavior:

```text
discovery completes
missing detection runs
no metadata jobs exist
ScanJob = COMPLETED
```

This is a successful scan.

---

# 41. First-Ever Scan

On first scan:

```text
database inventory is empty
```

Therefore all supported discovered files are:

```text
NEW
```

Potential consequence:

A very large number of ffprobe jobs may be generated.

The system should respect configured concurrency.

Do not launch all ffprobe processes simultaneously.

---

# 42. Large Initial Scan

For a large first scan:

```text
discovery
→ persist records incrementally
→ queue jobs incrementally
```

Do not require the entire filesystem listing to fit into memory before processing.

Avoid collecting all file paths into one giant in-memory array when streaming or batched processing is practical.

---

# 43. Database Transaction Boundaries

Do not wrap an entire storage scan in one database transaction.

A long-running transaction across thousands of files would create unnecessary risk.

Prefer small atomic operations or sensible batches.

Important atomic operations may include:

```text
upsert MediaFile
+
create ScanItem
+
update relevant counters
```

Exact transaction design should balance correctness and simplicity.

---

# 44. Duplicate Discovery Protection

Filesystem traversal must not create duplicate scan records for the same media.

Database uniqueness constraints should support:

```text
UNIQUE(scanJobId, mediaFileId)
```

Repeated processing of the same discovered path should remain safe.

---

# 45. Queue Duplicate Protection

A NEW or UPDATED media file should not receive uncontrolled duplicate extraction jobs from the same scan.

Possible mechanisms may include:

```text
deterministic job ID
persistent extraction state
database uniqueness
```

Use the simplest reliable strategy supported by BullMQ and PostgreSQL.

---

# 46. Application Restart During Scan

A scan may be interrupted by:

- Server A restart
- Docker restart
- API restart
- worker restart

Important state must remain recoverable because it is persisted in PostgreSQL.

After restart, the system should not silently treat an interrupted scan as completed.

Possible recovery strategy:

```text
RUNNING scan found after restart
    ↓
inspect state
    ↓
resume recoverable work
or
mark scan failed/interrupted
```

Initial implementation may choose the simpler explicit failure approach.

Do not build complex automatic resume behavior until needed.

---

# 47. Redis Loss

Redis queue data may theoretically be lost.

This must not erase the authoritative media inventory.

Because PostgreSQL stores:

```text
MediaFile
ScanJob
MetadataExtraction
```

the system should retain enough information to identify incomplete work.

Full automatic queue reconstruction is optional in v1.

The architecture must not make reconstruction impossible.

---

# 48. Media Detail Workflow

When the user opens a media detail page:

```text
UI
    ↓
GET /media/:id
    ↓
API
    ↓
PostgreSQL
```

The API may return:

```text
file identity
filesystem attributes
presence status
metadata status
normalized metadata
technicalMetadata
relevant failure information
observation timestamps
```

Do not run ffprobe merely because a detail page was opened.

---

# 49. Media List Workflow

The media list reads persisted metadata.

It must not scan storage on every page load.

Flow:

```text
UI request
    ↓
API query
    ↓
PostgreSQL
    ↓
paginated media response
```

Filesystem access belongs to explicit scan operations, not normal inventory browsing.

---

# 50. Basic Search Workflow

Search should query PostgreSQL.

Example:

```text
user searches "news"
    ↓
API validates query
    ↓
database searches known media records
    ↓
return paginated results
```

Do not traverse Server B to answer normal search requests.

---

# 51. Manual Retry Workflow

A failed media extraction may later support manual retry.

Conceptually:

```text
user retries media
    ↓
validate media exists
    ↓
create new extraction attempt
    ↓
queue job
    ↓
worker processes file
```

This is acceptable if required by v1 usability.

Do not implement complex bulk retry tools unless requested.

---

# 52. Manual Reprocess Workflow

If explicitly supported, a user may request metadata extraction even when a file is unchanged.

Flow:

```text
user requests reprocess
    ↓
create extraction attempt
    ↓
queue metadata job
```

This is different from a normal incremental scan.

Normal scans must still skip unchanged files.

---

**Status: implemented (Phase 11).** `POST /media/:id/reprocess` atomically claims a `READY` or `FAILED` file as `PROCESSING` (a file already `PENDING` or `PROCESSING` returns `409 Conflict`), detaches the extraction, and the client polls `GET /media/:id` until the terminal `READY`/`FAILED` state. The reprocess reuses the existing extraction core, so a successful attempt clears the previous error fields and a failed attempt records a new failure while keeping the last known good metadata. Reprocess is not a scan: it does not increment `ScanJob` counters, does not write `lastSeenScanId`, and does not re-discover files. If the process is interrupted mid-reprocess, `sweepInterruptedState` marks the row `FAILED`/`INTERRUPTED` and it can simply be reprocessed again. Automatic retry of transient failures is added by Phase 12 (`WORKFLOWS.md §33`, `ADR-005`) and applies to reprocess attempts too; the reprocess claim resets `retryCount`. See `ADR/ADR-004-metadata-reprocessing.md`.

---

# 53. Scheduled Scanning

Scheduled scanning is deferred.

When added later, it should invoke the same scan orchestration used by manual scans.

Avoid creating separate scan logic such as:

```text
manual scanner
scheduled scanner
```

Both should call the same underlying scan service.

---

# 54. Future File Settling Workflow

Files may be discovered while still being copied.

If real-world testing shows this happens frequently, a future settling workflow may be added.

Possible design:

```text
file discovered
    ↓
check age / stability
    ↓
stable?
    ├── no → defer
    └── yes → classify and process
```

Do not implement this until required.

The current architecture must remain compatible with it.

---

# 55. Future Multiple Storage Workflow

If multiple storage locations are introduced later, scanning should remain storage-scoped.

Conceptually:

```text
ScanJob belongs to one Storage
```

Avoid one global scan mixing unrelated storage roots unless a future requirement explicitly needs it.

---

# 56. Workflow Observability

Important operations should include identifiers in logs.

Recommended context:

```text
scanId
storageId
mediaFileId
metadataExtractionId
relativePath
```

Example logical event:

```text
metadata extraction failed
scanId = ...
mediaFileId = ...
relativePath = ...
errorCode = ...
```

This is sufficient for operational troubleshooting without building a separate analytics system.

---

# 57. State Transition Summary

## ScanJob

```text
PENDING
    ↓
RUNNING
    ├──→ COMPLETED
    ├──→ COMPLETED_WITH_ERRORS
    └──→ FAILED
```

---

## MediaFile Presence

```text
ACTIVE
    ↓
MISSING
    ↓
ACTIVE
```

A file may return after being missing.

---

## Metadata Status

```text
PENDING
    ↓
PROCESSING
    ├──→ READY
    └──→ FAILED
```

A failed item may later return to:

```text
PENDING
→ PROCESSING
→ READY
```

through retry.

Within a single `PROCESSING` claim, a transient failure may retry automatically (Phase 12) before the terminal `READY`/`FAILED`; the row remains `PROCESSING` for the whole retry sequence (`WORKFLOWS.md §33`, `ADR-005`).

---

## ScanItem Discovery State

```text
NEW
UNCHANGED
UPDATED
MISSING
```

These values describe one scan observation and are not a permanent media lifecycle.

---

# 58. End-to-End Acceptance Workflow

The minimum full workflow that must be verified is:

```text
Video A exists on Server B
    ↓
User starts Scan 1
    ↓
Video A discovered
    ↓
Video A classified NEW
    ↓
Metadata extraction queued
    ↓
Worker runs ffprobe
    ↓
Metadata stored
    ↓
Video A visible in UI
    ↓
Scan 1 COMPLETED
```

Then:

```text
User starts Scan 2
    ↓
Video A discovered
    ↓
same size
same modifiedAt
    ↓
UNCHANGED
    ↓
ffprobe skipped
    ↓
Scan 2 COMPLETED
```

Then modify Video A:

```text
User starts Scan 3
    ↓
Video A discovered
    ↓
source attributes changed
    ↓
UPDATED
    ↓
metadata extraction queued
    ↓
new metadata stored
    ↓
Scan 3 COMPLETED
```

Then remove Video A:

```text
User starts Scan 4
    ↓
discovery completes
    ↓
Video A not observed
    ↓
status = MISSING
    ↓
record remains in database
```

Then return Video A:

```text
User starts Scan 5
    ↓
same logical path discovered
    ↓
existing MediaFile reused
    ↓
status = ACTIVE
```

This sequence defines the core behavioral contract of TMIP v1.

---

# 59. Workflow Anti-Patterns

Do not implement:

```text
scan
→ immediately run ffprobe inline
→ wait before continuing discovery
```

if doing so unnecessarily serializes the whole pipeline.

Do not implement:

```text
page load
→ scan filesystem
```

Do not implement:

```text
file missing during traversal
→ immediately mark MISSING
```

Do not implement:

```text
ffprobe failed for one file
→ abort entire scan
```

Do not implement:

```text
every scan
→ re-run ffprobe for every known file
```

Do not implement:

```text
Redis job state
→ only evidence that metadata processing happened
```

Do not implement:

```text
UPDATED file
→ delete last known good metadata before new extraction succeeds
```

---

# 60. Final Workflow Principle

Prefer:

```text
observe
→ compare
→ persist state
→ process only what changed
→ isolate failures
→ expose progress
```

over:

```text
rescan everything
→ reprocess everything
→ overwrite state
→ fail as one large operation
```

TMIP v1 should behave like a reliable inventory pipeline, not a one-time batch script.