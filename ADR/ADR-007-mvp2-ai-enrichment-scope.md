# ADR-007: MVP 2 — AI Metadata Enrichment as an Additive Scope Layer

## Status

Accepted (scope decision, 2026-10-13).

This ADR records a **scope layer**, not a new architecture. The architecture of
AI enrichment is already decided in `ADR-006` and implemented (see Status
reconciliation in that ADR). This ADR answers one question only: **is AI metadata
enrichment an official TMIP milestone, and how does it relate to MVP 1?**

## Context

TMIP MVP 1 (technical metadata pipeline: DISCOVER → DETECT CHANGE → EXTRACT →
STORE → DISPLAY) is complete and tested. `SCOPE.md §2` and `PRD.md §28` define v1
narrowly, and `SCOPE.md §27.1/§27.2` plus `PRD.md §22` list AI capabilities
(descriptions, summaries, keywords, transcription, OCR, LLM integration) as **out
of v1 scope**. `SCOPE.md §28` lists "AI metadata" and "transcription" as
**deferred**.

At the same time, an AI enrichment capability was built and merged as an additive
v2 feature under `ADR-006` (commits up to `bc6d79f`): per-stage `AiResult` rows,
an `aiStatus` lifecycle on `MediaFile`, a transcription → summary/keywords/
classification → OCR pipeline driven by a separate Python processor, bounded
classified retry, durable cancellation, and safe read-only media handling.

This created a documentation gap: the capability is implemented, but no document
declares it an official milestone, and the scope documents still describe it as
"out of scope / deferred". The gap was catalogued in
`docs/mvp2-ai-metadata/06-consistency-report.md` (Conflict A) and the decision was
reviewed in `docs/mvp2-ai-metadata/05-open-decisions.md` (OD-13).

The design questions for this ADR:

1. Should AI enrichment be an official milestone at all, or remain an
   undocumented optional capability?
2. If official, does adopting it change MVP 1 guarantees or existing
   architecture decisions?
3. Where is the canonical definition of the AI metadata contract kept?

## Decision

### 1. MVP 2 is established as an additive scope layer

AI metadata enrichment is **MVP 2**: an official milestone that adds a capability
**on top of** the MVP 1 pipeline. It is defined as a *layer*, not a replacement:
MVP 1 continues to be a complete, independently valuable product.

MVP 2 delivers (all already implemented; see `docs/mvp2-ai-metadata/02`):

- transcription, summary, keywords, content classification, and lower-third OCR
  for a media file;
- a durable per-media AI lifecycle (`PENDING | PROCESSING | READY | FAILED |
  SKIPPED | CANCELLED`) with partial-result semantics;
- bounded, classified retry and durable cancellation;
- AI fields surfaced on the existing media list/details endpoints.

### 2. MVP 1 guarantees are preserved explicitly

Adopting MVP 2 **does not** change:

- The MVP 1 pipeline, its scope, or its acceptance criteria (`SCOPE.md §35`,
  `PRD.md §25`, `PRD.md §28`).
- The core architecture decisions in `AGENTS.md §35`.
- Media-safety guarantees (`ADR-002`: source media read-only; no writes to the
  media tree).
- The relationship between AI and technical metadata: **AI never writes
  `metadataStatus`**; the ffprobe pipeline is unaffected whether AI is enabled or
  not (`ADR-006`).

MVP 1 remains shippable and verifiable with MVP 2 disabled
(`AI_ENABLED=false`, the effective default — see §5).

### 3. MVP 2 is opt-in and inert by default

`AI_ENABLED` defaults to **false** (`docker-compose.yml`, `.env.example`, and
`config.ts` agree). With it unset, the subsystem is inert: every media row simply
stays `aiStatus=PENDING` ("not processed"). Enabling AI is an explicit operator
decision, not a default behaviour of a scan.

### 4. Existing architecture decisions are not superseded

This ADR introduces **no** architectural change. In particular it does **not**:

- adopt the team's multi-agent architecture, BullMQ/Redis, Media Catalog/Asset ID
  model, or Knowledge Base (`docs/mvp2-ai-metadata/00` dispositions: reference-only);
- introduce scene detection / CLIP / YOLO / object detection (deferred to a future
  Phase 15; `ADR-006 §16`; `SCOPE.md §27.1`);
- add semantic search, embeddings, or a vector store (`SCOPE.md §27.3`);
- add human-metadata capture, approval workflows, or automated QC.

Those remain out of MVP 2 and would each require their own ADR.

### 5. The canonical AI metadata contract lives in one place

The field contract for AI metadata is defined once, in
`docs/mvp2-ai-metadata/01-ai-metadata-contract.md`, and is referenced (not
duplicated) by other documents. `DATA_MODEL.md`, `WORKFLOWS.md`, and `TESTING.md`
document *storage*, *runtime flows*, and *verification strategy* respectively and
should point at the contract rather than restate field definitions
(`AGENTS.md §33`).

## Consequences

**Positive**

- MVP 2 has an official, reviewable scope; the implementation is no longer
  undocumented relative to the scope documents.
- MVP 1 guarantees remain explicit and unchanged.
- One canonical place for the AI metadata contract avoids duplicated/conflicting
  definitions.

**Negative / accepted cost**

- Two scope layers must be kept distinct in future documents; the terminology is
  standardised in §Terminology below.
- AI quality (LLM/OCR) is non-deterministic; MVP 2 records fields and shape, not
  exact text. Quality evaluation strategy is recorded separately
  (`docs/mvp2-ai-metadata/05-open-decisions.md` OD-07).

## Scope boundary

MVP 2 is an **additive layer**. A change belongs to MVP 2 only if it enriches
metadata about an existing media file without altering the MVP 1 pipeline or media
safety posture. Anything else requires a new ADR (see §4).

## Terminology (standardised)

- **MVP 1** — the technical metadata pipeline and its acceptance criteria.
- **MVP 2** — the AI metadata enrichment layer defined here.
- **Phase 14 / Phase 15** — the historical implementation-plan phase names used
  by `docs/plans/006` and `ADR-006`. They map to implementation work, not to
  product scope. Going forward, **MVP 2** is the product-scope name; existing
  references to "Phase 14" in ADR-006 / Plan 006 are retained for history.

## Unresolved decisions (recorded, not decided here)

| ID | Topic | Where recorded |
|---|---|---|
| OD-07 | Golden-dataset and quality evaluation strategy for AI enrichment. | `docs/mvp2-ai-metadata/05-open-decisions.md` |
| NEW-4 | The AI web UI has no automated test runner; UI coverage is a known gap. | `docs/mvp2-ai-metadata/06-consistency-report.md` |

> **OD-11 (resolved 2026-10-13):** OCR sampling was reconciled — the code was
> returned to the five-frame grid that `ADR-006 §20` specifies. See the resolution
> note in `ADR-006 §20` and `docs/mvp2-ai-metadata/05-open-decisions.md`.

## Related documents

- `AGENTS.md §34` (ADR rule), `§35` (core architecture decisions, unchanged), `§38`
- `ADR-006` (AI processor integration architecture — the architecture this scope adopts)
- `SCOPE.md` (MVP 2 scope section), `PRD.md` (MVP 2 requirements section)
- `docs/mvp2-ai-metadata/` (contract, workflow, rules mapping, open decisions)
- `docs/plans/006-ai-processor-integration.md` (Phase 14 implementation plan)
