# 08 — Proposed Implementation Plan (for approval)

Status: **proposal**. No implementation has started. This plan is bounded by the
MVP 2 scope (`04-mvp2-scope-and-requirements.md`) and the open decisions
(`05-open-decisions.md`).

## 0. Preconditions (resolve before coding)

1. Resolve blocking decisions: **OD-02, OD-05, OD-11, OD-12, OD-13** — *all resolved
   as of 2026-10-13* (see `05-open-decisions.md`).
2. Approve the scope note changes U-1/U-2 (or choose the larger OD-13 path).
3. Confirm which changes below are in scope.

## 1. Guiding constraints

- Preserve MVP 1 (`metadataStatus` pipeline) untouched.
- Additive schema/API only (`AGENTS.md §32`).
- No new heavy dependencies without approval; no Redis/BullMQ.
- No file operations on source media.

## 2. Workstreams

### WS-A — Documentation alignment (no code) [safe, low risk]
- Apply U-3 (DATA_MODEL AI section), U-4 (WORKFLOWS AI section referencing `02`),
  U-5 (TESTING AI expectations), U-1/U-2 (scope note). Each references the
  canonical contract in this folder rather than duplicating it.
- Rationale: the AI entities/flow are implemented but undocumented in the canonical
  docs; this closes the gap without new claims.

### WS-B — Reconcile the OCR sampling decision (OD-11) [DONE 2026-10-13]
- Completed: the 14-frame experiment was reverted to the five-frame grid to match
  `ADR-006 §20`; a regression assertion was added. No detection-accuracy claim is
  made for either grid.
- Rationale: the code contradicted the recorded decision and the wider grid added
  cost without a reliable gain.

### WS-C — AI metadata contract hardening (if gaps confirmed)
- Only if OD-02/OD-05/OD-04 are resolved toward "change":
  - category taxonomy alignment (OD-05) — may touch `text_llm.py` category list.
  - empty-keyword semantics (OD-02) — processor and/or adapter behavior.
  - optional `ai_confidence` (OD-04) — would touch processor prompt + contract.
- Each change would include contract update + tests.

### WS-D — Test coverage for the contract
- Ensure contract fields are covered by existing AI tests; add tests only for
  newly decided behavior. Keep contract/config parity test
  (`ai-processor/tests/test_team_parity.py`) green.
- Note the known gap: no web test runner (`07-document-update-list.md` U-5).

## 3. Sequencing

```text
0. decisions (OD-02/05/11/12/13)
1. WS-A documentation alignment        (no runtime change)
2. WS-B OCR decision reconciliation    (doc; maybe 1-line revert)
3. WS-C contract hardening             (only if decided)
4. WS-D tests
5. verification (below) + report
```

WS-A/WS-B are mechanical and low-risk. WS-C is the only workstream that can change
runtime behavior and must be explicitly approved decision-by-decision.

## 4. Verification (per `TESTING.md` + `AGENTS.md §29`)

- `pytest ai-processor/tests` and `pnpm --filter @tmip/api test` green.
- `pnpm typecheck`, `pnpm lint`, `pnpm build` clean.
- `docker compose build ai-processor` + container `/health` 200.
- Confirm no `metadataStatus` write from any AI path; media stays read-only;
  contained path enforced.
- `git diff --numstat` for MVP 1 files unchanged.

## 5. Explicitly NOT in this plan

- Scene/CLIP/YOLO, embeddings/KB, multi-agent, Media Catalog/Asset ID.
- Any scope move of AI into v1 without a recorded scope/ADR decision.
- Golden dataset / numeric quality targets (OD-07) until decided.

## 6. Deliverable on completion

Implementation + updated canonical docs + a report of actual test results,
consistent with `06-consistency-report.md` and this plan. Await approval before
starting.
