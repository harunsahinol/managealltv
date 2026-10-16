/** Turkish formatting helpers. Pure functions; `now` is injectable so they can be tested. */

const decimal1 = new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 1 });
const integer = new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 0 });

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

/** 1536 → "1,5 KB" (binary multiples, Turkish decimal comma). */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return "—";
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const formatter = unit === 0 ? integer : decimal1;
  return `${formatter.format(value)} ${BYTE_UNITS[unit]}`;
}

/** Clock-style length for a media item: 45 s → "0:45", 3725 s → "1:02:05". */
export function formatClock(totalSeconds: number | null | undefined): string {
  if (totalSeconds === null || totalSeconds === undefined || !Number.isFinite(totalSeconds) || totalSeconds < 0) {
    return "—";
  }
  const seconds = Math.round(totalSeconds);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** Media lengths arrive in milliseconds. */
export function formatClockMs(ms: number | null | undefined): string {
  return ms === null || ms === undefined ? "—" : formatClock(ms / 1000);
}

/** Spoken-style length for totals: 45 → "45 sn", 750 → "12 dk 30 sn", 3900 → "1 sa 5 dk". */
export function formatDuration(totalSeconds: number | null | undefined): string {
  if (totalSeconds === null || totalSeconds === undefined || !Number.isFinite(totalSeconds) || totalSeconds < 0) {
    return "—";
  }
  const seconds = Math.round(totalSeconds);
  if (seconds < 60) return `${seconds} sn`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return m > 0 ? `${h} sa ${m} dk` : `${h} sa`;
  return s > 0 ? `${m} dk ${s} sn` : `${m} dk`;
}

/** Uptime and similar long spans: 93_784 s → "1 gün 2 sa". */
export function formatUptime(totalSeconds: number | null | undefined): string {
  if (totalSeconds === null || totalSeconds === undefined || totalSeconds < 0) return "—";
  const days = Math.floor(totalSeconds / 86_400);
  if (days === 0) return formatDuration(totalSeconds);
  const hours = Math.floor((totalSeconds % 86_400) / 3600);
  return hours > 0 ? `${days} gün ${hours} sa` : `${days} gün`;
}

const MONTHS_SHORT = ["Oca", "Şub", "Mar", "Nis", "May", "Haz", "Tem", "Ağu", "Eyl", "Eki", "Kas", "Ara"] as const;

/** "2026-11-01" → "1 Kas 2026". Done by hand: a LocalDate is a calendar day, not an instant. */
export function formatLocalDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return value;
  const [, year, month, day] = match;
  const name = MONTHS_SHORT[Number(month) - 1];
  return name === undefined ? value : `${Number(day)} ${name} ${year}`;
}

const dateTimeFormat = new Intl.DateTimeFormat("tr-TR", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

const dateFormat = new Intl.DateTimeFormat("tr-TR", { day: "numeric", month: "short", year: "numeric" });

/** ISO instant → "15 Eki 2026 14:05" in the browser's time zone. */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "—" : dateTimeFormat.format(date);
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "—" : dateFormat.format(date);
}

/** "az önce", "5 dk önce", "3 sa önce", "2 gün önce", then a plain date after a week. */
export function formatRelative(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return "hiç";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  const seconds = Math.round((now.getTime() - date.getTime()) / 1000);
  if (seconds < 45) return "az önce";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} dk önce`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} sa önce`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} gün önce`;
  return formatDate(iso);
}

export function formatPercent(fraction: number): string {
  const clamped = Math.min(1, Math.max(0, fraction));
  return `%${integer.format(Math.floor(clamped * 100))}`;
}

export function formatNumber(value: number): string {
  return integer.format(value);
}
