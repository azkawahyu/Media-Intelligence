# MVP 2 — AI Metadata Enrichment: Documentation Set

Status: **planning documentation** (not implementation).
Scope: documentation foundation for TMIP MVP 2 (AI metadata enrichment).
Owner action required: review + approval before any implementation.

This folder is a **planning annex**. It does not replace the canonical TMIP
documents (`AGENTS.md`, `PRD.md`, `SCOPE.md`, `ARCHITECTURE.md`, `DATA_MODEL.md`,
`WORKFLOWS.md`, `TESTING.md`, `ADR/`). Where a canonical document already owns a
contract, this set defers to it and records the required change instead of
duplicating it (see `07-document-update-list.md`).

## Contents

| File | Purpose |
|---|---|
| `00-source-to-target-mapping.md` | Which team-repo documents were used, what was adopted/adapted/reference-only, and why |
| `01-ai-metadata-contract.md` | **Canonical** AI metadata contract for TMIP (fields, types, provenance, validation, required/optional) |
| `02-enrichment-workflow.md` | Enrichment workflow, I/O, status transitions, failure/retry/idempotency, relation to MVP 1 stages |
| `03-rules-to-fields-mapping.md` | How applicable broadcast/QC rules map to metadata fields and validation outcomes |
| `04-mvp2-scope-and-requirements.md` | MVP 2 scope, requirements, in/out, acceptance intent |
| `05-open-decisions.md` | Decision register (Resolved + still-open) |
| `06-consistency-report.md` | Conflicts found between current TMIP documents/ADRs and reality; proposals (no silent changes) |
| `07-document-update-list.md` | Existing TMIP documents needing future updates + proposed change per document |
| `08-implementation-plan.md` | Proposed implementation plan for approval (not started) |
| `09-quality-evaluation.md` | Proposed golden-dataset + quality-evaluation strategy (OD-07) |
| `reference/` | Adapted extracts from the team repository, with provenance labels |

**Status (2026-10-13):** the MVP 2 scope is now official —
`ADR/ADR-007-mvp2-ai-enrichment-scope.md` (additive scope layer), with MVP 2
sections in `SCOPE.md §37` and `PRD.md §29`. Decisions OD-13, OD-02, OD-05, OD-12
are **resolved**; OD-01/03/04/06/07/08/09/10/11 and NEW-4 remain open (see `05`).

## Provenance vocabulary

- **Adopted** — content taken from the team repository and accepted as-is for TMIP's semantics/rules.
- **Adapted** — content from the team repository, changed to fit TMIP's data model/terminology.
- **Reference-only** — kept for context/traceability; **not** a TMIP requirement.
- **Unresolved** — an open question; not decided.

## Non-negotiable constraints honoured by this set

- No application code, schema, migration, runtime config, dependency, or deployment change was made.
- The team repository was not modified.
- MVP 1 behavior and its verified pipeline are untouched.
- The team's multi-agent architecture, BullMQ/Redis, Media Catalog/Asset ID model, and
  Knowledge Base are **not** adopted; where relevant they appear only as
  reference-only or as a proposal requiring explicit approval.
- AI enrichment is documented as an **additive v2** capability; moving it into v1 scope
  is proposed (not performed) in `06-consistency-report.md` and `07-document-update-list.md`.
