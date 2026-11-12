# 03 — Rules-to-Fields Mapping (AI/QC rules → metadata fields)

Status: **mapping analysis** (documentation only). Source: team repository
`docs/rules.md` (DOC-RULES v1.3, status Draft, owner TVRI DKI Jakarta,
last_updated 2026-08-07), derived from UU No. 32/2002 (Penyiaran) and Peraturan
Dewan Direksi LPP TVRI No. 62/2024. Regulation citations are preserved verbatim.

**Important:** `rules.md` is a **Draft operational guide**, not a regulation and
not a TMIP requirement. It targets a broader scope (Metadata Agent + QC/Compliance
Agent) than TMIP MVP 2 implements. This document maps each rule to the field that
*would* carry it in TMIP, and states honestly whether TMIP produces that field.

## 1. How to read this mapping

| Column | Meaning |
|---|---|
| Rule | The rule id/section and its regulation citation (verbatim from `rules.md`) |
| Rule needs | The information the rule requires |
| TMIP field (canonical) | The field in `01-ai-metadata-contract.md` that carries it, or `—` |
| TMIP status | `Implemented` / `Partial` / `Not produced` |
| Outcome | Whether TMIP can evaluate the rule now |

"Not produced" is a factual statement about the current implementation — it is
**not** a commitment to build it.

## 2. Metadata rules (`rules.md` §3) → fields

| Rule (citation) | Rule needs | TMIP field | TMIP status | Outcome |
|---|---|---|---|---|
| §3.1 Bahasa Siaran (Ps 37) | Main language of the program | `TRANSCRIPTION.payload.language` | **Partial** — language is detected by the processor, not classified as "good Indonesian" | Can record language; cannot judge correctness |
| §3.1 Regional language → tag `muatan lokal` (Ps 38(1)) | A language tag | — | **Not produced** | Cannot evaluate |
| §3.1 Foreign language → tag `bahasa_asing` (Ps 38(2)) | A language tag | — | **Not produced** | Cannot evaluate |
| §3.1 Foreign-language program must mark subtitle need (Ps 39(1)) | Subtitle-requirement flag | — | **Not produced** | Cannot evaluate |
| §3.1 Dubbing proportion ≤ 30% (Ps 39(2)) | Dubbing share | — | **Not produced** | Cannot evaluate |
| §3.1 Sign language → tag `bahasa_isyarat` (Ps 39(3)) | A language tag | — | **Not produced** | Cannot evaluate |
| §3.2 Audience classification anak/remaja/dewasa (Ps 36(3), Ps 48(4)f) | Audience class | — | **Not produced** | Cannot evaluate |
| §3.2 Recommended air time (Ps 36(3)) | Air-time recommendation | — | **Not produced** | Cannot evaluate |
| §3.3 Content category (Berita/Pendidikan/…; Ps 36(2)) | A category | `CLASSIFICATION.payload.category` | **Partial** — TMIP's category set differs from the rule's list | Can record a category; the two taxonomies do not align (OD-05) |
| §3.4 Broadcast rights owner/status; `broadcast_rights: UNVERIFIED` (Ps 43) | Rights metadata | — | **Not produced** | Cannot evaluate |
| §3.5 News neutrality/accuracy (Ps 36(4), Ps 42, Ps 48(4)h) | Editorial judgement | `SUMMARY.payload.summary` (as text) | **Not produced** as a verdict | Cannot evaluate automatically |
| §3.6 Retention ≥ 1 year; archival value (Ps 45) | Retention metadata | — | **Not produced** | Cannot evaluate |
| §3.7 Origin / relay / joint broadcast (Ps 40–41) | Origin metadata | — | **Not produced** | Cannot evaluate |

## 3. QC rules (`rules.md` §4, §5) → fields

The 16-row QC checklist (`rules.md` §5) is reproduced in
`reference/team-ai-rules-extract.md` with its citations. Almost none of its items
map to a field TMIP produces: they require content-level judgement (violence,
SARА, advertising share, sensor marks) that MVP 2's text pipeline does not perform.

| QC item (citation) | TMIP field | Status |
|---|---|---|
| 1 No defamation/hoax (Ps 36(5)a) | — | Not produced |
| 2 No violence/pornography/gambling/drugs (Ps 36(5)b) | — | Not produced |
| 3 No SARA provocation (Ps 36(5)c) | — | Not produced |
| 4 No insult to religion/dignity (Ps 36(6)) | — | Not produced |
| 5 Main language correct (Ps 37–39) | `language` | Partial (see §2) |
| 6 Indonesian subtitle present for foreign programs (Ps 39(1)) | — | Not produced |
| 7 Dubbing ≤ 30% (Ps 39(2)) | — | Not produced |
| 8 Audience class + air time filled (Ps 36(3), 48(4)f) | — | Not produced |
| 9 Broadcast rights verified (Ps 43) | — | Not produced |
| 10 News neutral (Ps 36(4), 42) | — | Not produced |
| 11 Commercial ad share within limit (Ps 46(8)) | — | Not produced |
| 12 ILM meets minimum (Ps 46(9)) | — | Not produced |
| 13 No prohibited ads (Ps 46(3)) | — | Not produced |
| 14 Sensor clearance present (Ps 47) | — | Not produced |
| 15 Correction < 24h (Ps 44) | — | Not produced |
| 16 Retention/archival value (Ps 45) | — | Not produced |

## 4. Internal TVRI ingest rules (`rules.md` §7) → technical metadata (MVP 1)

These are the only rules that map onto data TMIP already has (from ffprobe, not
AI). They are relevant as *future* validation over `MediaFile` technical columns —
**not** part of MVP 2's AI metadata contract.

| Rule | Needs | TMIP source | Status |
|---|---|---|---|
| §7.1 Ingest format: MPEG2 HD 1920×1080 (regulation) vs operational MPEG4/H.264 1080p 8–12 Mbps; H.265 future; **H.264 and H.265 both pass QC** | codec, resolution, bitrate | `MediaFile.videoCodec`, `width`/`height`, `videoBitRate` (MVP 1) | Data available; **no validation rule implemented** |
| §7.2 Asset Code (Peraturan 62/2024, Ps 1(11)) | Asset code | — | Not produced |
| §7.3 Asset type AUDIO_VISUAL/RUNDOWN/ROUGHCUT/SIAP_SIAR (Ps 4) | Asset type | — | Not produced |
| §7.4 Access governance (Ps 6, 7, 8) | Access metadata | — | Not produced |

## 5. Finding output format (`rules.md` §6)

`rules.md` defines a structured finding shape:

```text
field          : <metadata field / item QC>
status         : PASS | WARN | FAIL
pasal_acuan    : <pasal UU 32/2002 atau acuan lain>
detail         : <penjelasan singkat temuan>
rekomendasi    : <tindakan yang disarankan untuk review manusia>
confidence     : <0.0 - 1.0>
```

TMIP has **no** storage for this shape today. Adopting it would require new fields
(`status`, `pasal_acuan`, `detail`, `rekomendasi`, `confidence`) — recorded as a
**proposal**, not implemented (see `05-open-decisions.md` OD-04, OD-05).

## 6. Honest summary

- **Maps to an implemented TMIP field:** the language signal (`language`), and a
  content category (`category`) with a taxonomy mismatch.
- **Requires fields TMIP does not produce:** every QC item, all metadata rules
  except language/category, and the whole finding format.
- **Conclusion:** the broadcast/QC rules are **reference material for future
  scope**, not an MVP 2 requirement. Adopting them as requirements would be a
  scope expansion requiring explicit approval (see `06-consistency-report.md`).
