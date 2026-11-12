# 01 — Canonical AI Metadata Contract (TMIP MVP 2)

Status: **proposed canonical contract** for AI metadata produced by TMIP's AI
enrichment. This file is the **single canonical source** for AI metadata field
definitions. Where team documents name the same concept differently, this file's
name wins (see the reconciliation table in `00-source-to-target-mapping.md`).

Grounding: every field below is **implemented** in TMIP today unless its status
says otherwise. Evidence is `apps/api/src/ai/runner.ts`, `apps/api/src/ai/adapter.ts`,
and `apps/api/prisma/schema.prisma`. Fields that are only *planned* (in the team
documents or in ADR-006's Phase 15) are marked **Deferred** and are **not**
MVP 2 requirements.

## 1. Storage model

AI metadata is stored per stage in `AiResult` (one row per `(mediaFileId, stage)`),
with the stage's output in the JSONB `payload` column. The AI lifecycle status is
on `MediaFile`. This matches TMIP's hybrid model (`DATA_MODEL.md` §28: relational
for queried fields, JSONB for flexible metadata) and `ADR-006 §8`.

```text
MediaFile (1) ──── (0..n) AiResult
   aiStatus                    stage      AiStage
   aiPartial                   status     AiStageStatus
   aiAttempt                   payload    JSONB   ← the AI metadata fields below
   aiExternalJobId             errorCode / errorMessage
   aiErrorCode / aiErrorAt     attemptedAt
   aiProcessedAt
   aiCancelRequestedAt
```

## 2. Provenance (who/what produced a value)

Every AI metadata value has exactly one provenance: **AI-generated**. AI values
must remain distinguishable from human/technical values. In TMIP, the distinction
is structural:

| Provenance | Where it lives | Example |
|---|---|---|
| **Technical** (ffprobe) | `MediaFile` relational columns + `rawProbeData` | `durationSeconds`, `videoCodec` |
| **AI** (enrichment) | `AiResult.payload` (+ AI lifecycle on `MediaFile`) | `summary`, `keywords` |
| **Human** | *(not implemented in TMIP)* | — |

> **Reference-only note:** the team model stores human + AI metadata in one record
> distinguished by a source field (`docs/06` Decision-003). TMIP does **not** adopt
> that now — TMIP has no human-metadata capture. Recorded in `05-open-decisions.md`
> as OD-06.

## 2a. Enabling AI — effective default (OD-12, resolved)

- `AI_ENABLED` defaults to **false**. This is consistent across the tracked files:
  `docker-compose.yml` (`AI_ENABLED: ${AI_ENABLED:-false}`), `.env.example`
  (`AI_ENABLED=false`), and `apps/api/src/config.ts` (`parseAiEnabled(undefined)`
  returns `false`).
- With `AI_ENABLED` unset or `false`, the subsystem is **inert**: no AI job is
  claimed and every media row simply stays `aiStatus=PENDING` ("not processed").
- An operator may override it by setting `AI_ENABLED=true` in `.env`. That is an
  **explicit operator decision**, not a repository/project default. (A local
  gitignored `.env` that sets `true` is such an override and does not change the
  tracked default.)

## 3. Stage contracts

Each stage's `payload` is the AI metadata for that stage. `status` is `READY`
(payload present) or `FAILED` (payload absent, error fields set).

### 3.1 `TRANSCRIPTION` — speech-to-text

| Field | Type | Required | Meaning | Validation |
|---|---|---|---|---|
| `segments` | array of `{ start: number, end: number, text: string }` | **Yes** | Timed transcript segments (seconds) | Array; each item has all three keys; numbers finite; `start ≤ end` |
| `full_text` | string | **Yes** | Concatenated transcript text | String (may be `""` for silent media) |
| `duration_sec` | number \| null | Optional | Media duration as reported by the processor | Finite ≥ 0 when present |
| `language` | string \| null | Optional | Detected/declared transcript language (e.g. `id`) | Non-empty string when present |

- Team name: `transcript` / `detected_language` (`docs/06`). **Adapted** → TMIP
  splits transcript into `segments` (timed) + `full_text` (flat), and calls
  language `language`. Both are implemented.
- Processor origin: `POST /transcribe` → `/transcribe/result/{id}`
  (`adapter.ts` `transcriptionResultSchema`).

### 3.2 `SUMMARY` — video summary

| Field | Type | Required | Meaning | Validation |
|---|---|---|---|---|
| `summary` | string | **Yes** | 2–3 sentence Indonesian summary of the content | Non-empty string |

- Team name: `summary` (`docs/06`). **Adopted.**
- Origin: the single `/summarize` call (`adapter.ts` `summarizeResultSchema`).
- Note: the processor's prompt yields a complete 3-field response or a controlled
  failure (`EMPTY_RESPONSE`/`INCOMPLETE_RESPONSE`, classified TRANSIENT) — see
  `02-enrichment-workflow.md` §6.

### 3.3 `KEYWORDS` — extracted keywords

| Field | Type | Required | Meaning | Validation |
|---|---|---|---|---|
| `keywords` | array of string | **Yes** | Up to ~10 Indonesian keywords | Array; each item a non-empty string |

- Team name: `keywords` (`docs/06`). **Adopted.**
- Origin: same `/summarize` call as SUMMARY (TMIP does **not** call `/keywords`
  separately — `ADR-006 §18`).
- **Empty list is a valid result (OD-02, resolved).** A response that contains a
  `KEYWORDS:` line but no keywords yields `keywords: []` and is a **success**, not
  a failure. Rationale: a transcript may legitimately have no extractable
  keywords; forcing a retry cannot produce them and would waste the retry budget
  and mark a healthy stage as failed. This is distinct from a *missing* section —
  a response that omits the `KEYWORDS:` line entirely is an incomplete response and
  fails (see `02-enrichment-workflow.md` §6).

### 3.4 `CLASSIFICATION` — content category

| Field | Type | Required | Meaning | Validation |
|---|---|---|---|---|
| `category` | string | **Yes** | One content category for the video | Non-empty string; value is matched case-insensitively against the processor's fixed category list, else the raw text is kept |

- Team name: `suggested_category` (`docs/06`) / `Suggested Category` (`docs/07`).
  **Adapted** → TMIP stores it as `category`.
- Origin: same `/summarize` call as SUMMARY/KEYWORDS.
- Processor's fixed category list (from `ai-processor/app/handlers/text_llm.py`
  `CONTENT_CATEGORIES`): Kuliner, Cooking Show, Dokumenter, Edukasi, Berita, Vlog,
  Tutorial, Bisnis/UMKM, Profil Perusahaan, Hiburan, Talkshow, Reality Show,
  Travel/Jalan-jalan, Musik, Religi, Kesehatan, Olahraga, Otomotif, Teknologi,
  Pertanian/Perikanan, Sosial/Budaya, Anak-anak, Investigasi, Motivasi/Inspirasi,
  Lainnya.
- **`category` is a content-genre label, not a broadcast regulatory
  classification (OD-05, resolved).** It exists to help a person find content
  ("what is this about?"). It is **not** the regulatory program classification used
  by broadcast rules (`rules.md §3.3`: Berita/Warta Berita, Pendidikan, IPTEK,
  Budaya, Olahraga, Hiburan, Agama, ILM) and is **not** an audience classification
  (anak/remaja/dewasa). Any mapping between this genre label and a regulatory
  classification is deferred and belongs to a future QC capability (out of MVP 2
  scope; `docs/mvp2-ai-metadata/03-rules-to-fields-mapping.md`).

### 3.5 `OCR` — lower-third text + presenter

| Field | Type | Required | Meaning | Validation |
|---|---|---|---|---|
| `raw_text` | string | **Yes** | Best-scoring lower-third text found across sampled frames | String (may be `""` when nothing usable) |
| `presenter` | `{ name: string \| null, role: string \| null }` \| null | **Yes** (key present) | Presenter/guest parsed from `raw_text` via the LLM | `null` when not parseable; when an object, both keys present (values may be `null`) |
| `sampled_count` | integer ≥ 0 | Optional | Frames actually decoded + OCR'd | Integer ≥ 0 |
| `best_timestamp_sec` | number | Optional | Timestamp of the winning frame | Finite ≥ 0 |

- Team docs mention `OCR Result` (`docs/07`) but not `presenter`. TMIP's
  `raw_text` + `presenter` split is **Adapted**; the team's `presenter_name` /
  `presenter_role` are the semantic equivalent (team implementation).
- Origin: `POST /ocr` (`adapter.ts` `ocrResultSchema`).
- Known limitation: the sampling grid is a heuristic; a short (~2–3 s) lower-third
  may be missed (`ADR-006 §20`). `raw_text` may be noise.

## 4. Fields named by the team but NOT in MVP 2

| Team field | Source | TMIP status | Why |
|---|---|---|---|
| `scene_labels` | `docs/06` | **Deferred** (Phase 15) | Scene/CLIP/YOLO is out of scope (`ADR-006 §16`, `SCOPE.md §27.1`). Requires its own ADR. |
| `detected_objects` | `docs/06` | **Deferred** (Phase 15) | Object detection out of scope (`SCOPE.md §27.1`). |
| `Scene Description` | `docs/07` | **Deferred** (Phase 15) | Same as above. |
| `Suggested Tags` | `docs/07` | **Unresolved** (OD-03) | Overlaps `keywords`; TMIP has no separate tags field. |
| `ai_confidence` | `docs/06` | **Unresolved** (OD-04) | No confidence value is produced or stored today; adding one needs a producer change. |

## 5. Lifecycle fields (on `MediaFile`)

These are **not** AI metadata content; they describe the AI job. Full transition
table in `02-enrichment-workflow.md`.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `aiStatus` | `PENDING \| PROCESSING \| READY \| FAILED \| SKIPPED \| CANCELLED` | `PENDING` | AI lifecycle state |
| `aiPartial` | boolean | `false` | `true` when ≥1 stage READY and ≥1 stage FAILED |
| `aiAttempt` | integer | `0` | Retry counter for the current claim |
| `aiExternalJobId` | string \| null | — | Deterministic processor job id: `` `${mediaFileId}:${attempt}` `` |
| `aiErrorCode` | string \| null | — | Terminal failure code (see §6) |
| `aiErrorMessage` | string \| null | — | Human-readable cause |
| `aiErrorAt` | timestamp \| null | — | When the error was recorded |
| `aiProcessedAt` | timestamp \| null | — | When the run finished successfully |
| `aiCancelRequestedAt` | timestamp \| null | — | Durable cancellation intent (`ADR-006 §19`) |

## 6. Error codes (AI path)

| Code | Class | Source |
|---|---|---|
| `AI_PROCESSOR_TIMEOUT` | TRANSIENT | `adapter.ts` |
| `AI_PROCESSOR_UNAVAILABLE` | TRANSIENT | `adapter.ts` |
| `AI_PROCESSOR_BAD_REQUEST` | PERMANENT | `adapter.ts` |
| `AI_PROCESSOR_INVALID_RESPONSE` | PERMANENT | `adapter.ts` |
| `AI_FILE_NOT_FOUND` | PERMANENT | `runner.ts` |
| `AI_PATH_INVALID` | PERMANENT | `runner.ts` |
| `AI_STAGE_FAILED` | PERMANENT | `runner.ts` |
| `AI_DEADLINE_EXCEEDED` | TRANSIENT | `runner.ts` |
| `AI_INTERRUPTED` | PERMANENT | `runner.ts` |
| `AI_CANCELLED` | (terminal, not a failure) | `runner.ts` |

Classification is fail-closed: anything not listed TRANSIENT is PERMANENT
(`apps/api/src/ai/ai-failure-classification.ts`).

## 7. Invariants

1. **AI never writes `metadataStatus`.** The ffprobe pipeline is unaffected
   whether AI is enabled or not (`ADR-006`, `README.md`).
2. **One row per `(mediaFileId, stage)`.** Re-runs upsert; no duplicates.
3. **Partial results are kept.** A later failure preserves earlier READY stages;
   `aiStatus = READY` with `aiPartial = true` (`ADR-006 §7`).
4. **Values are AI-generated and advisory.** No field triggers a file operation.
5. **A stage's `payload` is written only on success.** On failure, `payload` is
   left untouched and error fields are set.
