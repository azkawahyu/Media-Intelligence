# ADR-001: Use PostgreSQL with JSONB for Metadata Persistence

## Status

Accepted

## Context

TMIP needs to persist technical metadata extracted from video files.

Some metadata fields are stable and frequently used, such as:

- filename
- relative path
- duration
- codec
- resolution
- frame rate
- file size
- file status

Other metadata fields may vary significantly depending on:

- media container
- codec
- broadcast format
- ffprobe output
- future metadata requirements

Examples include:

- MXF-specific metadata
- color metadata
- timecode fields
- vendor-specific tags
- codec-specific flags
- stream-specific metadata

A fully relational schema for every possible metadata field would create unnecessary rigidity and frequent migrations.

A fully document-oriented database would provide flexibility, but TMIP also requires strong relational behavior for:

- storage records
- media identity
- scan jobs
- scan observations
- extraction history
- constraints
- incremental scanning
- filtering
- reporting
- transactional consistency

---

## Decision

TMIP will use PostgreSQL as its primary persistent database.

The metadata model will use a hybrid strategy:

```text
Stable + frequently queried metadata
→ relational columns

Flexible + format-specific metadata
→ PostgreSQL JSONB
```

PostgreSQL remains the source of truth for TMIP application state.

---

## Relational Data

Fields should use relational columns when they are:

- stable
- frequently queried
- frequently filtered
- frequently sorted
- used in application logic
- useful for indexing

Examples:

```text
storageId
relativePath
filename
extension
fileSize
modifiedAt

durationSeconds
videoCodec
width
height
frameRate

status
metadataStatus

firstSeenAt
lastSeenAt
lastMetadataExtractedAt
```

---

## JSONB Data

JSONB should be used for metadata that is:

- format-specific
- optional
- deeply nested
- rarely queried
- likely to evolve
- not yet important enough to justify a relational column

Examples:

```text
technicalMetadata JSONB
rawProbeData JSONB
```

Possible contents include:

```json
{
  "color": {
    "space": "bt709",
    "transfer": "bt709",
    "primaries": "bt709"
  },
  "timecode": "10:00:00:00",
  "streamTags": {},
  "containerTags": {}
}
```

---

## Metadata Promotion

Fields are allowed to move from JSONB into relational columns later.

Example:

Initially:

```text
technicalMetadata.colorSpace
```

If color space later becomes important for:

- filtering
- sorting
- indexing
- reporting
- business logic

then a column may be added:

```text
MediaFile.colorSpace
```

The migration should preferably be additive.

---

## Raw ffprobe Preservation

Where practical, TMIP should preserve the latest successful raw ffprobe output.

Example:

```text
rawProbeData JSONB
```

This preserves information that may not currently be normalized.

Application business logic should not depend directly on arbitrary raw ffprobe structures.

Normalization must occur through a dedicated metadata parsing boundary.

---

## Alternatives Considered

### Fully Relational PostgreSQL Schema

Advantages:

- strong schema
- explicit types
- easy indexing

Disadvantages:

- frequent schema migrations
- large number of rarely used columns
- poor fit for highly variable media metadata
- increased refactor cost

Rejected as the exclusive strategy.

---

### Document Database

Examples:

```text
MongoDB
CouchDB
```

Advantages:

- flexible document structure
- natural JSON storage

Disadvantages:

- TMIP still requires strong relational relationships
- relational scan and media state are important
- PostgreSQL already provides JSONB
- introduces another database model without a current requirement

Rejected for TMIP v1.

---

### JSON Files on Disk

Advantages:

- simple initial implementation
- human-readable
- easy to inspect manually

Disadvantages:

- difficult querying at scale
- weak concurrency behavior
- difficult pagination
- difficult indexing
- difficult transactional consistency
- filesystem becomes application state
- awkward incremental scan coordination

Rejected as the primary metadata store.

---

## Consequences

### Positive

TMIP gains:

- relational consistency
- SQL querying
- indexing
- transactional operations
- flexible metadata storage
- low-cost metadata evolution
- one primary database technology
- reduced future schema refactoring

### Negative

The system must define clear rules for:

```text
what belongs in relational columns
vs
what belongs in JSONB
```

Uncontrolled use of JSONB could lead to an unstructured data model.

Therefore JSONB must not become a replacement for deliberate domain modeling.

---

## Guardrails

Do not add a relational column simply because ffprobe returned a field.

Do not place all application data into JSONB.

Do not introduce another database solely because metadata structure changes.

Before adding a new metadata column, ask:

1. Is it stable?
2. Is it frequently queried?
3. Is it important to business logic?
4. Does it need an index?
5. Could it remain in JSONB for now?

---

## Result

The chosen persistence strategy is:

```text
PostgreSQL
+
relational core
+
JSONB metadata flexibility
```

This decision supports both current simplicity and future metadata evolution.