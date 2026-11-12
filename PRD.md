# TMIP v1 Product Requirements Document

## 1. Product Name

TMIP

For v1, TMIP should be treated as a focused video metadata inventory system rather than a broad media intelligence platform.

---

# 2. Product Summary

TMIP v1 is an internal application that discovers video files stored on Server B, extracts technical metadata from those files, stores the results in a structured database, and displays the results through a web application running on Server A.

The primary goal is to create a reliable and maintainable metadata pipeline for existing and newly added video files.

TMIP v1 is intentionally narrow in scope.

The product must first prove that the complete end-to-end workflow works reliably before additional capabilities are introduced.

---

# 3. Problem Statement

Server B contains a continuously growing collection of video files.

New video files may be added regularly, including on a monthly basis.

Without a structured metadata inventory, it is difficult to answer basic operational questions such as:

- What video files currently exist?
- Where is a specific file located?
- What is the duration of a video?
- What codec does it use?
- What is its resolution?
- What is its frame rate?
- When was the file last modified?
- Has a file been added since the previous scan?
- Has an existing file changed?
- Did metadata extraction succeed or fail?
- Is a previously known file no longer available?

Manual inspection does not scale as the number of files increases.

TMIP v1 must provide an automated and repeatable way to discover these files and maintain an up-to-date technical metadata inventory.

---

# 4. Product Goal

The primary goal of TMIP v1 is:

> Maintain an accurate, queryable, and continuously updateable inventory of video files stored on Server B and their technical metadata.

The core pipeline is:

```text
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

Every v1 feature must directly support this pipeline.

---

# 5. Primary User

The primary user is internal technical or media operations staff responsible for managing, monitoring, or inspecting the video storage environment.

The user is expected to understand basic media terminology such as:

- codec
- resolution
- frame rate
- duration
- file size
- file path

TMIP v1 does not need to simplify technical terminology for non-technical users.

---

# 6. Primary User Need

The user needs to be able to answer:

> What video files currently exist on the storage, and what are their technical characteristics?

The system must make this information available without manually opening or inspecting individual media files.

---

# 7. Core User Story

As a technical staff member,

I want TMIP to scan the configured media storage,

so that I can see all supported video files and their technical metadata without inspecting each file manually.

---

# 8. Secondary User Stories

## 8.1 New File Detection

As a technical staff member,

I want newly added video files to be identified during a new scan,

so that the metadata inventory stays current.

---

## 8.2 Changed File Detection

As a technical staff member,

I want TMIP to detect when an existing file has changed,

so that outdated metadata can be refreshed.

---

## 8.3 Unchanged File Handling

As a technical staff member,

I want unchanged files to be skipped during metadata extraction,

so that repeated scans do not waste unnecessary storage, network, or processing resources.

---

## 8.4 Missing File Detection

As a technical staff member,

I want previously known files that are no longer found during a scan to be identified,

so that I can distinguish missing files from active files.

---

## 8.5 Failed Extraction Visibility

As a technical staff member,

I want files that fail metadata extraction to remain visible with their failure information,

so that I can investigate problematic media files without losing scan progress.

---

# 9. Functional Scope

TMIP v1 must support the following functional areas.

## 9.1 Storage Access

The application must be able to read a configured media directory mounted on Server A.

The underlying storage may physically reside on Server B.

The application should operate on a filesystem path exposed to the application environment.

The application must not depend on Server B implementation details.

---

## 9.2 Media Discovery

TMIP must recursively scan configured media directories.

The scanner must:

- traverse nested directories
- identify supported media file extensions
- ignore unsupported files
- collect required filesystem attributes
- register discovered files for comparison against existing records

The scanner must not modify source media.

---

## 9.3 Incremental Scanning

Repeated scans must be incremental.

The system must distinguish at minimum:

```text
NEW
UNCHANGED
UPDATED
MISSING
```

A file that has not changed should not undergo technical metadata extraction again.

A new or changed file should be eligible for metadata extraction.

---

## 9.4 Technical Metadata Extraction

TMIP must use ffprobe to inspect supported media files.

The system should capture at minimum:

### File Metadata

- filename
- relative path
- file extension
- file size
- modified timestamp

### Video Metadata

- duration
- video codec
- width
- height
- frame rate

### Audio Metadata

When present:

- audio codec
- sample rate
- channel count

The exact metadata set may evolve without changing the fundamental product behavior.

---

## 9.5 Raw Probe Preservation

Where practical, the system should preserve raw ffprobe output.

Raw metadata is not intended to replace normalized fields.

It exists to retain additional technical information that may become useful later.

---

## 9.6 Metadata Persistence

Metadata must be stored persistently.

PostgreSQL is the primary source of truth for TMIP v1.

The system must retain sufficient information to support:

- incremental scanning
- file status tracking
- metadata retrieval
- scan history
- troubleshooting

---

## 9.7 Background Processing

Long-running metadata extraction must run outside the HTTP request lifecycle.

Starting a scan must not require an HTTP request to remain open until all files are processed.

The application must support background processing for metadata extraction.

---

## 9.8 Scan Tracking

Each scan operation should be represented as a scan job.

A scan job should expose enough information to understand its progress.

Useful states include:

```text
PENDING
RUNNING
COMPLETED
COMPLETED_WITH_ERRORS
FAILED
```

Useful counters may include:

- discovered files
- new files
- unchanged files
- updated files
- missing files
- processed files
- failed files

---

# 10. Main Product Flow

The expected primary flow is:

```text
User opens TMIP
        ↓
User starts a scan
        ↓
TMIP creates a scan job
        ↓
Scanner traverses configured storage
        ↓
Supported media files are discovered
        ↓
Each file is compared with stored state
        ↓
NEW / UPDATED files are queued
UNCHANGED files are skipped
        ↓
Workers run ffprobe
        ↓
Metadata is normalized and stored
        ↓
Progress is updated
        ↓
User views scan result
```

---

# 11. Expected File State Behavior

## New File

A file not previously known to TMIP.

Expected behavior:

```text
discover
→ register
→ mark NEW
→ extract metadata
→ store metadata
→ mark active
```

---

## Unchanged File

A previously known file whose relevant filesystem properties have not changed.

Expected behavior:

```text
discover
→ compare
→ mark UNCHANGED
→ update observation timestamp
→ skip ffprobe
```

---

## Updated File

A previously known file whose relevant filesystem properties have changed.

Expected behavior:

```text
discover
→ compare
→ mark UPDATED
→ queue metadata extraction
→ update stored metadata
```

---

## Missing File

A previously known file that is not found during a completed scan of its configured storage.

Expected behavior:

```text
previously known
→ not observed during scan
→ mark MISSING
```

The media record must not be deleted automatically.

---

# 12. Manual Scanning

TMIP v1 must support manual scan triggering.

Manual scanning is the initial operational model.

Automatic scheduling is not required for initial product completion.

The architecture should not prevent scheduled scanning from being added later.

---

# 13. User Interface Requirements

The UI should remain functional and simple.

Visual polish is secondary to clear system behavior.

TMIP v1 should provide at minimum the following views.

## 13.1 Media List

Display discovered media records.

Useful information includes:

- filename
- relative path
- duration
- resolution
- codec
- file size
- file status
- metadata extraction status

---

## 13.2 Media Detail

The user should be able to inspect a media record in more detail.

The detail page may include:

- filesystem metadata
- normalized technical metadata
- audio stream information
- metadata extraction status
- last observed time
- last metadata extraction time
- failure details when applicable

---

## 13.3 Scan Control

The user should be able to start a manual scan.

The UI must clearly indicate that a scan has started.

---

## 13.4 Scan Progress

The user should be able to see scan progress.

The UI should show meaningful progress instead of only a generic loading indicator.

Example:

```text
Scan Running

Discovered: 23,482
New:          1,204
Updated:         31
Unchanged:   22,247

Metadata Processed: 913 / 1,235
Failed: 4
```

Exact presentation may evolve.

---

# 14. Search and Filtering

TMIP v1 may provide basic filtering needed to navigate the metadata inventory.

Examples:

- filename search
- status filter
- codec filter
- file extension filter

Complex search functionality is not required.

Semantic search is explicitly outside v1 scope.

---

# 15. Data Safety Requirements

TMIP must treat source media storage as read-only.

The product must never automatically:

- delete source media
- rename source media
- move source media
- overwrite source media
- modify source media contents

Metadata extraction must not alter source files.

---

# 16. Reliability Requirements

## 16.1 File-Level Isolation

A failure while processing one media file must not stop the entire scan.

Example:

```text
10,000 files discovered

9,997 successful
3 failed
```

The scan should still reach completion with errors recorded.

---

## 16.2 Repeatability

Running a scan multiple times against unchanged storage must produce consistent results.

Repeated scans must not create duplicate media records.

---

## 16.3 Recovery

A failed metadata extraction must remain recoverable.

The system should allow the file to be retried later.

---

## 16.4 Temporary Storage Failure

Temporary inability to access storage must not automatically cause permanent deletion of known media records.

---

# 17. Performance Requirements

TMIP v1 does not require maximum possible scanning speed.

Reliability and storage safety have higher priority than scan speed.

The system must avoid unnecessarily processing unchanged files.

Worker concurrency should be configurable to avoid overwhelming:

- Server B
- network infrastructure
- Server A

---

# 18. Scalability Expectations

The architecture should support growth from a small test dataset to a substantially larger media collection without changing the core design.

TMIP should be capable of evolving toward:

```text
hundreds
→ thousands
→ tens of thousands
```

of media records.

Exact performance targets should be established after real storage measurements exist.

The project must not introduce distributed-system complexity solely for hypothetical scale.

---

# 19. Metadata Flexibility Requirement

TMIP must support future metadata expansion without requiring major schema redesign.

The expected strategy is:

```text
Frequently queried stable metadata
→ relational database columns

Flexible or format-specific metadata
→ JSONB
```

The metadata model must support additive evolution.

---

# 20. Storage Flexibility Requirement

Business logic must not depend directly on a single hardcoded filesystem root.

The system should support a storage abstraction such as:

```text
Storage
- id
- name
- rootPath
```

Media paths should be represented relative to their storage root wherever practical.

This ensures that infrastructure path changes do not require rewriting core media records.

---

# 21. Non-Goals

TMIP v1 is not intended to be:

- a complete Digital Asset Management platform
- a Media Asset Management platform
- a video editing platform
- a transcoding platform
- an AI media understanding platform
- a semantic search engine
- a chatbot
- an archive lifecycle platform
- a workflow approval system
- a content management system
- a notification platform
- a reporting platform

These may be evaluated in future phases only after the v1 metadata pipeline is complete and reliable.

---

# 22. Explicitly Out of Scope

TMIP v1 does not require:

- speech-to-text
- AI-generated descriptions
- OCR
- object detection
- face recognition
- scene recognition
- automatic tagging
- semantic embeddings
- vector databases
- conversational interfaces
- automated QC
- content recommendations
- thumbnail generation
- video transcoding
- proxy generation
- automated file relocation
- media deletion
- media rename
- duplicate resolution
- archive lifecycle automation
- complex access control
- multi-tenancy
- external public access

> **Note (MVP 2):** transcription, summary, keywords, content classification, and
> lower-third OCR are delivered by **MVP 2**, a separate additive scope layer
> (§29, `ADR/ADR-007-mvp2-ai-enrichment-scope.md`). They remain out of **v1**
> scope. Every other item above remains out of scope for both v1 and MVP 2.

---

# 23. Technology Constraints

The default technology stack is:

### Frontend

- Next.js
- React
- TypeScript

### Backend

- Node.js
- Express
- TypeScript
- Zod

### Database

- PostgreSQL
- Prisma

### Queue

- BullMQ
- Redis

### Metadata Inspection

- ffprobe

### Infrastructure

- Docker
- Docker Compose

Technology changes should only occur when a documented requirement justifies them.

---

# 24. Product Success Criteria

TMIP v1 should be considered successful when the complete end-to-end workflow reliably works with actual storage.

A successful demonstration must prove:

1. Server A can access the media directory from Server B.
2. TMIP can recursively discover supported video files.
3. New files are recognized correctly.
4. Unchanged files are not unnecessarily reprocessed.
5. Changed files are detected.
6. ffprobe successfully extracts metadata from supported media.
7. Metadata is stored in PostgreSQL.
8. Failed files do not stop the entire scan.
9. A repeated scan does not create duplicate records.
10. The user can view discovered media and metadata through the web application.
11. TMIP does not modify source media files.

---

# 25. Minimum End-to-End Acceptance Scenario

The smallest valid product demonstration is:

```text
A video exists on Server B
        ↓
Server A exposes the storage to TMIP
        ↓
User starts a scan
        ↓
TMIP discovers the video
        ↓
TMIP identifies it as NEW
        ↓
Metadata extraction job is created
        ↓
ffprobe inspects the file
        ↓
Metadata is stored
        ↓
The video appears in the TMIP web interface
```

A second scan without modifying the file must result in:

```text
video discovered
        ↓
identified as UNCHANGED
        ↓
metadata extraction skipped
```

If the file is later modified:

```text
video discovered
        ↓
identified as UPDATED
        ↓
metadata extracted again
        ↓
stored metadata updated
```

This complete sequence is the primary acceptance test for TMIP v1.

---

# 26. Product Development Principle

TMIP v1 prioritizes:

```text
complete workflow
over
feature count
```

and:

```text
reliable implementation
over
architectural sophistication
```

and:

```text
clean extension points
over
pre-building future features
```

A feature that does not strengthen the core metadata pipeline should not delay completion of that pipeline.

---

# 27. Future Compatibility

The product may later evolve to support additional capabilities.

Examples may include:

- scheduled scans
- richer search
- technical QC
- AI-generated metadata
- transcription
- richer reporting
- additional storage locations

TMIP v1 must not implement these prematurely.

The responsibility of v1 is to make future evolution possible through:

- clear component boundaries
- flexible data structures
- reliable identifiers
- safe database evolution
- non-destructive storage handling

Future compatibility must come from good architecture, not from implementing future product scope early.

---

# 28. Definition of Product Completion

TMIP v1 is complete when the system can reliably maintain a technical metadata inventory of the configured video storage through repeated incremental scans.

Completion is not defined by the number of screens, services, or features.

The defining capability is:

> A user can scan real video storage, discover new or changed media, extract and persist technical metadata, and inspect the result through the application without modifying the original media.

---

# 29. MVP 2 — AI Metadata Enrichment (Additive)

MVP 2 is an additive product milestone on top of v1 (§1–§28). It is authorised by
`ADR/ADR-007-mvp2-ai-enrichment-scope.md` and uses the architecture of
`ADR/ADR-006-ai-processor-integration.md`. This section states MVP 2 requirements;
it does not change any v1 requirement.

## 29.1 Product goal

Enrich a media file with AI-generated metadata — transcription, summary, keywords,
content category, and lower-third OCR — durably and safely, without changing the
v1 pipeline or media-safety guarantees.

## 29.2 Requirements (MVP 2)

- The system can produce, per media file: a transcript (timed segments + full
  text), a summary, keywords, a content category, and lower-third OCR text with an
  optional parsed presenter.
- Each AI stage's result is persisted durably and independently; a later failure
  preserves earlier results (partial results).
- AI processing is opt-in and inert by default (`AI_ENABLED=false`).
- Failures are classified (transient vs permanent) and retried within a bounded,
  configurable budget; a failing file never fails the scan or the metadata
  pipeline.
- A running AI job can be cancelled durably; results from completed stages are
  kept.
- AI results are surfaced on the existing media list and media detail endpoints.
- The AI metadata field contract is defined once in
  `docs/mvp2-ai-metadata/01-ai-metadata-contract.md`.

## 29.3 Out of scope (MVP 2)

- Scene detection, CLIP, YOLO, object detection, scene descriptions.
- Semantic search, embeddings, vector databases, Knowledge Base.
- Multi-agent architecture, queue/Redis, Media Catalog/Asset ID model.
- Automated QC / compliance verdicts; human-metadata capture; approval workflows.
- Any modification of source media.

## 29.4 Acceptance intent

MVP 2 is acceptable when a media file can be driven through all MVP 2 stages to a
terminal AI state with correct fields (see §29.2), while the v1 completion criteria
(§28) and media-safety guarantees continue to hold. No numeric quality threshold is
defined here; quality-evaluation strategy is an open decision
(`docs/mvp2-ai-metadata/05-open-decisions.md` OD-07).