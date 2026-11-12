# ADR-004: Metadata Reprocessing Is Explicit, Isolated, and Scan-Independent

## Status

Accepted

## Context

Technical metadata extraction can fail. A media file may be:

- malformed
- incomplete
- partially copied
- unsupported
- temporarily inaccessible

`WORKFLOWS.md` §31 records such a failure on the `MediaFile` row (`metadataStatus = FAILED` plus error fields), and `PRD.md` §16.3 states that a failed extraction must remain recoverable — "the system should allow the file to be retried later".

`AGENTS.md` §10 ("Discovery Is Not Extraction") already names the trigger: extraction should occur when "the user explicitly requests reprocessing". `WORKFLOWS.md` §52 describes the manual reprocess workflow. The first vertical slice deferred this endpoint (Plan 001 Annex A D6); Phase 11 lifts exactly that deferral.

The design question is how a single-file reprocess should interact with the existing incremental-scan machinery so that neither breaks the other.

A naive approach would:

```text
reprocess requested
→ create a new ScanJob
→ run a full scan
→ or set the row back to PENDING and wait for the next scan
```

This is undesirable because:

- it conflates reprocessing one file with discovery of the whole storage root
- it would attribute a non-scan attempt to `ScanJob` counters, corrupting scan progress semantics
- setting a row to `PENDING` lets an unrelated scan claim it later at an unpredictable time, so the user cannot observe the result of *their* request
- without a guard, two concurrent requests could run two ffprobe attempts on the same file

## Decision

Metadata reprocessing is an explicit, user-initiated, isolated, scan-independent operation.

The entry point is:

```text
POST /media/:id/reprocess
```

The state machine is claim-first with a compare-and-set guard:

```text
PENDING     → 409 Conflict   (a scan will pick it up)
PROCESSING  → 409 Conflict   (already being processed — concurrent guard)
READY       → PROCESSING     (atomic claim succeeds) → READY | FAILED
FAILED      → PROCESSING     (atomic claim succeeds) → READY | FAILED
```

The claim is a single conditional update:

```text
mediaFile.updateMany({
  where: { id, metadataStatus: { in: ["READY", "FAILED"] } },
  data:  { metadataStatus: "PROCESSING" }
})
```

`count === 1` means this request owns the attempt; `count === 0` means another actor already holds the row and the request is rejected with `409 Conflict`. This is the same compare-and-set idiom already used by `ExtractionRunner.claimOne`, so no new concurrency mechanism is introduced.

The API answers immediately with `202 Accepted` and `{ mediaFileId, metadataStatus: "PROCESSING" }`, then detaches the extraction. The client polls `GET /media/:id` until the terminal `READY`/`FAILED` state, mirroring the existing scan-progress polling model (`ARCHITECTURE.md` §37). The HTTP handler never runs ffprobe inline (`AGENTS.md` §8).

The extraction itself reuses the existing extraction core. `ExtractionRunner.processOne` was split into a shared private `appendAttempt` (validate → probe → normalise → persist READY-or-FAILED, no counters) plus the scan-attribution wrapper. `reprocessOne` calls the same `appendAttempt`, so success and failure semantics are identical to a scan: success sets `READY` and clears `errorCode/errorMessage/errorStage/errorAt`; failure sets `FAILED` and records the new error fields while leaving the previously stored normalised columns and JSONB intact (`WORKFLOWS.md` §15).

Reprocess is **not** a scan:

- it does not create a `ScanJob`
- it does not increment `queuedCount`, `processedCount`, or `failedCount`
- it does not write `lastSeenScanId`

## Why This Is Safe Alongside Scanning

The scan orchestrator's completion guard is counter-based, not state-based: `finalize` guards only on `processedCount < queuedCount` and the `RUNNING → terminal` transition. No code path queries `MediaFile.metadataStatus` during finalize. A reprocess that deliberately does not touch scan counters is therefore invisible to the completion guard. Safety rests on two facts:

1. `ExtractionRunner.claimOne` claims **only** `PENDING` rows, so a scan drain will never double-process a row a reprocess holds in `PROCESSING`.
2. The orchestrator's observation paths (UNCHANGED/UPDATED) update only `lastSeenAt`/`lastSeenScanId`/`status` — never `metadataStatus` — so a concurrent scan leaves a reprocess `PROCESSING` row intact.

## No Automatic Retry

This decision introduces explicit, user-bounded reprocessing only. It adds no automatic retry, no retry counter, no backoff, and no transient/permanent failure classification. `AGENTS.md` §19's "retries must be bounded" is satisfied because each attempt is a discrete user action.

> **Update (Phase 12, `ADR-005`):** the deferral of bounded retry (`SCOPE.md` §20, `WORKFLOWS.md` §33) is lifted. Automatic retry now exists for TRANSIENT failures only, bounded by `METADATA_MAX_RETRIES`; the `retryCount` counter and backoff described here as absent are added by `ADR-005`. Manual reprocessing is unchanged and resets the retry state.

## Alternatives Considered

### Requeue as PENDING and rely on the next scan

Rejected: it makes the result of the user's request unobservable and unpredictable, contaminates `ScanJob` counters with a non-scan attempt, and couples a single-file operation to a full-storage discovery run.

### Create a dedicated ScanJob for a single file

Rejected: `ScanJob` is defined as storage-scoped discovery (`WORKFLOWS.md` §55, `ScanJob belongs to one Storage`). A one-file pseudo-scan would overload that entity and confuse progress reporting.

### Allow reprocessing of PROCESSING rows

Rejected: it would let two ffprobe attempts read the same file concurrently and produce a last-writer-wins state, violating "prevent conflicting concurrent processing of the same media file". Rejecting with 409 is the safe, deterministic outcome.

### Add a MetadataExtraction history table

Rejected for v1 (`AGENTS.md` §25, premature abstraction; `DATA_MODEL.md` §22–24 make it optional). The existing `MediaFile` error fields plus `lastMetadataExtractedAt` already carry the last extraction outcome. `appendAttempt` is a clean boundary should a history entity be justified later.

### Delete and recreate the record, or write sidecar files

Rejected: source media storage is read-only (`ADR-002`), and the media inventory is the application's source of truth. Reprocessing only mutates the application database.

## Failure Behavior

- A failed reprocess records the new failure and keeps the file visible with its failure information (`PRD.md` §8.5).
- One failed file does not affect any other file; the operation is isolated per row (`AGENTS.md` §18).
- If the process is interrupted mid-reprocess, the startup sweep (`sweepInterruptedState`) marks the row `FAILED`/`INTERRUPTED`; it is recoverable and can simply be reprocessed again.
- Source media files are never modified, renamed, moved, or written to (`ADR-002`).

## Result

A technical staff member can explicitly request metadata reprocessing for a single existing media file, observe the resulting `PROCESSING` / `READY` / `FAILED` state, and have concurrent attempts on the same file safely rejected — without disturbing the incremental scan pipeline, its counters, or its change detection.
