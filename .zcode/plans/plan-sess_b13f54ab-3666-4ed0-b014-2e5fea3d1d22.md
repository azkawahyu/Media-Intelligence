# Plan Implementasi TMIP — LLM Config, Durable Cancellation, OCR Multi-Frame, UI

Berdasarkan task spec Anda. Audit awal sudah saya lakukan sebelum plan mode (temuan terverifikasi di bawah). Setelah ini saya kerjakan berurutan A→E, verifikasi tiap bagian, lalu Docker E2E. **Tanpa commit/push.**

## Temuan audit terverifikasi

| # | Temuan | Bukti |
|---|---|---|
| 1 | 503 `/summarize` karena `openrouter.py` hardcode `https://openrouter.ai/api/v1/...`; key Anda milik provider lain (bukan `sk-or-v1-`) | DB `AiResult`: SUMMARY/KEYWORDS/CLASSIFICATION = `FAILED`, `AI_PROCESSOR_UNAVAILABLE`; `openrouter.py:17` |
| 2 | OCR sampah karena `runner.ts:460` kirim `timestampSec: 0` (frame pertama hitam) | payload OCR: `{"raw_text":"oa 3 ara pa = aes...","presenter":null}` |
| 3 | Tidak ada cancel apa pun di API; `AiStatus` = PENDING/PROCESSING/READY/FAILED/SKIPPED; adapter **sudah** terima `signal?` tapi Runner tak pernah mengirimnya; `/transcribe/cancel/{asset_id}` ada di Python tapi tak dipakai | `runner.ts` tanpa AbortSignal; `main.py:158` |
| 4 | `page.tsx` menaruh kartu hasil (`AiSection`) di atas kartu aksi (`AiReprocessAction`), judul keduanya sama "AI enrichment" | `page.tsx:88-89` |
| 5 | Perubahan belum di-commit: `docker-compose.yml`, `.env.example`, `README.md` (namespace media) + `AiProgress.tsx` + `globals.css` + `page.tsx` | git status |

**Potensi konflik:** menambah enum `CANCELLED` + kolom `aiCancelRequestedAt` = migration aditif (aman, AGENTS.md §12/§32). `reprocess.ts` pakai allow-list `in: [PENDING,READY,FAILED,SKIPPED]` → **harus** ditambah `CANCELLED` eksplisit. `sweepInterruptedAiState` hanya reset `PROCESSING` → `CANCELLED` aman, tapi harus **diperluas**: row `PROCESSING` **dengan** cancel intent → `CANCELLED`, tanpa intent → `PENDING` (perilaku Phase 14).

---

## A — LLM config generik + klasifikasi error provider

**`ai-processor/app/handlers/openrouter.py`**
- `LLM_BASE_URL` (default `https://openrouter.ai/api/v1`), `LLM_API_KEY`, `LLM_MODEL`.
- Prioritas: `LLM_*` menang; fallback ke `OPENROUTER_*` (backward compat) — didokumentasikan.
- URL dibentuk `f"{base.rstrip('/')}/chat/completions"` → tanpa double slash.
- **Klasifikasi per status HTTP** (bukan semua → 503): 400/401/402/403/404 = permanent; 408/429/5xx/timeout/network = transient. Exception kaya info (`LlmProviderError(status, kind, safe_message)`).
- **Tidak pernah** mencetak key/header/body provider. Pesan aman: status + kategori + potongan pesan provider yang sudah disanitasi.

**`ai-processor/app/main.py`** — `/summarize` memetakan: transient → 503, permanent → 4xx yang sesuai (mis. 401→502/401 dengan pesan aman), bukan 503 generik. Response tetap `{ok,data}` / error terstruktur.

**`docker-compose.yml`** — ai-processor terima `LLM_BASE_URL`/`LLM_API_KEY`/`LLM_MODEL` + `OPENROUTER_*` (fallback), default `https://openrouter.ai/api/v1`.
**`.env`** — `LLM_BASE_URL=https://openagentic.id/api/v1` (milik Anda); `.env.example` placeholder saja.
**Verifikasi** — health, auth, model, quota, transient via tes mock (tanpa key nyata) + curl nyata bila provider tersedia (kalau tidak → **BLOCKED**).

## B — Durable cancellation + race safety (paling kritis)

**Schema (`schema.prisma`) + migration aditif**
- `AiStatus` + `CANCELLED`.
- `MediaFile.aiCancelRequestedAt DateTime? @db.Timestamptz(6)`.

**`AiRunner`**
- `Map<mediaFileId, AbortController>` in-memory **hanya** untuk abort cepat lokal; **PostgreSQL tetap sumber kebenaran** via `aiCancelRequestedAt`.
- `cancel(mediaFileId)`: tulis intent (conditional `updateMany where aiStatus=PROCESSING`), lalu abort controller.
- Cek intent: sebelum stage, sesudah stage, sebelum retry, sebelum simpan hasil.
- **Conditional writes** (CAS `where aiStatus=PROCESSING`) sehingga late worker tak bisa menimpa `CANCELLED` → `READY/FAILED`.
- Abort remote transcription: panggil `POST /transcribe/cancel/{asset_id}` dengan `asset_id` = `aiExternalJobId` (`${mediaFileId}:${attempt}`) — **mapping diverifikasi lewat kode & tes**, bukan diasumsikan.
- Hasil stage `READY` sebelumnya dipertahankan.

**`startup.ts`** — recovery: `PROCESSING` + intent → `CANCELLED`; `PROCESSING` tanpa intent → `PENDING` (Phase 14).
**`reprocess.ts`** — tambah `CANCELLED` ke allow-list; reset `aiCancelRequestedAt=null` atomik.
**`routes.ts`** — `POST /media/:id/ai-cancel`: 202 `{aiStatus:"PROCESSING", cancelRequested:true}` (idempotent), 404, 409 bila tak diproses/tak ada intent.
**Web** — `cancelAiProcessing()` di `lib/api.ts`; tombol Stop + "Stopping…"; polling sampai terminal; **tidak** menampilkan `CANCELLED` hanya karena request sukses.

**Tes** — 9 skenario wajib Anda (in-flight, partial kept, next stage berhenti, retry berhenti, late worker, restart recovery, remote ID benar, idempotent, reprocess pasca-cancel).

## C — OCR multi-frame

**`/ocr`** — terima `duration_sec` opsional; sampling maks 5 frame (10/30/50/70/90%), clamp ke rentang video; fallback 1 frame aman bila durasi invalid; tidak scan seluruh video; tidak menulis ke media root.
**Scoring** (`ocr.py`) — bukan sekadar jumlah alfanumerik: gabung rasio alfanumerik, panjang wajar, kualitas token/kata, penalti repetisi/noise, confidence bila ada.
**Plumbing** — `adapter.ocr({durationSec})`, `runner.runOcr` kirim durasi dari MediaFile + `signal`.
**Tes** — sampling, fallback, scoring, hasil kosong, durasi ekstrem, error/timeout/cancel.

## D — UI urutan kartu

`page.tsx`: kartu **AI processing** (badge status + stage aktif + attempts + error aman + progress + tombol Reprocess/Stop/"Stopping…") di **atas**; kartu **AI results** (tabel stage) di bawah. Pertahankan pola desain TMIP. Tes UI relevan.

## E — Dokumentasi

ADR-006 + README: LLM generik & backward compat, klasifikasi error, retry, lifecycle `CANCELLED` + intent, restart recovery & race protection, mapping ID transcription, batasan cancel remote, OCR multi-frame + batas sampling.

---

## Verifikasi
- Per bagian: tes relevan. Akhir: lint, typecheck, full test suite, build api+web, tes Python.
- **Docker E2E wajib**: `docker compose config` (tanpa secret) → rebuild service terdampak → health ai-processor (internal-only) → `/summarize` via provider → alur API→Runner→summary `READY` → cancellation E2E tanpa late write → OCR multi-frame → media read-only → scan idempotency.
- Provider tak tersedia → tandai **BLOCKED**, bukan PASS.

## Batasan yang saya sadari
- Abort HTTP ≠ stop komputasi remote (whisper); cancel kooperatif hanya di transcription. Akan didokumentasikan sebagai keterbatasan.
- Model `deepseek-v4-flash` mungkin bukan nama valid di openagentic → saya uji nyata dan laporkan; jika invalid, beri tahu nama modelnya.
- Fixture TVRI mungkin minim lower-third → hasil OCR apa adanya, tidak diklaim sukses.

**Berhenti setelah laporan akhir; tanpa commit/push.**