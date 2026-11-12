# ADR-003: Use Incremental Scanning

## Status

Accepted

## Context

Video files on Server B will continue to increase over time.

New media may be added regularly.

TMIP therefore cannot assume scanning is a one-time operation.

A naive approach would:

```text
scan all files
→ run ffprobe on all files
→ repeat during every scan
```

This would create unnecessary:

- network traffic
- storage reads
- CPU usage
- scan duration
- operational load on Server B

Most files are expected to remain unchanged between scans.

TMIP needs a repeatable mechanism that identifies only what requires new processing.

---

## Decision

TMIP will use incremental scanning.

Every scan may rediscover known files, but technical metadata extraction should only occur when required.

The main behavior is:

```text
DISCOVER FILE
    ↓
COMPARE WITH STORED STATE
    ↓
┌─────────────┬─────────────┬─────────────┐
│ NEW         │ UNCHANGED   │ UPDATED     │
└──────┬──────┴──────┬──────┴──────┬──────┘
       │             │             │
       ▼             ▼             ▼
    ffprobe         skip         ffprobe
```

After successful discovery:

```text
previously known files not observed
→ MISSING
```

---

## File Identity

The initial logical identity is:

```text
storageId + relativePath
```

Filename alone is not sufficient.

Absolute infrastructure paths must not be used as permanent media identity.

---

## Change Detection

The initial change-detection strategy will use inexpensive filesystem attributes:

```text
fileSize
modifiedAt
```

A known file with:

```text
same fileSize
+
same modifiedAt
```

is classified:

```text
UNCHANGED
```

A known file where either value differs is classified:

```text
UPDATED
```

---

## New File

If:

```text
storageId + relativePath
```

does not exist in the inventory:

```text
NEW
```

Behavior:

```text
create MediaFile
→ queue metadata extraction
```

---

## Unchanged File

Behavior:

```text
update lastSeenAt
update lastSeenScanId
keep status ACTIVE
skip ffprobe
```

The system must not update:

```text
lastMetadataExtractedAt
```

because extraction did not occur.

---

## Updated File

Behavior:

```text
update source filesystem attributes
→ queue metadata extraction
```

Existing last-known-good metadata should not be destroyed before replacement extraction succeeds.

---

## Missing File

Missing status may only be determined after discovery completes successfully.

Conceptually:

```text
current scan = 105

all discovered media:
lastSeenScanId = 105

after discovery:

known ACTIVE media
where lastSeenScanId != 105

→ MISSING candidates
```

The database record must not be deleted.

---

## Failed Discovery Safety

If the storage cannot be scanned reliably:

```text
missing detection must not run
```

Examples:

- network disconnect
- mount unavailable
- root permission failure
- fatal traversal failure

This prevents false mass-missing states.

---

## Rename Behavior

Because identity is based on path, a rename or move is interpreted as:

```text
old path
→ MISSING

new path
→ NEW
```

This behavior is accepted for v1.

Content-based rename detection is not required.

---

## Reappearance

A missing file that later returns at the same:

```text
storageId + relativePath
```

should reuse the existing media record.

Behavior:

```text
MISSING
→ ACTIVE
```

Then normal change detection applies.

---

## Why Full Hashing Is Not Used Initially

A stronger identity could use file hashing.

However, large broadcast media files may be expensive to hash.

Full hashing would increase:

- network traffic
- disk reads
- scan duration
- server load

For v1:

```text
path + size + modified time
```

is considered sufficient.

Hashing may be reconsidered if real-world evidence shows that this strategy is unreliable.

---

## Alternatives Considered

### Full Reprocessing Every Scan

Advantages:

- simplest conceptual behavior
- always refreshes metadata

Disadvantages:

- unnecessary ffprobe execution
- unnecessary network traffic
- poor scalability
- increased production-storage load

Rejected.

---

### Filesystem Watcher Only

Examples:

```text
fs.watch
inotify
```

Advantages:

- near-realtime file detection
- avoids full traversal

Disadvantages:

- behavior across network mounts may vary
- events may be lost during downtime
- watcher state may not reflect historical changes
- difficult initial inventory
- requires reconciliation anyway

Rejected as the primary inventory mechanism.

Filesystem watching may later supplement scanning if needed.

---

### Full File Hashing

Advantages:

- stronger content identity
- detects some replacements even when metadata is unusual

Disadvantages:

- expensive for large media
- significant network/storage cost
- unnecessary until proven otherwise

Deferred.

---

## Scan Scheduling

Incremental scanning does not require automatic scheduling.

TMIP v1 initially supports manual scan triggering.

Future scheduled scanning should reuse exactly the same incremental scan workflow.

Do not create separate business logic for:

```text
manual scan
scheduled scan
```

---

## Idempotency Requirement

Running repeated scans against unchanged storage must produce:

```text
no duplicate MediaFile records
no unnecessary metadata extraction
consistent inventory
```

Scan history may grow because each scan is a separate event.

Media inventory must remain stable.

---

## Scalability Consequence

The cost of repeated scans becomes approximately:

```text
directory traversal
+
filesystem stat operations
+
ffprobe only for changed/new files
```

instead of:

```text
directory traversal
+
ffprobe for every video
```

This is essential as the media collection grows.

---

## Future Evolution

Incremental scanning may later gain additional change-detection mechanisms such as:

- file settling periods
- lightweight fingerprints
- hashes
- filesystem event hints

These mechanisms should enhance the existing workflow rather than replace its fundamental structure.

---

## Result

TMIP scanning is designed as a recurring inventory reconciliation process.

The guiding principle is:

```text
rediscover everything cheaply
+
reprocess only what changed
```

rather than:

```text
reprocess everything every time
```