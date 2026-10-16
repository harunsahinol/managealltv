export const DEFAULT_TIMEZONE = "Europe/Istanbul";

/** Shown first because they are the likely choices; the full IANA list follows. */
const PREFERRED = ["Europe/Istanbul", "Europe/Berlin", "Europe/London", "Asia/Dubai", "UTC"];

/** IANA zones the browser knows, preferred ones first. Keeps an unknown current value selectable. */
export function timezoneOptions(current?: string): string[] {
  let all: string[] = [];
  try {
    all = Intl.supportedValuesOf("timeZone");
  } catch {
    all = [];
  }
  const rest = all.filter((zone) => !PREFERRED.includes(zone));
  const list = [...PREFERRED, ...rest];
  if (current !== undefined && current !== "" && !list.includes(current)) list.unshift(current);
  return list;
}

/** "Europe/Istanbul" → "Europe/Istanbul (UTC+03:00)" for the select. */
export function timezoneLabel(zone: string, at: Date = new Date()): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset" }).formatToParts(at);
    const offset = parts.find((part) => part.type === "timeZoneName")?.value ?? "";
    const normalized = offset === "GMT" ? "UTC+00:00" : offset.replace("GMT", "UTC");
    return normalized === "" ? zone : `${zone} (${normalized})`;
  } catch {
    return zone;
  }
}
