import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  FFPROBE_ERROR_CODES,
  FFprobeError,
  SpawnFFprobeAdapter,
} from "./ffprobe-adapter.js";
import { normalizeFFprobeOutput } from "./normalizer.js";

/**
 * Environment-gated real-ffprobe integration tests
 * (docs/plans/001-first-vertical-slice.md, Phase 9; Annex A, D4;
 * TESTING.md "32. Metadata Extraction Integration Test",
 * "33. Test Media Fixtures", "15. FFprobe Process Failure Tests").
 *
 * These tests run ONLY where real ffmpeg/ffprobe binaries exist — i.e. inside
 * the Phase 9 Docker verification (ffmpeg installed in the api image). On the
 * development host (no ffprobe installed) they are skipped with an explicit,
 * logged reason — TESTING.md "71. Testing Anti-Patterns" prohibits silent
 * skips. Mock-adapter tests cover the same logic deterministically everywhere.
 */

const ffprobePath = process.env.FFPROBE_PATH ?? "ffprobe";
const ffmpegPath = process.env.FFMPEG_PATH ?? "ffmpeg";

function runBinary(
  command: string,
  args: readonly string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("close", (code) =>
      resolve({ code: code ?? 1, stdout, stderr }),
    );
  });
}

// Availability probe runs at collection time (synchronously via spawnSync) so
// the skip decision (and its logged reason) is explicit and deterministic.
function binaryAvailable(binary: string): boolean {
  const result = spawnSync(binary, ["-version"], { shell: false });
  return !result.error && result.status === 0;
}

const ffprobeAvailable = binaryAvailable(ffprobePath);
const ffmpegAvailable = binaryAvailable(ffmpegPath);
const missingBinaries = [
  ...(ffprobeAvailable ? [] : [`ffprobe (FFPROBE_PATH="${ffprobePath}")`]),
  ...(ffmpegAvailable ? [] : [`ffmpeg (FFMPEG_PATH="${ffmpegPath}")`]),
];
const skipReason = missingBinaries.length
  ? `required binaries not available in this environment: ${missingBinaries.join(", ")}`
  : undefined;

if (skipReason !== undefined) {
  console.warn(
    `[real-ffprobe.integration] SKIPPED — ${skipReason}. ` +
      "These tests run in the Phase 9 Docker verification stage where ffmpeg/ffprobe are installed.",
  );
}

let workDir: string;

describe.skipIf(!ffprobeAvailable || !ffmpegAvailable)(
  "real ffprobe extraction (environment-gated)",
  () => {
    beforeAll(async () => {
      workDir = await mkdtemp(path.join(tmpdir(), "tmip-real-ffprobe-"));
    });

    afterAll(async () => {
      if (workDir !== undefined) {
        await rm(workDir, { recursive: true, force: true });
      }
    });

    async function generateTestVideo(filePath: string): Promise<void> {
      // Tiny fixture: 1s of testsrc video + silent mono audio
      // (TESTING.md "33. Test Media Fixtures" — smallest meaningful probe target).
      const result = await runBinary(ffmpegPath, [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "testsrc=duration=1:size=320x240:rate=10",
        "-f",
        "lavfi",
        "-i",
        "anullsrc=r=44100:cl=mono:duration=1",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-shortest",
        filePath,
      ]);
      if (result.code !== 0) {
        throw new Error(`ffmpeg fixture generation failed: ${result.stderr}`);
      }
    }

    it("extracts realistic metadata from an ffmpeg-generated fixture", async () => {
      const fixture = path.join(workDir, "test-video.mp4");
      await generateTestVideo(fixture);

      const adapter = new SpawnFFprobeAdapter({ binaryPath: ffprobePath });
      const { parsed, rawJson } = await adapter.probe(fixture);

      // Raw output preserved verbatim (AGENTS.md "13. Raw Metadata Preservation").
      expect(rawJson.trim().startsWith("{")).toBe(true);

      const normalized = normalizeFFprobeOutput(parsed);
      expect(normalized.durationSeconds).toBeGreaterThan(0);
      expect(normalized.videoCodec).toBe("h264");
      expect(normalized.width).toBe(320);
      expect(normalized.height).toBe(240);
      // Rational frame rate preserved without lossy rounding
      // (DATA_MODEL.md "30. Frame Rate Representation").
      expect(normalized.frameRateNumerator).toBeGreaterThan(0);
      expect(normalized.frameRateDenominator).toBeGreaterThan(0);
      expect(normalized.audioCodec).toBeTruthy();
      expect(normalized.audioSampleRate).toBe(44_100);
      expect(normalized.audioChannels).toBe(1);
    });

    it("reports FFPROBE_FAILED with a stderr excerpt for a nonexistent file", async () => {
      const missing = path.join(workDir, "does-not-exist.mp4");
      const adapter = new SpawnFFprobeAdapter({ binaryPath: ffprobePath });

      await expect(adapter.probe(missing)).rejects.toMatchObject({
        name: "FFprobeError",
        code: FFPROBE_ERROR_CODES.FAILED,
        stage: "FFPROBE",
      });
      await expect(adapter.probe(missing)).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof FFprobeError &&
          typeof error.stderr === "string" &&
          error.stderr.length > 0,
      );
    });
  },
);
