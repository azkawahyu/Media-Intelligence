import { describe, expect, it, vi } from "vitest";
import { createAiRuntime } from "./runtime.js";
import type { AiRunner } from "./runner.js";

function fakeRunner(drain: () => Promise<number>): AiRunner {
  return { drainOnce: vi.fn(drain) } as unknown as AiRunner;
}

describe("createAiRuntime", () => {
  it("tick() drains once", async () => {
    const runner = fakeRunner(async () => 1);
    const runtime = createAiRuntime({ runner, intervalMs: 1_000 });
    await runtime.tick();
    expect(runner.drainOnce).toHaveBeenCalledOnce();
  });

  it("does not overlap drains while one is in flight", async () => {
    let resolve: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      resolve = r;
    });
    const runner = fakeRunner(async () => {
      await gate;
      return 1;
    });
    const runtime = createAiRuntime({ runner, intervalMs: 1_000 });

    const first = runtime.tick();
    await runtime.tick(); // Must return immediately without a second drain.
    expect(runner.drainOnce).toHaveBeenCalledOnce();

    resolve?.();
    await first;
  });

  it("reports a drain error through onError and keeps running", async () => {
    const onError = vi.fn();
    const runner = fakeRunner(async () => {
      throw new Error("boom");
    });
    const runtime = createAiRuntime({ runner, intervalMs: 1_000, onError });
    await expect(runtime.tick()).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledOnce();
  });

  it("start is idempotent and stop clears the interval", () => {
    const runner = fakeRunner(async () => 0);
    const runtime = createAiRuntime({ runner, intervalMs: 1_000 });
    expect(() => {
      runtime.start();
      runtime.start();
      runtime.stop();
      runtime.stop();
    }).not.toThrow();
  });
});
