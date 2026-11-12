# TMIP Plan 004 — Phase 12: v1.1 Hardening — Failure Classification & Bounded Retry

- **Status:** Implemented and verified (2026-10-07). Independent test-engineer verification: PASS (including the post-fix delta).
- **Scope:** Failure classification (transient/retryable vs permanent) for metadata extraction, and bounded **in-process** retry of explicitly retryable failures only. No new queue, no scheduled/`nextRetryAt` state, no new attempt-history entity, no AI/LLM, no auth/RBAC, no v2 work.
- **Review basis:** `AGENTS.md` (§10, §18, §19, §20, §25, §29–§32, §38), `PRD.md` (§8.5, §16.1, §16.3), `SCOPE.md` (§20, §21, §22), `ARCHITECTURE.md` (§8, §13, §26), `DATA_MODEL.md` (§46–§49), `WORKFLOWS.md` (§15, §31–§34, §36, §43, §46, §47, §51, §52, §57), `TESTING.md` (§4, §21, §35–§37, §43, §55, §62, §63, §69), `docs/plans/001-first-vertical-slice.md` (Annex A D1, D6), `docs/plans/003-metadata-reprocessing.md`, `ADR/ADR-004-metadata-reprocessing.md`.
- **Baseline:** Phases 1–11 complete and verified (97/97 tests, typecheck, lint, build pass). Phase 11 added explicit metadata reprocessing with a compare-and-set `PROCESSING` claim. Plan 001 Annex A **D6** deferred all retry ("no retry logic — `SCOPE.md §20` and `WORKFLOWS.md §33` deferred") and Plan 003 deliberately preserved that deferral. **This plan lifts exactly that deferral, bounded as described below.**

**Mission:** When an extraction fails for a plausibly transient reason (ffprobe timeout, temporary file access failure, temporary storage/network unavailability), TMIP retries it automatically a small, configured number of times inside the same worker before recording a final deterministic FAILED. Failures that are likely permanent (corrupt/unsupported media, invalid media structure, deterministic validation errors) are never retried automatically. Manual reprocessing (Phase 11) still works and resets retry state.

---

## 1. Relevant documented requirements

- **WORKFLOWS.md §33 "Retry Workflow"** — "failure occurs → classify retry eligibility → retryable? yes → retry within configured limit / no → final FAILED. Retries must be finite." Transient examples: temporary file access failure, temporary network interruption, ffprobe timeout, temporary storage unavailability. Permanent examples: corrupt media, unsupported format, invalid media structure.
- **SCOPE.md §20 "Retry Handling"** — "Bounded retry handling is in scope … for failures that are plausibly transient. Retry policies must remain configurable and finite."
- **AGENTS.md §19 "Retry Behavior"** — bounded, no infinite loops; must distinguish transient vs permanent. **§18** — record category/message/stage/timestamp; one failure must not fail the scan.
- **DATA_MODEL.md §46** — the emitted error vocabulary already includes `FFPROBE_TIMEOUT` (transient) and `INVALID_PROBE_OUTPUT`/`FFPROBE_FAILED` (permanent-leaning). **§47 "Retry Count"** — retry count may be tracked; must not become part of media identity. **§49** — counters are operational summaries; authoritative records remain `MediaFile`/`ScanJob`.
- **WORKFLOWS.md §36** — completion requires every queued job to reach a terminal state; retry is bounded, so it terminates. **§43** — counter increments guarded/atomic. **§47** — authoritative state is PostgreSQL, so retry state must live there, not in Redis.
- **PRD.md §16.3** — failed extraction remains recoverable; **§16.1** — one failure must not stop the scan.
- **TESTING.md §36/§37** — retry test and permanent-failure test are explicitly named; §4 lists "retry eligibility" as a unit-test candidate; §62 worker concurrency.

## 2. Design decisions (owner directive + plan-review corrections)

1. **In-process, immediate, bounded retry.** A retryable failure is retried in the same `ExtractionRunner.appendAttempt` call, up to `METADATA_MAX_RETRIES` extra attempts, with short exponential backoff between attempts. No requeue, no `nextRetryAt`, no new queue, no scheduler.
   - *Why:* keeps Phase 6's PostgreSQL-backed claim model (Plan 001 Annex A D1) intact; the row stays `PROCESSING` for the whole retry sequence, so the Phase 11 concurrency guard continues to hold without new state.
2. **The retry loop wraps the whole attempt: validate → probe → normalise.** `FILE_NOT_FOUND` and `PERMISSION_DENIED` originate in `validateFile` (`extractor.ts`), so wrapping only probe/normalise would leave two transient codes unretried. *(Plan-review Finding 1.)*
3. **Only the final attempt persists a terminal state.** Intermediate attempts persist **no** `metadataStatus` change and **no** error fields — the row stays `PROCESSING` across backoff. Only the terminal attempt writes `READY` (clearing error fields) or `FAILED` (recording the last failure). This is what keeps "no concurrent/duplicate processing of the same media" true during backoff. *(Plan-review Finding 3.)*
4. **Classification is explicit and centralized** in one pure module, `metadata/failure-classification.ts`, keyed on the `errorCode` string only, so it is unit-testable without ffprobe/Postgres (`TESTING.md §4`) — mirroring how `classify.ts` centralizes change detection.
5. **Retry limit and backoff are configuration, not per-row.** `METADATA_MAX_RETRIES` (default **2**, per the owner directive; `0` disables retry) and `METADATA_RETRY_BACKOFF_MS` (default 250). No `maxAttempts` column.
6. **`retryCount` is persisted on `MediaFile`** (`DATA_MODEL.md §47`) so attempts are observable and survive a restart. It is **reset to 0 on every fresh claim** — both `claimOne` (`PENDING→PROCESSING`) and `reprocessOne` (`READY|FAILED→PROCESSING`) — and on success. The retry loop's bound is a **local counter**, never the persisted value, so a stale `retryCount` can never suppress retries for a re-queued row. *(Plan-review Finding 2.)* `lastRetryAt` is **not** added — no clear operational value beyond `errorAt`/`updatedAt` (`AGENTS.md §25`).
7. **Terminal failure remains deterministic.** After retries are exhausted, the **last** attempt's failure is persisted exactly as today (`WORKFLOWS.md §31`: `metadataStatus=FAILED` + error fields), and one `processedCount`/`failedCount` increment is applied per claim — the scan counts one queued file, not N attempts (`WORKFLOWS.md §31`, `DATA_MODEL.md §49`, `TESTING.md §43`).
8. **Backoff is small and bounded** (default base 250 ms, ×2 per retry, capped). It is a safety pause, not a scheduler.
9. **No metadata erasure.** `WORKFLOWS.md §15`: previous good metadata is never cleared before a new extraction succeeds — unchanged.
10. **The persistence-failure path is unchanged.** There is no `PERSISTENCE_FAILED` code emitted today; a DB write failure during the attempt returns the existing `ABORTED` outcome (no error fields written, no counter increment), so the completion guard exposes unfinished work. *(Plan-review Finding 4.)* `UNSUPPORTED_MEDIA`/`UNKNOWN` from `DATA_MODEL.md §46` are not emitted today and are covered by the fail-closed rule.

### 2.1 The automatic-retry default

`METADATA_MAX_RETRIES` defaults to **2** (the owner's stated operating point). This is the one intentional behavior change of Phase 12, and it applies **only** to codes classified TRANSIENT (§3); permanent failures still perform a single attempt. Setting `METADATA_MAX_RETRIES=0` disables automatic retry and reproduces Phase 1–11 behavior exactly. Documented in `.env.example`, `README.md`, and `WORKFLOWS.md §33`.

## 3. Failure classification table

Keyed on the `errorCode` vocabulary **actually emitted** by the current code (verified by inspection: `extractor.ts`, `metadata/ffprobe-adapter.ts`, `scan/startup.ts`). No new codes are introduced.

| errorCode | Emitted at | Class | Automatic retry? | Rationale (`WORKFLOWS.md §33`) |
| --- | --- | --- | --- | --- |
| `FFPROBE_TIMEOUT` | FFPROBE stage (`ffprobe-adapter.ts`) | **TRANSIENT** | Yes, bounded | "ffprobe timeout" is a listed potentially-transient failure |
| `FILE_NOT_FOUND` | VALIDATION stage (`validateFile`) | **TRANSIENT** | Yes, bounded | "temporary file access failure / temporary storage unavailability" — the file may reappear |
| `PERMISSION_DENIED` | VALIDATION stage (`validateFile`) | **TRANSIENT** | Yes, bounded | "temporary file access failure" |
| `FFPROBE_FAILED` | FFPROBE stage (`ffprobe-adapter.ts`) | **PERMANENT** | No | non-timeout process failure — treated as unsupported/corrupt media |
| `INVALID_PROBE_OUTPUT` | NORMALIZATION stage (`ffprobe-adapter.ts`) | **PERMANENT** | No | "invalid media structure" |
| `VALIDATION_FAILED` | VALIDATION stage (`validateFile`: path containment / not-a-regular-file) | **PERMANENT** | No | deterministic — retrying cannot help |
| `INTERRUPTED` | PERSISTENCE stage (`startup.ts` sweep) | **PERMANENT** | No | set only by the startup sweep; the row is manually reprocessable |
| `UNSUPPORTED_MEDIA`, `UNKNOWN`, *anything else* | (not emitted today) | **PERMANENT** | No | fail-closed (`AGENTS.md §19` — never retry unbounded on unknown causes) |

There is **no `PERSISTENCE_FAILED` code**; persistence failures surface as the `ABORTED` outcome (§2.10) and are never auto-retried.

**Fail-closed rule:** an unrecognized `errorCode` is **PERMANENT**. This guarantees no unbounded/looping retry and cannot regress to "retry everything".

## 4. Retry state transitions

```text
PENDING
   │
   ▼
PROCESSING            (compare-and-set claim — scan drain or manual reprocess; retryCount := 0)
   │
   ├─ attempt 1 SUCCESS ─────────────────────────► READY   (retryCount := 0, error fields cleared, lastMetadataExtractedAt=now)
   │
   └─ attempt 1 failure
        │
        ├─ PERMANENT ───────────────────────────► FAILED  (error fields persisted; retryCount unchanged; processedCount+1, failedCount+1)
        │
        └─ TRANSIENT and retriesUsed < METADATA_MAX_RETRIES
             │  (retryCount := retriesUsed; short backoff; row STAYS PROCESSING; no terminal write)
             ├─ attempt N SUCCESS ───────────────► READY
             └─ attempt N failure
                  …
        └─ TRANSIENT and retriesUsed == METADATA_MAX_RETRIES (exhausted)
             └───────────────────────────────────► FAILED  (last failure persisted; retryCount == limit; processedCount+1, failedCount+1)

Manual reprocess (Phase 11, unchanged externally):
   READY|FAILED ──(POST /media/:id/reprocess)──► PROCESSING (retryCount := 0) ──► READY | FAILED
   PENDING|PROCESSING ─────────────────────────► 409 CONFLICT (unchanged)
```

Invariants:
- The row is `PROCESSING` for the entire retry sequence (no intermediate terminal write) → **no concurrent processing of the same file**.
- Bounded: at most `METADATA_MAX_RETRIES` extra attempts → terminal in finite time (`WORKFLOWS.md §33`, `AGENTS.md §19`).
- Exactly one terminal transition from `PROCESSING` to `READY`/`FAILED` per claim, and exactly one counter increment per claim → no duplicate processing (`TESTING.md §43`).
- Restart mid-retry: `sweepInterruptedState` marks the row `FAILED`/`INTERRUPTED` (permanent, not auto-retried); it remains manually reprocessable (`WORKFLOWS.md §46`, `TESTING.md §55`).

## 5. Expected files

**New**
- `apps/api/src/metadata/failure-classification.ts` — pure `classifyExtractionFailure(code: string): "TRANSIENT" | "PERMANENT"`; single source of truth for the table above. No `stage` parameter (the classification is code-only; stage is not a signal).
- `apps/api/src/metadata/failure-classification.test.ts` — unit tests (no Postgres/ffprobe): every emitted code → expected class; unknown/empty → PERMANENT.
- `apps/api/prisma/migrations/<ts>_add_media_retry_count/migration.sql` — additive `ALTER TABLE "MediaFile" ADD COLUMN "retryCount" INTEGER NOT NULL DEFAULT 0`.
- `ADR/ADR-005-bounded-extraction-retry.md` — decision record.

**Changed**
- `apps/api/prisma/schema.prisma` — add `retryCount Int @default(0)` to `MediaFile`.
- `apps/api/src/config.ts` (+ `config.test.ts`) — add `METADATA_MAX_RETRIES` (default 2, non-negative integer) and `METADATA_RETRY_BACKOFF_MS` (default 250, positive integer); `AppConfig` extended.
- `apps/api/src/scan/extractor.ts` — restructure `appendAttempt` so the retry loop **wraps validate → probe → normalise**:
  - a private `attemptOnce(mediaFile)` performs validate/probe/normalise and persists `READY` on success (returns a discriminated result; it does **not** persist on failure);
  - on failure the loop classifies via `classifyExtractionFailure`; if TRANSIENT and the local `retriesUsed < maxRetries`, it persists only `retryCount` (row stays `PROCESSING`), awaits bounded backoff, and retries;
  - otherwise it persists the terminal `FAILED` + error fields (or `READY` on success) once;
  - the persistence-failure `ABORTED` path is preserved for the terminal write.
  Add injectable `maxRetries`, `retryBackoffMs`, and `retrySleep` (default `setTimeout`; a test seam mirroring the adapter's `spawnProcess` injection, for deterministic tests). Reset `retryCount: 0` in the `claimOne` claim update **and** the `reprocessOne` claim update. **No duplicated ffprobe logic** — one `attemptOnce` helper is reused by both the drain and the reprocess path.
- `apps/api/src/media/routes.ts` (+ `routes.test.ts`) — include `retryCount` in the media detail payload (observability; `WORKFLOWS.md §48`).
- `apps/api/src/server.ts` — pass `maxRetries`/`retryBackoffMs` from config into `ExtractionRunner`.
- `apps/web/lib/api.ts`, `apps/web/app/media/[id]/page.tsx` — surface `retryCount` on the detail page.
- `apps/api/src/scan/orchestrator.integration.test.ts`, `apps/api/src/media/reprocess.test.ts` — add the retry tests (§6); existing test helpers pass `retryBackoffMs: 0` for speed.
- Docs: `WORKFLOWS.md §33` (implemented-status note), `DATA_MODEL.md §47` (retryCount note), `README.md` + `.env.example` (new vars), `docs/plans/001-first-vertical-slice.md` Annex A D6 (superseded-in-part note), `SCOPE.md` (status note only if warranted).

## 6. Tests (focused, per the Phase 12 brief)

Unit (`TESTING.md §4`): classification table — every emitted code → expected class; unknown → PERMANENT (fail-closed). Config parsing of `METADATA_MAX_RETRIES`/`METADATA_RETRY_BACKOFF_MS` (defaults; reject negative/non-integer/empty).

Integration (real Postgres + mock adapter — existing `MockAdapter` pattern; `TESTING.md §21`, §63), with `retryBackoffMs: 0` for determinism:
1. **Retryable then success** — adapter fails `FFPROBE_TIMEOUT` on attempt 1, succeeds on attempt 2 → final `READY`, `retryCount` reset to 0, error fields null, scan `COMPLETED`. (`TESTING.md §36`)
2. **Validation-stage transient** — file absent on attempt 1 (`FILE_NOT_FOUND`), created before attempt 2 → `READY`; proves the loop wraps validate. *(Plan-review Finding 1.)*
3. **Permanent failure** — `INVALID_PROBE_OUTPUT` → single attempt, final `FAILED`, `retryCount` 0, scan `COMPLETED_WITH_ERRORS`. (`TESTING.md §37`)
4. **Retry limit / exhausted** — adapter always `FFPROBE_TIMEOUT`, `METADATA_MAX_RETRIES=2` → exactly 3 attempts, final `FAILED` with the timeout code, `retryCount == 2`, `failedCount == 1`, `processedCount == 1`. (`TESTING.md §36` bounded)
5. **Retry disabled** — `METADATA_MAX_RETRIES=0` → single attempt (preserves Phases 1–11).
6. **Concurrent processing prevented mid-backoff** — while a row is retrying (still `PROCESSING`), a manual reprocess returns `CONFLICT` and a second drain does not re-claim it; only one attempt sequence runs. *(Plan-review Finding 3.)*
7. **Exhausted → UPDATED → next scan retries again** — a `FAILED` row with `retryCount == limit` is re-queued `PENDING` and claimed; the fresh claim resets `retryCount` to 0 and retries again. *(Plan-review Finding 2.)*
8. **Manual reprocess resets retry state** — a `FAILED` row with `retryCount>0` reprocessed → `retryCount` back to 0; on success → `READY`.
9. **Counters unchanged** — one queued file yields `processedCount+1` regardless of attempt count. (`TESTING.md §43`)
10. **Restart/recovery** — a `PROCESSING` row mid-retry is swept to `FAILED`/`INTERRUPTED`, not auto-retried, and is reprocessable. (`TESTING.md §55`)
11. **Source media byte-identical** — existing `snapshotMediaTree` before/after the retry tests.

## 7. Verification (independent test-engineer)

- `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` — record exact output.
- Confirm the Phase 12 list: retryable retried within bound; permanent not auto-retried; exhausted → deterministic FAILED; successful retry → READY with cleared failure state; manual reprocessing still works; concurrency prevented (including mid-backoff); restart recovery safe; scan counters/status semantics intact; source media byte-identical; Phase 9 Docker/read-only unchanged (`git status` on `docker-compose.yml`, `Dockerfile`s, and `prisma/migrations` except the new additive one).
- Requirement→code and requirement→test mapping recorded in the final report.

## 8. Risks / notes

- **Bounded total time:** the whole retry sequence is bounded by `(1 + METADATA_MAX_RETRIES) × ffprobe timeout + Σ backoff`, so `finalize` cannot be delayed indefinitely.
- **Backoff briefly blocks the worker's claim loop** when `METADATA_WORKER_CONCURRENCY=1` (at most the backoff sum, default 250 + 500 = 750 ms). Bounded and small; concurrency stays configurable (`ARCHITECTURE.md §25`).
- **Counter reconciliation:** retries add no counter increments; `processedCount` still equals one terminal record per queued file (`TESTING.md §43`).
- **Migration is additive and recoverable** (`AGENTS.md §32`); existing rows default `retryCount=0`.
- **Scope guard:** no bulk retry, no `POST /media/:id/retry` (WORKFLOWS §51 stays deferred), no scheduling, no new entity, no duplicated extraction/ffprobe logic.
