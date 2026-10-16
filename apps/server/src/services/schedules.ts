import { type api, Weekday } from "@managealltv/protocol";
import type { Prisma, Schedule } from "@prisma/client";
import { prisma } from "../db";
import { badRequest } from "../lib/errors";

export const scheduleInclude = { playlist: { select: { name: true } } } as const;
export type ScheduleRow = Prisma.ScheduleGetPayload<{ include: typeof scheduleInclude }>;

const WEEKDAY_ORDER = Weekday.options;

const WEEKDAY_LABELS: Record<Weekday, string> = {
  mon: "Pzt",
  tue: "Sal",
  wed: "Çar",
  thu: "Per",
  fri: "Cum",
  sat: "Cmt",
  sun: "Paz",
};

/** Removes duplicates and sorts Monday → Sunday, so equal rules are stored (and hashed) equally. */
export function normalizeDays(days: readonly Weekday[]): Weekday[] {
  return WEEKDAY_ORDER.filter((day) => days.includes(day));
}

function isCalendarDate(value: string): boolean {
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** Checks what the schema cannot: real calendar days (no 31 February) and start ≤ end. */
export function assertScheduleDates(startDate: string | null, endDate: string | null): void {
  for (const value of [startDate, endDate]) {
    if (value !== null && !isCalendarDate(value)) throw badRequest(`Geçersiz tarih: ${value}`);
  }
  if (startDate !== null && endDate !== null && startDate > endDate) {
    throw badRequest("Başlangıç tarihi bitiş tarihinden sonra olamaz.");
  }
}

/** Short Turkish description of a rule's time window for audit summaries, e.g. "Pzt, Cum 18:00–23:00". */
export function describeWindow(rule: Pick<Schedule, "days" | "startTime" | "endTime" | "startDate" | "endDate">): string {
  const days = rule.days.length === 0 ? "her gün" : rule.days.map((day) => WEEKDAY_LABELS[day]).join(", ");
  const time = rule.startTime === rule.endTime ? "tüm gün" : `${rule.startTime}–${rule.endTime}`;
  const range =
    rule.startDate === null && rule.endDate === null ? "" : `, ${rule.startDate ?? "…"} / ${rule.endDate ?? "…"}`;
  return `${days} ${time}${range}`;
}

/** Display names of schedule targets (devices and locations) in two queries. */
export async function scheduleTargetNames(rows: readonly Pick<Schedule, "targetType" | "targetId">[]): Promise<Map<string, string>> {
  const deviceIds = rows.filter((r) => r.targetType === "device").map((r) => r.targetId);
  const locationIds = rows.filter((r) => r.targetType === "location").map((r) => r.targetId);
  const [devices, locations] = await Promise.all([
    deviceIds.length === 0 ? [] : prisma.device.findMany({ where: { id: { in: deviceIds } }, select: { id: true, name: true } }),
    locationIds.length === 0 ? [] : prisma.location.findMany({ where: { id: { in: locationIds } }, select: { id: true, name: true } }),
  ]);
  const names = new Map<string, string>();
  for (const device of devices) names.set(`device:${device.id}`, device.name);
  for (const location of locations) names.set(`location:${location.id}`, location.name);
  return names;
}

export async function toScheduleViews(rows: readonly ScheduleRow[]): Promise<api.Schedule[]> {
  const names = await scheduleTargetNames(rows);
  return rows.map((row) => ({
    id: row.id,
    playlistId: row.playlistId,
    playlistName: row.playlist.name,
    targetType: row.targetType,
    targetId: row.targetId,
    // Targets have no foreign key, but device/location deletes remove their rules in the same transaction.
    targetName: names.get(`${row.targetType}:${row.targetId}`) ?? "",
    days: [...row.days],
    startTime: row.startTime,
    endTime: row.endTime,
    startDate: row.startDate,
    endDate: row.endDate,
    priority: row.priority,
    createdAt: row.createdAt.toISOString(),
  }));
}

export async function toScheduleView(row: ScheduleRow): Promise<api.Schedule> {
  const [view] = await toScheduleViews([row]);
  if (!view) throw new Error("unreachable");
  return view;
}
