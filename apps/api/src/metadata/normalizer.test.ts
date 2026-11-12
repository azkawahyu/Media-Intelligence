import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { InvalidProbeOutputError } from "./ffprobe-adapter.js";
import { normalizeFFprobeOutput } from "./normalizer.js";
import { parseFFprobeJson, type FFprobeOutput } from "./ffprobe-schema.js";

const fixtureDirectory = path.resolve("src/metadata/fixtures");

function fixture(name: string): FFprobeOutput {
  const raw = readFileSync(path.join(fixtureDirectory, name), "utf8");
  return parseFFprobeJson(raw);
}

describe("ffprobe schema and metadata normalizer", () => {
  it.each([
    ["mp4-h264.synthetic.json", "h264", 1920, 1080, 25, 1],
    ["mov.synthetic.json", "prores", 1280, 720, 30000, 1001],
    ["mxf.synthetic.json", "mpeg2video", 1920, 1080, 25, 1],
    ["mpeg2.synthetic.json", "mpeg2video", 720, 576, 25, 1],
    ["h265.synthetic.json", "hevc", 3840, 2160, 60000, 1001],
    ["interlaced.synthetic.json", "mpeg2video", 1920, 1080, 30000, 1001],
  ])(
    "normalizes %s representative synthetic fixture",
    (name, codec, width, height, numerator, denominator) => {
      const result = normalizeFFprobeOutput(fixture(name));
      expect(result.videoCodec).toBe(codec);
      expect(result.width).toBe(width);
      expect(result.height).toBe(height);
      expect(result.frameRateNumerator).toBe(numerator);
      expect(result.frameRateDenominator).toBe(denominator);
      expect(result.technicalMetadata.containerFormat).toBeTypeOf("string");
    },
  );

  it("normalizes duration as numeric seconds without rounding away precision", () => {
    expect(normalizeFFprobeOutput(fixture("mov.synthetic.json")).durationSeconds).toBe(
      1832.52,
    );
  });

  it("converts an integer frame rate to a /1 rational", () => {
    const result = normalizeFFprobeOutput(fixture("mxf.synthetic.json"));
    expect(result.frameRateNumerator).toBe(25);
    expect(result.frameRateDenominator).toBe(1);
  });

  it("accepts incomplete optional metadata and returns null columns", () => {
    const result = normalizeFFprobeOutput(fixture("incomplete.synthetic.json"));
    expect(result.videoCodec).toBeNull();
    expect(result.width).toBeNull();
    expect(result.height).toBeNull();
    expect(result.audioCodec).toBeNull();
    expect(result.audioSampleRate).toBeNull();
    expect(result.audioChannels).toBeNull();
  });

  it("uses the first audio stream when multiple audio streams are present", () => {
    const result = normalizeFFprobeOutput(fixture("multi-audio.synthetic.json"));
    expect(result.audioCodec).toBe("aac");
    expect(result.audioSampleRate).toBe(44100);
    expect(result.audioChannels).toBe(2);
  });

  it("does not fail a valid video that has no audio stream", () => {
    const result = normalizeFFprobeOutput(fixture("no-audio.synthetic.json"));
    expect(result.audioCodec).toBeNull();
    expect(result.audioSampleRate).toBeNull();
    expect(result.audioChannels).toBeNull();
  });

  it("rejects a supposedly-video inventory item with no video stream", () => {
    expect(() =>
      normalizeFFprobeOutput({
        format: { duration: "1", format_name: "mp4" },
        streams: [{ codec_type: "audio", codec_name: "aac" }],
      }),
    ).toThrow(InvalidProbeOutputError);
  });

  it("rejects malformed JSON and wrong consumed types as INVALID_PROBE_OUTPUT", () => {
    expect(() => parseFFprobeJson(readFileSync(path.join(fixtureDirectory, "truncated.synthetic.json"), "utf8"))).toThrow();
    expect(() => parseFFprobeJson(readFileSync(path.join(fixtureDirectory, "wrong-types.synthetic.json"), "utf8"))).toThrow();
  });

  it("passes through unknown ffprobe fields while validating the consumed structure", () => {
    const result = parseFFprobeJson(
      JSON.stringify({
        format: { duration: "2", format_name: "custom", future_field: { value: 1 } },
        streams: [{ codec_type: "video", future_stream_field: true }],
        future_top_level: "retained",
      }),
    );
    expect(result.future_top_level).toBe("retained");
    expect(result.format.future_field).toEqual({ value: 1 });
    expect(result.streams[0]?.future_stream_field).toBe(true);
  });
});
