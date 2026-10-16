import type { Weekday } from "@managealltv/protocol";
import { formatLocalDate } from "./format";

/** Monday-first, the way schedules are read in Turkey. */
export const WEEKDAYS: readonly Weekday[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

export const WEEKDAY_SHORT: Record<Weekday, string> = {
  mon: "Pzt",
  tue: "Sal",
  wed: "Çar",
  thu: "Per",
  fri: "Cum",
  sat: "Cmt",
  sun: "Paz",
};

export const WEEKDAY_LONG: Record<Weekday, string> = {
  mon: "Pazartesi",
  tue: "Salı",
  wed: "Çarşamba",
  thu: "Perşembe",
  fri: "Cuma",
  sat: "Cumartesi",
  sun: "Pazar",
};

export const WEEKDAYS_WORK: readonly Weekday[] = ["mon", "tue", "wed", "thu", "fri"];
export const WEEKDAYS_WEEKEND: readonly Weekday[] = ["sat", "sun"];

/** Normalises a day list to unique, Monday-first order. */
export function sortDays(days: readonly Weekday[]): Weekday[] {
  const set = new Set(days);
  return WEEKDAYS.filter((day) => set.has(day));
}

function sameDays(a: readonly Weekday[], b: readonly Weekday[]): boolean {
  const sa = sortDays(a);
  const sb = sortDays(b);
  return sa.length === sb.length && sa.every((day, i) => day === sb[i]);
}

/**
 * "Her gün", "Hafta içi", "Hafta sonu", "Pzt–Per" for runs of three or more days, else "Pzt, Çar, Cum".
 * An empty list means every day (protocol semantics).
 */
export function summarizeDays(days: readonly Weekday[]): string {
  const sorted = sortDays(days);
  if (sorted.length === 0 || sorted.length === 7) return "Her gün";
  if (sameDays(sorted, WEEKDAYS_WORK)) return "Hafta içi";
  if (sameDays(sorted, WEEKDAYS_WEEKEND)) return "Hafta sonu";
  if (sorted.length === 1) {
    const only = sorted[0];
    return only === undefined ? "" : WEEKDAY_LONG[only];
  }

  // Group consecutive days (Monday-first; Sunday→Monday does not wrap, matching how people read a week).
  const indexes = sorted.map((day) => WEEKDAYS.indexOf(day));
  const runs: number[][] = [];
  for (const index of indexes) {
    const run = runs[runs.length - 1];
    const last = run?.[run.length - 1];
    if (run !== undefined && last !== undefined && index === last + 1) run.push(index);
    else runs.push([index]);
  }
  const label = (index: number): string => {
    const day = WEEKDAYS[index];
    return day === undefined ? "" : WEEKDAY_SHORT[day];
  };
  return runs
    .map((run) => {
      const first = run[0];
      const last = run[run.length - 1];
      if (first === undefined || last === undefined) return "";
      if (run.length >= 3) return `${label(first)}–${label(last)}`;
      return run.map(label).join(", ");
    })
    .join(", ");
}

function minutesOf(time: string): number {
  const [h, m] = time.split(":");
  return Number(h) * 60 + Number(m);
}

export type WindowKind = "whole_day" | "same_day" | "overnight";

export function windowKind(startTime: string, endTime: string): WindowKind {
  const start = minutesOf(startTime);
  const end = minutesOf(endTime);
  if (start === end) return "whole_day";
  return start < end ? "same_day" : "overnight";
}

/** "11:30–14:00", "22:00–06:00 (ertesi gün)" or "tüm gün". */
export function summarizeTime(startTime: string, endTime: string): string {
  switch (windowKind(startTime, endTime)) {
    case "whole_day":
      return "tüm gün";
    case "same_day":
      return `${startTime}–${endTime}`;
    case "overnight":
      return `${startTime}–${endTime} (ertesi gün)`;
  }
}

/** Optional date range; empty string when the rule has no dates. */
export function summarizeDateRange(startDate: string | null, endDate: string | null): string {
  if (startDate !== null && endDate !== null) {
    return startDate === endDate
      ? `yalnız ${formatLocalDate(startDate)}`
      : `${formatLocalDate(startDate)} – ${formatLocalDate(endDate)}`;
  }
  if (startDate !== null) return `${formatLocalDate(startDate)} itibarıyla`;
  if (endDate !== null) return `${formatLocalDate(endDate)} tarihine kadar`;
  return "";
}

export interface ScheduleLike {
  days: readonly Weekday[];
  startTime: string;
  endTime: string;
  startDate: string | null;
  endDate: string | null;
}

/** One line for lists: "Hafta içi 11:30–14:00", "Her gün, tüm gün", "Cmt, Paz 10:00–18:00, 1 Kas 2026 – 30 Kas 2026". */
export function summarizeSchedule(rule: ScheduleLike): string {
  const days = summarizeDays(rule.days);
  const kind = windowKind(rule.startTime, rule.endTime);
  const time = summarizeTime(rule.startTime, rule.endTime);
  const base = kind === "whole_day" ? `${days}, ${time}` : `${days} ${time}`;
  const range = summarizeDateRange(rule.startDate, rule.endDate);
  return range === "" ? base : `${base}, ${range}`;
}

/** Validation for the schedule form; returns Turkish problems keyed by field. */
export function scheduleFormProblems(input: {
  startDate: string | null;
  endDate: string | null;
}): Partial<Record<"endDate", string>> {
  if (input.startDate !== null && input.endDate !== null && input.endDate < input.startDate) {
    return { endDate: "Bitiş tarihi başlangıçtan önce olamaz." };
  }
  return {};
}
