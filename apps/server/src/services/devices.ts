import { type api, Command, DeviceStatus, OFFLINE_AFTER_SEC } from "@managealltv/protocol";
import type { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { logger } from "../logger";
import { deviceHub } from "./device-hub";
import { expectedPlaylistIds } from "./manifest";
import type { DeviceWithLocation } from "./permissions";

// ------------------------------------------------------------------ views

export function isOnline(lastSeenAt: Date | null, now = new Date()): boolean {
  return lastSeenAt !== null && now.getTime() - lastSeenAt.getTime() <= OFFLINE_AFTER_SEC * 1000;
}

function parseStatus(value: Prisma.JsonValue | null): DeviceStatus | null {
  if (value === null) return null;
  const parsed = DeviceStatus.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Serialises devices to the api.Device view (expectedPlaylistId computed in one batch). */
export async function toDeviceViews(devices: readonly DeviceWithLocation[], now = new Date()): Promise<api.Device[]> {
  const expected = await expectedPlaylistIds(
    devices.map((d) => ({
      id: d.id,
      locationId: d.locationId,
      defaultPlaylistId: d.defaultPlaylistId,
      timezone: d.location.timezone,
    })),
    now,
  );
  return devices.map((device) => ({
    id: device.id,
    name: device.name,
    locationId: device.locationId,
    locationName: device.location.name,
    online: isOnline(device.lastSeenAt, now),
    lastSeenAt: device.lastSeenAt?.toISOString() ?? null,
    manufacturer: device.manufacturer,
    model: device.model,
    androidVersion: device.androidVersion,
    appVersionName: device.appVersionName,
    manifestVersion: device.manifestVersion,
    defaultPlaylistId: device.defaultPlaylistId,
    volume: device.volume,
    expectedPlaylistId: expected.get(device.id) ?? null,
    status: parseStatus(device.status),
    createdAt: device.createdAt.toISOString(),
  }));
}

export async function toDeviceView(device: DeviceWithLocation, now = new Date()): Promise<api.Device> {
  const [view] = await toDeviceViews([device], now);
  if (!view) throw new Error("unreachable");
  return view;
}

// ------------------------------------------------------------------ status

/**
 * Applies a status report (WebSocket "status" or POST /status): last seen, stored status and the
 * app/storage facts that also appear in the device view. Returns the server's manifest version.
 */
export async function recordDeviceStatus(deviceId: string, status: DeviceStatus): Promise<number> {
  const device = await prisma.device.update({
    where: { id: deviceId },
    data: {
      lastSeenAt: new Date(),
      status: status as Prisma.InputJsonValue,
      appVersionName: status.appVersionName,
      appVersionCode: status.appVersionCode,
      freeStorageBytes: BigInt(status.freeStorageBytes),
    },
    select: { manifestVersion: true },
  });
  return device.manifestVersion;
}

// ------------------------------------------------------------------ commands

/** Pending commands older than this are not delivered any more but marked expired. */
export const COMMAND_PENDING_TTL_MS = 10 * 60 * 1000;

const commandInclude = { createdBy: { select: { name: true } } } as const;
type CommandRow = Prisma.CommandGetPayload<{ include: typeof commandInclude }>;

export function toCommandView(row: CommandRow): api.CommandView {
  return {
    id: row.id,
    deviceId: row.deviceId,
    command: Command.parse(row.payload),
    status: row.status,
    message: row.message,
    createdAt: row.createdAt.toISOString(),
    createdByName: row.createdBy?.name ?? null,
  };
}

export async function listCommands(deviceId: string, limit = 50): Promise<api.CommandView[]> {
  const rows = await prisma.command.findMany({
    where: { deviceId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit,
    include: commandInclude,
  });
  return rows.map(toCommandView);
}

async function deliver(row: { id: string; deviceId: string; payload: Prisma.JsonValue }): Promise<boolean> {
  const command = Command.safeParse(row.payload);
  if (!command.success || !deviceHub.isConnected(row.deviceId)) return false;
  // Claim the row before sending: createCommand and a reconnect's deliverPendingCommands can both read
  // the same pending row, and sending first would let both deliver it (a reboot would run twice).
  const sentAt = new Date();
  const claimed = await prisma.command.updateMany({
    where: { id: row.id, status: "pending" },
    data: { status: "sent", sentAt },
  });
  if (claimed.count !== 1) return false;
  if (deviceHub.send(row.deviceId, { type: "command", id: row.id, command: command.data })) return true;
  // The socket went away in between: put it back so the next connect delivers it.
  await prisma.command.updateMany({
    where: { id: row.id, status: "sent", sentAt },
    data: { status: "pending", sentAt: null },
  });
  return false;
}

/** Creates a command; it is sent immediately when the device is connected, otherwise stays pending. */
export async function createCommand(deviceId: string, command: Command, createdById: string | null): Promise<api.CommandView> {
  const row = await prisma.command.create({
    data: { deviceId, payload: command as Prisma.InputJsonValue, createdById },
    include: commandInclude,
  });
  await deliver(row);
  const fresh = await prisma.command.findUniqueOrThrow({ where: { id: row.id }, include: commandInclude });
  return toCommandView(fresh);
}

/** On (re)connect: expire stale pending commands and send the recent ones in creation order. */
export async function deliverPendingCommands(deviceId: string, now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - COMMAND_PENDING_TTL_MS);
  await prisma.command.updateMany({
    where: { deviceId, status: "pending", createdAt: { lt: cutoff } },
    data: { status: "expired", completedAt: now, message: "Cihaz zamanında bağlanmadı" },
  });
  const pending = await prisma.command.findMany({
    where: { deviceId, status: "pending" },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  let sent = 0;
  for (const row of pending) if (await deliver(row)) sent += 1;
  return sent;
}

/** Marks all stale pending commands expired (maintenance). */
export async function expireStaleCommands(now = new Date()): Promise<number> {
  const result = await prisma.command.updateMany({
    where: { status: "pending", createdAt: { lt: new Date(now.getTime() - COMMAND_PENDING_TTL_MS) } },
    data: { status: "expired", completedAt: now, message: "Cihaz zamanında bağlanmadı" },
  });
  return result.count;
}

/** Stores a command result reported by the device. Returns false if the command is not the device's. */
export async function recordCommandResult(
  deviceId: string,
  commandId: string,
  ok: boolean,
  message: string | null,
): Promise<boolean> {
  const command = await prisma.command.findFirst({ where: { id: commandId, deviceId }, select: { id: true } });
  if (!command) return false;
  // Late results for an expired command still tell the truth about what happened on the TV.
  await prisma.command.updateMany({
    where: { id: commandId, status: { in: ["pending", "sent", "expired"] } },
    data: { status: ok ? "succeeded" : "failed", message, completedAt: new Date() },
  });
  return true;
}

// ------------------------------------------------------------------ deletion

/**
 * Deletes a device: revokes its token (row removed), removes its schedule rules and pending
 * commands/pairings (cascade), then tells a connected player it was unpaired.
 */
export async function deleteDevice(deviceId: string): Promise<void> {
  await prisma.$transaction([
    prisma.schedule.deleteMany({ where: { targetType: "device", targetId: deviceId } }),
    prisma.device.delete({ where: { id: deviceId } }),
  ]);
  deviceHub.unpair(deviceId);
  logger.info("Device deleted", { deviceId });
}
