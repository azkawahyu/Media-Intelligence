import http from "node:http";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import type { ScanOrchestrator } from "./orchestrator.js";

function makeScan(id: string, status: "PENDING" | "RUNNING" = "PENDING") {
  const now = new Date("2026-09-30T12:00:00.000Z");
  return {
    id,
    storageId: "storage-1",
    status,
    startedAt: now,
    discoveryCompletedAt: null,
    completedAt: null,
    discoveredCount: 0,
    newCount: 0,
    updatedCount: 0,
    unchangedCount: 0,
    missingCount: 0,
    queuedCount: 0,
    processedCount: 0,
    failedCount: 0,
    errorMessage: null,
    createdAt: now,
    updatedAt: now,
  };
}

function createFakeDatabase() {
  const scans = new Map<string, ReturnType<typeof makeScan>>();
  let nextId = 1;
  const database = {
    $queryRaw: async () => [{ result: 1 }],
    storage: {
      findUnique: async ({ where }: { where: { name: string } }) =>
        where.name === "Configured" ? { id: "storage-1", name: "Configured", enabled: true } : null,
    },
    scanJob: {
      findFirst: async ({ where }: { where: { storageId: string } }) =>
        [...scans.values()].find(
          (scan) => scan.storageId === where.storageId &&
            (scan.status === "PENDING" || scan.status === "RUNNING"),
        ) ?? null,
      create: async () => {
        const scan = makeScan(`scan-${nextId++}`);
        scans.set(scan.id, scan);
        return scan;
      },
      findUnique: async ({ where }: { where: { id: string } }) => scans.get(where.id) ?? null,
      findMany: async () => [...scans.values()].reverse(),
    },
  };
  return { database, scans };
}

async function withServer(app: ReturnType<typeof createApp>, test: (baseUrl: string) => Promise<void>) {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("server did not bind");
  try {
    await test(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

describe("scan API", () => {
  it("starts a scan asynchronously and returns 202", async () => {
    const { database } = createFakeDatabase();
    const runs: string[] = [];
    const orchestrator = { run: async (storageId: string, scanId: string) => { runs.push(`${storageId}:${scanId}`); } } as unknown as ScanOrchestrator;
    const app = createApp({
      prisma: database as never,
      config: { mediaRoot: "/media", storageName: "Configured", supportedMediaExtensions: [".mp4"] },
      orchestrator,
    });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/scans`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      expect(response.status).toBe(202);
      const payload = await response.json() as { scanId: string };
      expect(payload.scanId).toBeTruthy();
      await new Promise((resolve) => setImmediate(resolve));
      expect(runs).toHaveLength(1);
    });
  });

  it("echoes an allow-listed Origin and withholds disallowed origins", async () => {
    const { database } = createFakeDatabase();
    const orchestrator = { run: async () => undefined } as unknown as ScanOrchestrator;
    const app = createApp({
      prisma: database as never,
      config: {
        mediaRoot: "/media",
        storageName: "Configured",
        supportedMediaExtensions: [".mp4"],
        webOrigin: "http://localhost:3000,http://172.20.20.231:3000",
      },
      orchestrator,
    });

    await withServer(app, async (baseUrl) => {
      const allowed = await fetch(`${baseUrl}/scans`, {
        headers: { origin: "http://172.20.20.231:3000" },
      });
      expect(allowed.headers.get("access-control-allow-origin")).toBe("http://172.20.20.231:3000");

      const disallowed = await fetch(`${baseUrl}/scans`, {
        headers: { origin: "http://evil.example" },
      });
      expect(disallowed.headers.get("access-control-allow-origin")).toBeNull();

      const preflight = await fetch(`${baseUrl}/scans`, {
        method: "OPTIONS",
        headers: { origin: "http://localhost:3000" },
      });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
    });
  });

  it("returns exactly one 202 and one 409 for concurrent starts", async () => {
    const { database } = createFakeDatabase();
    const orchestrator = { run: async () => new Promise<void>(() => undefined) } as unknown as ScanOrchestrator;
    const app = createApp({
      prisma: database as never,
      config: { mediaRoot: "/media", storageName: "Configured", supportedMediaExtensions: [".mp4"] },
      orchestrator,
    });

    await withServer(app, async (baseUrl) => {
      const responses = await Promise.all([
        fetch(`${baseUrl}/scans`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }),
        fetch(`${baseUrl}/scans`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }),
      ]);
      expect(responses.map((response) => response.status).sort()).toEqual([202, 409]);
    });
  });

  it("validates storageId, body, progress lookup, and history", async () => {
    const { database } = createFakeDatabase();
    const app = createApp({
      prisma: database as never,
      config: { mediaRoot: "/media", storageName: "Configured", supportedMediaExtensions: [".mp4"] },
    });
    await withServer(app, async (baseUrl) => {
      const unknownBody = await fetch(`${baseUrl}/scans`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ unexpected: true }) });
      expect(unknownBody.status).toBe(400);
      const invalidStorage = await fetch(`${baseUrl}/scans`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ storageId: "other" }) });
      expect(invalidStorage.status).toBe(400);
      expect((await fetch(`${baseUrl}/scans/unknown`)).status).toBe(404);
      expect((await fetch(`${baseUrl}/scans`)).status).toBe(200);
    });
  });
});

