-- Phase 14: AI enrichment lifecycle (ADR-006, docs/plans/006-ai-processor-integration.md §3).
-- Purely additive: new enum types, a new AiResult table, and nullable/defaulted
-- columns on MediaFile. Existing rows read aiStatus = PENDING and aiAttempt = 0.

-- CreateEnum
CREATE TYPE "AiStatus" AS ENUM ('PENDING', 'PROCESSING', 'READY', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "AiStage" AS ENUM ('TRANSCRIPTION', 'SUMMARY', 'KEYWORDS', 'CLASSIFICATION', 'OCR');

-- CreateEnum
CREATE TYPE "AiStageStatus" AS ENUM ('READY', 'FAILED');

-- AlterTable
ALTER TABLE "MediaFile"
  ADD COLUMN "aiStatus" "AiStatus" NOT NULL DEFAULT 'PENDING',
  ADD COLUMN "aiPartial" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "aiAttempt" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "aiExternalJobId" TEXT,
  ADD COLUMN "aiErrorCode" TEXT,
  ADD COLUMN "aiErrorMessage" TEXT,
  ADD COLUMN "aiErrorAt" TIMESTAMPTZ(6),
  ADD COLUMN "aiProcessedAt" TIMESTAMPTZ(6);

-- CreateIndex
CREATE INDEX "MediaFile_aiStatus_idx" ON "MediaFile"("aiStatus");

-- CreateTable
CREATE TABLE "AiResult" (
    "id" TEXT NOT NULL,
    "mediaFileId" TEXT NOT NULL,
    "stage" "AiStage" NOT NULL,
    "status" "AiStageStatus" NOT NULL,
    "payload" JSONB,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "attemptedAt" TIMESTAMPTZ(6) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "AiResult_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AiResult_mediaFileId_idx" ON "AiResult"("mediaFileId");

-- CreateIndex
CREATE UNIQUE INDEX "AiResult_mediaFileId_stage_key" ON "AiResult"("mediaFileId", "stage");

-- AddForeignKey
ALTER TABLE "AiResult" ADD CONSTRAINT "AiResult_mediaFileId_fkey" FOREIGN KEY ("mediaFileId") REFERENCES "MediaFile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
