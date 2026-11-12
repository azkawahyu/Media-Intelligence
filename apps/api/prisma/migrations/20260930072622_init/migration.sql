-- CreateEnum
CREATE TYPE "MediaStatus" AS ENUM ('ACTIVE', 'MISSING');

-- CreateEnum
CREATE TYPE "MetadataStatus" AS ENUM ('PENDING', 'PROCESSING', 'READY', 'FAILED');

-- CreateEnum
CREATE TYPE "ErrorStage" AS ENUM ('VALIDATION', 'FFPROBE', 'NORMALIZATION', 'PERSISTENCE');

-- CreateEnum
CREATE TYPE "ScanJobStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'COMPLETED_WITH_ERRORS', 'FAILED');

-- CreateTable
CREATE TABLE "Storage" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "rootPath" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Storage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MediaFile" (
    "id" TEXT NOT NULL,
    "storageId" TEXT NOT NULL,
    "relativePath" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "extension" TEXT NOT NULL,
    "fileSize" BIGINT NOT NULL,
    "modifiedAt" TIMESTAMPTZ(6) NOT NULL,
    "status" "MediaStatus" NOT NULL DEFAULT 'ACTIVE',
    "metadataStatus" "MetadataStatus" NOT NULL DEFAULT 'PENDING',
    "durationSeconds" DOUBLE PRECISION,
    "videoCodec" TEXT,
    "width" INTEGER,
    "height" INTEGER,
    "frameRateNumerator" INTEGER,
    "frameRateDenominator" INTEGER,
    "audioCodec" TEXT,
    "audioSampleRate" INTEGER,
    "audioChannels" INTEGER,
    "technicalMetadata" JSONB,
    "rawProbeData" JSONB,
    "firstSeenAt" TIMESTAMPTZ(6) NOT NULL,
    "lastSeenAt" TIMESTAMPTZ(6) NOT NULL,
    "lastSeenScanId" TEXT NOT NULL,
    "lastMetadataExtractedAt" TIMESTAMPTZ(6),
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "errorStage" "ErrorStage",
    "errorAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "MediaFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScanJob" (
    "id" TEXT NOT NULL,
    "storageId" TEXT NOT NULL,
    "status" "ScanJobStatus" NOT NULL DEFAULT 'PENDING',
    "startedAt" TIMESTAMPTZ(6) NOT NULL,
    "discoveryCompletedAt" TIMESTAMPTZ(6),
    "completedAt" TIMESTAMPTZ(6),
    "discoveredCount" INTEGER NOT NULL DEFAULT 0,
    "newCount" INTEGER NOT NULL DEFAULT 0,
    "updatedCount" INTEGER NOT NULL DEFAULT 0,
    "unchangedCount" INTEGER NOT NULL DEFAULT 0,
    "missingCount" INTEGER NOT NULL DEFAULT 0,
    "queuedCount" INTEGER NOT NULL DEFAULT 0,
    "processedCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ScanJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Storage_name_key" ON "Storage"("name");

-- CreateIndex
CREATE INDEX "MediaFile_metadataStatus_idx" ON "MediaFile"("metadataStatus");

-- CreateIndex
CREATE INDEX "MediaFile_storageId_status_idx" ON "MediaFile"("storageId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "MediaFile_storageId_relativePath_key" ON "MediaFile"("storageId", "relativePath");

-- CreateIndex
CREATE INDEX "ScanJob_storageId_status_idx" ON "ScanJob"("storageId", "status");

-- AddForeignKey
ALTER TABLE "MediaFile" ADD CONSTRAINT "MediaFile_storageId_fkey" FOREIGN KEY ("storageId") REFERENCES "Storage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScanJob" ADD CONSTRAINT "ScanJob_storageId_fkey" FOREIGN KEY ("storageId") REFERENCES "Storage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
