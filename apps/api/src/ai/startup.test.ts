import { describe, expect, it } from "vitest";
import { sweepInterruptedAiState } from "./startup.js";

interface Row {
  id: string;
  aiStatus: string;
  aiAttempt: number;
  aiCancelRequestedAt?: Date | null;
  aiPartial?: boolean;
  aiProcessedAt?: Date | null;
  aiErrorCode?: string | null;
  aiErrorMessage?: string | null;
  aiErrorAt?: Date | null;
}

function createFakePrisma(rows: Row[]) {
  return {
    mediaFile: {
      updateMany: async ({
        where,
        data,
      }: {
        where: { aiStatus?: string; aiCancelRequestedAt?: { not: null } | null };
        data: Partial<Row>;
      }) => {
        let count = 0;
        for (const row of rows) {
          if (where.aiStatus !== undefined && row.aiStatus !== where.aiStatus) continue;
          if (where.aiCancelRequestedAt !== undefined) {
            const isNull = (row.aiCancelRequestedAt ?? null) === null;
            if (where.aiCancelRequestedAt === null && !isNull) continue;
            if (
              where.aiCancelRequestedAt !== null &&
              typeof where.aiCancelRequestedAt === "object" &&
              isNull
            ) {
              continue;
            }
          }
          Object.assign(row, data);
          count += 1;
        }
        return { count };
      },
    },
  };
}

describe("sweepInterruptedAiState", () => {
  it("resets PROCESSING rows to PENDING for a safe re-run", async () => {
    const rows = [
      { id: "a", aiStatus: "PROCESSING", aiAttempt: 0 },
      { id: "b", aiStatus: "PROCESSING", aiAttempt: 1 },
    ];
    const result = await sweepInterruptedAiState(createFakePrisma(rows) as never);

    expect(result.processingAiFiles).toBe(2);
    expect(rows.every((row) => row.aiStatus === "PENDING")).toBe(true);
  });

  it("does not consume a retry (aiAttempt is untouched)", async () => {
    const rows = [{ id: "a", aiStatus: "PROCESSING", aiAttempt: 1 }];
    await sweepInterruptedAiState(createFakePrisma(rows) as never);
    expect(rows[0]?.aiAttempt).toBe(1);
  });

  it("leaves READY, FAILED, PENDING and SKIPPED rows untouched", async () => {
    const rows = [
      { id: "ready", aiStatus: "READY", aiAttempt: 0 },
      { id: "failed", aiStatus: "FAILED", aiAttempt: 2 },
      { id: "pending", aiStatus: "PENDING", aiAttempt: 0 },
      { id: "skipped", aiStatus: "SKIPPED", aiAttempt: 0 },
    ];
    const result = await sweepInterruptedAiState(createFakePrisma(rows) as never);

    expect(result.processingAiFiles).toBe(0);
    expect(rows.map((row) => row.aiStatus)).toEqual(["READY", "FAILED", "PENDING", "SKIPPED"]);
  });

  it("is a no-op when no AI work was in flight", async () => {
    const result = await sweepInterruptedAiState(createFakePrisma([]) as never);
    expect(result.processingAiFiles).toBe(0);
  });

  it("finalizes a PROCESSING row carrying a cancellation intent as CANCELLED (ADR-006 §18)", async () => {
    const rows = [
      { id: "stopped", aiStatus: "PROCESSING", aiAttempt: 0, aiCancelRequestedAt: new Date() },
      { id: "live", aiStatus: "PROCESSING", aiAttempt: 0, aiCancelRequestedAt: null },
    ];
    const result = await sweepInterruptedAiState(createFakePrisma(rows) as never);

    // The cancelled row is honored, not resurrected; the live row is re-queued.
    expect(rows[0]?.aiStatus).toBe("CANCELLED");
    expect(rows[1]?.aiStatus).toBe("PENDING");
    expect(result.cancelledAiFiles).toBe(1);
    expect(result.processingAiFiles).toBe(1);
  });
});
