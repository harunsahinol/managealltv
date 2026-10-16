import type { api } from "@managealltv/protocol";

/**
 * What the current user may do, mirroring the role table in docs/API.md. Used only to hide actions;
 * the server enforces the same rules (and answers 403/404) regardless.
 */
type Subject = Pick<api.Me, "role" | "locationIds" | "name">;

export const isAdmin = (me: Subject): boolean => me.role === "admin";

/** Editors act only on devices in their locations; out-of-scope devices are normally not even listed. */
export function inScope(me: Subject, locationId: string): boolean {
  return me.role === "admin" || me.locationIds.includes(locationId);
}

/** Pair, rename, move or remove TVs; manage locations, users and the audit log. */
export const canAdminister = isAdmin;

/** Default playlist, volume and remote commands for one device. */
export function canControlDevice(me: Subject, device: Pick<api.Device, "locationId">): boolean {
  if (me.role === "admin") return true;
  return me.role === "editor" && inScope(me, device.locationId);
}

export const canEditContent = (me: Subject): boolean => me.role === "admin" || me.role === "editor";

/**
 * Editors may delete only their own uploads. Media carries the uploader's display name, not an id,
 * so this is a best-effort match used to hide the button; the server decides.
 */
export function canDeleteMedia(me: Subject, media: Pick<api.Media, "uploadedByName">): boolean {
  if (me.role === "admin") return true;
  return me.role === "editor" && media.uploadedByName !== null && media.uploadedByName === me.name;
}

export const canManageSchedules = canEditContent;

/** A schedule is editable by an editor when its target is in scope (device or location). */
export function canEditSchedule(
  me: Subject,
  schedule: Pick<api.Schedule, "targetType" | "targetId">,
  deviceLocation: (deviceId: string) => string | undefined,
): boolean {
  if (me.role === "admin") return true;
  if (me.role !== "editor") return false;
  if (schedule.targetType === "location") return inScope(me, schedule.targetId);
  const locationId = deviceLocation(schedule.targetId);
  return locationId !== undefined && inScope(me, locationId);
}

export const ROLE_LABELS: Record<api.Role, string> = {
  admin: "Yönetici",
  editor: "Editör",
  viewer: "İzleyici",
};

export const ROLE_DESCRIPTIONS: Record<api.Role, string> = {
  admin: "Her şeyi yönetir; tüm konumları görür.",
  editor: "Medya ve listeleri düzenler; kendi konumlarındaki TV'lere zamanlama ve komut gönderir.",
  viewer: "Kendi konumlarındaki TV'leri ve zamanlamaları yalnız görüntüler.",
};
