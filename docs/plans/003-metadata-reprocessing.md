# TMIP Plan 003 — Phase 11: v1.1 Hardening — Metadata Reprocessing & Failure Recovery

- **Status:** Approved (owner directive, 2026-10-06)
- **Scope:** Explicit, user-initiated metadata reprocessing only. No automatic retry, no retry counters, no backoff, no transient/permanent classification, no authentication, no v2 scope.
- **Review basis:** `AGENTS.md`, `PRD.md` ("8.5 Failed Extraction Visibility", "16.3 Recovery"), `SCOPE.md` ("13. Manual Scan Triggering", "20. Retry Handling"), `ARCHITECTURE.md`, `DATA_MODEL.md` ("15. Preserve Last Known Good Metadata", "22–24 MetadataExtraction"), `WORKFLOWS.md` ("31. Failed Metadata Extraction", "32. Failure Isolation", "51. Manual Retry Workflow", "52. Manual Reprocess Workflow"), `TESTING.md`, `docs/plans/001-first-vertical-slice.md` (Annex A D6), `docs/plans/002-linting-engineering-quality.md`.
- **Baseline:** Phases 1–10 complete and verified (97/97 tests, typecheck, lint, build all pass). Repo has uncommitted Phase 10 changes.

**Mission:** A technical staff member can explicitly request metadata reprocessing for a single existing media file (especially one whose extraction FAILED), have the existing extraction pipeline re-run it, and see the resulting PROCESSING / READY / FAILED state in the UI — with concurrent attempts on the same file safely rejected.

---

## 1. Relevant documented requirements used

- **AGENTS.md §10 "Discovery Is Not Extraction"** — extraction occurs when "the user explicitly requests reprocessing". This phase implements exactly that clause.
- **AGENTS.md §18–19** — failure must be recorded with category/message/stage/timestamp; retries bounded. Explicit manual reprocessing is bounded by user action; **no** automatic retry is added.
- **AGENTS.md §8 Separation of Responsibilities** — the API handler must not run ffprobe inline; extraction stays in the worker (`ExtractionRunner`).
- **PRD.md §8.5** — failed files remain visible with failure info. **PRD.md §16.3** — "A failed metadata extraction must remain recoverable. The system should allow the file to be retried later."
- **WORKFLOWS.md §52 "Manual Reprocess Workflow"** — `user requests reprocess → create extraction attempt → queue metadata job`, and "This is different from a normal incremental scan. Normal scans must still skip unchanged files."
- **WORKFLOWS.md §15 "Preserve Last Known Good Metadata"** — on reprocess, previous metadata must not be erased before a new extraction succeeds.
- **WORKFLOWS.md §31 / §32** — FAILED sets `metadataStatus=FAILED` + error fields; one failure must not crash the worker.
- **SCOPE.md §13** — manual triggering is in scope; reprocessing is not in the "explicitly out of scope" list (v2 items are AI/RBAC/etc.).
- **Plan 001 Annex A D6** — manual retry/reprocess endpoints were deferred from the first slice; this phase lifts that specific deferral, nothing else.
- **DATA_MODEL.md §22–24** — MetadataExtraction is an *optional* history entity ("suggested fields"; the preferred implementation is chosen for simplicity, §21). v1 intentionally records extraction history on `MediaFile` (error fields + `lastMetadataExtractedAt`); this phase does **not** add a new history table (avoids scope/abstraction creep — AGENTS.md §25).

## 2. State-transition design

Chosen model: **claim-first, isolated, non-queued, scan-independent.**

On `POST /media/:id/reprocess` the API performs a single atomic conditional claim, then detaches the work (mirroring the existing scan-start pattern in `scan/routes.ts`):

```text
PENDING     → 409 Conflict  (already awaiting processing; a scan will pick it up)
PROCESSING  → 409 Conflict  (already being processed — concurrent guard)
READY       → PROCESSING    (atomic claim succeeds) → READY | FAILED
FAILED      → PROCESSING    (atomic claim succeeds) → READY | FAILED
```

- The claim is a `mediaFile.updateMany({ where: { id, metadataStatus: { in: ["READY","FAILED"] } }, data: { metadataStatus: "PROCESSING" } })`; `count === 1` means this request owns the attempt. This is the same compare-and-set idiom already used by `ExtractionRunner.claimOne` (`extractor.ts:125-128`), so it is safe under concurrency without a new mechanism.
- `PROCESSING`/`PENDING` are **rejected** rather than overwritten, satisfying "prevent conflicting concurrent processing of the same media file".
- The response is `202 Accepted` with `{ mediaFileId, metadataStatus: "PROCESSING" }`; the client polls `GET /media/:id` for the terminal state (same polling model as scans — `ARCHITECTURE.md §37`).
- On success the runner sets `READY` and clears `errorCode/errorMessage/errorStage/errorAt`, keeps `technicalMetadata`/`rawProbeData`, updates `lastMetadataExtractedAt` (existing success branch of `processOne`, reused via the shared core — section 4/§R1).
- On failure the runner sets `FAILED` and records the new error fields; **previous metadata stays stored** (WORKFLOWS.md §15) — the existing failure branch already writes only error fields, leaving normalised columns/JSONB intact.
- `lastSeenScanId` is untouched by reprocess; the attempt is **not** attributed to a ScanJob (there is no active scan). Counters are therefore not incremented — reprocess is not a scan, matching WORKFLOWS.md §52. This is an intentional, documented deviation from "create extraction attempt" (no history entity in v1, §1 above).

### 2.1 Safety argument (corrected)

The scan orchestrator's completion guard is **counter-based**, not state-based: `finalize` (`orchestrator.ts:105`) guards only on `scan.processedCount < scan.queuedCount` and the `RUNNING → terminal` transition. **No code path queries `MediaFile.metadataStatus` during finalize.** Therefore a reprocess that deliberately does not touch `queuedCount`/`processedCount` is invisible to the scan completion guard. Safety rests on two facts, not on a state-checking guard:

1. `ExtractionRunner.claimOne` (`extractor.ts:120`) claims **only** `PENDING` rows, so a scan drain will never double-process a row that a reprocess holds in `PROCESSING`.
2. The orchestrator's observation paths (`persistObservation` UNCHANGED/UPDATED, `orchestrator.ts:175-196`) update only `lastSeenAt`/`lastSeenScanId`/`status` — they never write `metadataStatus` — so a concurrent scan leaves a reprocess `PROCESSING` row intact.

**Restart window:** if the process dies mid-reprocess, `sweepInterruptedState` (`startup.ts`) marks the row `FAILED`/`INTERRUPTED` — recoverable, and the file can simply be reprocessed again. Covered by a test (§5).

## 3. Requirements → deliverables

| # | Requirement (owner) | Deliverable |
|---|---|---|
| R1 | Review existing extraction/failure transitions, reuse runner | Reuse the existing `ExtractionRunner` extraction core by refactoring `processOne` into a shared `appendAttemptCore` used by both `processOne` (drain, with counters) and the new `reprocessOne` (without counters) — no duplicated ffprobe logic |
| R2 | Add API operation to reprocess existing media | `POST /media/:id/reprocess` in `apps/api/src/media/routes.ts`; new `MediaReprocessor` in `apps/api/src/media/reprocess.ts` delegating to a new public `ExtractionRunner.reprocessOne(mediaFileId)` |
| R3 | Safe state transitions incl. FAILED/READY → PROCESSING | Atomic claim in `reprocessOne` (section 2) |
| R4 | Clear/update previous error fields correctly | Reuse existing success/failure branches in `ExtractionRunner` (they already null/overwrite error fields) |
| R5 | Prevent conflicting concurrent processing | Conditional `updateMany` guard → 409 |
| R6 | Expose reprocess action on media detail page | Button on `apps/web/app/media/[id]/page.tsx`; API client `reprocessMedia(id)` in `apps/web/lib/api.ts` |
| R7 | Show processing/success/failure state clearly | Client component polls while `PROCESSING`; shows outcome + existing failure card |
| R8 | Focused tests (success, failure, invalid/nonexistent, concurrent) | `media/reprocess.test.ts` (fake-db state transitions) + route tests + integration test in `scan/` |
| R9 | Preserve source-media safety and Phase 1–10 behaviour | No writes to media tree; only additive route + UI; runner change is additive/non-breaking |
| R10 | Documentation consistency | Correct `README.md:176` **and** `README.md:203-206`; WORKFLOWS.md §52 status note; Plan 001 Annex A D6 supersession note; `ADR/ADR-004-metadata-reprocessing.md` |

## 4. Implementation plan (files)

1. **`apps/api/src/scan/extractor.ts`** — split `processOne` (`extractor.ts:135-183`) into:
   - a shared private `appendAttempt(mediaFile)` that runs validate → probe → normalise → persist success **or** persist failure (unchanged logic, minus counters), and
   - the existing `processOne(mediaFile, activeScanId)` = `resolveCounterScan` + `appendAttempt` + `incrementCounters` (drain behaviour unchanged).
   Add `public async reprocessOne(mediaFileId: string): Promise<"STARTED" | "CONFLICT" | "NOT_FOUND">` that:
   (a) loads the row (`NOT_FOUND` if absent),
   (b) atomically claims `READY`/`FAILED → PROCESSING` via `updateMany` (`CONFLICT` / no-op if `count === 0`; `PENDING` and `PROCESSING` fall here),
   (c) calls `appendAttempt` **without** `resolveCounterScan` and **without** `incrementCounters` (no `activeScanId` is ever computed).
2. **`apps/api/src/media/reprocess.ts`** (new) — `MediaReprocessor` interface + `createExtractionReprocessor(extractor)` implementation that delegates to `reprocessOne`. The reprocessor is built in `server.ts` from the existing `ExtractionRunner` (same adapter/normalizer/`storageRoot`), so no ffprobe wiring is duplicated.
3. **`apps/api/src/media/routes.ts`** — extend the router deps with optional `reprocessor?: MediaReprocessor`; add `POST /media/:id/reprocess` (Zod-validated id param, consistent with `scan/routes.ts` style): `202` `{ mediaFileId, metadataStatus: "PROCESSING" }` on accept, `404` unknown id, `409` conflict, `500` unexpected; detaches via `void reprocessor.reprocessOne(id)` mirroring the detached scan-start pattern.
4. **`apps/api/src/app.ts`** — add optional `reprocessor?: MediaReprocessor` to `AppDependencies`/`CreateAppOptions` and pass it into `createMediaRouter` (mirrors the optional `orchestrator` threading at `app.ts:16-49,87`).
5. **`apps/api/src/server.ts`** — construct the reprocessor from the existing `ExtractionRunner` and pass it into `createApp({ prisma, config, orchestrator, reprocessor })`. **Required** — without this the endpoint would 202 and do nothing.
6. **`apps/web/lib/api.ts`** — `reprocessMedia(id): Promise<{ mediaFileId: string; metadataStatus: string }>`.
7. **`apps/web/app/media/[id]/page.tsx`** (+ small `"use client"` action component) — "Reprocess metadata" button; while `PROCESSING`, poll `getMediaDetail` on the existing `setInterval` idiom (`page.tsx:68-72`, cleared on terminal status); surface errors; refetch to show new metadata; keep the existing FAILED failure card.
8. **Docs** — `README.md:176` and the `README.md:203-206` manual-SQL workaround; WORKFLOWS.md §52 status note; Plan 001 Annex A D6 supersession note; new `ADR/ADR-004-metadata-reprocessing.md` (AGENTS.md §34).

## 5. Verification plan (independent test-engineer)

Commands: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`.

**Unit (no DB):**
- Pure decision-table test for the claim: `READY`/`FAILED` → PROCESSING (accepted); `PENDING`/`PROCESSING` → rejected (409). Route test uses an injected fake `reprocessor` via the `AppDependencies` idiom (`scan/routes.test.ts:3-4`) so the route is testable without Prisma; the `media/routes.test.ts` fake (`createMediaDatabase`, lines 76-87) gains `updateMany`.

**Integration (real `tmip_test` DB + `MockAdapter`, `TEST_DATABASE_URL`; no Docker changes):**
- failed media (`FAILED`) reprocessed → reaches `READY`, metadata updated, error fields cleared (`errorCode/errorMessage/errorStage/errorAt` null);
- reprocess of a FAILED file whose probe fails again → records the **new** failure;
- concurrent reprocess while `PROCESSING` → rejected (409) and only one attempt runs;
- nonexistent id → 404; `PENDING` → 409;
- **idempotency:** reprocess does not change any `ScanJob` counters (`queuedCount/processedCount/failedCount`), and a subsequent normal scan still classifies the file `UNCHANGED` and skips re-extraction;
- **concurrent-scan safety:** a scan running while a row is held `PROCESSING` by reprocess does not reset that row's `metadataStatus` on finalize;
- **restart window:** reprocess in flight + `sweepInterruptedState` → row becomes `FAILED`/`INTERRUPTED` (recoverable);
- **source-media safety:** `snapshotMediaTree` before/after reprocess is byte-identical;
- Phase 9 Docker artifacts (`docker-compose.yml`, Dockerfiles, `prisma/`) unchanged (`git status`).

Requirement→verification mapping and exact command output to be recorded in the final report.

## 6. Notes / risks

- **Counter semantics:** reprocess does not touch `ScanJob` counters and does not write `lastSeenScanId`; this is deliberate (§2, §2.1). Leaving `lastSeenScanId` untouched is precisely why a subsequent incremental scan still classifies by `fileSize`/`modifiedAt` (`classify.ts`) and skips unchanged files — Phase 1–10 idempotency preserved.
- **UI polling** uses the existing client-side polling pattern; no realtime infrastructure (out of scope).
- **Concurrency guard races:** the compare-and-set `updateMany` guarantees a single claimer even under simultaneous requests; the loser receives 409.
- **Scope guard:** a reprocess on a non-video/unsupported row is still allowed because the row already exists (no extension re-validation needed); reprocess never re-scans or re-discovers.
