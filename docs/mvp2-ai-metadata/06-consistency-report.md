# 06 — Documentation Consistency Report

Status: **findings + resolutions**. Originally a report of conflicts; the MVP 2
alignment (2026-10-13) resolved Conflicts A, B, and D and partially addressed the
documentation gaps. Conflict C (OCR sampling) remains open. Historical findings are
retained below with a **Resolution** line.

## 1. Conflict A — AI is "out of scope" but implemented and enabled-able

| Aspect | Evidence |
|---|---|
| Scope says out | `SCOPE.md §27.1` (AI-generated descriptions, automatic summaries, content understanding, video classification, object detection, scene detection, AI tagging, AI-generated keywords, LLM integration) and `§27.2` (transcription, speech-to-text, OCR). |
| PRD says out | `PRD.md §22` (speech-to-text, AI-generated descriptions, OCR, object detection, scene recognition, automatic tagging). |
| Deferred list | `SCOPE.md §28` lists "AI metadata" and "transcription" under **Deferred**. |
| But implemented | `apps/api/src/ai/*`, `AiResult`, `aiStatus`, migrations `20261007140000_add_ai_enrichment`, `20261009090000_add_ai_cancellation`. |
| Framed as v2 | `README.md` §"AI enrichment (additive v2 capability)"; `ADR-006` ("additive v2 architecture that does not change v1 scope"). |

**Nature of the conflict:** not a technical bug — a *documentation/scope* framing.
AI is deliberately built as additive v2, but SCOPE/PRD still list it as out of
scope and the ADR header still said Phase 14 was "not yet implemented".

**Resolution (2026-10-13):** MVP 2 is now an official *additive scope layer*.
`ADR/ADR-007-mvp2-ai-enrichment-scope.md` establishes it; `SCOPE.md §37` and
`PRD.md §29` define MVP 2 scope/requirements; notes in `SCOPE.md §27/§28` and
`PRD.md §22` state that the covered capabilities belong to MVP 2 while remaining
outside **v1**. v1 scope text and acceptance criteria are unchanged. ADR-006 and
Plan 006 status wording was reconciled with the implemented state.

## 2. Conflict B — `AI_ENABLED` default mismatch

| Aspect | Evidence |
|---|---|
| Compose default | `docker-compose.yml` `AI_ENABLED: ${AI_ENABLED:-false}`. |
| `.env.example` | `AI_ENABLED=false`. |
| ADR-006 §11 | disabled by default. |
| config.ts | `parseAiEnabled(undefined)` → `false`. |
| Operator `.env` | local gitignored `.env` sets `AI_ENABLED=true` (operator override). |

**Resolution (2026-10-13):** confirmed `false` is the tracked default and `true` is
an explicit operator override; documented in `01-ai-metadata-contract.md §2a`
(OD-12 resolved).

## 3. Conflict C — ADR-006 §20 decision vs code

| Aspect | Evidence |
|---|---|
| ADR-006 §20 | "Decision: the five-frame strategy is retained unchanged." |
| Code (before fix) | `ai-processor/app/handlers/ocr.py` used a 14-frame grid (P5 experiment). |
| P4/P5 measurement | A wider grid did not reliably improve detection (5- and 14-frame each caught 0 of 3 verified bursts). |

**Resolution (2026-10-13):** the code was **reverted to the five-frame grid**
(`SAMPLE_FRACTIONS = (0.10, 0.30, 0.50, 0.70, 0.90)`), consistent with the ADR
decision. A regression assertion pins the adopted fractions
(`ai-processor/tests/test_ocr.py`). ADR-006 §20 carries the resolution note. OD-11
is closed. No detection-accuracy claim is made for either grid.

## 4. Conflict D — category taxonomy mismatch

| Aspect | Evidence |
|---|---|
| TMIP categories | `CONTENT_CATEGORIES` (25 values incl. Kuliner, Vlog, Talkshow, Dokumenter…). |
| Rule-doc categories | `rules.md §3.3` broadcast categories (Berita/Pendidikan/…) with Ps 36(2). |

**Resolution (2026-10-13):** resolved by clarifying the contract — TMIP's
`category` is a **content-genre label for discovery**, explicitly **not** a
regulatory classification; the mapping is deferred to a future QC capability (out
of MVP 2). Recorded in `01-ai-metadata-contract.md §3.4` (OD-05 resolved).

## 5. Non-conflicts (verified consistent)

- `ADR-006` §8 (per-stage `AiResult`) matches the Prisma model.
- `README.md` AI section matches `ADR-006` (provider-generic LLM, manual trigger,
  cooperative cancel, no Redis).
- `DATA_MODEL.md` / `WORKFLOWS.md` / `TESTING.md` make **no** AI claims (verified:
  zero AI mentions), so they neither conflict nor document AI — a **documentation
  gap**, still open in `07-document-update-list.md` U-3/U-4/U-5.

## 6. Architectural proposals requiring explicit approval (NOT adopted)

Recorded only so they are visible; **no** change is made:

1. **Team multi-agent architecture** (`docs/09`) — would replace TMIP's single
   additive capability. Requires an architecture ADR.
2. **Media Catalog + Asset ID** (`docs/07`, `docs/06`) — would replace the
   `MediaFile` model. Requires a data-model ADR.
3. **Knowledge Base** (`docs/08`) — needs embeddings/vector store, explicitly out of
   v1 scope.
4. **BullMQ/Redis queue** (team stack) — `ADR-006` deliberately avoids Redis.

## 7. Resolution summary (2026-10-13 alignment)

| Conflict / gap | Status |
|---|---|
| Conflict A — AI out-of-scope vs implemented | **Resolved** — MVP 2 additive scope layer (`ADR-007`, `SCOPE §37`, `PRD §29`) |
| Conflict B — `AI_ENABLED` default | **Resolved** — `false` default, documented (`01` §2a) |
| Conflict C — OCR sampling code vs ADR §20 | **Resolved** — code reverted to five frames; regression assertion added |
| Conflict D — category taxonomy | **Resolved** — clarified as genre vs regulation (`01` §3.4) |
| ADR-006 / Plan 006 status wording | **Reconciled** with implemented state |
| U-3/U-4/U-5 (DATA_MODEL/WORKFLOWS/TESTING AI docs) | **Still open** (see `07`) |
