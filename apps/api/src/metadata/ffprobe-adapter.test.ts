import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  FFPROBE_ERROR_CODES,
  InvalidProbeOutputError,
  SpawnFFprobeAdapter,
  buildFFprobeArgs,
  createMockProcess,
  type SpawnedProcess,
} from "./ffprobe-adapter.js";

function emitOutput(process: SpawnedProcess, stdout: string, stderr = ""): void {
  process.stdout.emit("data", stdout);
  process.stdout.emit("end");
  process.stderr.emit("data", stderr);
  process.stderr.emit("end");
}

const validOutput = JSON.stringify({
  format: { duration: "12.5", format_name: "mp4" },
  streams: [{ codec_type: "video", codec_name: "h264" }],
});

describe("ffprobe argv builder", () => {
  it("passes special-character paths as one argv value", () => {
    expect(buildFFprobeArgs("/media/Program #01/test & demo.mp4")).toEqual([
      "-v",
      "error",
      "-print_format",
      "json",
      "-show_format",
      "-show_streams",
      "/media/Program #01/test & demo.mp4",
    ]);
  });
});

describe("SpawnFFprobeAdapter", () => {
  it("captures stdout and returns parsed output plus verbatim raw JSON", async () => {
    const child = createMockProcess();
    const spawnProcess = vi.fn(() => child);
    const adapter = new SpawnFFprobeAdapter({
      binaryPath: "ffprobe-test",
      spawnProcess,
      timeoutMs: 100,
    });
    const resultPromise = adapter.probe("C:/media/test & demo.mp4");

    emitOutput(child, validOutput);
    child.emit("close", 0);

    await expect(resultPromise).resolves.toEqual({
      parsed: expect.objectContaining({ format: expect.any(Object) }),
      rawJson: validOutput,
    });
    expect(spawnProcess).toHaveBeenCalledWith(
      "ffprobe-test",
      buildFFprobeArgs("C:/media/test & demo.mp4"),
      { shell: false },
    );
  });

  it("maps non-zero exit to FFPROBE_FAILED and includes stderr excerpt", async () => {
    const child = createMockProcess();
    const adapter = new SpawnFFprobeAdapter({ spawnProcess: () => child, timeoutMs: 100 });
    const resultPromise = adapter.probe("/media/bad.mxf");
    emitOutput(child, "", "Invalid data found in input");
    child.emit("close", 1);

    await expect(resultPromise).rejects.toMatchObject({
      code: FFPROBE_ERROR_CODES.FAILED,
      stage: "FFPROBE",
      stderr: "Invalid data found in input",
    });
  });

  it("maps a missing executable spawn error to FFPROBE_FAILED", async () => {
    const child = createMockProcess();
    const adapter = new SpawnFFprobeAdapter({ spawnProcess: () => child, timeoutMs: 100 });
    const resultPromise = adapter.probe("/media/test.mp4");
    const error = Object.assign(new Error("spawn ffprobe ENOENT"), { code: "ENOENT" });
    child.emit("error", error);

    await expect(resultPromise).rejects.toMatchObject({
      code: FFPROBE_ERROR_CODES.FAILED,
      stage: "FFPROBE",
    });
  });

  it("kills the process and maps timeout to FFPROBE_TIMEOUT", async () => {
    const child = createMockProcess();
    const kill = vi.spyOn(child, "kill");
    const adapter = new SpawnFFprobeAdapter({ spawnProcess: () => child, timeoutMs: 5 });

    await expect(adapter.probe("/media/hung.mp4")).rejects.toMatchObject({
      code: FFPROBE_ERROR_CODES.TIMEOUT,
      stage: "FFPROBE",
    });
    expect(kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("maps invalid or oversized JSON to INVALID_PROBE_OUTPUT without a real process", async () => {
    const child = createMockProcess();
    const adapter = new SpawnFFprobeAdapter({ spawnProcess: () => child, timeoutMs: 100 });
    const resultPromise = adapter.probe("/media/invalid.mp4");
    emitOutput(child, "{" + "x".repeat(100_000));
    child.emit("close", 0);

    await expect(resultPromise).rejects.toBeInstanceOf(InvalidProbeOutputError);
    await expect(resultPromise).rejects.toMatchObject({
      code: FFPROBE_ERROR_CODES.INVALID_OUTPUT,
      stage: "NORMALIZATION",
    });
  });

  it("exports a mock-compatible process boundary without shell execution", () => {
    const process = createMockProcess();
    expect(process).toBeInstanceOf(EventEmitter);
  });
});
