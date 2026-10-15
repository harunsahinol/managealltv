/**
 * Manifest building ("Manifest building" in docs/API.md).
 *
 * The manifest content (everything except version and generatedAt) is hashed; when the hash differs
 * from Device.manifestHash the version is incremented and connected devices get manifest_updated.
 * Call refreshManifests()/refreshManifestsFor*() after every mutation that can change a manifest.
 */
import {
  DEVICE_API_BASE,
  type Manifest,
  type ManifestMedia,
  type ManifestPlaylist,
  manifestIssues,
  PROTOCOL_VERSION,
  resolveActivePlaylist,
  type ScheduleRule,
  toLocalMoment,
} from "@managealltv/protocol";
import type { Media, Prisma, Schedule } from "@prisma/client";
import { prisma } from "../db";
import { sha256Hex } from "../lib/crypto";
import { logger } from "../logger";
import { deviceHub } from "./device-hub";

export const DEFAULT_IMAGE_DURATION_SEC = 10;

export type ManifestContent = Omit<Manifest, "version" | "generatedAt">;

// ------------------------------------------------------------------ schedule rules

/** Sort order of rules everywhere (manifest, expectedPlaylistId): priority desc, then oldest first. */
export const SCHEDULE_ORDER: Prisma.ScheduleOrderByWithRelationInput[] = [
  { priority: "desc" },
  { createdAt: "asc" },
  { id: "asc" },
];

export function toScheduleRule(row: Schedule): ScheduleRule {
  return {
    id: row.id,
    playlistId: row.playlistId,
    days: [...row.days],
    startTime: row.startTime,
    endTime: row.endTime,
    startDate: row.startDate,
    endDate: row.endDate,
    priority: row.priority,
  };
}

function compareRules(a: Schedule, b: Schedule): number {
  if (a.priority !== b.priority) return b.priority - a.priority;
  const byDate = a.createdAt.getTime() - b.createdAt.getTime();
  if (byDate !== 0) return byDate;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

interface DeviceTarget {
  id: string;
  locationId: string;
}

/** Rules for several devices with one query, keyed by device id, in manifest order. */
export async function loadScheduleRules(devices: readonly DeviceTarget[]): Promise<Map<string, ScheduleRule[]>> {
  const result = new Map<string, ScheduleRule[]>();
  if (devices.length === 0) return result;
  const rows = await prisma.schedule.findMany({
    where: {
      OR: [
        { targetType: "device", targetId: { in: devices.map((d) => d.id) } },
        { targetType: "location", targetId: { in: [...new Set(devices.map((d) => d.locationId))] } },
      ],
    },
  });
  for (const device of devices) {
    const own = rows
      .filter((r) => (r.targetType === "device" ? r.targetId === device.id : r.targetId === device.locationId))
      .sort(compareRules);
    result.set(device.id, own.map(toScheduleRule));
  }
  return result;
}

/** Playlist that should be playing now on each device, according to the server's clock. */
export async function expectedPlaylistIds(
  devices: readonly (DeviceTarget & { defaultPlaylistId: string | null; timezone: string })[],
  now = new Date(),
): Promise<Map<string, string | null>> {
  const rules = await loadScheduleRules(devices);
  const result = new Map<string, string | null>();
  for (const device of devices) {
    const moment = toLocalMoment(now, device.timezone);
    result.set(device.id, resolveActivePlaylist(rules.get(device.id) ?? [], device.defaultPlaylistId, moment).playlistId);
  }
  return result;
}

// ------------------------------------------------------------------ content

function isDeliverable(media: Media): media is Media & { sha256: string; size: bigint; mimeType: string } {
  return media.status === "ready" && media.sha256 !== null && media.size !== null && media.size > 0n && media.mimeType !== null;
}

function toManifestMedia(media: Media & { sha256: string; size: bigint }): ManifestMedia {
  return {
    id: media.id,
    type: media.type,
    sha256: media.sha256,
    size: Number(media.size),
    durationMs: media.type === "video" && media.durationMs !== null && media.durationMs > 0 ? media.durationMs : null,
    path: `${DEVICE_API_BASE}/media/${media.id}`,
  };
}

/** Builds the manifest content of a device from the database; null if the device does not exist. */
export async function buildManifestContent(deviceId: string): Promise<ManifestContent | null> {
  const device = await prisma.device.findUnique({ where: { id: deviceId }, include: { location: true } });
  if (!device) return null;

  const schedule = (await loadScheduleRules([device])).get(device.id) ?? [];
  const playlistIds: string[] = [];
  for (const id of [device.defaultPlaylistId, ...schedule.map((r) => r.playlistId)]) {
    if (id !== null && !playlistIds.includes(id)) playlistIds.push(id);
  }

  const rows = await prisma.playlist.findMany({
    where: { id: { in: playlistIds } },
    include: { items: { orderBy: { position: "asc" }, include: { media: true } } },
  });
  const byId = new Map(rows.map((row) => [row.id, row]));

  const playlists: ManifestPlaylist[] = [];
  const media = new Map<string, ManifestMedia>();
  for (const id of playlistIds) {
    const row = byId.get(id);
    if (!row) continue;
    const items: ManifestPlaylist["items"] = [];
    for (const item of row.items) {
      if (!isDeliverable(item.media)) continue;
      items.push({ mediaId: item.mediaId, durationSec: item.durationSec });
      if (!media.has(item.mediaId)) media.set(item.mediaId, toManifestMedia(item.media));
    }
    playlists.push({ id: row.id, name: row.name, items });
  }

  return {
    protocolVersion: PROTOCOL_VERSION,
    deviceId: device.id,
    deviceName: device.name,
    timezone: device.location.timezone,
    defaultPlaylistId: device.defaultPlaylistId,
    playlists,
    media: [...media.values()],
    // A rule whose playlist vanished between the two queries would fail manifestIssues; drop it.
    schedule: schedule.filter((rule) => byId.has(rule.playlistId)),
    settings: { volume: device.volume, defaultImageDurationSec: DEFAULT_IMAGE_DURATION_SEC },
  };
}

/** Deterministic JSON (sorted object keys) so that equal content always hashes equally. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function hashManifestContent(content: ManifestContent): string {
  return sha256Hex(canonicalJson(content));
}

// ------------------------------------------------------------------ versioning

// Serialises hash/version updates per device inside this process so that two concurrent refreshes
// cannot both bump the version for the same change.
const locks = new Map<string, Promise<unknown>>();

async function withDeviceLock<T>(deviceId: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(deviceId) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(fn);
  locks.set(deviceId, run);
  try {
    return await run;
  } finally {
    if (locks.get(deviceId) === run) locks.delete(deviceId);
  }
}

export interface SyncedManifest {
  manifest: Manifest;
  /** True when this call bumped the version. */
  changed: boolean;
}

/**
 * Builds the device's manifest, bumps the stored version if the content changed (pushing
 * manifest_updated to a connected device) and returns the manifest. Null if the device is gone.
 */
export async function syncManifest(deviceId: string): Promise<SyncedManifest | null> {
  return withDeviceLock(deviceId, async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const content = await buildManifestContent(deviceId);
      if (!content) return null;
      const state = await prisma.device.findUnique({
        where: { id: deviceId },
        select: { manifestHash: true, manifestVersion: true },
      });
      if (!state) return null;

      const hash = hashManifestContent(content);
      let version = state.manifestVersion;
      let changed = false;
      if (state.manifestHash !== hash) {
        // The first build of a new device keeps version 1; any later change increments it.
        const bump = state.manifestHash !== null;
        const updated = await prisma.device.updateMany({
          where: { id: deviceId, manifestHash: state.manifestHash, manifestVersion: state.manifestVersion },
          data: { manifestHash: hash, ...(bump ? { manifestVersion: { increment: 1 } } : {}) },
        });
        if (updated.count === 0) continue; // Another process got there first; rebuild.
        if (bump) {
          version += 1;
          changed = true;
        }
      }

      const manifest: Manifest = { ...content, version, generatedAt: new Date().toISOString() };
      const issues = manifestIssues(manifest);
      if (issues.length > 0) {
        logger.error("Refusing to serve an invalid manifest", { deviceId, issues });
        throw new Error(`Manifest for device ${deviceId} has problems: ${issues.join("; ")}`);
      }
      if (changed) deviceHub.send(deviceId, { type: "manifest_updated", version });
      return { manifest, changed };
    }
    throw new Error(`Could not update manifest version of device ${deviceId} (concurrent updates)`);
  });
}

/**
 * Re-evaluates the manifests of the given devices (or all) and notifies the ones that changed.
 * Errors are logged per device and never thrown: a mutation that already committed must not fail
 * because a notification could not be prepared.
 */
export async function refreshManifests(deviceIds: readonly string[] | "all"): Promise<void> {
  const ids =
    deviceIds === "all"
      ? (await prisma.device.findMany({ select: { id: true } })).map((d) => d.id)
      : [...new Set(deviceIds)];
  for (const id of ids) {
    try {
      await syncManifest(id);
    } catch (error) {
      logger.error("Manifest refresh failed", { deviceId: id, error });
    }
  }
}

/** Devices whose manifest can contain any of these playlists (default playlist or schedule rule). */
export async function devicesAffectedByPlaylists(playlistIds: readonly string[]): Promise<string[]> {
  if (playlistIds.length === 0) return [];
  const ids = [...playlistIds];
  const [defaults, rules] = await Promise.all([
    prisma.device.findMany({ where: { defaultPlaylistId: { in: ids } }, select: { id: true } }),
    prisma.schedule.findMany({ where: { playlistId: { in: ids } }, select: { targetType: true, targetId: true } }),
  ]);
  const result = new Set(defaults.map((d) => d.id));
  for (const rule of rules) if (rule.targetType === "device") result.add(rule.targetId);
  const locationIds = rules.filter((r) => r.targetType === "location").map((r) => r.targetId);
  if (locationIds.length > 0) {
    const devices = await prisma.device.findMany({ where: { locationId: { in: locationIds } }, select: { id: true } });
    for (const device of devices) result.add(device.id);
  }
  return [...result];
}

export async function refreshManifestsForPlaylists(playlistIds: readonly string[]): Promise<void> {
  await refreshManifests(await devicesAffectedByPlaylists(playlistIds));
}

/** Use after media becomes ready/failed or changes; playlists containing it are re-evaluated. */
export async function refreshManifestsForMedia(mediaIds: readonly string[]): Promise<void> {
  if (mediaIds.length === 0) return;
  const items = await prisma.playlistItem.findMany({
    where: { mediaId: { in: [...mediaIds] } },
    select: { playlistId: true },
    distinct: ["playlistId"],
  });
  await refreshManifestsForPlaylists(items.map((i) => i.playlistId));
}

export async function refreshManifestsForLocations(locationIds: readonly string[]): Promise<void> {
  if (locationIds.length === 0) return;
  const devices = await prisma.device.findMany({ where: { locationId: { in: [...locationIds] } }, select: { id: true } });
  await refreshManifests(devices.map((d) => d.id));
}

/** For a schedule create/update/delete: the target (and, for a location, its devices). */
export async function refreshManifestsForScheduleTarget(targetType: "device" | "location", targetId: string): Promise<void> {
  if (targetType === "device") await refreshManifests([targetId]);
  else await refreshManifestsForLocations([targetId]);
}

/** Media ids present in a device's current manifest (for authorising downloads). */
export async function manifestMediaIds(deviceId: string): Promise<Set<string>> {
  const content = await buildManifestContent(deviceId);
  return new Set(content?.media.map((m) => m.id) ?? []);
}
