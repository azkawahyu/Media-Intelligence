import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { parseFFprobeJson, type FFprobeOutput } from "./ffprobe-schema.js";

export const FFPROBE_ERROR_CODES = {
  FAILED: "FFPROBE_FAILED",
  TIMEOUT: "FFPROBE_TIMEOUT",
  INVALID_OUTPUT: "INVALID_PROBE_OUTPUT",
} as const;

export type FFprobeErrorCode =
  (typeof FFPROBE_ERROR_CODES)[keyof typeof FFPROBE_ERROR_CODES];

/** Low-level process failures are reported at the FFPROBE stage. */
export class FFprobeError extends Error {
  public readonly code: FFprobeErrorCode;
  public readonly stage = "FFPROBE" as const;
  public readonly stderr?: string;

  public constructor(
    code: FFprobeErrorCode,
    message: string,
    options?: { stderr?: string },
  ) {
    super(message);
    this.name = "FFprobeError";
    this.code = code;
    this.stderr = options?.stderr;
  }
}

/** Parser and normalization failures are reported at the NORMALIZATION stage. */
export class InvalidProbeOutputError extends Error {
  public readonly code = FFPROBE_ERROR_CODES.INVALID_OUTPUT;
  public readonly stage = "NORMALIZATION" as const;

  public constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "InvalidProbeOutputError";
  }
}

export interface FFprobeResult {
  parsed: FFprobeOutput;
  rawJson: string;
}

export interface FFprobeAdapter {
  probe(absolutePath: string): Promise<FFprobeResult>;
}

export type SpawnedProcess = Pick<
  ChildProcessWithoutNullStreams,
  "stdout" | "stderr" | "once" | "kill"
> & { pid?: number };

export type SpawnProcess = (
  command: string,
  args: readonly string[],
  options: { shell: false },
) => SpawnedProcess;

export function buildFFprobeArgs(absolutePath: string): string[] {
  return [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    absolutePath,
  ];
}

function excerpt(value: string, maxLength = 2_000): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
}

class ProbeOutputTooLargeError extends Error {}

function collectOutput(
  stream: NodeJS.ReadableStream,
  maxOutputBytes: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = "";
    let outputBytes = 0;
    let tooLarge = false;
    const setEncoding = (stream as NodeJS.ReadableStream & {
      setEncoding?: (encoding: BufferEncoding) => void;
    }).setEncoding;
    setEncoding?.call(stream, "utf8");
    stream.on("data", (chunk: string | Buffer) => {
      if (tooLarge) return;
      const text = chunk.toString();
      outputBytes += Buffer.byteLength(text);
      if (outputBytes > maxOutputBytes) {
        tooLarge = true;
        reject(new ProbeOutputTooLargeError(`ffprobe output exceeds ${maxOutputBytes} bytes`));
        return;
      }
      output += text;
    });
    stream.once("end", () => {
      if (!tooLarge) resolve(output);
    });
    stream.once("error", reject);
  });
}

export interface FFprobeAdapterOptions {
  binaryPath?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  spawnProcess?: SpawnProcess;
}

export class SpawnFFprobeAdapter implements FFprobeAdapter {
  private readonly binaryPath: string;
  private readonly timeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly spawnProcess: SpawnProcess;

  public constructor(options: FFprobeAdapterOptions = {}) {
    this.binaryPath = options.binaryPath ?? "ffprobe";
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxOutputBytes = options.maxOutputBytes ?? 10 * 1024 * 1024;
    this.spawnProcess = options.spawnProcess ?? ((command, args, spawnOptions) =>
      nodeSpawn(command, args, spawnOptions) as SpawnedProcess);
  }

  public async probe(absolutePath: string): Promise<FFprobeResult> {
    const child = this.spawnProcess(this.binaryPath, buildFFprobeArgs(absolutePath), {
      shell: false,
    });

    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    let stdout = "";
    let stderr = "";

    const stdoutPromise = collectOutput(child.stdout, this.maxOutputBytes);
    const stderrPromise = collectOutput(child.stderr, this.maxOutputBytes);

    try {
      const exitCode = await new Promise<number>((resolve, reject) => {
        const finish = (callback: () => void): void => {
          if (settled) return;
          settled = true;
          if (timeout !== undefined) clearTimeout(timeout);
          callback();
        };

        timeout = setTimeout(() => {
          finish(() => {
            child.kill("SIGKILL");
            reject(
              new FFprobeError(
                FFPROBE_ERROR_CODES.TIMEOUT,
                `ffprobe timed out after ${this.timeoutMs}ms`,
              ),
            );
          });
        }, this.timeoutMs);

        child.once("error", (error: NodeJS.ErrnoException) => {
          finish(() => {
            reject(
              new FFprobeError(
                FFPROBE_ERROR_CODES.FAILED,
                `Unable to start ffprobe: ${error.message}`,
              ),
            );
          });
        });
        child.once("close", (code: number | null) => {
          finish(() => resolve(code ?? 1));
        });
      });

      [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
      if (exitCode !== 0) {
        throw new FFprobeError(
          FFPROBE_ERROR_CODES.FAILED,
          `ffprobe exited with code ${exitCode}: ${excerpt(stderr)}`,
          { stderr: excerpt(stderr) },
        );
      }
    } catch (error) {
      if (error instanceof FFprobeError) throw error;
      if (error instanceof ProbeOutputTooLargeError) {
        throw new InvalidProbeOutputError(error.message, { cause: error });
      }
      throw new FFprobeError(
        FFPROBE_ERROR_CODES.FAILED,
        `ffprobe process failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    try {
      return { parsed: parseFFprobeJson(stdout), rawJson: stdout };
    } catch (error) {
      throw new InvalidProbeOutputError(
        `ffprobe returned invalid JSON or an unexpected structure: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
  }
}

/** Small test helper for process mocks that need an EventEmitter-compatible child. */
export function createMockProcess(): SpawnedProcess & EventEmitter {
  const process = new EventEmitter() as SpawnedProcess & EventEmitter;
  process.stdout = new EventEmitter() as SpawnedProcess["stdout"];
  process.stderr = new EventEmitter() as SpawnedProcess["stderr"];
  process.kill = () => true;
  return process;
}
