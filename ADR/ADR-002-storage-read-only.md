# ADR-002: Source Media Storage Must Be Read-Only

## Status

Accepted

## Context

TMIP reads video files stored on Server B.

The application runs on Server A and accesses Server B through mounted network storage.

TMIP v1 only requires source media access for:

- file discovery
- filesystem metadata inspection
- ffprobe technical metadata extraction

TMIP does not require modification of source media.

Allowing write access would increase operational risk without providing value to the current product scope.

Potential accidental operations could include:

- delete
- rename
- move
- overwrite
- timestamp modification
- accidental sidecar creation
- incorrect cleanup logic

Because Server B contains operational media assets, source safety is a higher priority than convenience.

---

## Decision

TMIP must treat source media storage as read-only.

The preferred infrastructure flow is:

```text
Server B
    ↓
SMB / NFS
    ↓
Server A host mount
    ↓
Docker read-only bind mount
    ↓
TMIP
```

Example:

```text
/mnt/tmip-media:/media:ro
```

TMIP should only have the permissions required to:

- list directories
- read file attributes
- open files for reading
- allow ffprobe to inspect files

---

## Application Restrictions

TMIP MUST NOT:

- delete source media
- rename source media
- move source media
- overwrite source media
- modify source media contents
- alter media timestamps
- create sidecar metadata beside source media
- reorganize source storage

---

## Metadata Location

Application metadata must be stored outside the source media storage.

Persistent metadata belongs in:

```text
PostgreSQL
```

Temporary queue state belongs in:

```text
Redis
```

Application logs belong in application-managed logging locations.

TMIP must not write:

```text
video.mxf.json
video.mxf.metadata
video.mxf.sidecar
```

into source media directories during normal operation.

---

## Mount Responsibility

SMB or NFS mounting should preferably be handled by Server A or its operating system.

TMIP application code should see the mounted directory as a normal filesystem.

The application should not contain SMB/NFS connection logic unless a future requirement clearly justifies it.

---

## Why Host-Level Mounting Is Preferred

It keeps network-storage concerns outside business logic.

Benefits include:

- simpler application code
- easier Docker configuration
- easier infrastructure troubleshooting
- easier credential management
- less protocol coupling
- easier migration between SMB and NFS

Conceptually:

```text
TMIP only knows:

/media
```

It does not need to know whether `/media` originates from:

```text
SMB
NFS
local disk
NAS
another storage technology
```

---

## Alternatives Considered

### Read-Write Mount

Advantages:

- future file operations become easier

Disadvantages:

- unnecessary risk
- accidental destructive operations become possible
- violates TMIP v1 scope
- increases impact of application bugs

Rejected.

---

### Application-Managed SMB Connection

Advantages:

- application directly controls remote access

Disadvantages:

- application becomes protocol-aware
- credential management becomes harder
- more application complexity
- weaker separation between infrastructure and domain logic

Rejected for v1.

---

### Sidecar JSON Files Beside Video

Advantages:

- metadata physically accompanies media

Disadvantages:

- requires write access
- pollutes source directories
- introduces synchronization problems
- violates read-only principle
- metadata becomes harder to query centrally

Rejected.

---

## Failure Behavior

If source storage becomes unavailable:

TMIP must report a storage-level failure.

It must not assume that previously known files were deleted.

Therefore:

```text
storage unavailable
≠
all files missing
```

Missing-file detection may only occur after sufficiently successful discovery.

---

## Security Consequence

Read-only mounting provides infrastructure-level protection against a class of application bugs.

Even if application code accidentally attempts:

```text
delete
rename
write
```

the filesystem should reject the operation when correctly mounted as read-only.

Application-level rules are still required.

Read-only infrastructure is defense in depth, not a replacement for correct code.

---

## Testing Requirement

At least one acceptance environment must verify TMIP against a genuinely read-only media mount.

The application must successfully:

- discover files
- stat files
- execute ffprobe
- persist metadata elsewhere

without requiring source write access.

---

## Future Changes

Any future feature requiring write access to source media must be considered a significant scope and architecture change.

Examples:

- rename
- relocation
- archive management
- metadata sidecars
- automatic cleanup

Such a change must require:

1. explicit approval
2. PRD update
3. SCOPE update
4. architecture review
5. a new ADR

Do not silently change this decision.

---

## Result

Source media remains operationally protected.

TMIP operates as:

```text
observer
+
metadata inventory system
```

not as a media file manager.