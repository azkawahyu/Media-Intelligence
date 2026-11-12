# 07 — Existing TMIP Documents Requiring Updates

Status: **partially applied**. The MVP 2 alignment (2026-10-13) applied U-1, U-2,
U-6, U-7, U-8, and (after the OD-11 resolution) U-9. U-3/U-4/U-5 remain open (they
document behavior already covered by this set; apply when convenient).

| ID | Document | Proposed change | Reason | Status |
|---|---|---|---|---|
| U-1 | `SCOPE.md` | Add an explicit MVP 2 note + section: an **additive scope layer** exists (disabled by default), cross-referencing `ADR-007`; do **not** reclassify AI as v1. | AI is implemented but scope text did not mention it. **[scope]** | **Applied** — `SCOPE.md §27` note, `§28` note, new `§37` |
| U-2 | `PRD.md` | Same note + an MVP 2 requirements section. | Same as U-1. **[scope]** | **Applied** — `PRD.md §22` note, new `§29` |
| U-3 | `DATA_MODEL.md` | Add an AI section documenting `AiStatus`/`AiStage`/`AiStageStatus`, the `AiResult` model, and the `MediaFile` AI columns (reference the contract, do not restate fields). | AI entities exist in schema but are absent from DATA_MODEL. | Open |
| U-4 | `WORKFLOWS.md` | Add an AI enrichment workflow section referencing `docs/mvp2-ai-metadata/02-enrichment-workflow.md` (avoid duplicating it). | Runtime AI flow is undocumented in WORKFLOWS. | Open |
| U-5 | `TESTING.md` | Add AI testing expectations (adapter boundary, real-DB integration tests, env-gated parity test) and note the missing web test runner. | No AI guidance in TESTING today. | Open |
| U-6 | `docs/plans/006-ai-processor-integration.md` | Update the header status from "not yet implemented" to reflect the implemented Phase 14 state. | Header was stale vs code. | **Applied** |
| U-7 | `ADR-006` §20 | Reconcile the OCR sampling decision with the code. See OD-11. | Code contradicted the recorded decision. | **Applied** — resolution note added; code reverted to five frames |
| U-8 | `ADR-006` (Status header) | Add an "implemented" note alongside "Accepted (Phase 13)". | ADR read as architecture-only though Phase 14 is built. | **Applied** |
| U-9 | `README.md` | Keep the OCR bullet consistent with the sampling decision (five frames, 10/30/50/70/90 %). | Must match the final sampling decision (OD-11). | **Applied / consistent** — README already states the five-frame grid; no edit needed |

## Where the new contract lives (avoid duplication)

- **AI metadata fields** → single canonical source:
  `docs/mvp2-ai-metadata/01-ai-metadata-contract.md`. `DATA_MODEL.md` should
  **reference** it, not restate field definitions.
- **AI workflow** → `docs/mvp2-ai-metadata/02-enrichment-workflow.md`;
  `WORKFLOWS.md` should reference it.
- **Rules mapping** → `docs/mvp2-ai-metadata/03-rules-to-fields-mapping.md`.

This keeps one canonical definition per contract, per `AGENTS.md §33`.

## Sequencing (updated 2026-10-13)

1. ~~Resolve blocking decisions OD-02, OD-05, OD-12, OD-13~~ — **done** (`05` resolved section).
2. ~~Apply U-1/U-2 (scope) + U-6/U-7/U-8 (status/ADR)~~ — **done**.
3. ~~Resolve **OD-11** (OCR sampling) — then apply U-9 (README bullet).~~ — **done**
   (code reverted to five frames; README already consistent).
4. Apply U-3/U-4/U-5 (DATA_MODEL/WORKFLOWS/TESTING AI sections) — pure documentation
   of existing behavior; low risk, not blocking.
