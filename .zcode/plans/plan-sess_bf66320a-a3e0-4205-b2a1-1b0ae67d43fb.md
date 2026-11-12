# Integrasi AI Enrichment (Pipeline Teks) — Disetujui

Pengguna telah menyetujui: pemulihan Phase 14, `AI_ENABLED=false`, pipeline teks saja, pengujian, dan pelaporan. Di luar scope: `scene.py`/Phase 15, dependency vision, perubahan PRD/SCOPE, deployment, commit.

## Langkah implementasi
1. **Pulihkan baseline:** `git checkout HEAD -- ai-processor/` (file tracked), hapus `ai-processor/app/handlers/scene.py` hanya dari TMIP, **pertahankan** `.env.example` yang tidak terkait. Repo tim tidak disentuh. Backup tetap di `D:\DEVELOP\_backup-tmip-ai-20261012`.
2. **`docker-compose.yml`:** `AI_ENABLED` default `true` → `false`.
3. **`ai-processor/tests/test_team_parity.py` (baru):** repo tim sebagai sumber kebenaran yang dapat ditelusuri — baca file repo tim (env `TEAM_REPO_PATH`, default `D:/DEVELOP/tvri-media-intelligence-platform`) dan bandingkan prompt, `CONTENT_CATEGORIES`, parameter inferensi Whisper, bentuk field/tipe respons kontrak `ai-client.ts`, dan urutan pipeline. Skip dengan alasan tercatat bila repo tim tidak ada.
4. **Verifikasi:** `ai-processor/tests` (pytest), `pnpm --filter @tmip/api test`, `pnpm typecheck`, `pnpm lint`, `pnpm build`, `docker compose build ai-processor`, smoke `/health`.
5. **Laporan:** diff per file, hasil tes apa adanya, status contract parity vs live output parity (live = PENDING), penyimpangan dari rencana.

Tidak melemahkan tes bila gagal; tidak menambah dependency/fitur; tidak deploy/commit.