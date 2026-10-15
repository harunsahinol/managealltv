import { z } from "zod";
import { Id, IsoDateTime, LocalDate, MediaType, Sha256Hex, TimeOfDay, Weekday } from "./common";

export const ManifestMedia = z.object({
  id: Id,
  type: MediaType,
  sha256: Sha256Hex,
  size: z.number().int().positive(),
  /** Video length; null for images. */
  durationMs: z.number().int().positive().nullable(),
  /** Server-relative download path (supports HTTP Range), e.g. /api/device/v1/media/<id> */
  path: z.string().startsWith("/"),
});
export type ManifestMedia = z.infer<typeof ManifestMedia>;

export const ManifestPlaylistItem = z.object({
  mediaId: Id,
  /** How long an image stays on screen. Null for videos (play to the end) or to use the default. */
  durationSec: z.number().int().min(1).max(86_400).nullable(),
});
export type ManifestPlaylistItem = z.infer<typeof ManifestPlaylistItem>;

export const ManifestPlaylist = z.object({
  id: Id,
  name: z.string(),
  items: z.array(ManifestPlaylistItem),
});
export type ManifestPlaylist = z.infer<typeof ManifestPlaylist>;

/**
 * A time window in which a playlist plays. Semantics (implemented identically on server and device,
 * see schedule.ts and fixtures/schedule-cases.json):
 * - startTime < endTime: active on matching days from startTime (inclusive) to endTime (exclusive).
 * - startTime > endTime: overnight window; it belongs to the day it starts on.
 * - startTime == endTime: the whole day.
 * - days empty = every day. startDate/endDate are inclusive and checked against the day the window starts.
 * - Highest priority wins; on a tie the rule that comes first in the list wins.
 */
export const ScheduleRule = z.object({
  id: Id,
  playlistId: Id,
  days: z.array(Weekday),
  startTime: TimeOfDay,
  endTime: TimeOfDay,
  startDate: LocalDate.nullable(),
  endDate: LocalDate.nullable(),
  priority: z.number().int(),
});
export type ScheduleRule = z.infer<typeof ScheduleRule>;

/** GET {DEVICE_API_BASE}/manifest — the full desired state of one device. */
export const Manifest = z.object({
  protocolVersion: z.literal(1),
  /** Increases every time the content of the manifest changes. Also sent as the ETag. */
  version: z.number().int().min(1),
  generatedAt: IsoDateTime,
  deviceId: Id,
  deviceName: z.string(),
  /** IANA time zone used to evaluate the schedule, e.g. Europe/Istanbul. */
  timezone: z.string().min(1),
  /** Plays when no schedule rule is active; null means a blank screen. */
  defaultPlaylistId: Id.nullable(),
  playlists: z.array(ManifestPlaylist),
  /** Every media item referenced by any playlist above, exactly once. */
  media: z.array(ManifestMedia),
  schedule: z.array(ScheduleRule),
  settings: z.object({
    /** Volume the device should apply (0-100); null leaves the TV's own volume alone. */
    volume: z.number().int().min(0).max(100).nullable(),
    /** Image duration when a playlist item has none. */
    defaultImageDurationSec: z.number().int().min(1),
  }),
});
export type Manifest = z.infer<typeof Manifest>;

/**
 * Referential checks the schema cannot express. Returns human-readable problems; empty means valid.
 * The server must never send a manifest with problems.
 */
export function manifestIssues(manifest: Manifest): string[] {
  const issues: string[] = [];
  const mediaIds = new Set<string>();
  for (const media of manifest.media) {
    if (mediaIds.has(media.id)) issues.push(`duplicate media ${media.id}`);
    mediaIds.add(media.id);
  }
  const playlistIds = new Set<string>();
  const referenced = new Set<string>();
  for (const playlist of manifest.playlists) {
    if (playlistIds.has(playlist.id)) issues.push(`duplicate playlist ${playlist.id}`);
    playlistIds.add(playlist.id);
    for (const item of playlist.items) {
      referenced.add(item.mediaId);
      if (!mediaIds.has(item.mediaId)) issues.push(`playlist ${playlist.id} references unknown media ${item.mediaId}`);
    }
  }
  for (const id of mediaIds) {
    if (!referenced.has(id)) issues.push(`media ${id} is not used by any playlist`);
  }
  if (manifest.defaultPlaylistId !== null && !playlistIds.has(manifest.defaultPlaylistId)) {
    issues.push(`unknown default playlist ${manifest.defaultPlaylistId}`);
  }
  for (const rule of manifest.schedule) {
    if (!playlistIds.has(rule.playlistId)) issues.push(`rule ${rule.id} references unknown playlist ${rule.playlistId}`);
  }
  return issues;
}
