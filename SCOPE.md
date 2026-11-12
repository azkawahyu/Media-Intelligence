# SCOPE.md

## 1. Purpose

This document defines the active scope boundary for TMIP v1.

Its purpose is to prevent scope creep and keep development focused on completing the core metadata pipeline.

This document should be used when evaluating whether a requested change belongs in the current phase.

If a request is not clearly within this scope, it must not be implemented unless explicitly approved.

---

# 2. Current Product Scope

TMIP v1 has one primary responsibility:

> Discover video files from configured storage, detect file state changes, extract technical metadata, persist the results, and display them through the application.

The core product pipeline is:

```text id="z5ynx8"
DISCOVER
    ↓
DETECT CHANGE
    ↓
EXTRACT METADATA
    ↓
STORE
    ↓
DISPLAY
```

All v1 implementation work must directly support this pipeline.

---

# 3. Scope Decision Rule

Before implementing any request, determine whether it directly supports one or more of the following:

- media discovery
- file change detection
- technical metadata extraction
- metadata persistence
- scan execution
- scan progress visibility
- metadata result visibility
- reliability of the pipeline
- safety of source media access
- maintainability of the current pipeline

If not, the request is outside the current scope.

---

# 4. In Scope

## 4.1 Storage Access

The system may support:

- mounted remote storage
- local mounted directories
- SMB-mounted storage
- NFS-mounted storage
- Docker bind mounts
- configurable storage roots
- multiple configured storage roots when required by the current implementation

Storage access must remain read-only from the application perspective.

---

## 4.2 Storage Configuration

The system may define storage configuration such as:

```text id="gih4sy"
Storage
- id
- name
- rootPath
- enabled
```

The purpose of storage configuration is to avoid hardcoded paths and support future infrastructure changes.

Do not expand this into a full storage management platform.

---

## 4.3 Recursive File Discovery

The system may:

- traverse directories recursively
- detect nested folders
- enumerate supported video files
- collect filesystem attributes
- ignore unsupported files
- track discovery errors

The scanner must not modify files or directories.

---

## 4.4 Supported Media Detection

The system may use a centralized list of supported media extensions.

Examples may include:

```text id="tstr6c"
.mp4
.mov
.mxf
.mpg
.mpeg
.avi
.mkv
.ts
.mts
```

The exact supported list may evolve.

Extension filtering is only an initial discovery mechanism.

Actual media validation remains the responsibility of metadata inspection.

---

# 5. Incremental Scanning

Incremental scanning is explicitly in scope.

The system must distinguish:

```text id="6z7q5a"
NEW
UNCHANGED
UPDATED
MISSING
```

A scan should not blindly reprocess all known files.

---

## 5.1 New Files

A newly discovered file may be:

- registered in the database
- marked for metadata extraction
- queued for background processing

---

## 5.2 Unchanged Files

An unchanged file should:

- remain active
- update observation metadata when appropriate
- skip unnecessary ffprobe processing

---

## 5.3 Updated Files

A changed file should:

- remain associated with the same logical media record when appropriate
- be marked as updated
- have its technical metadata extracted again

---

## 5.4 Missing Files

A previously known file not observed during a completed scan may be marked missing.

The record must not be automatically deleted.

Missing state is part of inventory management, not destructive cleanup.

---

# 6. File Change Detection

The initial change detection strategy may use:

- storage identifier
- relative path
- file size
- modified timestamp

This is sufficient for v1 unless real-world testing proves otherwise.

Full-file hashing is out of scope unless explicitly required.

Content-based duplicate detection is out of scope.

---

# 7. Technical Metadata Extraction

Technical metadata extraction is in scope.

The primary tool is:

```text id="a6ffgr"
ffprobe
```

The system may extract metadata such as:

## File

- filename
- relative path
- extension
- file size
- modified timestamp

## Video

- duration
- codec
- codec profile
- width
- height
- frame rate
- bit rate
- pixel format
- field order when available

## Audio

- codec
- sample rate
- channel count
- bit rate when available

## Container

- format name
- duration
- overall bit rate where available

This list is not required to remain fixed.

---

# 8. Flexible Technical Metadata

Metadata fields that are unstable, format-specific, or rarely queried may be stored as JSONB.

Examples:

- MXF-specific metadata
- timecode information
- color metadata
- stream tags
- container tags
- vendor-specific fields
- raw ffprobe structures

This flexibility is in scope because it reduces future schema refactoring.

It must not be used as justification to avoid modeling important stable fields properly.

---

# 9. Raw ffprobe Data

Preserving raw ffprobe output in JSONB is in scope.

Raw probe data may be used for:

- debugging
- future metadata extraction improvements
- inspection of format-specific fields
- migration of selected fields into normalized columns later

Application logic should not depend directly on arbitrary raw ffprobe structure.

---

# 10. PostgreSQL Persistence

PostgreSQL is in scope as the primary persistent store.

The database may store:

- media records
- storage records
- scan jobs
- scan counters
- metadata extraction state
- metadata extraction errors
- normalized metadata
- raw technical metadata
- timestamps required for incremental scanning

---

# 11. Prisma

Prisma is in scope for:

- schema definition
- migrations
- database access
- type-safe queries

Prisma should not be wrapped in unnecessary abstraction unless a real need emerges.

---

# 12. Background Jobs

Background processing is in scope.

BullMQ and Redis may be used for:

- metadata extraction jobs
- retry handling
- controlled concurrency
- background scan processing when appropriate

Redis must not become the persistent source of truth.

---

# 13. Manual Scan Triggering

Manual scanning is in scope.

The user must be able to initiate a scan from the application.

The initial product does not require automated scheduling.

---

# 14. Scan Progress

Basic scan progress is in scope.

The system may expose:

- scan status
- start time
- completion time
- discovered count
- new count
- unchanged count
- updated count
- missing count
- queued count
- processed count
- failed count

The goal is operational visibility, not analytics.

---

# 15. Scan History

Basic scan history is in scope if needed to support troubleshooting and current workflow visibility.

Examples:

- scan ID
- storage
- start time
- end time
- status
- counters
- error summary

Do not expand this into long-term operational analytics during v1.

---

# 16. Media List

A basic media inventory view is in scope.

The user may view fields such as:

- filename
- relative path
- duration
- resolution
- video codec
- extension
- file size
- media status
- metadata status
- last observed time

---

# 17. Media Detail

A basic media detail page is in scope.

It may display:

- file attributes
- video metadata
- audio metadata
- raw metadata when useful
- extraction status
- failure information
- observation timestamps

The detail page should remain focused on technical metadata.

---

# 18. Basic Search and Filtering

Basic navigation-oriented search and filtering is in scope.

Allowed examples:

- filename contains
- extension
- codec
- active / missing status
- extraction status

Search exists to make the metadata inventory usable.

Do not expand basic search into advanced discovery features.

---

# 19. Error Handling

Error handling required for pipeline reliability is in scope.

Examples:

- inaccessible file
- ffprobe failure
- corrupt media
- unsupported media
- network interruption
- missing mount
- permission issue
- worker failure
- database failure

Errors should be visible and recoverable where possible.

---

# 20. Retry Handling

Bounded retry handling is in scope.

Retry behavior may be implemented for failures that are plausibly transient.

Retry policies must remain configurable and finite.

---

# 21. Worker Concurrency

Configurable worker concurrency is in scope.

Its purpose is to protect:

- source storage
- local server resources
- network capacity

Dynamic autoscaling is out of scope.

---

# 22. Application Configuration

Configuration required to operate TMIP is in scope.

Examples:

- media root
- database URL
- Redis URL
- ffprobe executable path
- worker concurrency
- supported extensions
- application ports

Environment-specific configuration must not be hardcoded.

---

# 23. Docker Deployment

Docker and Docker Compose are in scope.

The initial deployment may contain:

```text id="2cwod3"
web
api
worker
postgres
redis
```

Exact service separation may evolve if simplification is beneficial.

---

# 24. Logging

Basic structured application logging is in scope when necessary for debugging and operations.

Useful events include:

- scan started
- scan completed
- scan failed
- file extraction failed
- storage inaccessible
- worker error

A full centralized logging platform is out of scope.

---

# 25. Health Checks

Basic health checks may be included for:

- API
- database connectivity
- Redis connectivity
- worker availability where practical

Complex infrastructure monitoring is out of scope.

---

# 26. Tests

Tests directly supporting pipeline correctness are in scope.

Important scenarios include:

- first-time discovery
- unchanged file
- updated file
- missing file
- unsupported file
- extraction failure
- retry behavior
- repeated scan idempotency
- scan completion with partial failures

---

# 27. Explicitly Out of Scope

The following capabilities are not part of TMIP v1 unless explicitly approved.

> **Note (MVP 2):** a subset of the AI capabilities below is delivered by **MVP 2**
> as an *additive scope layer* (see §37 and `ADR/ADR-007-mvp2-ai-enrichment-scope.md`).
> That layer does not change v1 scope or v1 acceptance criteria. MVP 2 covers
> transcription, summary, keywords, content classification, and lower-third OCR
> only; every other item in §27 remains out of scope.

---

## 27.1 Artificial Intelligence

Out of scope:

- AI-generated descriptions
- automatic summaries
- content understanding
- image classification
- video classification
- object detection
- scene detection
- face recognition
- emotion detection
- AI tagging
- AI-generated keywords
- LLM integration

---

## 27.2 Speech and Text Analysis

Out of scope:

- transcription
- speech-to-text
- subtitle generation
- OCR
- language detection
- translation
- speaker diarization

---

## 27.3 Semantic Retrieval

Out of scope:

- embeddings
- vector databases
- semantic search
- conversational search
- natural-language query interpretation
- chatbot interfaces

---

## 27.4 Video Processing

Out of scope:

- transcoding
- re-encoding
- proxy generation
- clipping
- trimming
- rendering
- normalization
- audio conversion
- thumbnail generation unless later explicitly required
- waveform generation

---

## 27.5 Source Media Modification

Strictly out of scope:

- deleting files
- renaming files
- moving files
- overwriting files
- changing timestamps
- modifying contents
- reorganizing source storage

---

## 27.6 Duplicate Management

Out of scope:

- full-file hashing for all media
- perceptual hashing
- duplicate detection
- near-duplicate detection
- automatic duplicate cleanup
- duplicate resolution workflows

---

## 27.7 Advanced Archive Management

Out of scope:

- retention policies
- archive tiers
- automatic archival
- automatic deletion
- tape management
- restore workflows
- lifecycle policies

---

## 27.8 Quality Control

Out of scope:

- automated technical QC
- loudness analysis
- black-frame detection
- freeze-frame detection
- dropout detection
- broadcast compliance scoring
- QC reporting

Basic metadata inspection must not silently evolve into a QC platform.

---

## 27.9 Reporting and Analytics

Out of scope:

- executive dashboards
- monthly reports
- business intelligence
- trend analytics
- usage analytics
- storage forecasting
- automated report generation

Simple operational counters are allowed.

---

## 27.10 Notification Systems

Out of scope:

- email notifications
- Slack notifications
- WhatsApp notifications
- push notifications
- alert escalation

---

## 27.11 Complex Authentication

Out of scope unless deployment requires it:

- advanced RBAC
- SSO
- OAuth providers
- Active Directory integration
- multi-tenant access rules
- fine-grained permissions

If authentication becomes necessary, implement only the minimum needed.

---

## 27.12 Public Access

TMIP v1 is not intended as a public-facing platform.

Public internet exposure is outside the initial scope.

---

## 27.13 Workflow Systems

Out of scope:

- approval workflows
- task assignment
- editorial workflows
- production scheduling
- review workflows
- asset checkout
- collaboration systems

---

## 27.14 Agentic Automation

Out of scope:

- autonomous agents
- automatic decision-making agents
- multi-agent workflows
- AI orchestration systems

---

## 27.15 Microservices

A microservices architecture is out of scope.

TMIP should remain a small, understandable system.

Separate processes such as API and worker are allowed when operationally necessary, but they should still belong to one cohesive application.

---

# 28. Deferred Capabilities

The following capabilities may be reasonable future extensions but must remain deferred:

```text id="j7vw3l"
scheduled scans
technical QC
AI metadata
transcription
semantic search
chat interface
advanced reporting
multi-storage management
duplicate detection
archive workflows
```

Deferred does not mean planned or guaranteed.

Future features should only be evaluated after the core pipeline is stable.

> **Note (MVP 2):** "AI metadata" and "transcription" listed above are delivered by
> the MVP 2 additive layer (§37). They remain outside **v1** scope; MVP 2 is a
> separate, opt-in milestone. The other deferred items remain deferred.

---

# 29. Flexibility That Is In Scope

TMIP v1 should deliberately include flexibility where doing so has low complexity and prevents costly future refactors.

Examples include:

- storage abstraction
- relative media paths
- JSONB technical metadata
- configurable extensions
- configurable worker concurrency
- clear ffprobe adapter boundary
- scan job records
- additive database migrations
- separation between discovery and extraction

This is acceptable architectural flexibility.

---

# 30. Flexibility That Is Out of Scope

Do not build speculative frameworks such as:

- generic plugin systems
- metadata plugin marketplaces
- generic pipeline builders
- workflow engines
- dynamically loaded modules
- event-driven microservice architectures
- abstraction layers for hypothetical databases
- multi-cloud storage abstractions

Flexibility should solve plausible change, not imaginary change.

---

# 31. Scope Creep Examples

The following request:

> Add an AI description of every video while scanning.

Decision:

```text id="9ut39o"
OUT OF SCOPE
```

Reason:

It introduces AI content analysis unrelated to completing the technical metadata pipeline.

---

The following request:

> Store additional ffprobe color-space metadata in JSONB.

Decision:

```text id="8ujh4u"
IN SCOPE
```

Reason:

It extends technical metadata without changing the product mission.

---

The following request:

> Add an automatic nightly scan.

Decision:

```text id="sm37nw"
DEFERRED
```

Reason:

The architecture may support it later, but manual scanning should first prove reliable.

---

The following request:

> Add retry support when ffprobe fails because the storage temporarily disconnects.

Decision:

```text id="ppv083"
IN SCOPE
```

Reason:

It improves reliability of the core pipeline.

---

The following request:

> Add thumbnails to make the media library look better.

Decision:

```text id="a56p3c"
OUT OF SCOPE
```

unless explicitly approved.

Reason:

It is not required to prove the metadata pipeline.

---

The following request:

> Add an index on videoCodec because filtering becomes slow.

Decision:

```text id="mjatf4"
IN SCOPE
```

Reason:

It improves performance of an existing core function.

---

# 32. Scope Change Process

A request that falls outside this document must not automatically be implemented.

When an intentional scope expansion is approved:

1. update `PRD.md` if product requirements change
2. update `SCOPE.md`
3. update architecture documentation if needed
4. create an ADR when the decision has architectural impact
5. only then implement the feature

Documentation should reflect the approved product before implementation diverges significantly from it.

---

# 33. Current Phase Priority

Development priority should follow this order:

```text id="53jc82"
1. Storage connectivity
2. File discovery
3. File state detection
4. Technical metadata extraction
5. Metadata persistence
6. Background processing reliability
7. Scan visibility
8. Media inventory visibility
9. Basic usability improvements
```

Lower-priority work should not block higher-priority pipeline completion.

---

# 34. Current Minimum Deliverable

The minimum acceptable v1 vertical slice is:

```text id="9gy1rt"
Server B video
    ↓
visible on Server A
    ↓
discovered by scanner
    ↓
identified as NEW
    ↓
processed by ffprobe
    ↓
stored in PostgreSQL
    ↓
visible in web UI
```

Followed by:

```text id="fw2icj"
second scan
    ↓
same file detected
    ↓
UNCHANGED
    ↓
ffprobe skipped
```

This flow must work before broader features are considered.

---

# 35. Scope Completion Criteria

The current scope is considered complete when:

- real media storage can be scanned reliably
- supported media files are discovered recursively
- new files are identified
- unchanged files are skipped
- changed files are reprocessed
- missing files are represented safely
- technical metadata is extracted
- metadata is persisted
- failures are visible
- repeated scans are idempotent
- scan progress is visible
- media metadata can be inspected through the application
- source media remains untouched

---

# 36. Final Scope Principle

When deciding whether to add something, prefer:

```text id="4fnwg3"
a complete and reliable metadata inventory
```

over:

```text id="tycpvc"
a larger platform with incomplete core behavior
```

TMIP v1 should remain narrow until its core pipeline is proven with real storage and real media files.

---

# 37. MVP 2 — AI Metadata Enrichment (Additive Scope Layer)

MVP 2 is an **official, additive scope layer** on top of MVP 1. It is authorised by
`ADR/ADR-007-mvp2-ai-enrichment-scope.md` and implements the architecture recorded
in `ADR/ADR-006-ai-processor-integration.md`. This section defines MVP 2 scope
without altering v1 scope (§1–§36), which remains in force.

## 37.1 Relationship to MVP 1

- MVP 1 remains a complete, independently valuable product.
- MVP 2 adds enrichment metadata about an existing media file; it never changes the
  MVP 1 pipeline, its acceptance criteria (§35), or media-safety guarantees
  (`ADR-002`).
- AI never writes `metadataStatus`; the ffprobe pipeline is unaffected whether AI
  is enabled or not.
- MVP 2 is **opt-in**: `AI_ENABLED` defaults to **false**; with it unset the
  subsystem is inert.

## 37.2 In scope (MVP 2)

- Transcription (speech-to-text) of the media's audio.
- Summary, keywords, and content classification derived from the transcript.
- Lower-third OCR (text + presenter parse).
- A durable per-media AI lifecycle with partial results, bounded classified retry,
  and durable cancellation.
- AI status and results surfaced on the existing media list/details endpoints.

## 37.3 Explicitly out of scope for MVP 2

- Scene detection, CLIP, YOLO, object detection, scene descriptions (future Phase
  15; `ADR-006 §16`).
- Semantic search, embeddings, vector databases, Knowledge Base (`§27.3`).
- Multi-agent architecture, BullMQ/Redis, Media Catalog/Asset ID model
  (`ADR-007 §4`).
- Automated QC / compliance verdicts, human-metadata capture, approval workflows.
- Any file operation on source media.

## 37.4 Acceptance intent (MVP 2)

MVP 2 is acceptable when, with `AI_ENABLED=true`, a media file can be enriched
through all MVP 2 stages to a terminal AI state (`READY` / `READY`+partial /
`FAILED` / `CANCELLED`) with correct fields, while §35 (MVP 1 completion criteria)
continues to hold and source media remains untouched.

## 37.5 Canonical contract

The AI metadata field contract is defined once in
`docs/mvp2-ai-metadata/01-ai-metadata-contract.md` and is not duplicated here.