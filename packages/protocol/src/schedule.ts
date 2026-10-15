import type { Weekday } from "./common";
import type { ScheduleRule } from "./manifest";

/** A wall-clock moment in the schedule's time zone. */
export interface LocalMoment {
  /** YYYY-MM-DD */
  date: string;
  weekday: Weekday;
  /** Minutes since local midnight, 0-1439. */
  minutes: number;
}

const WEEKDAYS: readonly Weekday[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const SHORT_TO_WEEKDAY: Record<string, Weekday> = {
  Sun: "sun",
  Mon: "mon",
  Tue: "tue",
  Wed: "wed",
  Thu: "thu",
  Fri: "fri",
  Sat: "sat",
};

/** Converts an instant to wall-clock time in an IANA time zone. */
export function toLocalMoment(instant: Date, timeZone: string): LocalMoment {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  }).formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes): string => {
    const value = parts.find((p) => p.type === type)?.value;
    if (value === undefined) throw new Error(`Intl.DateTimeFormat returned no ${type}`);
    return value;
  };
  const weekday = SHORT_TO_WEEKDAY[part("weekday")];
  if (weekday === undefined) throw new Error(`Unexpected weekday ${part("weekday")}`);
  return {
    date: `${part("year")}-${part("month")}-${part("day")}`,
    weekday,
    minutes: Number(part("hour")) * 60 + Number(part("minute")),
  };
}

function parseTime(value: string): number {
  const [h, m] = value.split(":");
  return Number(h) * 60 + Number(m);
}

function previousDay(date: string): { date: string; weekday: Weekday } {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  const weekday = WEEKDAYS[d.getUTCDay()];
  if (weekday === undefined) throw new Error("unreachable");
  return { date: d.toISOString().slice(0, 10), weekday };
}

function dayMatches(rule: ScheduleRule, date: string, weekday: Weekday): boolean {
  if (rule.days.length > 0 && !rule.days.includes(weekday)) return false;
  if (rule.startDate !== null && date < rule.startDate) return false;
  if (rule.endDate !== null && date > rule.endDate) return false;
  return true;
}

export function isRuleActive(rule: ScheduleRule, now: LocalMoment): boolean {
  const start = parseTime(rule.startTime);
  const end = parseTime(rule.endTime);
  if (start === end) return dayMatches(rule, now.date, now.weekday);
  if (start < end) {
    return now.minutes >= start && now.minutes < end && dayMatches(rule, now.date, now.weekday);
  }
  // Overnight window: it belongs to the day it starts on.
  if (now.minutes >= start) return dayMatches(rule, now.date, now.weekday);
  if (now.minutes < end) {
    const prev = previousDay(now.date);
    return dayMatches(rule, prev.date, prev.weekday);
  }
  return false;
}

export interface ActivePlaylist {
  playlistId: string | null;
  /** The rule that selected the playlist; null when the default playlist applies. */
  ruleId: string | null;
}

/** Highest priority active rule wins; on a tie the first one in the list wins. */
export function resolveActivePlaylist(
  rules: readonly ScheduleRule[],
  defaultPlaylistId: string | null,
  now: LocalMoment,
): ActivePlaylist {
  let best: ScheduleRule | null = null;
  for (const rule of rules) {
    if (isRuleActive(rule, now) && (best === null || rule.priority > best.priority)) best = rule;
  }
  return best === null
    ? { playlistId: defaultPlaylistId, ruleId: null }
    : { playlistId: best.playlistId, ruleId: best.id };
}
