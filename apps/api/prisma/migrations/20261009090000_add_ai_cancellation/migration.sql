-- Phase 16: durable AI cancellation (ADR-006 §18).
-- Purely additive: one new enum value and one nullable column on MediaFile.
-- No existing row is modified or deleted (AGENTS.md §12, §32).

-- AlterEnum
ALTER TYPE "AiStatus" ADD VALUE IF NOT EXISTS 'CANCELLED';

-- AlterTable
ALTER TABLE "MediaFile"
  ADD COLUMN "aiCancelRequestedAt" TIMESTAMPTZ(6);
