/**
 * Role and location-scope rules of docs/API.md.
 *
 * - admin: everything, all locations.
 * - editor/viewer: only devices whose locationId is in user.locationIds, and schedules whose target is
 *   such a device or location. Out-of-scope single resources answer 404 (never 403) so existence is
 *   not leaked. Role checks (e.g. viewer trying to mutate) answer 403.
 */
import type { api } from "@managealltv/protocol";
import type { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { forbidden, notFound } from "../lib/errors";
import type { AuthUser } from "../types";

export const isAdmin = (user: AuthUser): boolean => user.role === "admin";

/** Editors and admins may change content (media, playlists) and act on in-scope devices. */
export const canEdit = (user: AuthUser): boolean => user.role === "admin" || user.role === "editor";

export function assertRole(user: AuthUser, ...roles: api.Role[]): void {
  if (!roles.includes(user.role)) throw forbidden();
}

export function canSeeLocation(user: AuthUser, locationId: string): boolean {
  return isAdmin(user) || user.locationIds.includes(locationId);
}

/** Prisma filter for the devices a user may see. */
export function deviceScopeWhere(user: AuthUser): Prisma.DeviceWhereInput {
  return isAdmin(user) ? {} : { locationId: { in: user.locationIds } };
}

/** Prisma filter for the locations a user may see. */
export function locationScopeWhere(user: AuthUser): Prisma.LocationWhereInput {
  return isAdmin(user) ? {} : { id: { in: user.locationIds } };
}

/** Prisma filter for the schedules a user may see (target device or location in scope). */
export async function scheduleScopeWhere(user: AuthUser): Promise<Prisma.ScheduleWhereInput> {
  if (isAdmin(user)) return {};
  const devices = await prisma.device.findMany({ where: deviceScopeWhere(user), select: { id: true } });
  return {
    OR: [
      { targetType: "location", targetId: { in: user.locationIds } },
      { targetType: "device", targetId: { in: devices.map((d) => d.id) } },
    ],
  };
}

/** Loads a device (with its location) the user may see, or throws 404. */
export async function findDeviceInScope(user: AuthUser, deviceId: string): Promise<DeviceWithLocation> {
  const device = await prisma.device.findFirst({
    where: { id: deviceId, ...deviceScopeWhere(user) },
    include: { location: true },
  });
  if (!device) throw notFound("Cihaz bulunamadı");
  return device;
}

export type DeviceWithLocation = Prisma.DeviceGetPayload<{ include: { location: true } }>;

/** Throws 404 unless the location exists and is in the user's scope. */
export async function findLocationInScope(user: AuthUser, locationId: string) {
  const location = await prisma.location.findFirst({ where: { id: locationId, ...locationScopeWhere(user) } });
  if (!location) throw notFound("Konum bulunamadı");
  return location;
}

/**
 * Resolves a schedule target (device or location) the user may see; throws 404 otherwise.
 * Returns the target's display name for the Schedule view.
 */
export async function findScheduleTargetInScope(
  user: AuthUser,
  targetType: api.ScheduleTargetType,
  targetId: string,
): Promise<{ id: string; name: string; locationId: string }> {
  if (targetType === "device") {
    const device = await findDeviceInScope(user, targetId);
    return { id: device.id, name: device.name, locationId: device.locationId };
  }
  const location = await findLocationInScope(user, targetId);
  return { id: location.id, name: location.name, locationId: location.id };
}
