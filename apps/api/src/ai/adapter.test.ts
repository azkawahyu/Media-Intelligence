import { describe, expect, it } from "vitest";
import {
  AI_PROCESSOR_ERROR_CODES,
  AiProcessorError,
  HttpAiProcessorAdapter,
} from "./adapter.js";

/** Build a fake `fetch` returning a single canned response. */
function fakeFetch(response: {
  ok?: boolean;
  status?: number;
  body?: unknown;
  throws?: unknown;
  onRequest?: (url: string, init?: RequestInit) => void;
}): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    response.onRequest?.(String(url), init);
    if (response.throws !== undefined) throw response.throws;
    const status = response.status ?? 200;
    return {
      ok: response.ok ?? (status >= 200 && status < 300),
      status,
      json: async () => {
        if (response.body === undefined) throw new Error("no body");
        return response.body;
      },
    } as unknown as Response;
  }) as typeof fetch;
}

function adapter(fetchImpl: typeof fetch) {
  return new HttpAiProcessorAdapter({
    baseUrl: "http://ai-processor:8000/",
    requestTimeoutMs: 1_000,
    fetchImpl,
  });
}

describe("HttpAiProcessorAdapter", () => {
  it("starts a transcription and reports STARTED", async () => {
    let seenUrl = "";
    let seenBody: unknown;
    const fetchImpl = fakeFetch({
      body: { ok: true, data: { job_id: "asset:0", status: "STARTED" } },
      onRequest: (url, init) => {
        seenUrl = url;
        seenBody = init?.body === undefined ? undefined : JSON.parse(String(init.body));
      },
    });
    const result = await adapter(fetchImpl).startTranscription({
      absolutePath: "/media/a.mp4",
      externalJobId: "asset:0",
      modelSize: "medium",
      language: "id",
    });

    expect(result).toEqual({ jobId: "asset:0", alreadyRunning: false });
    expect(seenUrl).toBe("http://ai-processor:8000/transcribe");
    // TMIP sends the resolved absolute path and the external job id as asset_id.
    expect(seenBody).toEqual({
      video_path: "/media/a.mp4",
      asset_id: "asset:0",
      model_size: "medium",
      language: "id",
    });
  });

  it("maps ALREADY_RUNNING to alreadyRunning", async () => {
    const fetchImpl = fakeFetch({
      body: { ok: true, data: { job_id: "asset:0", status: "ALREADY_RUNNING" } },
    });
    await expect(
      adapter(fetchImpl).startTranscription({
        absolutePath: "/media/a.mp4",
        externalJobId: "asset:0",
        modelSize: "medium",
        language: "id",
      }),
    ).resolves.toEqual({ jobId: "asset:0", alreadyRunning: true });
  });

  it("parses RUNNING / COMPLETED / FAILED / NOT_FOUND statuses", async () => {
    const running = adapter(fakeFetch({ body: { ok: true, data: { status: "RUNNING", progress: { segments_done: 3 } } } }));
    await expect(running.transcriptionStatus("asset:0")).resolves.toMatchObject({ status: "RUNNING" });

    const completed = adapter(fakeFetch({
      body: { ok: true, data: { status: "COMPLETED", result: { segments: [{ start: 0, end: 1, text: "hi" }], full_text: "hi", duration_sec: 1, language: "id" } } },
    }));
    await expect(completed.transcriptionStatus("asset:0")).resolves.toMatchObject({ status: "COMPLETED" });

    const failed = adapter(fakeFetch({ body: { ok: true, data: { status: "FAILED", error: "boom" } } }));
    await expect(failed.transcriptionStatus("asset:0")).resolves.toEqual({ status: "FAILED", error: "boom" });

    const notFound = adapter(fakeFetch({ body: { ok: true, data: { status: "NOT_FOUND" } } }));
    await expect(notFound.transcriptionStatus("asset:0")).resolves.toEqual({ status: "NOT_FOUND" });
  });

  it("parses the transcription result payload", async () => {
    const fetchImpl = fakeFetch({
      body: { ok: true, data: { segments: [{ start: 0, end: 2, text: "halo" }], full_text: "halo", duration_sec: 2, language: "id" } },
    });
    await expect(adapter(fetchImpl).transcriptionResult("asset:0")).resolves.toEqual({
      segments: [{ start: 0, end: 2, text: "halo" }],
      full_text: "halo",
      duration_sec: 2,
      language: "id",
    });
  });

  it("parses summarize and ocr payloads", async () => {
    const summarize = adapter(fakeFetch({
      body: { ok: true, data: { summary: "s", keywords: ["a", "b"], category: "Berita" } },
    }));
    await expect(summarize.summarize("text")).resolves.toEqual({ summary: "s", keywords: ["a", "b"], category: "Berita" });

    const ocr = adapter(fakeFetch({
      body: { ok: true, data: { raw_text: "NAME", presenter: { name: "A", role: "Host" } } },
    }));
    await expect(ocr.ocr({ absolutePath: "/media/a.mp4", timestampSec: 0 })).resolves.toEqual({
      raw_text: "NAME",
      presenter: { name: "A", role: "Host" },
    });
  });

  it("maps a 5xx to UNAVAILABLE (transient)", async () => {
    const fetchImpl = fakeFetch({ status: 503, body: { detail: "down" } });
    await expect(adapter(fetchImpl).summarize("t")).rejects.toMatchObject({
      code: AI_PROCESSOR_ERROR_CODES.UNAVAILABLE,
    });
  });

  it("maps a 4xx to BAD_REQUEST (permanent)", async () => {
    const fetchImpl = fakeFetch({ status: 400, body: { detail: "bad" } });
    await expect(adapter(fetchImpl).summarize("t")).rejects.toMatchObject({
      code: AI_PROCESSOR_ERROR_CODES.BAD_REQUEST,
    });
  });

  it("maps 401/404 to BAD_REQUEST (permanent) and surfaces the safe provider detail", async () => {
    // 401 (auth) must be PERMANENT, not transient: retrying a bad key is useless.
    await expect(
      adapter(fakeFetch({ status: 401, body: { detail: "LLM provider returned HTTP 401 (AUTHENTICATION)" } }))
        .summarize("t"),
    ).rejects.toMatchObject({
      code: AI_PROCESSOR_ERROR_CODES.BAD_REQUEST,
      message: expect.stringContaining("AUTHENTICATION"),
    });

    await expect(
      adapter(fakeFetch({ status: 404, body: { detail: "LLM provider returned HTTP 404 (NOT_FOUND)" } }))
        .summarize("t"),
    ).rejects.toMatchObject({ code: AI_PROCESSOR_ERROR_CODES.BAD_REQUEST });
  });

  it("forwards durationSec so the processor can sample multiple OCR frames", async () => {
    let seenBody: Record<string, unknown> = {};
    const fetchImpl = fakeFetch({
      body: { ok: true, data: { raw_text: "x", presenter: null } },
      onRequest: (_url, init) => {
        seenBody = init?.body === undefined ? {} : JSON.parse(String(init.body));
      },
    });
    await adapter(fetchImpl).ocr({ absolutePath: "/media/a.mp4", timestampSec: 0, durationSec: 120 });
    expect(seenBody.duration_sec).toBe(120);

    // When duration is unknown the field is omitted, preserving the old contract.
    await adapter(fetchImpl).ocr({ absolutePath: "/media/a.mp4", timestampSec: 0 });
    expect("duration_sec" in seenBody).toBe(false);
  });

  it("cancelTranscription posts to the cancel endpoint and returns the flag", async () => {
    let seenUrl = "";
    let seenMethod = "";
    const fetchImpl = fakeFetch({
      body: { ok: true, data: { asset_id: "asset:0", cancelled: true } },
      onRequest: (url, init) => {
        seenUrl = url;
        seenMethod = init?.method ?? "";
      },
    });
    await expect(adapter(fetchImpl).cancelTranscription("asset:0")).resolves.toBe(true);
    expect(seenMethod).toBe("POST");
    expect(seenUrl).toBe("http://ai-processor:8000/transcribe/cancel/asset%3A0");
  });

  it("maps a 429 rate limit to UNAVAILABLE (transient, ADR-006 §6)", async () => {
    const fetchImpl = fakeFetch({ status: 429, body: { detail: "slow down" } });
    await expect(adapter(fetchImpl).summarize("t")).rejects.toMatchObject({
      code: AI_PROCESSOR_ERROR_CODES.UNAVAILABLE,
    });
  });

  it("maps a connection failure to UNAVAILABLE (transient)", async () => {
    const fetchImpl = fakeFetch({ throws: new TypeError("fetch failed") });
    await expect(adapter(fetchImpl).summarize("t")).rejects.toMatchObject({
      code: AI_PROCESSOR_ERROR_CODES.UNAVAILABLE,
    });
  });

  it("maps an aborted request to TIMEOUT (transient)", async () => {
    const fetchImpl = (async () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    }) as unknown as typeof fetch;
    const slow = new HttpAiProcessorAdapter({
      baseUrl: "http://ai-processor:8000",
      requestTimeoutMs: 5,
      fetchImpl,
    });
    await expect(slow.summarize("t")).rejects.toMatchObject({
      code: AI_PROCESSOR_ERROR_CODES.TIMEOUT,
    });
  });

  it("rejects a malformed envelope as INVALID_RESPONSE (permanent)", async () => {
    const fetchImpl = fakeFetch({ body: { not: "the contract" } });
    await expect(adapter(fetchImpl).summarize("t")).rejects.toMatchObject({
      code: AI_PROCESSOR_ERROR_CODES.INVALID_RESPONSE,
    });
  });

  it("rejects an unexpected data shape as INVALID_RESPONSE (permanent)", async () => {
    const fetchImpl = fakeFetch({ body: { ok: true, data: { summary: 123, keywords: "no", category: null } } });
    await expect(adapter(fetchImpl).summarize("t")).rejects.toMatchObject({
      code: AI_PROCESSOR_ERROR_CODES.INVALID_RESPONSE,
    });
  });

  it("rejects a non-JSON body as INVALID_RESPONSE", async () => {
    const fetchImpl = fakeFetch({ body: undefined });
    await expect(adapter(fetchImpl).summarize("t")).rejects.toBeInstanceOf(AiProcessorError);
  });

  it("health() resolves false instead of throwing when the processor is down", async () => {
    const fetchImpl = fakeFetch({ throws: new TypeError("fetch failed") });
    await expect(adapter(fetchImpl).health()).resolves.toBe(false);
  });

  it("health() resolves true on a 200", async () => {
    const fetchImpl = fakeFetch({ body: { status: "ok", openrouter_available: true } });
    await expect(adapter(fetchImpl).health()).resolves.toBe(true);
  });

  it("encodes the external job id in the status URL", async () => {
    let seenUrl = "";
    const fetchImpl = fakeFetch({
      body: { ok: true, data: { status: "NOT_FOUND" } },
      onRequest: (url) => {
        seenUrl = url;
      },
    });
    await adapter(fetchImpl).transcriptionStatus("abc:1/../x");
    expect(seenUrl).toBe("http://ai-processor:8000/transcribe/status/abc%3A1%2F..%2Fx");
  });
});
