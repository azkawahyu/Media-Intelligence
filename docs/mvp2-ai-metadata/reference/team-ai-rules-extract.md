# Reference — Team AI/QC Rules (adapted extract)

Provenance: **Adapted, reference-only.** Extracted from the team repository
`docs/rules.md` (DOC-RULES v1.3, status **Draft**, owner TVRI DKI Jakarta,
last_updated 2026-08-07). Derived from:
- **UU No. 32 Tahun 2002 tentang Penyiaran** (citations as `Ps NN`).
- **Peraturan Dewan Direksi LPP TVRI No. 62 Tahun 2024** (internal asset rules).

Regulation citations are reproduced **verbatim** from the source. This is a
reference extract, **not** a TMIP requirement and **not** legal advice. TMIP's
mapping of these rules to fields is in `../03-rules-to-fields-mapping.md`.

## §5 QC checklist (16 items, verbatim citations)

Result per item: PASS / WARN / FAIL.

| # | Item | Pasal |
|---|---|---|
| 1 | Tidak ada fitnah/hasut/menyesatkan/bohong | Ps 36(5)a |
| 2 | Tidak ada kekerasan, cabul, judi, narkoba | Ps 36(5)b |
| 3 | Tidak ada provokasi SARA | Ps 36(5)c |
| 4 | Tidak menghina agama/martabat/hubungan internasional | Ps 36(6) |
| 5 | Bahasa utama benar (Indonesia) atau ditandai sesuai | Ps 37–39 |
| 6 | Subtitle/teks ID tersedia untuk program TV bahasa asing | Ps 39(1) |
| 7 | Proporsi dubbing ≤ 30% | Ps 39(2) |
| 8 | Klasifikasi khalayak & waktu tayang terisi | Ps 36(3), 48(4)f |
| 9 | Hak siar terverifikasi dan dicantumkan | Ps 43 |
| 10 | Berita netral & sesuai kode etik jurnalistik | Ps 36(4), 42 |
| 11 | Persentase iklan niaga dalam batas | Ps 46(8) |
| 12 | ILM memenuhi batas minimum | Ps 46(9) |
| 13 | Tidak ada iklan terlarang (alkohol/rokok/narkoba/eksploitasi anak) | Ps 46(3) |
| 14 | Tanda lulus sensor ada (film/iklan) | Ps 47 |
| 15 | Kebutuhan ralat terdeteksi & diproses < 24 jam | Ps 44 |
| 16 | Metadata retensi & nilai arsip terisi | Ps 45 |

## §6 Finding output format (verbatim)

```text
field          : <metadata field / item QC>
status         : PASS | WARN | FAIL
pasal_acuan    : <pasal UU 32/2002 atau acuan lain>
detail         : <penjelasan singkat temuan>
rekomendasi    : <tindakan yang disarankan untuk review manusia>
confidence     : <0.0 - 1.0>
```

Rules attached to the format (§6):
- Every change is recorded in the Audit Log.
- Every FAIL/WARN must include a recommendation and a regulation citation.
- No destructive action is taken automatically; all wait for human approval.

## §7 Internal TVRI asset/ingest rules (verbatim key points)

- **§7.1 Ingest standardisation:** regulation cites **MPEG2 HD 1920×1080**
  (Peraturan 62/2024, Ps 1 angka 6). Current operational standard: **MPEG4
  (H.264), 1080p, ±8–12 Mbps**. Future direction: **H.265 (HEVC)**. QC passes
  **both H.264 and H.265** if within spec (Ps 5(3)). Broadcast-ready packages must
  meet the technical standard.
- **§7.2/§7.3/§7.4:** Asset Code, asset type classification
  (audio visual / rundown / roughcut / paket siap siar), and access governance —
  see source for full text.

## Metadata rules (§3) — summary of fields the rules reference

The metadata rules reference fields such as language tags (`muatan lokal`,
`bahasa_asing`, `bahasa_isyarat`), audience classification, broadcast-rights status
(`broadcast_rights: UNVERIFIED`), retention, and origin. None of these are produced
by TMIP today (see `../03-rules-to-fields-mapping.md` §2).

## Change log (from source)

- v1.3 — QC §7.1: H.264 and H.265 both pass QC.
- v1.2 — QC §7.1: separated regulation reference (MPEG2 HD) from current
  operational standard (MPEG4/H.264 1080p 8–12 Mbps); noted H.265 direction.
- v1.1 — added Internal TVRI rules (§7) from Peraturan 62/2024 (OCR-derived).
- v1.0 — initial draft from UU 32/2002.
