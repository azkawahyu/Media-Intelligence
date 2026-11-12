# DATA_MODEL.md

## 1. Purpose

This document defines the core data model for TMIP v1.

Its goals are to:

- provide stable identities for discovered media
- support incremental scanning
- preserve technical metadata
- allow metadata growth without major schema redesign
- separate stable relational data from flexible metadata
- preserve enough history for troubleshooting
- avoid destructive assumptions about source media

The data model should favor additive evolution.

---

# 2. Data Modeling Principles

TMIP uses PostgreSQL as the source of truth.

The data model should follow these principles:

1. Stable and frequently queried fields belong in relational columns.
2. Flexible or format-specific metadata belongs in JSONB.
3. Raw ffprobe output may be preserved separately.
4. Media identity must not depend on filename alone.
5. Source media records must not be deleted automatically when files disappear.
6. Scan state must be explicit and queryable.
7. Schema evolution should prefer additive changes.
8. Operational state and metadata state should remain distinguishable.
9. Infrastructure paths should not become permanent business identifiers.

---

# 3. Core Entities

TMIP v1 should use the following core entities:

```text
Storage
MediaFile
ScanJob
ScanItem
MetadataExtraction
```

Optional additional entities may be introduced later if a concrete requirement appears.

Do not create additional entities preemptively.

---

# 4. Entity Relationship Overview

Conceptually:

```text
Storage
   │
   │ 1
   │
   └───────────────< MediaFile
                         │
                         │
                         ├──────────────< MetadataExtraction
                         │
                         │
                         └──────────────< ScanItem
                                              │
                                              │
ScanJob >─────────────────────────────────────┘
```

Relationships:

```text
Storage
1 → many MediaFile

Storage
1 → many ScanJob

ScanJob
1 → many ScanItem

MediaFile
1 → many ScanItem

MediaFile
1 → many MetadataExtraction
```

---

# 5. Storage

## Purpose

Represents one logical media storage location.

A storage record separates business identity from infrastructure-specific mount paths.

Example:

```text
name:
Server B Media

rootPath:
/media
```

If Server A later mounts Server B somewhere else, the storage configuration may change without rewriting every media record.

---

## Suggested Fields

```text
Storage

id
name
rootPath
enabled
createdAt
updatedAt
```

Optional fields may include:

```text
description
```

Do not add protocol-specific fields unless the application truly needs to manage storage connections itself.

---

## Example

```json
{
  "id": "storage_01",
  "name": "Server B Media",
  "rootPath": "/media",
  "enabled": true
}
```

---

# 6. Storage Identity

`Storage.id` must remain stable even if:

```text
/mnt/tmip-media
```

later becomes:

```text
/mnt/server-b-media
```

or the container mount changes.

Media identity must use:

```text
storageId + relativePath
```

not:

```text
absolute filesystem path
```

---

# 7. MediaFile

## Purpose

Represents one logical media file known to TMIP.

This is the primary inventory entity.

A `MediaFile` record may continue to exist even when the source file is temporarily missing.

---

# 8. MediaFile Identity

The preferred logical identity is:

```text
storageId + relativePath
```

This pair should be unique.

Conceptually:

```text
UNIQUE(storageId, relativePath)
```

Example:

```text
storageId:
storage_01

relativePath:
News/2026/September/news-001.mxf
```

Do not use filename alone as a unique identifier.

---

# 9. MediaFile Suggested Fields

Core identity:

```text
id
storageId
relativePath
filename
extension
```

Filesystem state:

```text
fileSize
modifiedAt
```

Inventory state:

```text
status
firstSeenAt
lastSeenAt
lastSeenScanId
```

Metadata state:

```text
metadataStatus
lastMetadataExtractedAt
```

Frequently queried technical metadata:

```text
durationSeconds
videoCodec
videoCodecProfile
width
height
frameRate
videoBitRate
pixelFormat
fieldOrder
audioCodec
audioSampleRate
audioChannels
audioBitRate
containerFormat
```

Flexible metadata:

```text
technicalMetadata JSONB
rawProbeData JSONB
```

Operational fields:

```text
createdAt
updatedAt
```

Not every suggested technical field must be implemented immediately.

Only promote fields into relational columns when they are useful to current product behavior.

---

# 10. Media Status

Suggested `MediaFile.status` values:

```text
ACTIVE
MISSING
```

The status should represent whether the file is currently observed in storage.

Avoid using too many meanings in one status field.

For example:

```text
FAILED
```

should not be a media presence status.

Metadata extraction failure belongs in `metadataStatus`.

---

# 11. Metadata Status

Suggested values:

```text
PENDING
PROCESSING
READY
FAILED
```

Possible behavior:

```text
NEW file
→ PENDING

worker starts
→ PROCESSING

successful extraction
→ READY

failed extraction
→ FAILED
```

An unchanged file with previously valid metadata remains:

```text
READY
```

---

# 12. Discovery Classification vs Persisted State

The following values:

```text
NEW
UNCHANGED
UPDATED
MISSING
```

represent the result of a particular scan comparison.

They should not necessarily become the permanent `MediaFile.status`.

This distinction is important.

Example:

```text
MediaFile.status = ACTIVE

ScanItem.discoveryState = UPDATED
```

This says:

> The media file currently exists, and during this scan it was detected as changed.

---

# 13. Why Scan State Should Be Separate

If `NEW`, `UPDATED`, and `UNCHANGED` are stored directly as the permanent media status, the meaning becomes unclear after multiple scans.

Example:

```text
Scan 1:
NEW

Scan 2:
UNCHANGED

Scan 3:
UNCHANGED
```

The file itself is simply:

```text
ACTIVE
```

The scan result belongs to the specific scan.

Therefore:

```text
MediaFile
→ current inventory state

ScanItem
→ observation during a particular scan
```

---

# 14. ScanJob

## Purpose

Represents one execution of a storage scan.

The scan job is the durable parent record for scan progress and results.

---

# 15. ScanJob Suggested Fields

```text
id
storageId
status
startedAt
discoveryCompletedAt
completedAt
```

Counters:

```text
discoveredCount
newCount
updatedCount
unchangedCount
missingCount
queuedCount
processedCount
failedCount
```

Optional error state:

```text
errorMessage
```

Operational fields:

```text
createdAt
updatedAt
```

---

# 16. ScanJob Status

Suggested values:

```text
PENDING
RUNNING
COMPLETED
COMPLETED_WITH_ERRORS
FAILED
```

Possible lifecycle:

```text
PENDING
    ↓
RUNNING
    ↓
COMPLETED
```

or:

```text
RUNNING
    ↓
COMPLETED_WITH_ERRORS
```

or:

```text
RUNNING
    ↓
FAILED
```

---

# 17. Scan Failure Meaning

`FAILED` should normally mean the scan itself could not complete meaningfully.

Examples:

- storage root unavailable
- permission denied at root
- database failure preventing scan operation
- unrecoverable scanner failure

Individual media extraction failures should not automatically make the entire scan `FAILED`.

They may instead result in:

```text
COMPLETED_WITH_ERRORS
```

---

# 18. ScanItem

## Purpose

Represents how one media file was observed during one scan.

This preserves the distinction between current media state and scan-specific state.

---

# 19. ScanItem Suggested Fields

```text
id
scanJobId
mediaFileId
discoveryState
fileSize
modifiedAt
observedAt
metadataQueued
createdAt
```

Possible `discoveryState` values:

```text
NEW
UNCHANGED
UPDATED
MISSING
```

---

# 20. ScanItem Uniqueness

A media file should generally appear only once per scan.

Conceptually:

```text
UNIQUE(scanJobId, mediaFileId)
```

This helps ensure scan idempotency.

---

# 21. Missing Scan Items

A missing media record may still receive a `ScanItem` entry with:

```text
discoveryState = MISSING
```

if maintaining explicit per-scan history is useful.

Alternatively, missing state may be derived and persisted only on `MediaFile`.

The preferred implementation should be chosen based on simplicity.

If `ScanItem` is already used for all other states, explicit `MISSING` entries provide a consistent history model.

---

# 22. MetadataExtraction

## Purpose

Represents one attempt to extract technical metadata from a media file.

This entity separates extraction history from the current normalized metadata stored on `MediaFile`.

---

# 23. Why Extraction History Is Useful

A media file may be processed multiple times because:

- it is new
- it changed
- a previous extraction failed
- a retry occurred
- the user explicitly requested reprocessing

Without extraction history, debugging becomes harder.

Example:

```text
Attempt 1
FAILED

Attempt 2
READY
```

The current media record should show successful current metadata, while history preserves the failure.

---

# 24. MetadataExtraction Suggested Fields

```text
id
mediaFileId
scanJobId
status
attemptNumber
startedAt
completedAt
```

Input state:

```text
sourceFileSize
sourceModifiedAt
```

Result:

```text
rawProbeData JSONB
```

Failure details:

```text
errorCode
errorMessage
```

Operational:

```text
createdAt
```

Possible status values:

```text
PENDING
PROCESSING
SUCCEEDED
FAILED
```

---

# 25. Current Metadata vs Extraction History

Current useful metadata should live on `MediaFile`.

Example:

```text
MediaFile.videoCodec = "mpeg2video"
MediaFile.durationSeconds = 1800
```

Extraction history belongs in `MetadataExtraction`.

Example:

```text
Extraction #1
FAILED

Extraction #2
SUCCEEDED
```

This prevents normal UI queries from requiring history traversal.

---

# 26. Raw Metadata Strategy

There are two useful levels of metadata storage.

## Current Flexible Metadata

Stored on:

```text
MediaFile.technicalMetadata
```

Purpose:

- store normalized but flexible technical properties
- make current metadata easy to access

Example:

```json
{
  "color": {
    "space": "bt709",
    "transfer": "bt709",
    "primaries": "bt709"
  },
  "timecode": "10:00:00:00"
}
```

---

## Raw Probe Metadata

Stored as:

```text
MediaFile.rawProbeData
```

and/or:

```text
MetadataExtraction.rawProbeData
```

Purpose:

- preserve original ffprobe result
- support debugging
- allow later metadata normalization improvements

The exact duplication strategy should avoid unnecessary storage waste.

---

# 27. Recommended Raw Metadata Approach

For v1, prefer:

```text
MediaFile.rawProbeData
→ latest successful raw ffprobe result
```

and optionally:

```text
MetadataExtraction.rawProbeData
→ retain per-attempt raw output only when needed
```

If raw output is large, avoid duplicating successful probe data unnecessarily.

A practical approach is:

```text
successful extraction
→ current raw JSON stored on MediaFile

failed extraction
→ error details stored on MetadataExtraction
```

Full historical raw metadata can be added later if a real requirement emerges.

---

# 28. Stable Columns vs JSONB

A field should usually become a relational column when it is:

- frequently filtered
- frequently sorted
- frequently displayed
- used in application logic
- used for indexing
- conceptually stable

Examples:

```text
durationSeconds
videoCodec
width
height
frameRate
status
```

---

A field should usually remain in JSONB when it is:

- rare
- highly format-specific
- unstable
- experimental
- deeply nested
- not used for common queries

Examples:

```text
MXF operational pattern
stream tags
color side data
vendor-specific metadata
rare codec-specific flags
```

---

# 29. Metadata Promotion Strategy

A flexible field may later be promoted from JSONB into a relational column.

Example:

Initially:

```json
{
  "colorSpace": "bt709"
}
```

stored inside:

```text
technicalMetadata
```

Later, if users frequently filter by color space:

```text
MediaFile.colorSpace
```

may be added.

Migration approach:

```text
1. add nullable relational column
2. populate from existing JSONB
3. update extraction normalization
4. add index if justified
5. optionally keep raw JSON field unchanged
```

This is an additive change.

---

# 30. Frame Rate Representation

Frame rates should avoid lossy floating-point representation where practical.

ffprobe may return values such as:

```text
25/1
30000/1001
```

A simple v1 approach may store:

```text
frameRateNumerator
frameRateDenominator
```

or:

```text
frameRate
```

as a normalized decimal/string if application needs are simple.

If accurate broadcast frame-rate distinctions matter, prefer rational representation.

Do not silently convert:

```text
30000/1001
```

into an imprecise conceptual:

```text
30
```

---

# 31. Duration Representation

Prefer numeric seconds for normalized duration.

Example:

```text
durationSeconds = 1832.52
```

UI formatting may convert this into:

```text
00:30:32.520
```

Do not store formatted duration text as the primary duration value.

---

# 32. File Size Representation

File size should use a type capable of handling large broadcast media files.

Prefer:

```text
BIGINT
```

or equivalent Prisma-compatible representation.

Do not assume file sizes fit safely inside small integer types.

---

# 33. Timestamp Strategy

Store timestamps using timezone-aware database timestamp types where appropriate.

Important timestamps include:

```text
firstSeenAt
lastSeenAt
modifiedAt
lastMetadataExtractedAt
scan startedAt
scan completedAt
```

`modifiedAt` represents source filesystem metadata.

Other timestamps represent TMIP application observations.

Do not confuse the two.

---

# 34. firstSeenAt

`firstSeenAt` represents when TMIP first observed the logical file.

It should not be overwritten on later scans.

Example:

```text
firstSeenAt:
2026-09-01
```

Even if the file remains present for years, this value remains stable.

---

# 35. lastSeenAt

`lastSeenAt` represents the most recent successful observation of the file during scanning.

Example:

```text
Scan September
→ lastSeenAt = Sep 01

Scan October
→ lastSeenAt = Oct 01
```

An unchanged file should still update `lastSeenAt`.

---

# 36. lastSeenScanId

A scan identifier is useful for safe missing-file detection.

Example:

```text
mediaFile.lastSeenScanId = currentScanId
```

After discovery completes:

```text
ACTIVE media records
where lastSeenScanId != currentScanId
```

become missing candidates.

This is safer than marking files missing during traversal.

---

# 37. lastMetadataExtractedAt

This timestamp should only change when ffprobe metadata extraction actually succeeds.

An unchanged scan should not modify it.

Example:

```text
lastSeenAt
→ updated every successful observation

lastMetadataExtractedAt
→ updated only when extraction succeeds
```

---

# 38. Source Change Signature

For v1, source change detection may use:

```text
fileSize
modifiedAt
```

Optional conceptual field:

```text
sourceSignature
```

is not required if these values are already persisted.

Do not create a hash field unless there is a demonstrated need.

---

# 39. Rename Behavior

Under the v1 identity model:

```text
storageId + relativePath
```

a rename or move appears as:

```text
old path
→ MISSING

new path
→ NEW
```

This behavior is acceptable for v1.

Do not introduce content-based rename tracking unless it becomes a real requirement.

---

# 40. File Replacement Behavior

Suppose:

```text
News/video01.mxf
```

exists with:

```text
size A
modifiedAt A
```

and is later replaced with another file at the same path.

If:

```text
size changes
or
modifiedAt changes
```

TMIP should classify it as:

```text
UPDATED
```

and extract metadata again.

---

# 41. Files with Identical Names

The data model must allow:

```text
News/video01.mxf
Sports/video01.mxf
```

because identity depends on relative path, not filename.

---

# 42. Multiple Storage Locations

The data model should not assume only one storage forever.

Even if v1 initially uses only Server B, `Storage` should exist explicitly.

Example:

```text
Storage 1
Server B

Storage 2
Future Archive Storage
```

This is a low-cost flexibility point and avoids major identity refactoring later.

Do not implement complex multi-storage management UI until required.

---

# 43. Database Constraints

Recommended constraints include:

```text
Storage.name
→ unique when appropriate

MediaFile(storageId, relativePath)
→ unique

ScanItem(scanJobId, mediaFileId)
→ unique
```

Foreign keys should protect relational consistency.

---

# 44. Deletion Strategy

TMIP should avoid hard-deleting media inventory records during normal scanning.

When a file disappears:

```text
status = MISSING
```

Do not:

```text
DELETE FROM MediaFile
```

automatically.

This preserves:

- metadata
- investigation history
- auditability
- recovery if the file returns

---

# 45. File Reappearance

If a missing file later reappears at the same:

```text
storageId + relativePath
```

the existing `MediaFile` record should generally be reused.

Example:

```text
MISSING
    ↓
file appears again
    ↓
ACTIVE
```

Then determine whether metadata extraction is required based on current file attributes.

---

# 46. Metadata Extraction Error Model

Errors should not be stored only as free-form text if a simple category is useful.

Possible fields:

```text
errorCode
errorMessage
```

Potential categories may include:

```text
FILE_NOT_FOUND
PERMISSION_DENIED
FFPROBE_TIMEOUT
FFPROBE_FAILED
INVALID_PROBE_OUTPUT
UNSUPPORTED_MEDIA
UNKNOWN
```

Do not create an excessively complex error taxonomy in v1.

---

# 47. Retry Count

Metadata extraction history may track:

```text
attemptNumber
```

or retry information.

This helps distinguish:

```text
initial attempt
retry 1
retry 2
```

Do not encode retry count as part of media identity.

---

**Status: implemented (Phase 12).** `MediaFile.retryCount` (`Int @default(0)`) records how many automatic retries the last extraction claim used. It is an observation field, never part of identity (`storageId + relativePath`). The retry *limit* is configuration (`METADATA_MAX_RETRIES`), not persisted per row. `retryCount` is reset to 0 on every fresh claim (scan drain and manual reprocess) and on success; it holds the exhausted count on a terminal FAILED. See `docs/plans/004-failure-classification-bounded-retry.md`, `WORKFLOWS.md §33–§34`, and `ADR/ADR-005-bounded-extraction-retry.md`.

---

# 48. Scan Counters

Scan counters should preferably be persisted for efficient UI access.

Example:

```text
discoveredCount
newCount
updatedCount
unchangedCount
missingCount
processedCount
failedCount
```

Counters must be treated carefully under concurrency.

Implementation should avoid incorrect increments caused by duplicate job execution.

---

# 49. Counter Consistency

Counters are operational summaries.

Authoritative records remain:

```text
MediaFile
ScanItem
MetadataExtraction
```

If a counter becomes inconsistent, it should be possible to recompute it from underlying data where practical.

Do not make correctness depend solely on increment-only counters.

---

# 50. Idempotency Requirements

Data model constraints should help enforce idempotency.

Important examples:

```text
one media record
per storageId + relativePath
```

and:

```text
one scan observation
per scanJobId + mediaFileId
```

Repeated processing should update or reuse appropriate records rather than create uncontrolled duplicates.

---

# 51. Metadata Extraction Idempotency

Queue delivery may theoretically occur more than once.

The worker should therefore avoid assuming a job is executed exactly once.

Before committing extraction results, the system should ensure the result still corresponds to the expected file state.

Example:

Job created for:

```text
size = 1000
modifiedAt = A
```

Before or after ffprobe, if the file now has:

```text
size = 2000
modifiedAt = B
```

the result may be stale.

Exact stale-job handling belongs in workflow design, but the data model should preserve source attributes needed to detect it.

---

# 52. Processing Version

A future-compatible optional field may represent metadata extraction logic version.

Example:

```text
metadataSchemaVersion
```

or:

```text
extractorVersion
```

This can help if normalization logic changes later.

Do not introduce elaborate versioning infrastructure unless needed.

A simple string or integer may be sufficient.

---

# 53. Why Metadata Versioning May Matter

Example:

```text
v1 parser
→ frame rate normalization method A

v2 parser
→ improved frame rate normalization
```

The system may later need to identify records created by older extraction logic.

A lightweight version field can reduce migration ambiguity.

This is optional for initial implementation but should be easy to add.

---

# 54. Suggested Prisma-Level Model Shape

The following is conceptual only.

Exact Prisma syntax belongs in implementation.

```text
Storage
├── id
├── name
├── rootPath
├── enabled
├── createdAt
└── updatedAt

MediaFile
├── id
├── storageId
├── relativePath
├── filename
├── extension
├── fileSize
├── modifiedAt
├── status
├── metadataStatus
├── durationSeconds
├── videoCodec
├── videoCodecProfile
├── width
├── height
├── frameRateNumerator
├── frameRateDenominator
├── videoBitRate
├── pixelFormat
├── fieldOrder
├── audioCodec
├── audioSampleRate
├── audioChannels
├── audioBitRate
├── containerFormat
├── technicalMetadata
├── rawProbeData
├── firstSeenAt
├── lastSeenAt
├── lastSeenScanId
├── lastMetadataExtractedAt
├── createdAt
└── updatedAt

ScanJob
├── id
├── storageId
├── status
├── startedAt
├── discoveryCompletedAt
├── completedAt
├── discoveredCount
├── newCount
├── updatedCount
├── unchangedCount
├── missingCount
├── queuedCount
├── processedCount
├── failedCount
├── errorMessage
├── createdAt
└── updatedAt

ScanItem
├── id
├── scanJobId
├── mediaFileId
├── discoveryState
├── fileSize
├── modifiedAt
├── observedAt
├── metadataQueued
└── createdAt

MetadataExtraction
├── id
├── mediaFileId
├── scanJobId
├── status
├── attemptNumber
├── sourceFileSize
├── sourceModifiedAt
├── errorCode
├── errorMessage
├── startedAt
├── completedAt
└── createdAt
```

This structure is a design guide, not a requirement to implement every field immediately.

---

# 55. Minimal First Implementation

The first implementation may use a smaller subset.

For example:

```text
Storage

MediaFile
- id
- storageId
- relativePath
- filename
- extension
- fileSize
- modifiedAt
- status
- metadataStatus
- durationSeconds
- videoCodec
- width
- height
- frameRate
- technicalMetadata
- rawProbeData
- firstSeenAt
- lastSeenAt
- lastSeenScanId
- lastMetadataExtractedAt

ScanJob
- id
- storageId
- status
- counters
- timestamps
```

Add `ScanItem` and `MetadataExtraction` when needed by implementation clarity, troubleshooting, or reliability.

However, do not collapse responsibilities in a way that makes later separation expensive.

---

# 56. Data Model Evolution Rule

Before changing the schema, ask:

1. Is this field stable?
2. Will users query or filter it often?
3. Is it needed by core application logic?
4. Does it belong in JSONB instead?
5. Can this change be additive?
6. Will this create unnecessary coupling?
7. Does the same concept already exist?

---

# 57. When to Add a Column

Add a relational column when the field becomes operationally important.

Example:

```text
colorSpace
```

should remain JSONB if it is only occasionally inspected.

If later the application needs:

```text
filter all BT.709 media
```

frequently, then promoting it into a column becomes reasonable.

---

# 58. When Not to Add a Column

Do not create a relational column simply because ffprobe returned a field.

ffprobe can return many fields that TMIP may never use.

The database schema should represent TMIP's domain, not mirror ffprobe's entire output structure.

---

# 59. Current Source of Truth Rules

For current file presence:

```text
MediaFile.status
```

For current normalized metadata:

```text
MediaFile normalized columns
+
MediaFile.technicalMetadata
```

For current raw metadata:

```text
MediaFile.rawProbeData
```

For scan-specific observations:

```text
ScanJob
+
ScanItem
```

For extraction attempt history:

```text
MetadataExtraction
```

---

# 60. Final Data Model Principle

Prefer:

```text
stable relational core
+
flexible JSONB metadata
+
explicit scan state
+
non-destructive history
```

over:

```text
one giant JSON document
```

and over:

```text
hundreds of rigid metadata columns
```

TMIP should remain structured where structure creates value, and flexible where metadata naturally evolves.