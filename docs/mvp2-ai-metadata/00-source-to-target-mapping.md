# 00 — Source-to-Target Mapping

Phase 1 deliverable. Maps each team-repository source document to what TMIP does
with it, and why. Provenance labels: **Adopted**, **Adapted**, **Reference-only**,
**Unresolved** (see `README.md`).

Team repository root: `D:\DEVELOP\tvri-media-intelligence-platform`
Source files inspected (read-only): `docs/05`, `docs/06`, `docs/07`, `docs/08`,
`docs/09`, `docs/11`, `docs/rules.md`, `README.md`, `progress.md`.

## 1. Team sources → TMIP disposition

| Team source | Content used | Disposition | TMIP target | Rationale |
|---|---|---|---|---|
| `docs/06-media-asset-model.md` | AI Metadata field list (`summary`, `keywords`, `suggested_category`, `transcript`, `detected_language`, `scene_labels`, `detected_objects`, `ai_confidence`) | **Adapted** | `01-ai-metadata-contract.md` | Field *semantics* adopted; names/typing aligned to TMIP's actual `AiResult.payload` keys. `scene_labels`/`detected_objects`/`ai_confidence` are not implemented → recorded as deferred/proposal, not requirement. |
| `docs/06` Asset Status (`DISCOVERED→PROCESSING→PENDING_REVIEW→READY→ARCHIVED`), Asset ID `TVRI-DKI-VID-YYYY-NNNNNN` | Asset identity + approval workflow | **Reference-only** | not adopted | TMIP uses `MediaFile` + `metadataStatus`/`aiStatus`; no Asset ID / PENDING_REVIEW model. Adopting would be an architectural change (see `06-consistency-report.md`). |
| `docs/07-media-catalog-specification.md` | AI Metadata list (Summary, Keywords, Transcript, Language, Suggested Category, Suggested Tags, OCR Result, Scene Description); search fields incl. OCR/Transcript | **Adapted** (fields) / **Reference-only** (Media Catalog) | `01-ai-metadata-contract.md` | The AI field list corroborates `docs/06`. "Media Catalog" as a component is not adopted (TMIP's catalog = PostgreSQL `MediaFile`). |
| `docs/rules.md` | Metadata rules (§3), QC rules (§4), 16-row QC checklist (§5), finding output format (§6), internal TVRI ingest/asset rules (§7) | **Adapted** | `03-rules-to-fields-mapping.md`, `reference/team-ai-rules-extract.md` | Rules mapped onto the fields TMIP actually produces; rules requiring fields TMIP does not produce are marked Unresolved. Regulation citations preserved verbatim. |
| `docs/05-business-workflow.md` | AI integration points, AI vs human responsibilities, automation scope | **Adapted** | `02-enrichment-workflow.md` | Workflow *shape* (discovery → metadata → review) aligns with TMIP; the BullMQ/queue mechanics are not adopted. |
| `docs/09-ai-agent-architecture.md` | Multi-agent architecture (Orchestrator, Discovery/Metadata/Search/Recommendation agents) | **Reference-only** | not adopted | Explicitly excluded by this task's constraints. Recorded in `06-consistency-report.md` as a future proposal only. |
| `docs/08-knowledge-base-specification.md` | Knowledge Base, semantic relationships, confidence | **Reference-only** | not adopted | Semantic search / embeddings are out of TMIP v1 scope (`SCOPE.md` §27.3). Recorded as future. |
| `docs/11-open-questions.md` | Question register (AI-001…005, MQ-001…005, etc.) | **Adapted** | `05-open-decisions.md` | Team questions relevant to AI enrichment carried over and re-scoped to TMIP; TMIP-specific new decisions added. |
| `README.md`, `progress.md` (team) | Implementation status of the team project | **Reference-only** | — | Used only to distinguish *planned* vs *built* on the team side (e.g. team `progress.md`: Scene Detection ❌, OCR ❌). Not a TMIP requirement. |

## 2. What was verified on the TMIP side (facts, not assumptions)

TMIP implementation state used to build the contract (all read from code):

| Area | Fact | Evidence |
|---|---|---|
| AI lifecycle enum | `AiStatus { PENDING, PROCESSING, READY, FAILED, SKIPPED, CANCELLED }` | `apps/api/prisma/schema.prisma:37-44` |
| AI stage enum | `AiStage { TRANSCRIPTION, SUMMARY, KEYWORDS, CLASSIFICATION, OCR }` | `apps/api/prisma/schema.prisma:46-52` |
| Stage status | `AiStageStatus { READY, FAILED }` | `apps/api/prisma/schema.prisma:54-57` |
| Per-stage result | `AiResult{ id, mediaFileId, stage, status, payload Json?, errorCode?, errorMessage?, attemptedAt, createdAt, updatedAt }`, unique `(mediaFileId, stage)` | `apps/api/prisma/schema.prisma:130-145` |
| MediaFile AI columns | `aiStatus, aiPartial, aiAttempt, aiExternalJobId, aiErrorCode, aiErrorMessage, aiErrorAt, aiProcessedAt, aiCancelRequestedAt` | `apps/api/prisma/schema.prisma:99-124` |
| Migrations | `20261007140000_add_ai_enrichment`, `20261009090000_add_ai_cancellation` | `apps/api/prisma/migrations/` |
| Pipeline order | TRANSCRIPTION → (SUMMARY, KEYWORDS, CLASSIFICATION from one `/summarize`) → OCR | `apps/api/src/ai/runner.ts:387-416` |
| Endpoints | `POST /media/:id/ai-reprocess`, `POST /media/:id/ai-cancel`; AI fields on `GET /media` and `GET /media/:id` | `apps/api/src/ai/routes.ts`, `apps/api/src/media/routes.ts` |
| Config | 11 `AI_*` vars; **no** `LLM_*` in the API (LLM config lives in the Python processor) | `apps/api/src/config.ts:12-21,226-258`; `ai-processor/app/handlers/openrouter.py` |
| Tests | 8 AI test files, 96 `it(...)` declarations; no web test runner | `apps/api/src/ai/*.test.ts`; `apps/web/package.json` |

## 3. MVP 1 (must be preserved)

Verified present and untouched by this task: `apps/api/src/scanner.ts`,
`scan/classify.ts`, `scan/orchestrator.ts`, `scan/extractor.ts`,
`metadata/ffprobe-adapter.ts`, `metadata/normalizer.ts`, `media/routes.ts`,
`paths.ts`. AI is an additive layer that never writes `metadataStatus`
(`ADR-006`). No MVP 1 file was modified by this documentation task.

## 4. Terminology reconciliation

The same concept is named differently across team docs and TMIP code. The
**canonical** name (rightmost) is what `01-ai-metadata-contract.md` uses.

| Concept | Team `docs/06` | Team `docs/07` | TMIP code | Canonical (TMIP) |
|---|---|---|---|---|
| Summary | `summary` | Summary | `SUMMARY.payload.summary` | `summary` |
| Keywords | `keywords` | Keywords | `KEYWORDS.payload.keywords` | `keywords` |
| Category | `suggested_category` | Suggested Category | `CLASSIFICATION.payload.category` | `category` |
| Transcript | `transcript` | Transcript | `TRANSCRIPTION.payload.full_text` + `.segments` | `full_text` + `segments` |
| Language | `detected_language` | Language | `TRANSCRIPTION.payload.language` | `language` |
| OCR | (absent) | OCR Result | `OCR.payload.raw_text` (+ `presenter`) | `raw_text`, `presenter` |
| Scene | `scene_labels`, `detected_objects` | Scene Description | (not implemented) | deferred (Phase 15) |
| Confidence | `ai_confidence` | — | (not implemented) | Unresolved (proposal) |

## 5. Nothing was copied blindly

No team document was copied verbatim into TMIP. The two `reference/` extracts are
**adapted** (trimmed to AI-relevant content, re-labelled, citations preserved) and
are explicitly **reference-only** — they do not create TMIP requirements.
