import { describe, expect, it } from "vitest";
import {
  formatBytes,
  formatClock,
  formatClockMs,
  formatDuration,
  formatLocalDate,
  formatPercent,
  formatRelative,
  formatUptime,
} from "./format";

describe("formatBytes", () => {
  it("uses binary units and a Turkish decimal comma", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1,5 KB");
    expect(formatBytes(48_211_933)).toBe("46 MB");
    expect(formatBytes(3.25 * 1024 ** 3)).toBe("3,3 GB");
    expect(formatBytes(5 * 1024 ** 4)).toBe("5 TB");
  });

  it("shows a dash for missing or invalid values", () => {
    expect(formatBytes(null)).toBe("—");
    expect(formatBytes(undefined)).toBe("—");
    expect(formatBytes(-1)).toBe("—");
    expect(formatBytes(Number.NaN)).toBe("—");
  });
});

describe("formatClock", () => {
  it("formats media lengths like a player", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(45)).toBe("0:45");
    expect(formatClock(185)).toBe("3:05");
    expect(formatClock(3725)).toBe("1:02:05");
    expect(formatClock(59.6)).toBe("1:00");
  });

  it("accepts milliseconds through formatClockMs", () => {
    expect(formatClockMs(45_200)).toBe("0:45");
    expect(formatClockMs(null)).toBe("—");
  });
});

describe("formatDuration", () => {
  it("spells totals out", () => {
    expect(formatDuration(0)).toBe("0 sn");
    expect(formatDuration(45)).toBe("45 sn");
    expect(formatDuration(60)).toBe("1 dk");
    expect(formatDuration(750)).toBe("12 dk 30 sn");
    expect(formatDuration(3600)).toBe("1 sa");
    expect(formatDuration(3900)).toBe("1 sa 5 dk");
    expect(formatDuration(null)).toBe("—");
  });

  it("formats uptime in days and hours", () => {
    expect(formatUptime(93_784)).toBe("1 gün 2 sa");
    expect(formatUptime(172_800)).toBe("2 gün");
    expect(formatUptime(125)).toBe("2 dk 5 sn");
  });
});

describe("formatLocalDate", () => {
  it("formats a calendar day without time-zone shifts", () => {
    expect(formatLocalDate("2026-11-01")).toBe("1 Kas 2026");
    expect(formatLocalDate("2026-02-28")).toBe("28 Şub 2026");
    expect(formatLocalDate("2026-08-15")).toBe("15 Ağu 2026");
  });

  it("returns unexpected input unchanged", () => {
    expect(formatLocalDate("yarın")).toBe("yarın");
  });
});

describe("formatRelative", () => {
  const now = new Date("2026-10-15T12:00:00Z");
  const ago = (seconds: number) => new Date(now.getTime() - seconds * 1000).toISOString();

  it("describes recent instants", () => {
    expect(formatRelative(ago(10), now)).toBe("az önce");
    expect(formatRelative(ago(5 * 60), now)).toBe("5 dk önce");
    expect(formatRelative(ago(3 * 3600), now)).toBe("3 sa önce");
    expect(formatRelative(ago(2 * 86_400), now)).toBe("2 gün önce");
  });

  it("says never for a missing value", () => {
    expect(formatRelative(null, now)).toBe("hiç");
  });
});

describe("formatPercent", () => {
  it("puts the sign first as in Turkish and clamps", () => {
    expect(formatPercent(0.634)).toBe("%63");
    expect(formatPercent(1.2)).toBe("%100");
    expect(formatPercent(-1)).toBe("%0");
  });
});
