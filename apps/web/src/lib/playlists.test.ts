import type { api } from "@managealltv/protocol";
import { describe, expect, it } from "vitest";
import { draftTotalSeconds, isDraftDirty, moveItem, parseDurationInput, toItemsInput } from "./playlists";

function media(id: string, type: "image" | "video", durationMs: number | null = null): api.Media {
  return {
    id,
    name: id,
    type,
    status: "ready",
    error: null,
    size: 1,
    durationMs,
    width: 1920,
    height: 1080,
    playlistCount: 0,
    uploadedByName: null,
    createdAt: "2026-10-15T10:00:00.000Z",
  };
}

const image = media("img", "image");
const video = media("vid", "video", 45_400);

describe("draftTotalSeconds", () => {
  it("adds video lengths and image durations (default 10 s)", () => {
    expect(
      draftTotalSeconds([
        { media: image, durationSec: null },
        { media: image, durationSec: 5 },
        { media: video, durationSec: null },
      ]),
    ).toBe(10 + 5 + 45);
  });

  it("is unknown while a video length is unknown", () => {
    expect(draftTotalSeconds([{ media: media("v2", "video", null), durationSec: null }])).toBeNull();
  });

  it("is zero for an empty list", () => {
    expect(draftTotalSeconds([])).toBe(0);
  });
});

describe("toItemsInput", () => {
  it("never sends a duration for videos", () => {
    expect(
      toItemsInput([
        { key: "a", media: image, durationSec: 8 },
        { key: "b", media: video, durationSec: 99 },
      ]),
    ).toEqual({ items: [{ mediaId: "img", durationSec: 8 }, { mediaId: "vid", durationSec: null }] });
  });
});

describe("isDraftDirty", () => {
  const saved: api.PlaylistItem[] = [
    { mediaId: "img", durationSec: null, media: image },
    { mediaId: "vid", durationSec: null, media: video },
  ];

  it("detects order, duration and length changes", () => {
    const same = [
      { key: "1", media: image, durationSec: null },
      { key: "2", media: video, durationSec: null },
    ];
    expect(isDraftDirty(saved, same)).toBe(false);
    expect(isDraftDirty(saved, [...same].reverse())).toBe(true);
    expect(isDraftDirty(saved, [{ ...same[0]!, durationSec: 12 }, same[1]!])).toBe(true);
    expect(isDraftDirty(saved, same.slice(0, 1))).toBe(true);
  });
});

describe("moveItem", () => {
  it("moves within bounds and ignores the rest", () => {
    expect(moveItem(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
    expect(moveItem(["a", "b", "c"], 2, 1)).toEqual(["a", "c", "b"]);
    expect(moveItem(["a", "b"], 0, -1)).toEqual(["a", "b"]);
    expect(moveItem(["a", "b"], 1, 2)).toEqual(["a", "b"]);
  });
});

describe("parseDurationInput", () => {
  it("treats empty as the default", () => {
    expect(parseDurationInput("  ")).toEqual({ ok: true, value: null });
  });

  it("accepts whole seconds in range", () => {
    expect(parseDurationInput("15")).toEqual({ ok: true, value: 15 });
    expect(parseDurationInput("86400")).toEqual({ ok: true, value: 86_400 });
  });

  it("explains invalid input in Turkish", () => {
    expect(parseDurationInput("0")).toMatchObject({ ok: false, message: "En az 1 saniye olmalı." });
    expect(parseDurationInput("86401")).toMatchObject({ ok: false });
    expect(parseDurationInput("1,5")).toMatchObject({ ok: false, message: "Saniye olarak tam sayı girin." });
  });
});
