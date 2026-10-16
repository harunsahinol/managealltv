-- AlterTable
ALTER TABLE "media" ADD COLUMN     "sourceMimeType" TEXT,
ADD COLUMN     "uploadId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "media_uploadId_key" ON "media"("uploadId");

-- CreateIndex
CREATE INDEX "media_uploadedById_idx" ON "media"("uploadedById");

