# Plan 005 — AI Processor Assessment & Integration Architecture

**Status:** Assessment COMPLETE (Phase 13, 2026-10-07) — architecture decisions recorded in `ADR/ADR-006-ai-processor-integration.md`; Phase 14 implementation plan in `docs/plans/006-ai-processor-integration.md`  
**Phase:** 13  
**Scope:** Assessment, architecture, migration strategy, and ADR only  
**Code Changes:** NONE

---

## 0. Phase 13 audit result (verified against actual source)

This plan was written before the source was inspected. The audit (commit `05fdf14`) confirmed most assumptions but **refuted or corrected** several. Where this plan and the actual source disagreed, the source wins; the corrections below are authoritative and are reflected in ADR-006.

**Verified true:** the FastAPI service, the endpoint set (`/health`, `/transcribe`, `/transcribe/status/{id}`, `/transcribe/result/{id}`, `/transcribe/cancel/{id}`, `/summarize`, `/keywords`, `/classify`, `/ocr`, `/analyze-scenes`), faster-whisper/OpenRouter/Tesseract/PySceneDetect/CLIP/YOLO capabilities, shared media volume, `asset_id` as identifier, BullMQ/Redis orchestration in the *source* Node worker, read-only media requirement, and the "no Redis in TMIP" constraint.

**Corrected / newly discovered (see ADR-006 "Audit findings"):**

1. **Job state is NOT durable.** Transcription state is process memory only (`transcribe.py` dicts). Progress/results are written as files **inside the media tree** (`/media/.transcribe-progress-*.json`), which also violates ADR-002. Both are lost/ignored across restart.
2. **`get_background_status` has a dead-code bug** — a running job never returns its `RUNNING`/progress status (the return is misplaced after `_clear_result`). This makes the existing `ALREADY_RUNNING` idempotency check unreliable.
3. **`asset_id` is NOT a safe idempotency key.** `start_background_transcribe` clears prior progress/results and starts a new thread unconditionally; a duplicate `/transcribe` can start concurrent work and wipe a finished result.
4. **Cancellation is not real** — `cancel_background` drops references but the daemon thread keeps running to completion; it also deletes the stored result.
5. **No durable external job id exists** in the processor; its "job_id" is just the caller's `asset_id` echoed back. TMIP must mint its own (`aiExternalJobId`).
6. **The source Node orchestration blocks a worker for up to 150 minutes** polling inline — not restart-survivable.
7. **`/keywords` and `/classify` re-run the same `/summarize` logic** (one LLM call each); calling all three triples LLM cost. The source worker calls `summarize` once. ADR-006 therefore treats them as a single stage set.
8. **Media path is caller-supplied and unchecked in Python** (`os.path.exists` only); containment lives in the source Node caller, not the service.
9. **Resources:** Whisper runs CPU-only (`int8`, 8 threads); CLIP/YOLO are lazy singletons, CUDA-optional. Model weights cache at `HF_HOME=/model-cache` (persisted volume in the source compose).
10. **Source Dockerfile embeds a corporate SSL-inspection CA** (`certs/SecurityAppliance_SSL_CA.pem`) — environment-specific, must not be carried into TMIP.

**Plan 005 §5.1 preferred strategy** (persist external id → on restart resume/classify) is adopted, with the correction that TMIP owns and mints the id because the processor provides none.

**Divergence note:** this document remains an assessment/architecture plan. It does not become an implementation plan; Phase 14 steps live in Plan 006.

---

## 1. Purpose

TMIP already has an existing AI Processor implementation in a separate project.

This plan defines how the existing AI Processor will be assessed and integrated into TMIP without unnecessarily rewriting the existing AI capabilities.

This phase MUST NOT implement the integration yet.

The output of this phase is:

1. Assessment of the existing AI Processor.
2. Gap analysis against TMIP architecture.
3. Integration architecture.
4. Explicit lifecycle, retry, recovery, security, and data-storage decisions.
5. ADR-006.
6. A clear implementation plan for Phase 14.

---

## 2. Source Project

### Existing AI Processor

**Source project:**

`D:\DEVELOP\tvri-media-intelligence-platform`

**Source branch:**

`main`

**Known source commit:**

`05fdf14` — `AI PROCESSOR SUDAH BISA DIGUNAKAN`

The source project contains the existing AI Processor implementation and MUST be treated as the primary implementation reference during this assessment.

Zcode MUST inspect the actual source code rather than relying only on this plan.

---

## 3. Existing AI Processor Capabilities

The existing processor is a Python/FastAPI service providing:

- faster-whisper transcription
- OpenRouter-based summarization
- keyword extraction
- content classification
- Tesseract OCR for lower-third text
- PySceneDetect scene detection
- CLIP-based scene analysis
- YOLO-based object/scene analysis

Known HTTP endpoints include:

- `GET /health`
- `POST /transcribe`
- `GET /transcribe/status/{asset_id}`
- `GET /transcribe/result/{asset_id}`
- `POST /transcribe/cancel/{asset_id}`
- `POST /summarize`
- `POST /keywords`
- `POST /classify`
- `POST /ocr`
- `POST /analyze-scenes`

The existing implementation uses:

- Python
- FastAPI
- BullMQ/Redis orchestration
- shared media volume
- `asset_id` as an identifier
- background processing for transcription

---

## 4. TMIP Constraints

The integration MUST respect existing TMIP architecture.

TMIP currently uses:

- PostgreSQL
- Prisma
- Express + TypeScript API
- Next.js web
- Docker Compose
- database-driven processing state
- scan-based media discovery
- read-only media storage
- ffprobe-based technical metadata extraction

TMIP does NOT currently use:

- Redis
- BullMQ
- media upload
- multer-based upload flow
- AI-specific queue infrastructure

The actual media storage MUST remain read-only.

AI processing MUST NOT modify, move, rename, or delete source media.

Technical metadata extraction and AI enrichment MUST remain separate processing domains.

Example:

```text
Technical Metadata:
READY

AI Metadata:
FAILED
```

A failure in AI processing MUST NOT cause technical metadata to become FAILED.

---

# 5. Assessment Objectives

Phase 13 MUST answer the following questions before implementation begins.

## 5.1 AI Processor Job Durability

Inspect the existing transcription/background-job implementation.

Determine:

- Where job state is stored.
- Whether job state survives AI Processor restart.
- Whether `asset_id` is sufficient as a job identifier.
- Whether duplicate `/transcribe` calls create duplicate processing.
- Whether an existing job can be queried after service restart.
- Whether result data survives restart.
- Whether cancellation survives restart.

The assessment MUST explicitly document whether the current AI Processor provides durable job state.

Do not assume FastAPI background tasks are durable.

---

## 5.2 TMIP Restart Recovery

Define what happens when:

```text
TMIP API
    |
    +---- AI Processor job running
    |
    +---- TMIP restarts
```

The architecture MUST define one explicit recovery strategy.

Preferred strategy:

1. Persist an external AI job identifier in TMIP.
2. On TMIP restart, inspect AI jobs that were PROCESSING.
3. Resume polling if the external AI job still exists.
4. If the external job no longer exists, classify the state and either retry or fail deterministically.
5. Never create duplicate AI processing accidentally.

The exact behavior MUST be recorded in ADR-006.

---

## 5.3 AI Job Identity

Define an explicit correlation mechanism between TMIP and AI Processor.

Do not rely only on database `MediaFile.id` unless the existing processor is proven to provide idempotent behavior.

Preferred model:

```text
TMIP MediaFile.id
        |
        +---- AI Job ID / External Job ID
                    |
                    +---- AI Processor
```

The architecture MUST define whether repeated requests for the same media file are:

- rejected,
- reused,
- cancelled/replaced,
- or treated as a new job.

---

# 6. AI Lifecycle

AI processing MUST have its own state machine independent from technical metadata.

Recommended initial states:

```text
PENDING
PROCESSING
READY
FAILED
SKIPPED
```

Recommended database ownership:

```text
MediaFile
 ├── metadataStatus
 └── aiStatus
```

Technical metadata lifecycle remains unchanged.

AI lifecycle MUST NOT reuse `metadataStatus`.

---

# 7. AI Processing Trigger

The initial implementation SHOULD use explicit/manual triggering.

Recommended configuration:

```text
AI_ENABLED=false
AI_AUTO_PROCESS=false
```

This allows the AI Processor integration to be deployed and tested without automatically processing every discovered media file.

Manual processing should be available through a dedicated API operation.

Automatic processing after technical metadata becomes READY can be introduced later after the integration is proven stable.

---

# 8. AI Runner Architecture

TMIP SHOULD NOT introduce Redis/BullMQ solely to preserve the architecture of the old project.

Recommended architecture:

```text
TMIP API
   |
   +---- PostgreSQL
   |
   +---- AI Runner
             |
             +---- AI Processor HTTP API
```

The database remains the source of truth for TMIP AI lifecycle state.

The AI Runner is responsible for:

- claiming AI work
- invoking AI Processor
- tracking external job identity
- polling long-running operations
- collecting results
- persisting results
- handling retryable failures
- handling permanent failures
- recovering after restart

The AI Runner MUST NOT create concurrent duplicate processing for the same media file.

---

# 9. AI Retry Policy

AI retry policy MUST be separate from technical metadata retry policy.

Retryable examples:

- HTTP 429
- temporary HTTP 5xx
- connection timeout
- temporary connection failure
- temporary AI Processor unavailability
- explicitly classified transient processor failure

Permanent examples:

- invalid API key
- authentication failure
- unsupported media
- corrupt media
- invalid request
- schema validation failure
- invalid/non-recoverable model response

Retry behavior MUST be:

- bounded
- configuration-driven
- transient-only
- reset on successful completion
- reset on manual AI reprocess

The maximum retry count MUST NOT be persisted as row state.

Recommended persisted field:

```text
aiRetryCount
```

Maximum retry configuration remains environment/configuration based.

---

# 10. Partial Result Semantics

AI processing is a multi-stage pipeline.

Example:

```text
Transcription
    ↓
Summary
    ↓
Keywords
    ↓
Classification
    ↓
OCR
    ↓
Scene Analysis
```

Successful results MUST NOT be discarded merely because a later stage fails.

Example:

```text
Transcription: SUCCESS
Summary: SUCCESS
Keywords: SUCCESS
OCR: FAILED
```

Expected result:

```text
aiStatus = FAILED
aiErrorStage = OCR
```

while transcription, summary, and keywords remain available.

The data model MUST therefore support partial AI results.

---

# 11. AI Result Storage

For MVP, JSONB is acceptable for AI-generated results.

Recommended separation:

### Relational fields

Store lifecycle/control information relationally:

```text
aiStatus
aiStartedAt
aiCompletedAt
aiError
aiErrorStage
aiRetryCount
aiExternalJobId
aiUpdatedAt
```

### JSONB

Store AI-generated content:

```text
aiResults
```

Potential structure:

```json
{
  "transcription": {},
  "summary": {},
  "keywords": [],
  "classification": {},
  "ocr": {},
  "sceneAnalysis": {}
}
```

The schema MUST be versionable.

AI output SHOULD eventually record:

- provider
- model
- prompt/version
- processor version
- generated timestamp
- schema version

These fields may be introduced incrementally but the architecture should not prevent them.

---

# 12. Media Path Safety

The AI Processor MUST NOT receive arbitrary filesystem paths supplied directly by users.

TMIP MUST derive the media path from the existing media catalog:

```text
MediaFile.relativePath
        ↓
TMIP MEDIA_ROOT
        ↓
validated absolute media path
```

The resulting path MUST be validated to remain inside the configured media root.

AI Processor MUST receive only paths generated from trusted TMIP media metadata.

The AI Processor continues to access media as read-only.

---

# 13. Docker Networking

The AI Processor should normally be available only inside the Docker Compose network.

Preferred architecture:

```text
tmip-api
    |
    | http://ai-processor:8000
    |
tmip-ai
```

Do NOT publish:

```yaml
ports:
  - "8000:8000"
```

by default.

Prefer internal Compose networking / `expose` where appropriate.

Host publishing may be used temporarily for local debugging, but it should not be the default production architecture.

---

# 14. Secret Handling

Secrets MUST NOT be copied from the source project into:

- Git
- source code
- migration files
- ADR
- plans
- `.env.example`
- Docker image
- committed configuration

Required runtime configuration includes:

```text
OPENROUTER_API_KEY
OPENROUTER_MODEL
```

The actual secret MUST be supplied through the deployment/runtime environment.

The source project path may be documented, but actual credentials from that environment MUST NOT be copied into TMIP.

---

# 15. AI Processor Health

The architecture MUST distinguish between:

### Service health

Whether the AI Processor itself is functioning.

### Provider/capability health

Whether external services such as OpenRouter are currently available.

An unavailable OpenRouter API should not necessarily make the entire AI Processor container unhealthy if local capabilities such as transcription remain functional.

Healthcheck behavior MUST be decided explicitly in ADR-006.

---

# 16. Timeout and Polling Policy

Do not blindly copy the existing `150 minute` timeout from the source project.

Define configuration for:

```text
AI_POLL_INTERVAL
AI_STAGE_TIMEOUT
AI_JOB_DEADLINE
AI_REQUEST_TIMEOUT
```

Values should be based on actual observed processing characteristics.

The implementation MUST distinguish:

- HTTP request timeout
- individual stage timeout
- complete AI job deadline

---

# 17. Resource and Concurrency Control

AI processing can consume significant CPU, RAM, GPU, and model memory.

Before implementation, inspect:

- Whisper model requirements
- CLIP requirements
- YOLO requirements
- OCR requirements
- expected concurrent jobs
- Docker memory requirements
- model cache behavior

AI concurrency MUST be configurable.

Initial MVP SHOULD favor low concurrency to avoid resource exhaustion.

---

# 18. MVP Scope

Do NOT automatically migrate every AI capability into the first integration milestone.

Recommended MVP:

### Phase 14 — Integration Foundation

- AI Processor service
- Docker integration
- HTTP adapter
- AI Runner
- database state
- external job identity
- restart recovery
- retry policy
- basic API trigger
- basic healthcheck
- read-only media access

### Phase 15 — AI Metadata MVP

Prioritize:

1. transcription
2. summary
3. keywords
4. classification
5. basic OCR

Heavy scene/vision capabilities:

- PySceneDetect
- CLIP
- YOLO

should be treated as subsequent capability work unless assessment shows they are already stable and inexpensive enough for the MVP.

---

# 19. Manual Reprocess

AI MUST have explicit reprocess semantics.

Expected behavior:

```text
FAILED → manual reprocess → PENDING/PROCESSING
```

Manual reprocess MUST:

- reset `aiRetryCount`
- clear previous AI error state
- preserve or intentionally replace existing successful partial results according to the defined policy
- reject conflicting reprocess while already PROCESSING
- never trigger technical metadata extraction

---

# 20. API Contract

The integration should expose an AI-specific API.

Example:

```http
POST /media/:id/ai
```

The exact behavior MUST be defined for:

| Current State | Expected Behavior |
|---|---|
| PENDING | start processing |
| PROCESSING | conflict / no duplicate job |
| READY | conflict or explicit reprocess |
| FAILED | allow explicit reprocess |
| SKIPPED | allow explicit trigger |
| AI disabled | reject clearly |

Recommended HTTP semantics:

```text
202 Accepted
```

for successfully queued/started work.

```text
409 Conflict
```

for an already-processing job.

The endpoint MUST NOT rerun technical metadata extraction.

---

# 21. Database Design

The proposed AI-related fields should be evaluated against the existing Prisma schema.

Potential fields:

```text
aiStatus
aiRetryCount
aiError
aiErrorStage
aiExternalJobId
aiStartedAt
aiCompletedAt
aiResults
```

Do not add fields blindly.

The final schema MUST follow the existing TMIP data-model conventions.

---

# 22. ADR-006

Phase 13 MUST produce:

```text
ADR/ADR-006-ai-processor-integration.md
```

> Path note: this plan originally wrote `docs/adr/ADR-006-...`. The repository's existing ADRs live in `ADR/` (ADR-001 … ADR-005), so ADR-006 was created there to match the established convention. No second ADR directory was introduced.

ADR-006 MUST explicitly decide:

1. AI lifecycle/state machine.
2. AI Runner architecture.
3. External job identity.
4. AI Processor job durability.
5. TMIP restart recovery.
6. AI retry classification.
7. Manual vs automatic trigger.
8. Partial-result behavior.
9. JSONB/result storage strategy.
10. Media path security.
11. Docker networking.
12. Secret handling.
13. Healthcheck semantics.
14. Timeout/deadline policy.
15. AI concurrency/resource policy.
16. MVP capability scope.
17. Manual reprocess semantics.
18. API contract.

---

# 23. Phase 13 Deliverables

Phase 13 is complete only when:

- Existing AI Processor source has been inspected.
- Source capabilities are documented.
- Source job durability is understood.
- BullMQ/Redis dependency is assessed.
- TMIP integration gaps are documented.
- AI lifecycle is defined.
- Restart recovery is defined.
- External job identity is defined.
- Retry classification is defined.
- Partial-result semantics are defined.
- Security/path handling is defined.
- Docker networking is defined.
- Secret handling is defined.
- Healthcheck semantics are defined.
- Timeout/concurrency strategy is defined.
- MVP scope is defined.
- ADR-006 is written.
- Phase 14 implementation plan is produced.
- Plan-reviewer approves the resulting plan.
- No production code is changed.

---

# 24. Roadmap

The AI roadmap after Phase 12 becomes:

```text
Phase 12
Bounded Technical Metadata Retry
        ↓
Phase 13
AI Processor Assessment & Integration Architecture
        ↓
Phase 14
AI Processor Integration Foundation
        ↓
Phase 15
AI Metadata MVP
        ↓
Phase 16
AI Metadata Reliability & UX
        ↓
Phase 17+
Semantic Search / AI-powered MAM
```

The existing AI Processor is treated as an existing subsystem to reuse and adapt, not a system to rewrite from scratch.

---

# 25. Explicit Non-Goals

Phase 13 MUST NOT:

- implement AI Processor integration
- rewrite the Python AI Processor
- introduce Redis/BullMQ without an explicit architectural decision
- modify technical metadata extraction
- modify ffprobe behavior
- add media upload
- modify source media
- add automatic AI processing by default
- migrate every vision capability into MVP
- copy secrets from the source environment
- expose AI Processor publicly by default
- create unnecessary new infrastructure

---

## 26. Completion Gate

Phase 13 is:

**PASS**

only if the architecture is sufficiently explicit that another engineer can implement Phase 14 without making major architectural decisions during coding.

If critical questions remain unresolved, Phase 13 remains:

**BLOCKED**

and implementation MUST NOT begin.