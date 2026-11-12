import type { FFprobeOutput, FFprobeStream } from "./ffprobe-schema.js";
import { InvalidProbeOutputError } from "./ffprobe-adapter.js";

export interface NormalizedMetadata {
  durationSeconds: number;
  frameRateNumerator: number | null;
  frameRateDenominator: number | null;
  videoCodec: string | null;
  width: number | null;
  height: number | null;
  audioCodec: string | null;
  audioSampleRate: number | null;
  audioChannels: number | null;
  technicalMetadata: Record<string, unknown>;
}

function invalid(message: string): InvalidProbeOutputError {
  return new InvalidProbeOutputError(message);
}

function parseFiniteNumber(value: string, field: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw invalid(`${field} must be a finite non-negative number`);
  }
  return parsed;
}

function parseFrameRate(value: string | undefined): [number, number] | null {
  if (value === undefined) return null;
  const parts = value.split("/");
  if (parts.length > 2 || parts.some((part) => !/^\d+$/.test(part))) {
    throw invalid(`r_frame_rate is not a non-negative rational: ${value}`);
  }

  const numerator = Number(parts[0]);
  const denominator = Number(parts[1] ?? "1");
  if (
    !Number.isSafeInteger(numerator) ||
    !Number.isSafeInteger(denominator) ||
    denominator <= 0
  ) {
    throw invalid(`r_frame_rate is outside the supported rational range: ${value}`);
  }
  return [numerator, denominator];
}

function parseOptionalInteger(value: number | undefined, field: string): number | null {
  if (value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw invalid(`${field} must be a non-negative integer`);
  }
  return value;
}

function parseOptionalSampleRate(value: string | undefined): number | null {
  if (value === undefined) return null;
  return parseFiniteNumber(value, "sample_rate");
}

function firstStream(
  streams: readonly FFprobeStream[],
  codecType: string,
): FFprobeStream | undefined {
  return streams.find((stream) => stream.codec_type === codecType);
}

/**
 * Converts validated ffprobe data to the MediaFile column shape. A file in the
 * video inventory must contain a video stream; no video stream is therefore an
 * INVALID_PROBE_OUTPUT/NORMALIZATION failure rather than an empty record. An
 * absent audio stream is valid and produces null audio columns, as required by
 * WORKFLOWS.md §29 and TESTING.md §13.
 */
export function normalizeFFprobeOutput(probe: FFprobeOutput): NormalizedMetadata {
  const durationSeconds = parseFiniteNumber(probe.format.duration, "format.duration");
  const video = firstStream(probe.streams, "video");
  if (video === undefined) {
    throw invalid("ffprobe output contains no video stream");
  }
  const audio = firstStream(probe.streams, "audio");
  const frameRate = parseFrameRate(video.r_frame_rate);

  const technicalMetadata: Record<string, unknown> = {
    containerFormat: probe.format.format_name ?? null,
    videoPixelFormat: video.pix_fmt ?? null,
    videoProfile: video.profile ?? null,
    videoFieldOrder: video.field_order ?? null,
    videoTags: video.tags ?? null,
    containerTags: probe.format.tags ?? null,
  };

  return {
    durationSeconds,
    frameRateNumerator: frameRate?.[0] ?? null,
    frameRateDenominator: frameRate?.[1] ?? null,
    videoCodec: video.codec_name ?? null,
    width: parseOptionalInteger(video.width, "width"),
    height: parseOptionalInteger(video.height, "height"),
    audioCodec: audio?.codec_name ?? null,
    audioSampleRate: parseOptionalSampleRate(audio?.sample_rate),
    audioChannels: parseOptionalInteger(audio?.channels, "channels"),
    technicalMetadata,
  };
}
