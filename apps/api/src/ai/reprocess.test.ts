import { describe, expect, it } from "vitest";
import { createAiReprocessor } from "./reprocess.js";

interface Row {
  id: string;
  aiStatus: string;
  aiAttempt: number;
  aiPartial: boolean;
  aiExternalJobId: string | null;
  aiErrorCode: string | null;
  aiErrorMessage: string | null;
  aiErrorAt: Date | null;
}

function makeRow(id: string, aiStatus: string, overrides: Partial<Row> = {}): Row {
  return {
    id,
    aiStatus,
    aiAttempt: 2,
    aiPartial: true,
    aiExternalJobId: `${id}:2`,
    aiErrorCode: "AI_PROCESSOR_TIMEOUT",
    aiErrorMessage: "timed out",
    aiErrorAt: new Date("2026-10-07T00:00:00Z"),
    ...overrides,
  };
}

function createFakePrisma(rows: Row[]) {
  return {
    mediaFile: {
      updateMany: async ({
        where,
        data,
      }: {
        where: { id: string; aiStatus?: { in: string[] } };
        data: Partial<Row>;
      }) => {
        const row = rows.find((entry) => entry.id === where.id);
        if (row === undefined) return { count: 0 };
        const allowed = where.aiStatus?.in;
        if (allowed !== undefined && !allowed.includes(row.aiStatus)) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      },
      findUnique: async ({ where }: { where: { id: string } }) =>
        rows.find((entry) => entry.id === where.id) ?? null,
    },
  };
}

function reprocessorFor(rows: Row[]) {
  return createAiReprocessor(createFakePrisma(rows) as never);
}

describe("AiReprocessor", () => {
  it("resets a FAILED row to PENDING, clears errors, resets the attempt", async () => {
    const rows = [makeRow("failed", "FAILED")];
    const reprocessor = reprocessorFor(rows);

    await expect(reprocessor.reprocessOne("failed")).resolves.toBe("STARTED");
    expect(rows[0]).toMatchObject({
      aiStatus: "PENDING",
      aiAttempt: 0,
      aiPartial: false,
      aiExternalJobId: null,
      aiErrorCode: null,
      aiErrorMessage: null,
      aiErrorAt: null,
    });
  });

  it("treats an already-PENDING row as idempotent success (202), not a conflict", async () => {
    const rows = [makeRow("pending", "PENDING", { aiAttempt: 0, aiExternalJobId: null })];
    const reprocessor = reprocessorFor(rows);

    await expect(reprocessor.reprocessOne("pending")).resolves.toBe("STARTED");
  });

  it("returns CONFLICT for a PROCESSING row (live claim)", async () => {
    const rows = [makeRow("busy", "PROCESSING")];
    const reprocessor = reprocessorFor(rows);

    await expect(reprocessor.reprocessOne("busy")).resolves.toBe("CONFLICT");
    // The live claim is left untouched.
    expect(rows[0]?.aiStatus).toBe("PROCESSING");
  });

  it("returns NOT_FOUND for an unknown id", async () => {
    const reprocessor = reprocessorFor([]);
    await expect(reprocessor.reprocessOne("missing")).resolves.toBe("NOT_FOUND");
  });

  it("leaves AiResult rows in place (it only resets the MediaFile row)", async () => {
    const rows = [makeRow("ready", "READY")];
    // The reprocessor's prisma surface has no aiResult delegate at all; calling
    // it would throw. Reaching STARTED proves no AiResult mutation is attempted.
    const reprocessor = reprocessorFor(rows);
    await expect(reprocessor.reprocessOne("ready")).resolves.toBe("STARTED");
  });
});
