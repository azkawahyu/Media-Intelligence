# ADR-005: Bounded Automatic Retry for Transient Metadata Extraction Failures

## Status

Accepted

## Context

Technical metadata extraction can fail for two very different reasons:

- **Transient** causes — an ffprobe timeout, a file momentarily unreadable or absent while a copy is still settling on Server B, a temporary SMB/NFS hiccup. The same file is very likely to succeed a moment later.
- **Permanent** causes — corrupt media, an unsupported format, an invalid container structure, or a deterministic validation error (a path that escapes the storage root, a directory in place of a file). Re-running ffprobe cannot help.

`WORKFLOWS.md §33` ("Retry Workflow") already prescribes the intended pipeline — *classify retry eligibility → retryable? yes → retry within configured limit / no → final FAILED* — and states "Retries must be finite." `SCOPE.md §20` places bounded retry in scope for "failures that are plausibly transient", and requires the policy to be "configurable and finite". `AGENTS.md §19` requires retries to be bounded and to distinguish transient from permanent failures.

The first vertical slice deliberately implemented **no retry at all** (`docs/plans/001-first-vertical-slice.md`, Annex A D6: "no retry logic (bounded or otherwise)"), and Phase 11 (manual reprocessing) preserved that deferral — `ADR-004` records "No Automatic Retry". Phase 12 lifts exactly that deferral, bounded as described here.

The design questions are:

1. Where does the retry live — a new queue/scheduler, or the existing worker?
2. How is a failure classified as retryable?
3. How is the retry count bounded and made observable without a new entity?
4. How is "no concurrent/duplicate processing of the same media" preserved while a retry is in flight?

## Decision

### Retry lives in the existing in-process worker

A retryable failure is retried **inside the same `ExtractionRunner` call**, immediately, before the row leaves `PROCESSING`. There is no requeue, no `nextRetryAt`, no scheduled/background retry, and no new queue. This keeps the Phase 6 PostgreSQL-backed claim model (`ADR` / Plan 001 Annex A D1) intact: `metadataStatus` remains the single durable work signal.

The retry loop wraps the **whole** attempt — validate → probe → normalise — because two transient codes (`FILE_NOT_FOUND`, `PERMISSION_DENIED`) are produced by file validation, not by ffprobe. Wrapping only the probe would leave the most common "temporary storage/network" failures unretried.

### Classification is explicit, centralized, and fail-closed

A single pure module, `apps/api/src/metadata/failure-classification.ts`, maps an `errorCode` to `TRANSIENT` or `PERMANENT`:

| errorCode | Class | Retried automatically? |
| --- | --- | --- |
| `FFPROBE_TIMEOUT` | TRANSIENT | yes |
| `FILE_NOT_FOUND` | TRANSIENT | yes |
| `PERMISSION_DENIED` | TRANSIENT | yes |
| `FFPROBE_FAILED` | PERMANENT | no |
| `INVALID_PROBE_OUTPUT` | PERMANENT | no |
| `VALIDATION_FAILED` | PERMANENT | no |
| `INTERRUPTED` | PERMANENT | no |
| anything unrecognized | PERMANENT | no |

The rule is **fail-closed**: an unknown code is PERMANENT. This guarantees that a new or unexpected error can never produce an unbounded retry loop (`AGENTS.md §19`). There is no `PERSISTENCE_FAILED` code; a failure to write the terminal state returns the pre-existing `ABORTED` outcome (no error fields, no counter increment) and is never retried.

Classification is keyed on `errorCode` alone, not on stage: the code already encodes the cause, and each code maps to exactly one stage.

### The bound and backoff are configuration

- `METADATA_MAX_RETRIES` (default **2**) — maximum extra attempts after the first. `0` disables automatic retry and reproduces the Phase 1–11 single-attempt behavior exactly.
- `METADATA_RETRY_BACKOFF_MS` (default **250**) — base for exponential backoff (`base × 2^(n-1)`, capped at 5 s). The backoff is a short safety pause, not a scheduler.

The bound is a local per-call counter, never read from the database, so a stale persisted value can never suppress retries for a re-queued row.

### Retry state is one additive column

`MediaFile.retryCount` (`Int @default(0)`) records how many automatic retries the last claim used. It is reset to 0 on **every fresh claim** — both the scan-drain `PENDING→PROCESSING` compare-and-set and the manual-reprocess `READY|FAILED→PROCESSING` compare-and-set — and on success. It holds the exhausted count on a terminal FAILED. This follows `DATA_MODEL.md §47` (retry count may be tracked; must not become part of identity) and avoids a new attempt-history entity (`AGENTS.md §25`, `DATA_MODEL.md §22–24`).

### Only the final attempt persists a terminal state

Intermediate attempts persist **no** `metadataStatus` change and **no** error fields — only `retryCount` is updated for observability. The row therefore stays `PROCESSING` across the whole retry sequence (including the backoff windows). Only the terminal attempt writes `READY` (clearing the error fields) or `FAILED` (recording the last failure). One `processedCount`/`failedCount` increment is applied per claim, exactly as before, so the scan counts one queued file regardless of how many attempts it took (`WORKFLOWS.md §31`, `DATA_MODEL.md §49`, `TESTING.md §43`).

## Why This Is Safe

1. **No concurrent/duplicate processing.** `ExtractionRunner.claimOne` claims only `PENDING` rows; `reprocessOne` claims only `READY|FAILED` rows. Because the retrying row is `PROCESSING` for the entire sequence, neither a scan drain nor a manual reprocess can claim it. A manual reprocess issued mid-retry returns `409 Conflict`.
2. **Bounded time.** The sequence is bounded by `(1 + METADATA_MAX_RETRIES) × ffprobe timeout + Σ backoff`, so the orchestrator's `finalize` cannot be delayed indefinitely and `WORKFLOWS.md §36` completion still terminates.
3. **Deterministic terminal state.** After exhaustion the last failure is persisted exactly as before (`metadataStatus = FAILED` + `errorCode`/`errorMessage`/`errorStage`/`errorAt`), and the scan still finalizes `COMPLETED_WITH_ERRORS`.
4. **Restart-safe.** If the process dies mid-retry, `sweepInterruptedState` marks the row `FAILED`/`INTERRUPTED` (a PERMANENT code — never auto-retried); it remains manually reprocessable (`WORKFLOWS.md §46`, `TESTING.md §55`).
5. **Source media untouched.** Retries only re-read the file through the existing read-only path (`ADR-002`); nothing is written, renamed, moved, or deleted.

## Alternatives Considered

### Requeue retryable rows as PENDING with a `nextRetryAt` timestamp

Rejected for Phase 12: it introduces scheduling state and a background scheduler, lets an unrelated scan claim the row at an unpredictable time, and risks the row being re-discovered and re-queued by a concurrent scan. The owner explicitly excluded `nextRetryAt`, a new queue, and scheduled retry infrastructure.

### Add a MetadataExtraction attempt-history table

Rejected (`AGENTS.md §25`; `DATA_MODEL.md §22–24` make it optional). One `retryCount` column is enough for v1 observability; the `appendAttempt` boundary keeps a future history entity additive.

### Retry every failure a bounded number of times

Rejected: retrying permanent failures (corrupt/unsupported media) wastes network and storage load on Server B for no benefit, contradicts `WORKFLOWS.md §33`, and delays the deterministic FAILED the operator needs to see. Classification is therefore explicit.

### Retry only probe/normalise, not validation

Rejected: it would leave `FILE_NOT_FOUND`/`PERMISSION_DENIED` — the transient codes most representative of "temporary storage/network unavailability" — unretried.

### Default `METADATA_MAX_RETRIES=0` (opt-in)

Considered to maximize backward compatibility. The owner's directive specifies `2` as the operating point, so the default is `2`; `0` remains available to reproduce the earlier behavior exactly. This is the single intentional behavior change of Phase 12, and it applies only to failures classified TRANSIENT.

## Result

Transient extraction failures (timeouts, momentary file access/storage/network problems) are retried automatically a small, configured number of times inside the existing worker with bounded backoff, and reach `READY` when the transient condition clears. Permanent failures still fail once, deterministically. The retry count is observable on `MediaFile` and survives restarts. Manual reprocessing (Phase 11) is unchanged and resets the retry state. No new queue, scheduler, or attempt-history entity is introduced, and source media remains strictly read-only.
