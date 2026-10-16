import type { api } from "@managealltv/protocol";
import type { Media, Prisma } from "@prisma/client";
import { prisma } from "../db";
import { notFound } from "../lib/errors";
import { DEFAULT_IMAGE_DURATION_SEC } from "./manifest";
import { mediaInclude, playlistCounts, toMediaView } from "./media";

export const playlistDetailInclude = {
  items: { orderBy: { position: "asc" }, include: { media: { include: mediaInclude } } },
} as const;
export type PlaylistWithItems = Prisma.PlaylistGetPayload<{ include: typeof playlistDetailInclude }>;

const playlistSummaryInclude = {
  items: { select: { durationSec: true, media: { select: { type: true, status: true, durationMs: true } } } },
} as const;

/** Playlist list order: by name, id as a stable tie-breaker. */
export const PLAYLIST_ORDER: Prisma.PlaylistOrderByWithRelationInput[] = [{ name: "asc" }, { id: "asc" }];

type DurationItem = { durationSec: number | null; media: Pick<Media, "type" | "status" | "durationMs"> };

/**
 * What one pass of the playlist takes on a TV: video lengths plus image durations (the default for
 * images without one; the player ignores durationSec for videos). Failed media never plays and does
 * not count; a video whose length is not known yet (still processing) makes the total unknown.
 */
export function totalDurationSec(items: readonly DurationItem[]): number | null {
  let totalMs = 0;
  for (const item of items) {
    if (item.media.status === "failed") continue;
    if (item.media.type === "image") {
      totalMs += (item.durationSec ?? DEFAULT_IMAGE_DURATION_SEC) * 1000;
    } else if (item.media.durationMs === null) {
      return null;
    } else {
      totalMs += item.media.durationMs;
    }
  }
  return Math.round(totalMs / 1000);
}

function toSummary(row: { id: string; name: string; updatedAt: Date }, items: readonly DurationItem[]): api.Playlist {
  return {
    id: row.id,
    name: row.name,
    itemCount: items.length,
    totalDurationSec: totalDurationSec(items),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listPlaylists(): Promise<api.Playlist[]> {
  const rows = await prisma.playlist.findMany({ orderBy: PLAYLIST_ORDER, include: playlistSummaryInclude });
  return rows.map((row) => toSummary(row, row.items));
}

export async function toPlaylistDetail(row: PlaylistWithItems): Promise<api.PlaylistDetail> {
  const counts = await playlistCounts(row.items.map((item) => item.mediaId));
  return {
    ...toSummary(row, row.items),
    items: row.items.map((item) => ({
      mediaId: item.mediaId,
      durationSec: item.durationSec,
      media: toMediaView(item.media, counts.get(item.mediaId) ?? 0),
    })),
  };
}

export async function findPlaylistOrThrow(id: string): Promise<PlaylistWithItems> {
  const playlist = await prisma.playlist.findUnique({ where: { id }, include: playlistDetailInclude });
  if (!playlist) throw notFound("Oynatma listesi bulunamadı");
  return playlist;
}

export async function playlistDetail(id: string): Promise<api.PlaylistDetail> {
  return toPlaylistDetail(await findPlaylistOrThrow(id));
}
