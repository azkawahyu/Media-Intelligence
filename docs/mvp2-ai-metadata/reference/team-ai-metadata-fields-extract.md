# Reference — Team AI Metadata Field Extract

**Provenance: Adapted extract. Reference-only.**

Source: `D:\DEVELOP\tvri-media-intelligence-platform`
- `docs/06-media-asset-model.md` — section "AI Metadata" (fields table + example)
- `docs/07-media-catalog-specification.md` — section "Metadata" → "AI Metadata"

This is a trimmed, verbatim-faithful extract of the AI-metadata field definitions
only. It is kept for traceability of where TMIP's canonical field semantics came
from. It is **not** a TMIP requirement and does **not** override
`01-ai-metadata-contract.md`.

---

## From `docs/06-media-asset-model.md` — "AI Metadata"

> Metadata yang dihasilkan otomatis oleh sistem AI.

Fields (verbatim names):

| Field |
|---|
| `summary` |
| `keywords` |
| `suggested_category` |
| `transcript` |
| `detected_language` |
| `scene_labels` |
| `detected_objects` |
| `ai_confidence` |

Example (verbatim):

```yaml
summary:
  Feature mengenai aktivitas UMKM di kawasan Tanah Abang Jakarta Pusat.

keywords:
- UMKM
- Pasar
- Pedagang
- Ekonomi
- Jakarta

suggested_category:
  Ekonomi
```

Decision-003 (verbatim): *"Human Metadata dan AI Metadata disimpan dalam satu model
asset, tetapi dibedakan berdasarkan sumber pengisian."* — Status: Approved.

---

## From `docs/07-media-catalog-specification.md` — "AI Metadata"

Verbatim list:

- Summary
- Keywords
- Transcript
- Language
- Suggested Category
- Suggested Tags
- OCR Result
- Scene Description

---

## Field-name reconciliation (team → TMIP canonical)

| Team name (source) | TMIP canonical (`01-ai-metadata-contract.md`) | Note |
|---|---|---|
| `summary` (06) | `summary` | adopted |
| `keywords` (06) | `keywords` | adopted |
| `suggested_category` (06) / Suggested Category (07) | `category` | adapted (renamed) |
| `transcript` (06) / Transcript (07) | `full_text` + `segments` | adapted (split) |
| `detected_language` (06) / Language (07) | `language` | adapted (renamed) |
| OCR Result (07) | `raw_text` + `presenter` | adapted |
| Suggested Tags (07) | — | unresolved (OD-03) |
| `scene_labels` (06) / Scene Description (07) | — | deferred (Phase 15) |
| `detected_objects` (06) | — | deferred (Phase 15) |
| `ai_confidence` (06) | — | unresolved (OD-04) |
