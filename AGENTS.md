# AGENTS.md

## 1. Purpose

This document defines the operating rules for any AI coding agent working on TMIP.

These rules are mandatory.

The purpose of this file is to prevent:

- scope creep
- unnecessary architectural complexity
- duplicate implementations
- premature abstraction
- destructive operations
- large refactors caused by short-term decisions
- features being added before the core workflow is complete

TMIP must remain simple enough to understand, test, and maintain while preserving the ability to evolve later without major rewrites.

---

# 2. Project Mission

TMIP v1 has one primary mission:

> Discover video files stored on Server B, extract technical metadata from those files, persist the metadata, and display the results through the application running on Server A.

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

Every implementation decision in TMIP v1 must directly support this pipeline.

---

# 3. Scope Discipline

Agents MUST NOT expand the project scope unless explicitly requested by the user.

Do not implement "helpful extras" proactively.

Do not add functionality simply because it may be useful in the future.

Future extensibility should be achieved through clean boundaries and data modeling, not by implementing future features early.

Before implementing any feature, ask internally:

> Does this directly support the current TMIP v1 pipeline?

If the answer is no, do not implement it.

---

# 4. Current In-Scope Capabilities

TMIP v1 may include:

- remote media storage access
- read-only media discovery
- recursive directory scanning
- supported media file detection
- incremental scanning
- new file detection
- changed file detection
- unchanged file skipping
- missing file detection
- technical metadata extraction
- metadata persistence
- scan job tracking
- extraction failure tracking
- background processing
- basic media listing
- basic media detail view
- scan progress display
- manual scan triggering

---

# 5. Explicitly Out of Scope

Unless explicitly requested, agents MUST NOT implement:

- AI-generated metadata
- large language model integration
- chatbot functionality
- semantic search
- embeddings
- vector databases
- speech-to-text
- transcription
- OCR
- face recognition
- object detection
- scene detection
- automatic content classification
- recommendation systems
- automated QC analysis
- automated QC reports
- video transcoding
- proxy generation
- thumbnail generation unless explicitly required
- file rename operations
- file move operations
- file deletion
- file overwrite operations
- archive lifecycle management
- approval workflows
- notification systems
- complex RBAC
- multi-tenant architecture
- reporting platforms
- analytics dashboards
- workflow automation unrelated to metadata scanning
- agentic automation
- microservices architecture unless technically justified later

Do not prepare infrastructure for these features unless the current implementation genuinely requires it.

---

# 6. Media Storage Safety

Media storage must be treated as read-only.

TMIP MUST NOT modify original media files.

The application MUST NOT:

- delete media files
- rename media files
- move media files
- overwrite media files
- modify media contents
- modify media file timestamps
- write sidecar files into the source media directory

The preferred deployment model is:

```text
Server B
    ↓
SMB / NFS
    ↓
Server A mounted filesystem
    ↓
Docker read-only bind mount
    ↓
TMIP
```

Example:

```text
/mnt/tmip-media:/media:ro
```

Write access to source media storage must not be introduced without explicit approval.

---

# 7. Architecture Principles

TMIP must optimize for:

1. simplicity
2. maintainability
3. observability
4. recoverability
5. data safety
6. incremental evolution
7. low refactor cost

Prefer simple implementations with clean boundaries.

Avoid architecture designed for hypothetical future scale.

Do not introduce distributed systems concepts unless there is an actual requirement.

---

# 8. Separation of Responsibilities

The following concerns must remain logically separated.

## Scanner

Responsible for:

- filesystem traversal
- discovering files
- collecting filesystem attributes
- identifying supported media files
- detecting file presence

The scanner MUST NOT perform expensive metadata extraction directly.

---

## Change Detection

Responsible for determining whether a discovered file is:

- NEW
- UNCHANGED
- UPDATED
- MISSING

Change detection should use stable filesystem properties such as:

- storage identifier
- relative path
- file size
- modified timestamp

More expensive fingerprinting or hashing should only be introduced when required.

---

## Metadata Extractor

Responsible for:

- invoking ffprobe
- parsing ffprobe output
- validating extracted metadata
- normalizing selected metadata fields

It MUST NOT perform file discovery.

---

## Worker

Responsible for background processing.

Expensive work such as ffprobe execution must not block HTTP requests.

---

## API

Responsible for:

- exposing application functionality
- triggering scan jobs
- querying stored metadata
- exposing scan progress
- returning media records

The API must not directly perform long-running filesystem scans or ffprobe processing inside request handlers.

---

## Database

PostgreSQL is the persistent source of truth.

Redis, when used, is not a source of truth.

Filesystem state is not a replacement for application state.

---

# 9. Scanning Rules

Scanning must be idempotent.

Running the same scan multiple times against unchanged storage must not create duplicate media records or duplicate metadata.

The expected behavior is:

```text
FILE NOT KNOWN
→ NEW
→ queue metadata extraction

FILE KNOWN + UNCHANGED
→ update observation information
→ skip metadata extraction

FILE KNOWN + CHANGED
→ UPDATED
→ queue metadata extraction

PREVIOUSLY KNOWN FILE NOT FOUND
→ mark as MISSING
```

Do not delete database records simply because a file is missing during one scan.

A missing file may be caused by:

- temporary network failure
- temporary storage unavailability
- mount failure
- permission failure
- directory changes

Missing records should remain recoverable.

---

# 10. Discovery Is Not Extraction

File discovery and metadata extraction are separate operations.

A file may be discovered many times.

Metadata extraction should only occur when:

- the file is new
- the file has changed
- the previous extraction failed and is being retried
- the user explicitly requests reprocessing

Do not rerun ffprobe unnecessarily.

---

# 11. Database Strategy

PostgreSQL must remain the primary database unless an explicit architectural decision replaces it.

TMIP should use a hybrid data model.

## Relational Columns

Use relational columns for fields that are:

- stable
- frequently queried
- frequently filtered
- frequently sorted
- important to application behavior

Examples:

- id
- storageId
- relativePath
- filename
- extension
- fileSize
- modifiedAt
- duration
- width
- height
- videoCodec
- frameRate
- status
- firstSeenAt
- lastSeenAt
- lastScannedAt

---

## JSONB

Use PostgreSQL JSONB for metadata that is:

- dynamic
- format-specific
- rarely queried
- experimental
- likely to evolve
- difficult to normalize initially

Examples:

- raw ffprobe output
- container-specific metadata
- MXF-specific fields
- extended audio metadata
- color metadata
- timecode metadata
- vendor-specific metadata

Do not create new relational columns for every ffprobe field.

---

# 12. Schema Evolution

The database schema must be designed for additive evolution.

Prefer:

```text
add field
add table
add index
add relationship
```

over:

```text
rewrite schema
replace major entity model
migrate entire architecture
```

A field may initially live inside JSONB.

If that field later becomes important for:

- filtering
- indexing
- reporting
- sorting
- application logic

it may be promoted into a relational column.

This promotion should not require redesigning the entire media model.

---

# 13. Raw Metadata Preservation

When practical, preserve the raw ffprobe output.

Example:

```text
rawProbeData JSONB
```

The normalized application fields and raw probe data serve different purposes.

Normalized fields are used by the application.

Raw data preserves information that may become useful later.

Do not depend on raw ffprobe JSON structure directly throughout the application.

Parsing and normalization should occur through a dedicated boundary.

---

# 14. File Identity

Do not assume filename alone uniquely identifies a media file.

Prefer identity based on storage context and path.

Example conceptual identity:

```text
storageId + relativePath
```

Change detection may additionally use:

```text
fileSize
modifiedAt
```

Do not introduce expensive full-file hashing by default.

Hashing may be added later if stronger identity or duplicate detection becomes a real requirement.

---

# 15. Path Handling

Do not hardcode absolute server paths into business logic.

Bad:

```text
/mnt/server-b/video/archive/...
```

Preferred:

```text
Storage
- id
- name
- rootPath
```

Media records should store paths relative to their configured storage root whenever practical.

Example:

```text
storage root:
/media

relative path:
News/2026/September/report.mxf
```

This allows storage paths to change without rewriting every database record.

---

# 16. External Tool Boundary

FFmpeg / ffprobe must be treated as an external dependency.

Create a clear adapter or service boundary around ffprobe execution.

Application business logic must not be tightly coupled to shell command formatting.

Conceptually:

```text
MetadataExtractor
    ↓
FFprobeAdapter
    ↓
ffprobe executable
```

This makes ffprobe execution easier to:

- test
- mock
- replace
- version
- debug

---

# 17. Validation

External inputs must be validated.

This includes:

- API payloads
- environment variables
- scanner configuration
- ffprobe results where appropriate

Use Zod for application-level validation unless there is a strong reason not to.

Never assume external command output is always complete or valid.

Media files may be:

- malformed
- incomplete
- partially copied
- unsupported
- corrupted
- inaccessible

The application must handle these cases gracefully.

---

# 18. Failure Handling

One failed file must not fail an entire scan.

Example:

```text
10,000 files discovered

9,997 metadata success
3 metadata failures
```

The scan should complete and report the failures.

Failure records should contain enough information for debugging.

Where appropriate, store:

- error category
- error message
- processing stage
- timestamp
- retry count

Do not hide errors.

Do not crash the entire worker because one media file cannot be processed.

---

# 19. Retry Behavior

Retries must be bounded.

Do not create infinite retry loops.

Retry logic should distinguish between:

- transient failures
- permanent failures

Examples of potentially transient failures:

- network interruption
- temporary file lock
- temporary storage unavailability

Examples of likely permanent failures:

- unsupported format
- corrupted file
- invalid media structure

---

# 20. Concurrency

Do not maximize worker concurrency without considering Server B and network load.

Metadata extraction reads media files over the network.

High concurrency may cause:

- storage overload
- network saturation
- slow production workflows
- unstable scanning

Worker concurrency must be configurable.

Start conservatively.

Do not assume faster parallel processing is always better.

---

# 21. Configuration

Environment-specific configuration must not be hardcoded.

Use environment variables or validated configuration for values such as:

- database connection
- Redis connection
- media root
- worker concurrency
- supported extensions
- ffprobe binary location
- application ports

Provide safe defaults only when appropriate.

---

# 22. Supported Media Types

Supported media extensions must be configurable or centralized.

Do not scatter extension lists throughout the codebase.

Example:

```text
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

Extension detection alone does not guarantee a valid video.

ffprobe remains responsible for actual media inspection.

---

# 23. Technology Stack

The default TMIP v1 stack is:

## Language

- TypeScript

## Frontend

- Next.js
- React

## Backend

- Node.js
- Express
- Zod

## Database

- PostgreSQL
- Prisma

## Background Jobs

- BullMQ
- Redis

## Media Inspection

- FFmpeg / ffprobe

## Infrastructure

- Docker
- Docker Compose

Do not replace major technologies without an explicit architectural reason.

---

# 24. Dependency Discipline

Before adding a dependency:

1. determine whether the platform or existing dependency already solves the problem
2. evaluate maintenance impact
3. avoid overlapping libraries
4. avoid introducing large frameworks for small problems

Prefer built-in Node.js APIs where they are sufficient.

Example:

Use Node.js filesystem APIs for directory traversal unless another library provides a clearly necessary capability.

---

# 25. Avoid Premature Abstraction

Do not create generic systems before multiple concrete use cases exist.

Avoid unnecessary:

- repository patterns
- generic service factories
- plugin architectures
- event buses
- domain frameworks
- abstraction layers
- configuration engines

A small duplication is sometimes preferable to an abstraction whose purpose is speculative.

Refactor when repeated patterns actually emerge.

---

# 26. Avoid Premature Optimization

Do not optimize hypothetical bottlenecks.

Measure first.

Likely real bottlenecks include:

- network filesystem throughput
- ffprobe execution
- very large directory traversal
- database indexing

Optimize based on observed behavior.

---

# 27. Observability

Long-running operations should be observable.

A scan should expose meaningful state such as:

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
- queued files
- processed files
- failed files
- missing files

Do not build a full monitoring platform for v1.

Provide only what is necessary to understand whether the pipeline is working.

---

# 28. Testing Requirements

Changes must be testable.

At minimum, important business behavior should cover cases such as:

- new file discovered
- unchanged file skipped
- modified file reprocessed
- unsupported file ignored
- ffprobe failure recorded
- missing file marked correctly
- repeated scan does not duplicate records

Where external dependencies are involved, use boundaries that allow mocking.

Do not require access to Server B for every automated test.

---

# 29. Implementation Workflow for Agents

Before making changes, the agent MUST:

1. read this file
2. read `PRD.md`
3. read `SCOPE.md`
4. inspect relevant architecture documentation
5. inspect existing code before creating new implementation
6. search for existing types, utilities, services, schemas, and endpoints
7. identify the smallest change that satisfies the task

During implementation:

1. preserve existing behavior unless change is requested
2. avoid unrelated refactoring
3. avoid formatting unrelated files
4. keep changes localized
5. reuse existing patterns
6. maintain type safety
7. handle failures explicitly

After implementation:

1. run relevant tests
2. run type checking
3. run linting when configured
4. verify the requested behavior
5. inspect the diff for accidental scope expansion
6. update documentation only when behavior or architecture actually changed

## Implementation Traceability

For implementation tasks, agents must provide traceable evidence that the work follows project documentation.

Before implementation:
- identify the documentation relevant to the task
- cite the applicable requirements
- inspect existing implementation before creating new code

After implementation:
- map documented requirements to changed code
- map documented requirements to relevant tests
- report actual verification commands and results
- inspect the final Git diff for unrelated changes
- explicitly disclose anything unverified or blocked

Do not claim completion when required verification fails.

## Planning Traceability

Every implementation plan must identify the documented requirements that justify each major phase.

The plan-reviewer must verify that:
- the plan remains within `SCOPE.md`
- architectural decisions comply with `ARCHITECTURE.md` and ADRs
- data changes comply with `DATA_MODEL.md`
- runtime behavior complies with `WORKFLOWS.md`
- verification strategy complies with `TESTING.md`

---

# 30. Existing Implementation First

Never assume a requested feature does not exist.

Before implementing:

- search routes
- search services
- search schemas
- search database models
- search UI components
- search tests

If functionality already exists:

- reuse it
- extend it
- fix it

Do not create a second implementation unless replacement is explicitly justified.

---

# 31. Refactoring Rules

Refactoring is allowed when necessary to implement the requested change safely.

Do not perform broad refactors unrelated to the task.

Large refactors require a concrete reason such as:

- correctness issue
- major maintainability problem
- architectural violation
- blocker for requested functionality

"Cleaner" alone is not sufficient justification for a large rewrite.

---

# 32. Backward Compatibility

Prefer additive changes.

When modifying persisted data structures or APIs, consider existing records and callers.

Do not introduce destructive migrations casually.

Migration steps must be explicit and recoverable where practical.

---

# 33. Documentation Rules

Documentation must describe current behavior, not hypothetical systems.

Do not document features that do not exist as if they are implemented.

Use the following documents as separate sources of truth:

```text
AGENTS.md
→ agent behavior and engineering guardrails

PRD.md
→ product purpose and requirements

SCOPE.md
→ what is currently in scope and out of scope

ARCHITECTURE.md
→ system structure and component boundaries

DATA_MODEL.md
→ domain entities and data modeling rules

WORKFLOWS.md
→ runtime and business flows

TESTING.md
→ verification strategy

ADR/
→ important architectural decisions
```

Avoid duplicating large sections across documents.

---

# 34. Architecture Decision Records

Important architectural decisions must be documented using ADRs.

Examples:

```text
ADR-001-postgresql-jsonb.md
ADR-002-read-only-media-storage.md
ADR-003-incremental-scanning.md
```

Create an ADR when a decision:

- meaningfully constrains future implementation
- has multiple reasonable alternatives
- would otherwise be questioned later
- affects long-term architecture

Do not create ADRs for trivial coding choices.

---

# 35. Current Core Architectural Decisions

Unless explicitly changed through an ADR:

1. PostgreSQL is the source of truth.
2. Flexible metadata uses JSONB where appropriate.
3. Source media storage is read-only.
4. Scanning is incremental.
5. Discovery and metadata extraction are separate.
6. Expensive processing occurs in background workers.
7. ffprobe is the technical metadata extraction tool.
8. Redis is used only for ephemeral queue state.
9. Server-specific paths must not leak into core domain logic.
10. The system must support future additive evolution without implementing future features prematurely.

---

# 36. Definition of Done

A task is complete only when:

- the requested behavior is implemented
- the implementation remains inside project scope
- the implementation does not introduce destructive media operations
- the implementation follows existing architecture
- relevant validation exists
- relevant error handling exists
- relevant tests pass
- type checking passes
- no duplicate implementation was introduced
- no unrelated features were added
- documentation is updated when required

---

# 37. TMIP v1 Product Completion Rule

TMIP v1 is not considered successful because many features exist.

TMIP v1 is successful when the complete vertical workflow works reliably:

```text
Server B contains a video
        ↓
Server A can discover it
        ↓
TMIP identifies whether it is new or changed
        ↓
ffprobe extracts technical metadata
        ↓
metadata is persisted
        ↓
the user can see the result in the application
```

Reliability of this workflow takes priority over feature count.

---

# 38. Final Agent Rule

When choosing between:

```text
more features
```

and:

```text
a smaller, complete, reliable pipeline
```

always choose the smaller, complete, reliable pipeline.

When choosing between:

```text
future-proof by implementing future features now
```

and:

```text
future-proof through clean boundaries and flexible data design
```

always choose clean boundaries and flexible data design.
