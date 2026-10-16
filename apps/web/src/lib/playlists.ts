import type { api } from "@managealltv/protocol";

/** Matches manifest settings.defaultImageDurationSec (docs/API.md). */
export const DEFAULT_IMAGE_DURATION_SEC = 10;

export interface DraftItem {
  /** Local key: the same media may appear more than once in a list. */
  key: string;
  media: api.Media;
  /** Images only; null = default duration. Videos always play to the end. */
  durationSec: number | null;
}

/**
 * Total length of a draft in seconds; null when a video's length is still unknown (the server
 * reports totalDurationSec the same way).
 */
export function draftTotalSeconds(items: readonly Pick<DraftItem, "media" | "durationSec">[]): number | null {
  let total = 0;
  for (const item of items) {
    if (item.media.type === "image") {
      total += item.durationSec ?? DEFAULT_IMAGE_DURATION_SEC;
    } else {
      if (item.media.durationMs === null) return null;
      total += item.media.durationMs / 1000;
    }
  }
  return Math.round(total);
}

/** The PUT body; video durations are always sent as null. */
export function toItemsInput(items: readonly DraftItem[]): api.PlaylistItemsInput {
  return {
    items: items.map((item) => ({
      mediaId: item.media.id,
      durationSec: item.media.type === "image" ? item.durationSec : null,
    })),
  };
}

/** True when the draft differs from what the server has. */
export function isDraftDirty(saved: readonly api.PlaylistItem[], draft: readonly DraftItem[]): boolean {
  if (saved.length !== draft.length) return true;
  return saved.some((item, index) => {
    const other = draft[index];
    if (other === undefined) return true;
    const draftDuration = other.media.type === "image" ? other.durationSec : null;
    const savedDuration = item.media.type === "image" ? item.durationSec : null;
    return item.mediaId !== other.media.id || savedDuration !== draftDuration;
  });
}

/** Moves one element; out-of-range moves return the list unchanged. */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  if (from < 0 || from >= list.length || to < 0 || to >= list.length || from === to) return [...list];
  const copy = [...list];
  const [moved] = copy.splice(from, 1);
  if (moved !== undefined) copy.splice(to, 0, moved);
  return copy;
}

/** Parses the image-duration input: empty → null (default), otherwise an integer 1..86400 or an error. */
export function parseDurationInput(raw: string): { ok: true; value: number | null } | { ok: false; message: string } {
  const text = raw.trim();
  if (text === "") return { ok: true, value: null };
  if (!/^\d+$/.test(text)) return { ok: false, message: "Saniye olarak tam sayı girin." };
  const value = Number(text);
  if (value < 1) return { ok: false, message: "En az 1 saniye olmalı." };
  if (value > 86_400) return { ok: false, message: "En fazla 86.400 saniye (1 gün) olabilir." };
  return { ok: true, value };
}
