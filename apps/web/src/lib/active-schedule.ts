import { type ScheduleRule, resolveActivePlaylist, toLocalMoment } from "@managealltv/protocol";
import type { api } from "@managealltv/protocol";

/**
 * Rules in manifest order (docs/API.md: priority desc, then createdAt asc), so the protocol's
 * evaluator breaks ties exactly like the TV does.
 */
export function toManifestRules(schedules: readonly api.Schedule[]): ScheduleRule[] {
  return [...schedules]
    .sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt))
    .map((s) => ({
      id: s.id,
      playlistId: s.playlistId,
      days: s.days,
      startTime: s.startTime,
      endTime: s.endTime,
      startDate: s.startDate,
      endDate: s.endDate,
      priority: s.priority,
    }));
}

/** The rule that drives a device right now (null = its default playlist), evaluated in the location's zone. */
export function activeRuleId(
  schedules: readonly api.Schedule[],
  defaultPlaylistId: string | null,
  timeZone: string,
  now: Date,
): string | null {
  try {
    return resolveActivePlaylist(toManifestRules(schedules), defaultPlaylistId, toLocalMoment(now, timeZone)).ruleId;
  } catch {
    // Unknown time zone in the browser's ICU data: show no "active" marker rather than a wrong one.
    return null;
  }
}

/** Schedules that reach a device: aimed at the device itself or at its location. */
export function schedulesForDevice(
  schedules: readonly api.Schedule[],
  device: Pick<api.Device, "id" | "locationId">,
): api.Schedule[] {
  return schedules.filter(
    (s) =>
      (s.targetType === "device" && s.targetId === device.id) ||
      (s.targetType === "location" && s.targetId === device.locationId),
  );
}
