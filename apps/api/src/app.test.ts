import { describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import { healthHandler } from "./app.js";

type CapturedResponse = {
  statusCode: number;
  body: unknown;
};

function responseCapture(): { response: Response; captured: CapturedResponse } {
  const captured: CapturedResponse = { statusCode: 0, body: undefined };
  const response = {
    status(code: number) {
      captured.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      captured.body = payload;
      return this;
    },
  } as unknown as Response;
  return { response, captured };
}

describe("GET /health handler", () => {
  it("reports a reachable database", async () => {
    const { response, captured } = responseCapture();
    const database = { $queryRaw: vi.fn().mockResolvedValue([{ result: 1 }]) };

    await healthHandler({} as Request, response, database);

    expect(database.$queryRaw).toHaveBeenCalledOnce();
    expect(captured.statusCode).toBe(200);
    expect(captured.body).toEqual({ status: "ok", database: "reachable" });
  });

  it("reports an unreachable database as degraded", async () => {
    const { response, captured } = responseCapture();
    const database = { $queryRaw: vi.fn().mockRejectedValue(new Error("database down")) };

    await healthHandler({} as Request, response, database);

    expect(captured.statusCode).toBe(503);
    expect(captured.body).toEqual({ status: "degraded", database: "unreachable" });
  });
});
