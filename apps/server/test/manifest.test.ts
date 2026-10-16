import { api, Manifest, manifestIssues, type ServerToDevice } from "@managealltv/protocol";
import type { Location, Media, Playlist } from "@prisma/client";
import type { WSContext } from "hono/ws";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { prisma } from "../src/db";
import { deviceHub } from "../src/services/device-hub";
import {
  canonicalJson,
  devicesAffectedByPlaylists,
  refreshManifests,
  refreshManifestsForMedia,
  refreshManifestsForPlaylists,
  syncManifest,
} from "../src/services/manifest";
import { body, createDevice, createLocation, deviceRequest, login, resetDatabase } from "./helpers";

const { app } = createApp({ rateLimit: false });

let location: Location;

beforeEach(async () => {
  await resetDatabase();
  location = await createLocation("Lobi", "Europe/Istanbul");
});

const SHA = (char: string) => char.repeat(64);

function createMedia(name: string, data: Partial<Media> = {}): Promise<Media> {
  return prisma.media.create({
    data: {
      name,
      fileName: `${name}.mp4`,
      type: data.type ?? "video",
      status: data.status ?? "ready",
      mimeType: data.mimeType ?? "video/mp4",
      sha256: data.sha256 ?? SHA("a"),
      size: data.size ?? 1000n,
      durationMs: data.durationMs ?? 5000,
      width: 1920,
      height: 1080,
    },
  });
}

async function createPlaylist(name: string, items: { media: Media; durationSec?: number | null }[]): Promise<Playlist> {
  return prisma.playlist.create({
    data: {
      name,
      items: { create: items.map((item, position) => ({ mediaId: item.media.id, position, durationSec: item.durationSec ?? null })) },
    },
  });
}

/** Records what the hub would send to a connected player. */
function fakeSocket(deviceId: string): ServerToDevice[] {
  const sent: ServerToDevice[] = [];
  const ws = {
    readyState: 1,
    send: (data: string) => sent.push(JSON.parse(data) as ServerToDevice),
    close: () => undefined,
  } as unknown as WSContext;
  deviceHub.attach(deviceId, ws);
  return sent;
}

describe("manifest building", () => {
  it("collects default + scheduled playlists, ready media once and ordered rules", async () => {
    const video = await createMedia("video", { sha256: SHA("b"), size: 48_000_000n, durationMs: 31_500 });
    const image = await createMedia("image", { type: "image", mimeType: "image/jpeg", sha256: SHA("c"), size: 800_000n, durationMs: null });
    const processing = await createMedia("processing", { status: "processing", sha256: null, size: null });
    const failed = await createMedia("failed", { status: "failed" });
    const unrelated = await createMedia("unrelated", { sha256: SHA("d") });

    const general = await createPlaylist("Genel", [{ media: video }, { media: image, durationSec: 15 }, { media: processing }, { media: failed }]);
    const lunch = await createPlaylist("Öğle", [{ media: image, durationSec: 20 }]);
    const evening = await createPlaylist("Akşam", [{ media: video }]);
    const elsewhere = await createPlaylist("Başka", [{ media: unrelated }]);

    const { device } = await createDevice(location.id, { name: "Lobi 1", defaultPlaylistId: general.id, volume: 60 });
    const otherLocation = await createLocation("Diğer");

    const base = { days: [], startDate: null, endDate: null };
    const older = await prisma.schedule.create({
      data: { ...base, playlistId: evening.id, targetType: "location", targetId: location.id, startTime: "18:00", endTime: "23:00", priority: 5, createdAt: new Date("2026-01-01T00:00:00Z") },
    });
    const top = await prisma.schedule.create({
      data: { ...base, playlistId: lunch.id, targetType: "device", targetId: device.id, days: ["mon", "fri"], startTime: "11:30", endTime: "14:00", priority: 10 },
    });
    const newer = await prisma.schedule.create({
      data: { ...base, playlistId: lunch.id, targetType: "location", targetId: location.id, startTime: "08:00", endTime: "09:00", priority: 5, createdAt: new Date("2026-02-01T00:00:00Z"), startDate: "2026-10-01", endDate: "2026-12-31" },
    });
    await prisma.schedule.create({
      data: { ...base, playlistId: elsewhere.id, targetType: "location", targetId: otherLocation.id, startTime: "00:00", endTime: "00:00", priority: 100 },
    });

    const synced = await syncManifest(device.id);
    if (!synced) throw new Error("device missing");
    const manifest = Manifest.parse(synced.manifest);
    expect(manifestIssues(manifest)).toEqual([]);

    expect(manifest.timezone).toBe("Europe/Istanbul");
    expect(manifest.defaultPlaylistId).toBe(general.id);
    expect(manifest.settings).toEqual({ volume: 60, defaultImageDurationSec: 10 });
    expect(manifest.schedule.map((rule) => rule.id)).toEqual([top.id, older.id, newer.id]);
    expect(manifest.schedule[0]).toEqual({
      id: top.id,
      playlistId: lunch.id,
      days: ["mon", "fri"],
      startTime: "11:30",
      endTime: "14:00",
      startDate: null,
      endDate: null,
      priority: 10,
    });
    expect(manifest.schedule[2]).toMatchObject({ startDate: "2026-10-01", endDate: "2026-12-31" });

    expect(manifest.playlists.map((p) => p.id)).toEqual([general.id, lunch.id, evening.id]);
    expect(manifest.playlists[0]?.items).toEqual([
      { mediaId: video.id, durationSec: null },
      { mediaId: image.id, durationSec: 15 },
    ]);
    expect(manifest.media).toEqual([
      { id: video.id, type: "video", sha256: SHA("b"), size: 48_000_000, durationMs: 31_500, path: `/api/device/v1/media/${video.id}` },
      { id: image.id, type: "image", sha256: SHA("c"), size: 800_000, durationMs: null, path: `/api/device/v1/media/${image.id}` },
    ]);
  });

  it("bumps the version only when the content changes and pushes manifest_updated", async () => {
    const video = await createMedia("video");
    const playlist = await createPlaylist("Genel", [{ media: video }]);
    const { device, token } = await createDevice(location.id, { defaultPlaylistId: playlist.id });
    const sent = fakeSocket(device.id);

    expect(device.manifestVersion).toBe(1);
    expect(device.manifestHash).toMatch(/^[a-f0-9]{64}$/);

    // Nothing changed: same version, nothing pushed (also on a manifest request).
    await refreshManifests([device.id]);
    expect((await syncManifest(device.id))?.changed).toBe(false);
    const res = await deviceRequest(app, token, "/manifest");
    expect(Manifest.parse(await body(res)).version).toBe(1);
    expect(sent).toEqual([]);

    // A new item in the default playlist.
    const image = await createMedia("image", { type: "image", mimeType: "image/jpeg", sha256: SHA("e"), durationMs: null });
    await prisma.playlistItem.create({ data: { playlistId: playlist.id, mediaId: image.id, position: 1, durationSec: 8 } });
    await refreshManifestsForPlaylists([playlist.id]);
    expect(sent).toEqual([{ type: "manifest_updated", version: 2 }]);

    // Media that stops being ready disappears (and bumps again).
    await prisma.media.update({ where: { id: image.id }, data: { status: "failed" } });
    await refreshManifestsForMedia([image.id]);
    expect(sent).toEqual([
      { type: "manifest_updated", version: 2 },
      { type: "manifest_updated", version: 3 },
    ]);
    const current = await syncManifest(device.id);
    if (!current) throw new Error("device missing");
    expect(current.manifest.version).toBe(3);
    expect(current.manifest.media.map((m) => m.id)).toEqual([video.id]);
    expect(manifestIssues(current.manifest)).toEqual([]);

    // A location rule reaches the device through refreshManifests("all").
    const evening = await createPlaylist("Akşam", [{ media: video }]);
    await prisma.schedule.create({
      data: { playlistId: evening.id, targetType: "location", targetId: location.id, days: [], startTime: "18:00", endTime: "22:00", priority: 1 },
    });
    expect(await devicesAffectedByPlaylists([evening.id])).toEqual([device.id]);
    await refreshManifests("all");
    expect(sent.at(-1)).toEqual({ type: "manifest_updated", version: 4 });
    expect((await prisma.device.findUniqueOrThrow({ where: { id: device.id } })).manifestVersion).toBe(4);
  });

  it("computes expectedPlaylistId from the schedule in the location's time zone", async () => {
    const video = await createMedia("video");
    const general = await createPlaylist("Genel", [{ media: video }]);
    const always = await createPlaylist("Her zaman", [{ media: video }]);
    const { device } = await createDevice(location.id, { defaultPlaylistId: general.id });
    const { client } = await login(app, "admin");

    const read = async () => api.Device.parse(await body(await client.get(`/api/devices/${device.id}`)));
    expect((await read()).expectedPlaylistId).toBe(general.id);

    // startTime == endTime: the whole day, every day.
    await prisma.schedule.create({
      data: { playlistId: always.id, targetType: "device", targetId: device.id, days: [], startTime: "00:00", endTime: "00:00", priority: 1 },
    });
    expect((await read()).expectedPlaylistId).toBe(always.id);
  });

  it("hashes canonical JSON independent of key order", () => {
    expect(canonicalJson({ b: 1, a: [{ d: null, c: "x" }] })).toBe('{"a":[{"c":"x","d":null}],"b":1}');
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });
});
