# TESTING.md

## 1. Purpose

This document defines the testing strategy for TMIP v1.

The testing goal is not to maximize test count.

The goal is to prove that the core metadata pipeline behaves correctly, safely, and consistently.

The core pipeline is:

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

Tests must prioritize the correctness of this pipeline.

---

# 2. Testing Principles

TMIP testing should follow these principles:

1. Test behavior, not implementation details.
2. Protect source media safety.
3. Verify repeated scans are idempotent.
4. Verify failures remain isolated.
5. Verify state transitions explicitly.
6. Avoid requiring Server B for most automated tests.
7. External dependencies must be mockable.
8. Real ffprobe behavior should still be tested separately.
9. Database constraints should reinforce test expectations.
10. Tests should remain deterministic.

---

# 3. Testing Layers

TMIP should use the following testing layers:

```text
Unit Tests
    ↓
Integration Tests
    ↓
Pipeline Tests
    ↓
End-to-End Acceptance Tests
```

Not every feature requires every layer.

Use the smallest appropriate test level.

---

# 4. Unit Tests

Unit tests should cover isolated business logic.

Good candidates include:

- supported extension detection
- relative path normalization
- file change classification
- ffprobe output normalization
- frame-rate parsing
- error classification
- metadata mapping
- retry eligibility
- status transition decisions

Unit tests should not require:

- PostgreSQL
- Redis
- Server B
- real SMB/NFS
- browser automation

---

# 5. Change Detection Tests

Change detection is a critical business rule and must be thoroughly tested.

Given an existing file:

```text
fileSize = 1000
modifiedAt = T1
```

---

## 5.1 New File

Database record does not exist.

Expected:

```text
NEW
```

---

## 5.2 Unchanged File

Existing:

```text
size = 1000
modifiedAt = T1
```

Observed:

```text
size = 1000
modifiedAt = T1
```

Expected:

```text
UNCHANGED
```

ffprobe must not be queued.

---

## 5.3 Size Changed

Existing:

```text
size = 1000
modifiedAt = T1
```

Observed:

```text
size = 2000
modifiedAt = T1
```

Expected:

```text
UPDATED
```

---

## 5.4 Modified Time Changed

Existing:

```text
size = 1000
modifiedAt = T1
```

Observed:

```text
size = 1000
modifiedAt = T2
```

Expected:

```text
UPDATED
```

---

## 5.5 Both Changed

Expected:

```text
UPDATED
```

---

# 6. Media Identity Tests

Media identity must be tested using:

```text
storageId + relativePath
```

Cases:

```text
Storage A / News/video01.mxf
Storage A / Sports/video01.mxf
```

must be different records.

Also:

```text
Storage A / News/video01.mxf
Storage B / News/video01.mxf
```

must be different records.

Filename alone must never collapse these records.

---

# 7. Path Handling Tests

Path handling should verify:

- nested paths
- path separator normalization
- spaces in filenames
- Unicode filenames
- long filenames
- similar filenames in different folders

Example:

```text
News/2026/September/Program Final 01.mxf
```

must remain valid.

---

# 8. Path Traversal Safety Tests

If any API or internal input can influence file paths, test attempts such as:

```text
../../etc/passwd
```

or equivalent platform-specific traversal.

Expected behavior:

```text
reject
```

The resolved path must remain within the configured storage root.

---

# 9. Supported Extension Tests

Test supported formats such as:

```text
.mp4
.mov
.mxf
.mpg
.mpeg
.avi
.mkv
.ts
.mts
```

Case handling should be explicit.

Example:

```text
VIDEO.MXF
video.mxf
```

should normally behave consistently.

Unsupported files such as:

```text
.txt
.pdf
.docx
.jpg
```

should be ignored, not treated as scan failures.

---

# 10. FFprobe Parser Tests

The normalization layer must be tested with representative ffprobe JSON fixtures.

Fixtures should include examples for:

- MP4 / H.264
- MOV
- MXF
- MPEG-2
- H.265
- multiple audio streams
- no audio
- unusual frame rate
- interlaced video
- malformed metadata
- incomplete metadata

These fixtures should be stored in test resources.

---

# 11. Frame Rate Tests

Frame-rate parsing must preserve meaningful distinctions.

Test:

```text
25/1
```

Expected:

```text
25 fps
```

Test:

```text
30000/1001
```

Expected to preserve the rational value or accurately normalize it.

Do not silently convert it to exactly:

```text
30
```

if the implementation is expected to retain broadcast precision.

---

# 12. Duration Tests

Test ffprobe duration such as:

```text
"1832.520000"
```

Expected normalized value:

```text
1832.52
```

Invalid or missing duration must not crash metadata normalization.

---

# 13. Audio Metadata Tests

Test:

```text
stereo
mono
multiple channels
PCM
AAC
no audio stream
```

Absence of audio must not be considered a metadata extraction failure for an otherwise valid video.

---

# 14. Malformed FFprobe Output

Test invalid output such as:

```text
not JSON
```

or:

```json
{}
```

Expected behavior must be explicit.

Examples:

```text
INVALID_PROBE_OUTPUT
```

or a validated partial result where appropriate.

The process must not crash the worker.

---

# 15. FFprobe Process Failure Tests

Test:

- non-zero exit code
- executable not found
- timeout
- inaccessible file
- corrupt file

Expected:

```text
MetadataExtraction = FAILED
```

with useful error information.

---

# 16. FFprobe Command Safety

Tests should verify filenames containing special characters are passed safely.

Examples:

```text
Program #01.mxf
news (final).mov
test & demo.mp4
```

The implementation must use argument-array process execution.

Do not rely on shell interpolation.

---

# 17. Database Integration Tests

Integration tests should verify real database behavior.

Use an isolated PostgreSQL test database.

Important cases include:

- media creation
- unique constraints
- scan creation
- scan item uniqueness
- status updates
- metadata persistence
- JSONB persistence
- missing-file updates
- reappearance behavior

---

# 18. Unique Media Constraint Test

Attempt to create two records with the same:

```text
storageId
relativePath
```

Expected:

```text
constraint prevents duplicate
```

This protects scan idempotency.

---

# 19. Scan Item Uniqueness Test

Within one scan:

```text
scanJobId + mediaFileId
```

must not produce duplicate observations.

---

# 20. JSONB Tests

Test that:

```text
technicalMetadata
rawProbeData
```

can preserve unknown or future metadata fields without schema changes.

Example:

```json
{
  "colorSpace": "bt709",
  "customVendorField": "example"
}
```

must persist successfully.

---

# 21. Scan Orchestration Integration Tests

A temporary local directory should be used to simulate mounted storage.

Example test structure:

```text
tmp-media/
├── news/
│   ├── a.mp4
│   └── b.mxf
└── notes.txt
```

The scan should discover:

```text
2 supported media files
```

and ignore:

```text
notes.txt
```

---

# 22. First Scan Test

Given:

```text
database empty
storage contains 3 supported videos
```

Expected:

```text
discoveredCount = 3
newCount = 3
unchangedCount = 0
updatedCount = 0
```

All three media records should exist.

All three should be eligible for metadata extraction.

---

# 23. Second Unchanged Scan Test

Run the same scan again without changing the filesystem.

Expected:

```text
newCount = 0
updatedCount = 0
unchangedCount = 3
```

No new media records.

No unnecessary metadata extraction jobs.

---

# 24. Updated File Test

After the first scan, modify one test file.

Run another scan.

Expected:

```text
updatedCount = 1
unchangedCount = remaining files
```

Only the changed file should require metadata extraction.

---

# 25. New File Added Test

After an existing scan, add another file.

Expected:

```text
NEW
```

Only the added file should be treated as new.

Existing unchanged files should remain unchanged.

---

# 26. Missing File Test

After a successful scan, remove one test file.

Run another fully successful scan.

Expected:

```text
MediaFile.status = MISSING
```

The database record must remain present.

---

# 27. Missing File Safety Test

Simulate storage failure before or during discovery.

Expected:

```text
ScanJob = FAILED
```

Previously known media must not all become:

```text
MISSING
```

This is a critical safety test.

---

# 28. Reappearance Test

Given a media record marked:

```text
MISSING
```

restore the file to the same:

```text
storageId + relativePath
```

Run scan again.

Expected:

```text
existing MediaFile reused
status = ACTIVE
```

No duplicate record should be created.

---

# 29. Rename Behavior Test

Initial file:

```text
News/a.mxf
```

Rename externally to:

```text
News/b.mxf
```

Run a successful scan.

Expected v1 behavior:

```text
News/a.mxf
→ MISSING

News/b.mxf
→ NEW
```

Do not expect automatic rename detection.

---

# 30. File Replacement Test

Replace the contents of a file while keeping the same path.

If:

```text
size
or
modifiedAt
```

changes, expected:

```text
UPDATED
```

---

# 31. Scan Idempotency Test

Run identical scan input multiple times.

Expected:

```text
same logical inventory
same media count
no duplicate MediaFile records
no duplicate ScanItem records within each scan
```

Only scan history should increase.

---

# 32. Metadata Extraction Integration Test

Use a small known test video.

Run real ffprobe.

Verify fields such as:

```text
duration
videoCodec
width
height
frameRate
```

match expected values.

This test confirms the real ffprobe adapter works.

---

# 33. Test Media Fixtures

Repository test media should remain:

- small
- non-confidential
- legally usable
- stable

Avoid committing large production media files.

A few tiny generated test videos are sufficient.

---

# 34. Queue Integration Tests

Queue integration should test:

- job creation
- worker consumption
- successful completion
- retry behavior
- failure recording
- duplicate job prevention where applicable

Use isolated Redis for integration tests if needed.

Unit tests should not require Redis.

---

# 35. Worker Failure Isolation Test

Queue multiple metadata jobs.

Force one to fail.

Expected:

```text
remaining jobs continue
```

The failed job must not stop unrelated processing.

---

# 36. Retry Test

Simulate a retryable failure.

Expected:

```text
attempt 1 fails
attempt 2 runs
```

The retry count must remain bounded.

---

# 37. Permanent Failure Test

Simulate:

```text
unsupported/corrupt media
```

Expected:

```text
no infinite retry
final extraction status = FAILED
```

---

# 38. Stale Job Test

Create extraction job for:

```text
size = A
modifiedAt = T1
```

Before processing, change the file to:

```text
size = B
modifiedAt = T2
```

Expected:

```text
old extraction result must not become authoritative current metadata
```

The implementation may:

- mark old job stale
- fail it with explicit reason
- queue a fresh extraction

The exact implementation must remain consistent.

---

# 39. File Changes During Probe Test

Where implemented, simulate file state changing between:

```text
stat before
ffprobe
stat after
```

Expected:

```text
result not committed as current
```

This test is optional until the behavior exists.

---

# 40. Scan Completion Tests

Test:

```text
discovery complete
+
all extraction jobs successful
```

Expected:

```text
COMPLETED
```

---

Test:

```text
discovery complete
+
some file-level extraction failures
```

Expected:

```text
COMPLETED_WITH_ERRORS
```

---

Test:

```text
discovery fails before reliable completion
```

Expected:

```text
FAILED
```

---

# 41. Zero-Work Scan Test

Given all files unchanged:

```text
queuedCount = 0
```

The scan must still reach:

```text
COMPLETED
```

without waiting for jobs that do not exist.

---

# 42. Large Directory Simulation

Automated tests do not need thousands of real video files.

A large discovery test may create many lightweight placeholder filenames.

Use it to verify:

- traversal does not require one massive in-memory structure
- record creation remains stable
- counters remain correct

Do not turn normal test runs into performance benchmarks.

---

# 43. Counter Tests

Scan counters must have clearly defined semantics.

Test:

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

Counters should match underlying records.

Where practical, verify they can be reconciled with:

```text
ScanItem
MetadataExtraction
```

---

# 44. API Tests

API tests should cover at minimum:

```text
POST /scans
GET /scans/:id
GET /media
GET /media/:id
```

If implemented:

```text
POST /media/:id/retry
```

Test:

- valid input
- invalid input
- not found
- conflict
- current scan status
- pagination

---

# 45. Start Scan API Test

Expected behavior:

```text
POST /scans
```

returns quickly with a scan identifier.

It must not wait for all media processing to complete.

Appropriate status may be:

```text
202 Accepted
```

---

# 46. Concurrent Scan API Test

If a scan is already running for a storage:

```text
POST /scans
```

again should follow the documented concurrency policy.

Examples:

- reject with conflict
- return current active scan

Behavior must remain deterministic.

---

# 47. Media List Tests

Verify:

- pagination
- basic filename search
- status filter
- codec filter if implemented
- extension filter if implemented

Normal media list access must not touch the source filesystem.

---

# 48. Media Detail Tests

Opening media detail should:

```text
query PostgreSQL
```

It must not automatically:

```text
run ffprobe
scan directory
modify media
```

---

# 49. Source Media Safety Tests

This is a mandatory category.

During scans and metadata extraction, verify source files retain:

- same contents
- same filenames
- same paths
- no unexpected sidecar files

Where practical, compare directory contents before and after scan.

Expected:

```text
no source mutation
```

---

# 50. Read-Only Deployment Test

At least one deployment or acceptance test should run the media mount as:

```text
read-only
```

TMIP must still function.

This proves the application does not accidentally depend on source write access.

---

# 51. Permission Failure Tests

Test a file that exists but cannot be read.

Expected:

- scan does not crash
- failure is recorded appropriately
- unrelated files continue processing

---

# 52. Storage Root Failure Test

Configure a nonexistent root.

Expected:

```text
scan fails clearly
```

No media records should be mass-marked missing.

---

# 53. Database Failure Tests

Where practical, test behavior when PostgreSQL becomes unavailable.

Expected:

- clear failure
- no silent success
- no incorrect completion state

Do not overengineer automatic database recovery for v1.

---

# 54. Redis Failure Tests

Where practical, verify queue failure does not erase persistent inventory state.

Expected:

```text
MediaFile
ScanJob
MetadataExtraction
```

remain in PostgreSQL.

---

# 55. Application Restart Tests

If restart recovery behavior is implemented, test it explicitly.

Minimum acceptable v1 behavior may be:

```text
interrupted RUNNING scan
→ identified as interrupted/failed after restart
```

Do not claim automatic resume unless tested.

---

# 56. Frontend Tests

Frontend automated tests should focus on important behavior.

Examples:

- scan button triggers request
- running scan state displayed
- counts displayed correctly
- media list renders
- media detail renders
- failed metadata state visible
- missing media state visible

Do not spend excessive effort snapshot-testing visual implementation details.

---

# 57. UI Loading State Tests

The UI should clearly distinguish:

```text
loading
no results
scan running
scan completed
scan completed with errors
scan failed
```

A generic spinner for every state is not sufficient.

---

# 58. End-to-End Acceptance Test

The primary acceptance sequence is:

## Step 1

Place:

```text
video-a.mp4
```

inside the test storage.

Start scan.

Expected:

```text
NEW
metadata extracted
record visible
scan COMPLETED
```

---

## Step 2

Run another scan without changing the file.

Expected:

```text
UNCHANGED
ffprobe not rerun
```

---

## Step 3

Modify the file.

Run scan.

Expected:

```text
UPDATED
metadata extracted again
```

---

## Step 4

Remove the file.

Run a successful scan.

Expected:

```text
MISSING
database record retained
```

---

## Step 5

Restore the file.

Run scan.

Expected:

```text
ACTIVE
existing logical record reused
```

This sequence is the core acceptance contract for TMIP v1.

---

# 59. Real Environment Acceptance Test

Before declaring v1 complete, test against actual mounted storage from Server B.

Verify:

- Server A can read the mount
- Docker can read the mounted storage
- recursive scan works
- ffprobe works across the network mount
- worker concurrency does not overload the storage
- source files remain unchanged

Start with a limited test directory before scanning the complete server.

---

# 60. Progressive Real-World Test Strategy

Use progressive scale.

Recommended sequence:

```text
1 file
    ↓
10 files
    ↓
100 files
    ↓
1,000 files
    ↓
larger real directory
    ↓
full intended storage
```

Do not make the first real-world test a full production-storage scan.

---

# 61. Performance Validation

Performance testing should measure actual bottlenecks.

Useful measurements:

- directory discovery duration
- average ffprobe duration
- network throughput
- Server B load
- Server A CPU
- worker throughput
- database query latency

Do not optimize based only on synthetic assumptions.

---

# 62. Worker Concurrency Test

Test different controlled concurrency levels.

Example:

```text
1
2
4
```

Observe:

- storage load
- network impact
- processing speed
- error rate

The fastest setting is not automatically the best setting.

---

# 63. Test Isolation

Automated tests must not use production media storage.

Never run destructive test setup against Server B.

Integration tests must use:

- temporary directories
- test databases
- test Redis
- non-production media fixtures

---

# 64. Test Cleanup

Test-created resources must be cleaned up.

Examples:

- temporary directories
- test database records
- test Redis jobs
- generated fixture files

Cleanup must never target production paths.

---

# 65. Test Environment Safety

Test configuration should clearly differ from production configuration.

Examples:

```text
NODE_ENV=test
DATABASE_URL=test database
MEDIA_ROOT=temporary directory
```

Avoid environment fallbacks that could accidentally point tests to real media storage.

---

# 66. Regression Tests

Whenever a bug is fixed:

1. reproduce the bug in a test
2. verify the test fails before the fix where practical
3. implement the fix
4. verify the test passes

Important operational bugs should gain regression coverage.

---

# 67. Migration Tests

Database migrations should be verified against:

- empty database
- existing representative records

A migration must not accidentally destroy:

- media identity
- metadata
- scan state

Destructive migrations require explicit review.

---

# 68. JSONB Schema Evolution Tests

When metadata normalization evolves, verify old records remain readable.

Example:

Old:

```json
{
  "colorSpace": "bt709"
}
```

New:

```json
{
  "color": {
    "space": "bt709"
  }
}
```

If structure changes, migration or compatibility behavior must be explicit.

Do not silently break old persisted metadata.

---

# 69. Definition of Done for Code Changes

A code change is not complete solely because it compiles.

For relevant changes, verify:

```text
type check
tests
lint
runtime behavior
scope compliance
```

Linting is run with `pnpm lint` from the repository root (ESLint 9 flat config per app: `apps/api/eslint.config.mjs` uses typescript-eslint; `apps/web/eslint.config.mjs` uses eslint-config-next). Lint must pass with no errors; warnings must carry a justification.

At minimum:

- relevant tests pass
- no unrelated tests regress
- requested behavior is demonstrated

---

# 70. Required Tests Before TMIP v1 Completion

Before TMIP v1 can be considered complete, the following must pass:

- first scan
- unchanged second scan
- updated file scan
- new file addition
- missing file detection
- file reappearance
- repeated scan idempotency
- real ffprobe extraction
- ffprobe failure handling
- one file failure does not stop scan
- storage failure does not mass-mark missing
- source files remain unchanged
- scan progress is visible
- media data is visible through the application

---

# 71. Testing Anti-Patterns

Do not:

- test only happy paths
- depend on production Server B for normal automated tests
- mock every layer in integration tests
- run ffprobe for every unit test
- require Redis for pure business-logic tests
- verify implementation details instead of behavior
- write tests that depend on execution order
- hide flaky tests by retrying them indefinitely
- mark failing tests as skipped without documented reason

---

# 72. Test Priority Order

If development time is limited, prioritize testing in this order:

```text
1. Source media safety
2. Change detection correctness
3. Idempotency
4. Missing detection safety
5. Metadata extraction correctness
6. Failure isolation
7. Scan completion state
8. Persistence correctness
9. API behavior
10. UI behavior
```

A visually polished UI with an unreliable scanner is not an acceptable tradeoff.

---

# 73. Final Testing Principle

Prefer:

```text
a small number of meaningful tests
that prove critical behavior
```

over:

```text
a large number of shallow tests
that only increase coverage percentage
```

---

# 74. AI Enrichment Evaluation (MVP 2)

AI enrichment (MVP 2) is verified at **three distinct levels**. Conflating them is
an anti-pattern: passing contract tests is **not** evidence of semantic quality.

## 74.1 Deterministic contract tests (required, offline)

Stage payload *shape* against
`docs/mvp2-ai-metadata/01-ai-metadata-contract.md` (transcription, summary,
keywords, classification, OCR), plus error classification, bounded retry,
idempotent upsert, partial-result folding, and cancellation transitions. Covered by
`apps/api/src/ai/*.test.ts` and `ai-processor/tests/`; the contract shape checks
can also be run directly via `docs/mvp2-ai-metadata/eval/evaluate.py --self-test`.
No external AI call.

## 74.2 Synthetic fixture checks (required, offline)

Tiny synthetic videos with a **known burned-in caption** in
`ai-processor/tests/fixtures/` (regenerated byte-deterministically by
`generate_fixtures.py`). They verify that frames at different timestamps decode
**distinctly**, that the caption is **read**, and that a window-limited caption is
respected. These exercise the **real** OCR code path and real cv2/pytesseract.

`ai-processor/tests/test_ocr_fixtures.py` is env-gated: it skips when real
cv2/pytesseract are unavailable. Because other tests inject stub modules into
`sys.modules`, the skip check requires the real modules (`__file__` present), not a
plain import, so a stub cannot make the check pass falsely. The image ships no
pytest, so the same checks are run for real in the ai-processor container via
`eval/evaluate.py --ocr-fixtures`.

## 74.3 Manual semantic review (opt-in, NOT a CI gate)

Judging whether summaries/transcripts/keywords/OCR are *accurate* requires
**human-recorded reference data**, a real LLM key, and CPU time. It is manual,
opt-in, and recorded with the machine-readable sample format in
`docs/mvp2-ai-metadata/eval/` (reference / produced / human_judgment). The sample
template is a **template**, not evidence. No pass threshold is defined until a
measured baseline exists (`docs/mvp2-ai-metadata/09-quality-evaluation.md`).

Live AI evaluation has **not** been run or approved.

## 74.4 Invariants

- AI never writes `metadataStatus`; enabling or disabling AI does not change the
  MVP 1 pipeline (`ADR-006`).
- No test may require external AI calls, secrets, or production media.
- Contract/fixture checks must never be reported as quality scores, and passing
  them does not resolve OD-07 (semantic quality remains unmeasured).

TMIP testing should provide confidence that repeated operation against real media storage is safe, predictable, and recoverable.