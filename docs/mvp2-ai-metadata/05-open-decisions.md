# 05 — Open Decisions Register

Status: **register of decisions**. Items marked **Resolved** were settled by the
MVP 2 scope documentation alignment (ADR-007 and the canonical contract); items
marked **Open** still need a human decision. Each decision is scoped to avoid
drifting beyond MVP 2.

Legend: **Resolved** = decided and recorded; **Open** = awaiting decision;
**Blocking** = should be resolved before/at MVP 2 implementation start;
**Deferrable** = can wait; **Out-of-scope** = recorded only because it was raised,
not part of MVP 2.

## Resolved by the MVP 2 alignment (2026-10-13)

| ID | Decision | Resolution | Recorded in |
|---|---|---|---|
| OD-13 | Is AI enrichment an official milestone? | **Resolved — yes.** MVP 2 established as an *additive scope layer*; v1 scope and acceptance criteria unchanged. | `ADR/ADR-007-mvp2-ai-enrichment-scope.md`; `SCOPE.md §37`; `PRD.md §29` |
| OD-02 | Empty `keywords` handling | **Resolved — `keywords: []` is a valid success.** A missing `KEYWORDS:` section still fails; an empty list does not. | `01-ai-metadata-contract.md` §3.3 |
| OD-05 | Content category taxonomy | **Resolved — keep TMIP's genre `category`; it is not a regulatory classification.** Mapping to broadcast categories is deferred to a future QC capability (out of MVP 2). | `01-ai-metadata-contract.md` §3.4; `03-rules-to-fields-mapping.md` |
| OD-12 | `AI_ENABLED` effective default | **Resolved — `false` is the default; `true` is an explicit operator override.** | `01-ai-metadata-contract.md` §2a |
| OD-11 | OCR sampling strategy (5 vs wider grid) | **Resolved — revert to the five-frame grid (10/30/50/70/90 %).** `ADR-006 §20`'s decision stands; the 14-frame experiment was reverted because it did not reliably improve detection and added per-frame cost. Code, comments, and a regression assertion were aligned. | `ADR-006 §20` (resolution note); `ai-processor/app/handlers/ocr.py`; `test_ocr.py` |

## Still open

| ID | Decision | Type | Status | Options / notes | Source |
|---|---|---|---|---|---|
| OD-01 | Trigger model: manual-only vs automatic-on-`metadataStatus=READY` | Product/technical | Open (Deferrable) | Implemented today = manual only (`ADR-006 §5`). Auto would need a decision on WHEN (NEW only? UPDATED too?), concurrency, and cost. | TMIP `ADR-006 §5` |
| OD-03 | `Suggested Tags` vs `keywords` | Product | Open (Deferrable) | Team `docs/07` lists a separate "Suggested Tags" field. TMIP has only `keywords`. Adopt a separate field or treat tags == keywords? | team `docs/07` |
| OD-04 | `ai_confidence` (per field / per stage) | Product/technical | Open (Deferrable) | Team `docs/06` lists `ai_confidence`; TMIP produces none. Adding it needs the LLM prompt to return a confidence and a storage slot. | team `docs/06`, `docs/rules.md §6` |
| OD-06 | Human-entered metadata capture | Product | Open (Deferrable) | Team stores human + AI metadata in one record distinguished by source (`docs/06` Decision-003). TMIP has no human-metadata capture. Adopt now or later? | team `docs/06` |
| OD-07 | Quality target / golden dataset | Product | **Open (Blocking)** | No golden dataset exists (neither repo). Parity today is contract/config only; live output parity is unmeasured. Decide whether to define one and what "acceptable" means. A proposed strategy is in `09-quality-evaluation.md` (this set). | this task; team repo (no golden dataset found) |
| OD-08 | Automatic QC/Compliance findings | Product | Out-of-scope | `rules.md §4–§6` needs content judgement TMIP does not perform. Recorded as future; adopting would be a scope expansion. | team `docs/rules.md` |
| OD-09 | Scene/location enrichment (Phase 15) | Product/technical | Out-of-scope | `scene_labels`, `detected_objects`, Scene Description. Deferred (`ADR-006 §16`, `SCOPE.md §27.1`); requires its own ADR. | team `docs/06`/`07`; TMIP `ADR-006 §16` |
| OD-10 | Multi-agent / Knowledge Base / Media Catalog architecture | Architecture | Out-of-scope | Team architecture (Orchestrator, agents, Knowledge Base, Asset ID). Explicitly not adopted; would require an architecture ADR and would replace TMIP's model. | team `docs/09`, `docs/08`, `docs/07` |
| NEW-4 | AI web UI test coverage | Testing | **Open (Blocking for "verified UI" claims)** | `apps/web` has no test runner; the AI UI (`AiProgress`, `AiReprocessAction`) is untested. | `06-consistency-report.md` |

## Team question register carried over (adapted)

From team `docs/11-open-questions.md` (relevant subset; re-scoped to TMIP):

| Team ID | Question | Team status | TMIP relevance |
|---|---|---|---|
| AI-001 | Which AI model / provider runs the enrichment? | Open | TMIP: provider-agnostic via `LLM_*` (implemented); model choice is operator config. |
| MQ-001 | Which metadata fields are mandatory? | Partially answered | Answered for TMIP AI fields in `01-ai-metadata-contract.md` §3. |
| MQ-002 | Which metadata may be AI-generated? | Answered (team) | TMIP: the five stages in `01` §3. |
| MQ-003 | Who may edit metadata? | Open | TMIP: no human-metadata editing in scope (OD-06). |
| MQ-004 | Do metadata revisions need approval? | Open | TMIP: AI values are advisory; no approval workflow (out of scope). |
| MQ-005 | Does metadata keep revision history? | Assumption: Yes | TMIP: `AiResult` is upserted per stage (no per-revision history). |

## Priority recommendation

Resolve the **Blocking** set (OD-02, OD-05, OD-11, OD-12, OD-13) before starting
MVP 2 implementation. The rest can be scheduled or explicitly deferred.
