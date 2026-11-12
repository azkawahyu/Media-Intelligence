import http from "node:http";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import type { AiReprocessor } from "./reprocess.js";

function createDatabase() {
  return {
    $queryRaw: async () => [{ result: 1 }],
    storage: { findUnique: async () => null },
    scanJob: { findFirst: async () => null, create: async () => ({}), findUnique: async () => null, findMany: async () => [] },
    mediaFile: { findMany: async () => [], count: async () => 0, findUnique: async () => null },
  };
}

async function withServer(app: ReturnType<typeof createApp>, test: (baseUrl: string) => Promise<void>) {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("server did not bind");
  try {
    await test(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

const appConfig = { mediaRoot: "/unused", storageName: "Configured", supportedMediaExtensions: [".mp4"], aiEnabled: true };

describe("POST /media/:id/ai-reprocess", () => {
  it("returns 202 with the reset PENDING status", async () => {
    const calls: string[] = [];
    const aiReprocessor = {
      reprocessOne: async (id: string) => {
        calls.push(id);
        return "STARTED" as const;
      },
    } as AiReprocessor;

    await withServer(
      createApp({ prisma: createDatabase() as never, config: appConfig, aiReprocessor }),
      async (baseUrl) => {
        const response = await fetch(`${baseUrl}/media/a/ai-reprocess`, { method: "POST" });
        expect(response.status).toBe(202);
        expect(await response.json()).toEqual({ mediaFileId: "a", aiStatus: "PENDING" });
        expect(calls).toEqual(["a"]);
      },
    );
  });

  it("returns 404 for an unknown media id", async () => {
    const aiReprocessor = { reprocessOne: async () => "NOT_FOUND" as const } as AiReprocessor;
    await withServer(
      createApp({ prisma: createDatabase() as never, config: appConfig, aiReprocessor }),
      async (baseUrl) => {
        expect((await fetch(`${baseUrl}/media/missing/ai-reprocess`, { method: "POST" })).status).toBe(404);
      },
    );
  });

  it("returns 409 when a claim is already in flight", async () => {
    const aiReprocessor = { reprocessOne: async () => "CONFLICT" as const } as AiReprocessor;
    await withServer(
      createApp({ prisma: createDatabase() as never, config: appConfig, aiReprocessor }),
      async (baseUrl) => {
        expect((await fetch(`${baseUrl}/media/busy/ai-reprocess`, { method: "POST" })).status).toBe(409);
      },
    );
  });

  it("returns 409 with a disabled message when AI is not enabled", async () => {
    const aiReprocessor = { reprocessOne: async () => "STARTED" as const } as AiReprocessor;
    await withServer(
      createApp({
        prisma: createDatabase() as never,
        config: { ...appConfig, aiEnabled: false },
        aiReprocessor,
      }),
      async (baseUrl) => {
        const response = await fetch(`${baseUrl}/media/a/ai-reprocess`, { method: "POST" });
        expect(response.status).toBe(409);
        expect(await response.json()).toEqual({ error: "AI processing is disabled" });
      },
    );
  });

  it("returns 500 when no AI reprocessor is configured", async () => {
    await withServer(
      createApp({ prisma: createDatabase() as never, config: appConfig }),
      async (baseUrl) => {
        expect((await fetch(`${baseUrl}/media/a/ai-reprocess`, { method: "POST" })).status).toBe(500);
      },
    );
  });

  it("returns 500 when the reprocessor throws", async () => {
    const aiReprocessor = {
      reprocessOne: async () => {
        throw new Error("boom");
      },
    } as AiReprocessor;
    await withServer(
      createApp({ prisma: createDatabase() as never, config: appConfig, aiReprocessor }),
      async (baseUrl) => {
        expect((await fetch(`${baseUrl}/media/a/ai-reprocess`, { method: "POST" })).status).toBe(500);
      },
    );
  });
});

describe("POST /media/:id/ai-cancel (ADR-006 §18)", () => {
  it("returns 202 reporting PROCESSING + cancelRequested (not a premature terminal state)", async () => {
    const calls: string[] = [];
    const aiCanceller = {
      cancel: async (id: string) => {
        calls.push(id);
        return "REQUESTED" as const;
      },
    };
    await withServer(
      createApp({ prisma: createDatabase() as never, config: appConfig, aiCanceller }),
      async (baseUrl) => {
        const response = await fetch(`${baseUrl}/media/a/ai-cancel`, { method: "POST" });
        expect(response.status).toBe(202);
        expect(await response.json()).toEqual({
          mediaFileId: "a",
          aiStatus: "PROCESSING",
          cancelRequested: true,
        });
        expect(calls).toEqual(["a"]);
      },
    );
  });

  it("returns 404 for an unknown media id", async () => {
    const aiCanceller = { cancel: async () => "NOT_FOUND" as const };
    await withServer(
      createApp({ prisma: createDatabase() as never, config: appConfig, aiCanceller }),
      async (baseUrl) => {
        expect((await fetch(`${baseUrl}/media/missing/ai-cancel`, { method: "POST" })).status).toBe(404);
      },
    );
  });

  it("returns 409 when the media is not being processed", async () => {
    const aiCanceller = { cancel: async () => "NOT_PROCESSING" as const };
    await withServer(
      createApp({ prisma: createDatabase() as never, config: appConfig, aiCanceller }),
      async (baseUrl) => {
        expect((await fetch(`${baseUrl}/media/idle/ai-cancel`, { method: "POST" })).status).toBe(409);
      },
    );
  });

  it("returns 500 when no canceller is configured", async () => {
    await withServer(
      createApp({ prisma: createDatabase() as never, config: appConfig }),
      async (baseUrl) => {
        expect((await fetch(`${baseUrl}/media/a/ai-cancel`, { method: "POST" })).status).toBe(500);
      },
    );
  });

  it("returns 500 when the canceller throws", async () => {
    const aiCanceller = {
      cancel: async () => {
        throw new Error("boom");
      },
    };
    await withServer(
      createApp({ prisma: createDatabase() as never, config: appConfig, aiCanceller }),
      async (baseUrl) => {
        expect((await fetch(`${baseUrl}/media/a/ai-cancel`, { method: "POST" })).status).toBe(500);
      },
    );
  });
});
