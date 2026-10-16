import { describe, expect, it } from "vitest";
import {
  scheduleFormProblems,
  sortDays,
  summarizeDateRange,
  summarizeDays,
  summarizeSchedule,
  summarizeTime,
  windowKind,
} from "./schedule";

describe("summarizeDays", () => {
  it("names the common sets", () => {
    expect(summarizeDays([])).toBe("Her gün");
    expect(summarizeDays(["mon", "tue", "wed", "thu", "fri", "sat", "sun"])).toBe("Her gün");
    expect(summarizeDays(["fri", "mon", "tue", "wed", "thu"])).toBe("Hafta içi");
    expect(summarizeDays(["sun", "sat"])).toBe("Hafta sonu");
  });

  it("uses the full name for a single day", () => {
    expect(summarizeDays(["wed"])).toBe("Çarşamba");
  });

  it("collapses runs of three or more days and lists the rest", () => {
    expect(summarizeDays(["mon", "tue", "wed", "thu"])).toBe("Pzt–Per");
    expect(summarizeDays(["mon", "wed", "fri"])).toBe("Pzt, Çar, Cum");
    expect(summarizeDays(["mon", "tue", "thu", "fri", "sat"])).toBe("Pzt, Sal, Per–Cmt");
    expect(summarizeDays(["sat", "sun", "mon"])).toBe("Pzt, Cmt, Paz");
  });

  it("ignores duplicates and order", () => {
    expect(sortDays(["sun", "mon", "mon"])).toEqual(["mon", "sun"]);
  });
});

describe("time windows", () => {
  it("classifies windows like the protocol evaluator", () => {
    expect(windowKind("11:30", "14:00")).toBe("same_day");
    expect(windowKind("22:00", "06:00")).toBe("overnight");
    expect(windowKind("00:00", "00:00")).toBe("whole_day");
  });

  it("describes them", () => {
    expect(summarizeTime("11:30", "14:00")).toBe("11:30–14:00");
    expect(summarizeTime("22:00", "06:00")).toBe("22:00–06:00 (ertesi gün)");
    expect(summarizeTime("08:00", "08:00")).toBe("tüm gün");
  });
});

describe("summarizeDateRange", () => {
  it("handles every combination", () => {
    expect(summarizeDateRange(null, null)).toBe("");
    expect(summarizeDateRange("2026-11-01", "2026-11-30")).toBe("1 Kas 2026 – 30 Kas 2026");
    expect(summarizeDateRange("2026-11-01", "2026-11-01")).toBe("yalnız 1 Kas 2026");
    expect(summarizeDateRange("2026-11-01", null)).toBe("1 Kas 2026 itibarıyla");
    expect(summarizeDateRange(null, "2026-11-30")).toBe("30 Kas 2026 tarihine kadar");
  });
});

describe("summarizeSchedule", () => {
  const base = { startDate: null, endDate: null };

  it("reads like the brief's example", () => {
    expect(summarizeSchedule({ ...base, days: ["mon", "tue", "wed", "thu", "fri"], startTime: "11:30", endTime: "14:00" })).toBe(
      "Hafta içi 11:30–14:00",
    );
  });

  it("covers whole days, overnight windows and date ranges", () => {
    expect(summarizeSchedule({ ...base, days: [], startTime: "00:00", endTime: "00:00" })).toBe("Her gün, tüm gün");
    expect(summarizeSchedule({ ...base, days: ["fri"], startTime: "22:00", endTime: "02:00" })).toBe(
      "Cuma 22:00–02:00 (ertesi gün)",
    );
    expect(
      summarizeSchedule({ days: ["sat", "sun"], startTime: "10:00", endTime: "18:00", startDate: "2026-11-01", endDate: "2026-11-30" }),
    ).toBe("Hafta sonu 10:00–18:00, 1 Kas 2026 – 30 Kas 2026");
  });
});

describe("scheduleFormProblems", () => {
  it("rejects an end date before the start date", () => {
    expect(scheduleFormProblems({ startDate: "2026-11-02", endDate: "2026-11-01" })).toEqual({
      endDate: "Bitiş tarihi başlangıçtan önce olamaz.",
    });
    expect(scheduleFormProblems({ startDate: "2026-11-01", endDate: "2026-11-01" })).toEqual({});
    expect(scheduleFormProblems({ startDate: null, endDate: "2026-11-01" })).toEqual({});
  });
});
