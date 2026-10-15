-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('admin', 'editor', 'viewer');

-- CreateEnum
CREATE TYPE "InviteKind" AS ENUM ('invite', 'password_reset');

-- CreateEnum
CREATE TYPE "CommandStatus" AS ENUM ('pending', 'sent', 'succeeded', 'failed', 'expired');

-- CreateEnum
CREATE TYPE "MediaType" AS ENUM ('image', 'video');

-- CreateEnum
CREATE TYPE "MediaStatus" AS ENUM ('processing', 'ready', 'failed');

-- CreateEnum
CREATE TYPE "ScheduleTargetType" AS ENUM ('device', 'location');

-- CreateEnum
CREATE TYPE "Weekday" AS ENUM ('mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun');

-- CreateTable
CREATE TABLE "user" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "image" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "twoFactorEnabled" BOOLEAN DEFAULT false,
    "role" "UserRole" NOT NULL DEFAULT 'viewer',
    "disabled" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session" (
    "id" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "token" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "userId" TEXT NOT NULL,

    CONSTRAINT "session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "idToken" TEXT,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "refreshTokenExpiresAt" TIMESTAMP(3),
    "scope" TEXT,
    "password" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verification" (
    "id" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "verification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "twoFactor" (
    "id" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "backupCodes" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "verified" BOOLEAN DEFAULT true,
    "failedVerificationCount" INTEGER DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),

    CONSTRAINT "twoFactor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "location" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT,
    "timezone" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "location_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_location" (
    "userId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,

    CONSTRAINT "user_location_pkey" PRIMARY KEY ("userId","locationId")
);

-- CreateTable
CREATE TABLE "invite" (
    "id" TEXT NOT NULL,
    "kind" "InviteKind" NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "UserRole",
    "locationIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "userId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "device" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "tokenHash" TEXT,
    "hardwareId" TEXT NOT NULL,
    "manufacturer" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "androidVersion" TEXT NOT NULL,
    "sdkInt" INTEGER NOT NULL,
    "appVersionName" TEXT NOT NULL,
    "appVersionCode" INTEGER NOT NULL,
    "screenWidth" INTEGER NOT NULL,
    "screenHeight" INTEGER NOT NULL,
    "freeStorageBytes" BIGINT NOT NULL,
    "totalStorageBytes" BIGINT NOT NULL,
    "videoDecoders" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "lastSeenAt" TIMESTAMP(3),
    "status" JSONB,
    "manifestVersion" INTEGER NOT NULL DEFAULT 1,
    "manifestHash" TEXT,
    "defaultPlaylistId" TEXT,
    "volume" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "device_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "device_pairing" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "secretHash" TEXT NOT NULL,
    "info" JSONB NOT NULL,
    "ip" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "claimedDeviceId" TEXT,
    "claimedAt" TIMESTAMP(3),
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "device_pairing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "command" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "CommandStatus" NOT NULL DEFAULT 'pending',
    "message" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "command_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "MediaType" NOT NULL,
    "status" "MediaStatus" NOT NULL DEFAULT 'processing',
    "error" TEXT,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT,
    "size" BIGINT,
    "sha256" TEXT,
    "durationMs" INTEGER,
    "width" INTEGER,
    "height" INTEGER,
    "uploadedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "media_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "playlist" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "playlist_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "playlist_item" (
    "id" TEXT NOT NULL,
    "playlistId" TEXT NOT NULL,
    "mediaId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "durationSec" INTEGER,

    CONSTRAINT "playlist_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "schedule" (
    "id" TEXT NOT NULL,
    "playlistId" TEXT NOT NULL,
    "targetType" "ScheduleTargetType" NOT NULL,
    "targetId" TEXT NOT NULL,
    "days" "Weekday"[] DEFAULT ARRAY[]::"Weekday"[],
    "startTime" VARCHAR(5) NOT NULL,
    "endTime" VARCHAR(5) NOT NULL,
    "startDate" VARCHAR(10),
    "endDate" VARCHAR(10),
    "priority" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "schedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "summary" TEXT NOT NULL,
    "details" JSONB,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_email_key" ON "user"("email");

-- CreateIndex
CREATE UNIQUE INDEX "session_token_key" ON "session"("token");

-- CreateIndex
CREATE INDEX "session_userId_idx" ON "session"("userId");

-- CreateIndex
CREATE INDEX "account_userId_idx" ON "account"("userId");

-- CreateIndex
CREATE INDEX "verification_identifier_idx" ON "verification"("identifier");

-- CreateIndex
CREATE INDEX "twoFactor_secret_idx" ON "twoFactor"("secret");

-- CreateIndex
CREATE INDEX "twoFactor_userId_idx" ON "twoFactor"("userId");

-- CreateIndex
CREATE INDEX "user_location_locationId_idx" ON "user_location"("locationId");

-- CreateIndex
CREATE UNIQUE INDEX "invite_tokenHash_key" ON "invite"("tokenHash");

-- CreateIndex
CREATE INDEX "invite_email_idx" ON "invite"("email");

-- CreateIndex
CREATE INDEX "invite_userId_idx" ON "invite"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "device_tokenHash_key" ON "device"("tokenHash");

-- CreateIndex
CREATE INDEX "device_locationId_idx" ON "device"("locationId");

-- CreateIndex
CREATE INDEX "device_defaultPlaylistId_idx" ON "device"("defaultPlaylistId");

-- CreateIndex
CREATE UNIQUE INDEX "device_pairing_secretHash_key" ON "device_pairing"("secretHash");

-- CreateIndex
CREATE INDEX "device_pairing_code_idx" ON "device_pairing"("code");

-- CreateIndex
CREATE INDEX "device_pairing_expiresAt_idx" ON "device_pairing"("expiresAt");

-- CreateIndex
CREATE INDEX "device_pairing_claimedDeviceId_idx" ON "device_pairing"("claimedDeviceId");

-- CreateIndex
CREATE INDEX "command_deviceId_createdAt_idx" ON "command"("deviceId", "createdAt");

-- CreateIndex
CREATE INDEX "command_status_createdAt_idx" ON "command"("status", "createdAt");

-- CreateIndex
CREATE INDEX "media_createdAt_idx" ON "media"("createdAt");

-- CreateIndex
CREATE INDEX "media_status_idx" ON "media"("status");

-- CreateIndex
CREATE INDEX "playlist_item_mediaId_idx" ON "playlist_item"("mediaId");

-- CreateIndex
CREATE UNIQUE INDEX "playlist_item_playlistId_position_key" ON "playlist_item"("playlistId", "position");

-- CreateIndex
CREATE INDEX "schedule_targetType_targetId_idx" ON "schedule"("targetType", "targetId");

-- CreateIndex
CREATE INDEX "schedule_playlistId_idx" ON "schedule"("playlistId");

-- CreateIndex
CREATE INDEX "audit_log_createdAt_idx" ON "audit_log"("createdAt");

-- CreateIndex
CREATE INDEX "audit_log_entityType_entityId_idx" ON "audit_log"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "audit_log_userId_idx" ON "audit_log"("userId");

-- AddForeignKey
ALTER TABLE "session" ADD CONSTRAINT "session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account" ADD CONSTRAINT "account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "twoFactor" ADD CONSTRAINT "twoFactor_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_location" ADD CONSTRAINT "user_location_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_location" ADD CONSTRAINT "user_location_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "location"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invite" ADD CONSTRAINT "invite_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invite" ADD CONSTRAINT "invite_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device" ADD CONSTRAINT "device_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device" ADD CONSTRAINT "device_defaultPlaylistId_fkey" FOREIGN KEY ("defaultPlaylistId") REFERENCES "playlist"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_pairing" ADD CONSTRAINT "device_pairing_claimedDeviceId_fkey" FOREIGN KEY ("claimedDeviceId") REFERENCES "device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "command" ADD CONSTRAINT "command_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "command" ADD CONSTRAINT "command_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media" ADD CONSTRAINT "media_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "playlist" ADD CONSTRAINT "playlist_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "playlist_item" ADD CONSTRAINT "playlist_item_playlistId_fkey" FOREIGN KEY ("playlistId") REFERENCES "playlist"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "playlist_item" ADD CONSTRAINT "playlist_item_mediaId_fkey" FOREIGN KEY ("mediaId") REFERENCES "media"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule" ADD CONSTRAINT "schedule_playlistId_fkey" FOREIGN KEY ("playlistId") REFERENCES "playlist"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule" ADD CONSTRAINT "schedule_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
