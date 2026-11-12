# 04 — MVP 2 Scope and Requirements (AI Metadata Enrichment)

Status: **proposed** scope for approval. This document defines what MVP 2 is, and
is explicit about what it is not. It does not begin implementation.

## 1. Context

MVP 1 (technical metadata pipeline: DISCOVER → DETECT CHANGE → EXTRACT → STORE →
DISPLAY) is complete and tested. MVP 2 adds **AI metadata enrichment** as an
**additive** capability layered on top of the persisted media identity.

The AI enrichment **already exists in code** as an additive v2 capability
(`ADR-006`, `docs/plans/006`, `README.md`) but is **disabled by default** and is
**not** part of the declared v1 scope (`SCOPE.md` lists AI/transcription/OCR as out
of scope). MVP 2 formally scopes it; the documentation consequences are in
`06-consistency-report.md` and `07-document-update-list.md`.

## 2. MVP 2 goal

Enable TMIP to attach AI-generated enrichment metadata (transcript, summary,
keywords, content category, lower-third OCR) to a media file, durably and safely,
without changing the MVP 1 pipeline or media safety posture.

## 3. In scope (MVP 2)

| # | Requirement | Status in code |
|---|---|---|
| R1 | Per-stage AI result storage (`AiResult`, one row per `(mediaFileId, stage)`) | Implemented |
| R2 | AI lifecycle on `MediaFile` (`aiStatus`, `aiPartial`, `aiAttempt`, error fields, `aiProcessedAt`, `aiCancelRequestedAt`) | Implemented |
| R3 | Transcription + LLM (summary/keywords/classification) + OCR stages over the internal processor | Implemented |
| R4 | Bounded, classified retry (TRANSIENT vs PERMANENT) | Implemented |
| R5 | Durable manual cancellation | Implemented |
| R6 | Manual reprocess endpoint + restart recovery | Implemented |
| R7 | Platform-agnostic LLM provider config (generic `LLM_*`) | Implemented |
| R8 | Media safety: contained absolute path, read-only mount, internal-only network | Implemented |
| R9 | AI fields surfaced on media list + detail | Implemented |
| R10 | Canonical AI metadata contract | **This documentation set** (`01-ai-metadata-contract.md`) |
| R11 | Enrichment workflow + rules mapping | **This documentation set** (`02`, `03`) |

## 4. Explicitly out of scope for MVP 2

- Scene detection / CLIP / YOLO / object detection / scene descriptions
  (`SCOPE.md §27.1`, `ADR-006 §16` — deferred to a future Phase 15).
- Semantic search, embeddings, vector databases, knowledge graph
  (`SCOPE.md §27.3`; team `docs/08` is reference-only).
- Multi-agent architecture, orchestrator, recommendation agent (team `docs/09`
  reference-only; would need its own ADR).
- BullMQ/Redis, Media Catalog component, Asset ID model, Knowledge Base
  (team architecture; explicit exclusions in this task).
- Automatic file operations of any kind (rename/move/delete/transcode).
- Automated QC verdicts / compliance findings (see `03`; requires fields TMIP does
  not produce).
- Thumbnails/proxy generation (`SCOPE.md §27.4`).
- Human-entered metadata capture (`05-open-decisions.md` OD-06).

## 5. Functional requirements (detail)

### FR-1 Result model
- One AI result row per stage, keyed `(mediaFileId, stage)`; `payload` JSONB.
- Contract: `01-ai-metadata-contract.md` §3.
- Re-run upserts; no duplicates.

### FR-2 Lifecycle
- States and transitions exactly as `02-enrichment-workflow.md` §5.
- `CANCELLED` is terminal and not a failure.

### FR-3 Trigger
- Manual reprocess only (current). Automatic-on-READY is OD-01 (proposal).

### FR-4 Failure handling
- Per-file, per-stage isolation; classification fail-closed.
- Partial results preserved; `aiPartial=true`.

### FR-5 Retry
- Bounded; configurable; no infinite loops.

### FR-6 Cancellation
- Durable intent; cooperative stop between stages; late writes blocked.

### FR-7 Safety
- Contained path only; read-only media; internal network; no secrets in repo.

### FR-8 Observability
- AI status/fields on list + detail; processor `/health`.

## 6. Non-functional requirements

- **Preserve MVP 1:** no change to `metadataStatus` semantics or skeleton.
- **Additive schema/API only** (`AGENTS.md §32`).
- **Configuration via env, Zod-validated**; safe defaults; `AI_ENABLED=false`.
- **Conservative concurrency** (`AI_CONCURRENCY=1` default).
- **Testability:** AI paths behind the adapter boundary, mockable.

## 7. Determinism & quality note (honest)

- LLM outputs are **non-deterministic in wording**; the contract defines fields and
  shape, not exact text. No byte-for-byte quality target is claimed.
- Contract/config parity with the team pipeline is verified by tests
  (`ai-processor/tests/test_team_parity.py`); **live output/quality parity is
  pending** (team sample media + a real LLM key) and is not claimed.
- Recording a fixed content category is possible; the taxonomy differs from the
  team's rule list (OD-05).

## 8. Acceptance intent (not a test result)

MVP 2 is acceptable when, for a media file with `AI_ENABLED=true`:

1. A manual reprocess drives all five stages and reaches a terminal state
   (`READY` / `READY+aiPartial` / `FAILED` / `CANCELLED`) with correct fields.
2. No AI path writes `metadataStatus`; MVP 1 behavior is unchanged.
3. Media safety invariants hold (contained path, read-only, internal-only).
4. The AI test suites pass and the container builds + `/health` responds.

> Any numeric quality threshold, golden dataset, or "parity = X%" target is
> **not** set here (insufficient evidence). See `05-open-decisions.md` OD-07.

## 9. Deliverables of this planning phase

The `docs/mvp2-ai-metadata/` set. No code, schema, config, or migration changes.
