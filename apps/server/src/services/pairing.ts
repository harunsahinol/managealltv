import { DeviceInfo, type PairPollResponse, type PairResponse } from "@managealltv/protocol";
import type { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { generateDeviceToken, randomPairingCode, randomToken, sha256Hex } from "../lib/crypto";
import { badRequest, notFound } from "../lib/errors";
import { logger } from "../logger";
import { refreshManifests } from "./manifest";
import type { DeviceWithLocation } from "./permissions";

export const PAIRING_TTL_MS = 15 * 60 * 1000;
export const PAIRING_POLL_INTERVAL_SEC = 3;
/** Pairings (and their stored DeviceInfo) are deleted this long after they expire. */
export const PAIRING_RETENTION_MS = 24 * 60 * 60 * 1000;

// Arbitrary constant for pg_advisory_xact_lock: serialises code allocation across processes.
const PAIRING_CODE_LOCK = 724_001;

function openPairingWhere(now: Date): Prisma.DevicePairingWhereInput {
  return { expiresAt: { gt: now }, claimedDeviceId: null, consumedAt: null };
}

/** POST /pair: registers a pairing request with a 6-digit code unique among open pairings. */
export async function createPairing(info: DeviceInfo, ip: string | null): Promise<PairResponse> {
  const secret = randomToken(32);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + PAIRING_TTL_MS);

  const code = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${PAIRING_CODE_LOCK})`;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const candidate = randomPairingCode();
      const taken = await tx.devicePairing.findFirst({ where: { code: candidate, ...openPairingWhere(now) }, select: { id: true } });
      if (taken) continue;
      await tx.devicePairing.create({
        data: { code: candidate, secretHash: sha256Hex(secret), info: info as Prisma.InputJsonValue, ip, expiresAt },
      });
      return candidate;
    }
    throw new Error("Could not allocate a free pairing code");
  });

  return {
    pairingCode: code,
    pairingSecret: secret,
    expiresAt: expiresAt.toISOString(),
    pollIntervalSec: PAIRING_POLL_INTERVAL_SEC,
  };
}

/**
 * POST /pair/poll. After an admin claimed the code, the first poll generates the device token and
 * consumes the pairing, so the token is delivered exactly once; later polls answer "expired".
 */
export async function pollPairing(secret: string, now = new Date()): Promise<PairPollResponse> {
  const pairing = await prisma.devicePairing.findUnique({
    where: { secretHash: sha256Hex(secret) },
    include: { claimedDevice: { select: { id: true, name: true } } },
  });
  if (!pairing || pairing.consumedAt !== null) return { status: "expired" };

  const device = pairing.claimedDevice;
  if (device) {
    const { token, hash } = generateDeviceToken();
    const delivered = await prisma.$transaction(async (tx) => {
      const consumed = await tx.devicePairing.updateMany({
        where: { id: pairing.id, consumedAt: null },
        data: { consumedAt: now },
      });
      if (consumed.count !== 1) return false;
      await tx.device.update({ where: { id: device.id }, data: { tokenHash: hash } });
      return true;
    });
    if (!delivered) return { status: "expired" };
    logger.info("Device token delivered", { deviceId: device.id });
    return { status: "paired", deviceId: device.id, deviceToken: token, deviceName: device.name };
  }

  return pairing.expiresAt <= now ? { status: "expired" } : { status: "pending" };
}

export interface ClaimInput {
  pairingCode: string;
  name: string;
  locationId: string;
}

/** POST /api/devices/claim: turns an open pairing into a Device (its token is issued at the next poll). */
export async function claimPairing(input: ClaimInput): Promise<DeviceWithLocation> {
  const now = new Date();
  const location = await prisma.location.findUnique({ where: { id: input.locationId }, select: { id: true } });
  if (!location) throw badRequest("Seçilen konum bulunamadı.");

  const pairing = await prisma.devicePairing.findFirst({
    where: { code: input.pairingCode, ...openPairingWhere(now) },
    orderBy: { createdAt: "desc" },
  });
  if (!pairing) throw notFound("Eşleştirme kodu bulunamadı veya süresi doldu.", "pairing_not_found");
  const info = DeviceInfo.parse(pairing.info);

  const device = await prisma.$transaction(async (tx) => {
    const created = await tx.device.create({
      data: {
        name: input.name,
        locationId: input.locationId,
        hardwareId: info.hardwareId,
        manufacturer: info.manufacturer,
        model: info.model,
        androidVersion: info.androidVersion,
        sdkInt: info.sdkInt,
        appVersionName: info.appVersionName,
        appVersionCode: info.appVersionCode,
        screenWidth: info.screenWidth,
        screenHeight: info.screenHeight,
        freeStorageBytes: BigInt(info.freeStorageBytes),
        totalStorageBytes: BigInt(info.totalStorageBytes),
        videoDecoders: info.videoDecoders,
      },
      include: { location: true },
    });
    // Conditional update: two admins typing the same code at once must not create two devices.
    const claimed = await tx.devicePairing.updateMany({
      where: { id: pairing.id, ...openPairingWhere(now) },
      data: { claimedDeviceId: created.id, claimedAt: now },
    });
    if (claimed.count !== 1) throw notFound("Eşleştirme kodu bulunamadı veya süresi doldu.", "pairing_not_found");
    return created;
  });

  // Stores the first manifest hash (version 1) so the device's first fetch is already consistent.
  await refreshManifests([device.id]);
  return prisma.device.findUniqueOrThrow({ where: { id: device.id }, include: { location: true } });
}

/** Deletes pairings that expired more than PAIRING_RETENTION_MS ago (maintenance). */
export async function purgeOldPairings(now = new Date()): Promise<number> {
  const result = await prisma.devicePairing.deleteMany({
    where: { expiresAt: { lt: new Date(now.getTime() - PAIRING_RETENTION_MS) } },
  });
  return result.count;
}
