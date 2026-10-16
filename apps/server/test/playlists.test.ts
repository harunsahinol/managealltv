import { api, Manifest, manifestIssues, type ServerToDevice } from "@managealltv/protocol";
import type { Location } from "@prisma/client";
import { readFile, stat } from "node:fs/promises";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { prisma } from "../src/db";
import { mediaFilePath, thumbnailPath } from "../src/lib/storage";
import { processMedia } from "../src/services/media-processing";
import { body, createDevice, createLocation, deviceRequest, DeviceSocket, deviceStatus, errorBody, login, resetDatabase, startServer } from "./helpers";
import { createReadyMedia, makePng, sha256, tusUpload } from "./media-helpers";

const { app } = createApp({ rateLimit: false });

let location: Location;

beforeEach(async () => {
  await resetDatabase();
  location = await createLocation("Lobi");
});

const exists = (file: string) => stat(file).then(
  () => true,
  () => false,
);

const detail = async (res: Response) => {
  expect(res.status).toBe(200);
  return api.PlaylistDetail.parse(await body(res));
};

async function manifestOf(token: string): Promise<Manifest> {
  const res = await deviceRequest(app, token, "/manifest");
  expect(res.status).toBe(200);
  const manifest = Manifest.parse(await body(res));
  expect(res.headers.get("etag")).toBe(`"${manifest.version}"`);
  expect(manifestIssues(manifest)).toEqual([]);
  return manifest;
}

describe("playlists", () => {
  it("creates, lists, renames and reads playlists; viewers are read-only", async () => {
    const { client: editor } = await login(app, "editor");
    const { client: viewer } = await login(app, "viewer");

    const created = await detail(await editor.post("/api/playlists", { json: { name: "Öğle Arası" } }));
    expect(created).toMatchObject({ name: "Öğle Arası", itemCount: 0, totalDurationSec: 0, items: [] });
    await detail(await editor.post("/api/playlists", { json: { name: "Akşam" } }));

    // Sorted by name for everybody, viewers included.
    const list = api.Playlist.array().parse(await body(await viewer.get("/api/playlists")));
    expect(list.map((p) => p.name)).toEqual(["Akşam", "Öğle Arası"]);
    expect((await detail(await viewer.get(`/api/playlists/${created.id}`))).id).toBe(created.id);

    const renamed = await detail(await editor.patch(`/api/playlists/${created.id}`, { json: { name: "Öğle" } }));
    expect(renamed.name).toBe("Öğle");

    expect((await viewer.post("/api/playlists", { json: { name: "Gizli" } })).status).toBe(403);
    expect((await viewer.patch(`/api/playlists/${created.id}`, { json: { name: "X" } })).status).toBe(403);
    expect((await viewer.put(`/api/playlists/${created.id}/items`, { json: { items: [] } })).status).toBe(403);
    expect((await viewer.delete(`/api/playlists/${created.id}`)).status).toBe(403);

    expect((await editor.post("/api/playlists", { json: { name: "" } })).status).toBe(400);
    const missing = await viewer.get("/api/playlists/yok");
    expect(missing.status).toBe(404);
    expect((await errorBody(missing)).error.code).toBe("not_found");
    expect((await editor.patch("/api/playlists/yok", { json: { name: "X" } })).status).toBe(404);
  });

  it("replaces the ordered items and computes durations", async () => {
    const { client } = await login(app, "editor");
    const playlist = await detail(await client.post("/api/playlists", { json: { name: "Genel" } }));
    const video = (await createReadyMedia("Tanıtım", { type: "video", durationMs: 12_400 })).media;
    const image = (await createReadyMedia("Afiş", { type: "image" })).media;
    const poster = (await createReadyMedia("Poster", { type: "image" })).media;

    const put = await detail(
      await client.put(`/api/playlists/${playlist.id}/items`, {
        json: {
          items: [
            { mediaId: image.id, durationSec: 7 },
            { mediaId: video.id, durationSec: null },
            { mediaId: poster.id, durationSec: null },
            { mediaId: image.id, durationSec: 3 },
          ],
        },
      }),
    );
    expect(put.items.map((item) => [item.mediaId, item.durationSec])).toEqual([
      [image.id, 7],
      [video.id, null],
      [poster.id, null],
      [image.id, 3],
    ]);
    // 7 + 12.4 + 10 (default image duration) + 3 = 32.4 → 32.
    expect(put).toMatchObject({ itemCount: 4, totalDurationSec: 32 });
    // The same media twice still counts as one playlist.
    expect(put.items[0]?.media).toMatchObject({ id: image.id, name: "Afiş", type: "image", status: "ready", playlistCount: 1 });
    expect(Date.parse(put.updatedAt)).toBeGreaterThan(Date.parse(playlist.updatedAt));

    const summary = api.Playlist.array().parse(await body(await client.get("/api/playlists")));
    expect(summary).toEqual([{ id: playlist.id, name: "Genel", itemCount: 4, totalDurationSec: 32, updatedAt: put.updatedAt }]);
    const mediaList = api.Media.array().parse(await body(await client.get("/api/media")));
    expect(mediaList.find((m) => m.id === video.id)?.playlistCount).toBe(1);

    // A video still being processed has no known length yet.
    const pending = await prisma.media.create({ data: { name: "Yeni", fileName: "yeni.mp4", type: "video" } });
    const withPending = await detail(
      await client.put(`/api/playlists/${playlist.id}/items`, {
        json: { items: [{ mediaId: video.id, durationSec: null }, { mediaId: pending.id, durationSec: null }] },
      }),
    );
    expect(withPending).toMatchObject({ itemCount: 2, totalDurationSec: null });
    expect(withPending.items[1]?.media).toMatchObject({ status: "processing", size: null });

    // Unknown media → 400 and nothing changes.
    const unknown = await client.put(`/api/playlists/${playlist.id}/items`, {
      json: { items: [{ mediaId: "yok", durationSec: null }] },
    });
    expect(unknown.status).toBe(400);
    expect((await errorBody(unknown)).error.message).toContain("yok");
    expect((await detail(await client.get(`/api/playlists/${playlist.id}`))).itemCount).toBe(2);

    const invalid = await client.put(`/api/playlists/${playlist.id}/items`, {
      json: { items: [{ mediaId: video.id, durationSec: 0 }] },
    });
    expect(invalid.status).toBe(400);
    expect((await errorBody(invalid)).error.code).toBe("validation_error");

    const emptied = await detail(await client.put(`/api/playlists/${playlist.id}/items`, { json: { items: [] } }));
    expect(emptied).toMatchObject({ itemCount: 0, totalDurationSec: 0, items: [] });
    expect(await prisma.playlistItem.count()).toBe(0);
  });

  it("updates the manifests of devices using the playlist and pushes manifest_updated", async () => {
    const { client } = await login(app, "editor");
    const playlist = await detail(await client.post("/api/playlists", { json: { name: "Genel" } }));
    const { media: video, bytes } = await createReadyMedia("Tanıtım", { type: "video", durationMs: 8000 });
    const other = (await createReadyMedia("Başka", { type: "image" })).media;
    const { device, token } = await createDevice(location.id, { defaultPlaylistId: playlist.id });
    const bystander = await createDevice(location.id);

    const server = await startServer(createApp({ rateLimit: false }));
    const socket = await DeviceSocket.connect(server.wsUrl, token);
    try {
      expect((await manifestOf(token)).version).toBe(1);
      socket.send({ type: "status", status: deviceStatus(1) });

      await detail(await client.put(`/api/playlists/${playlist.id}/items`, { json: { items: [{ mediaId: video.id, durationSec: null }] } }));
      expect(await socket.next("manifest_updated")).toEqual({ type: "manifest_updated", version: 2 });

      const manifest = await manifestOf(token);
      expect(manifest).toMatchObject({ version: 2, defaultPlaylistId: playlist.id });
      expect(manifest.playlists).toEqual([{ id: playlist.id, name: "Genel", items: [{ mediaId: video.id, durationSec: null }] }]);
      expect(manifest.media).toEqual([
        { id: video.id, type: "video", sha256: sha256(bytes), size: bytes.length, durationMs: 8000, path: `/api/device/v1/media/${video.id}` },
      ]);

      // The device downloads exactly what the manifest describes; anything else is 404.
      const download = await deviceRequest(app, token, manifest.media[0]?.path.replace("/api/device/v1", "") ?? "");
      expect(download.status).toBe(200);
      expect(download.headers.get("content-type")).toBe("video/mp4");
      expect(sha256(Buffer.from(await download.arrayBuffer()))).toBe(manifest.media[0]?.sha256);
      expect((await deviceRequest(app, token, `/media/${other.id}`)).status).toBe(404);
      expect((await deviceRequest(app, bystander.token, `/media/${video.id}`)).status).toBe(404);

      // A rename changes the manifest (playlist names are part of it); renaming to the same name does not.
      await detail(await client.patch(`/api/playlists/${playlist.id}`, { json: { name: "Genel Akış" } }));
      expect(await socket.next("manifest_updated")).toEqual({ type: "manifest_updated", version: 3 });
      await detail(await client.patch(`/api/playlists/${playlist.id}`, { json: { name: "Genel Akış" } }));
      expect((await manifestOf(token)).version).toBe(3);

      // Removing the item takes the media out of the manifest and its download right with it.
      await detail(await client.put(`/api/playlists/${playlist.id}/items`, { json: { items: [] } }));
      expect(await socket.next("manifest_updated")).toEqual({ type: "manifest_updated", version: 4 });
      expect((await manifestOf(token)).media).toEqual([]);
      expect((await deviceRequest(app, token, `/media/${video.id}`)).status).toBe(404);

      // A device that does not use the playlist never changed.
      expect((await prisma.device.findUniqueOrThrow({ where: { id: bystander.device.id } })).manifestVersion).toBe(1);
      expect((await prisma.device.findUniqueOrThrow({ where: { id: device.id } })).manifestVersion).toBe(4);
    } finally {
      socket.close();
      await server.close();
    }
  });

  it("delivers an uploaded image end to end: tus → processing → playlist → device download", async () => {
    const { client } = await login(app, "editor");
    const playlist = await detail(await client.post("/api/playlists", { json: { name: "Duyurular" } }));
    const { token } = await createDevice(location.id, { defaultPlaylistId: playlist.id });

    const { mediaId } = await tusUpload(client, await makePng(1280, 720), { filename: "duyuru.png", filetype: "image/png" });
    // Media still processing may be listed, but devices only get it once it is ready.
    await detail(await client.put(`/api/playlists/${playlist.id}/items`, { json: { items: [{ mediaId, durationSec: 15 }] } }));
    const before = await manifestOf(token);
    expect(before.playlists[0]?.items).toEqual([]);
    expect(before.media).toEqual([]);

    expect(await processMedia(mediaId)).toBe("ready");
    const after = await manifestOf(token);
    expect(after.version).toBe(before.version + 1);
    expect(after.playlists[0]?.items).toEqual([{ mediaId, durationSec: 15 }]);
    const entry = after.media[0];
    if (!entry) throw new Error("media missing from manifest");
    expect(entry).toMatchObject({ id: mediaId, type: "image", durationMs: null });

    const download = await deviceRequest(app, token, `/media/${mediaId}`);
    expect(download.status).toBe(200);
    expect(download.headers.get("content-type")).toBe("image/jpeg");
    const bytes = Buffer.from(await download.arrayBuffer());
    expect(bytes.length).toBe(entry.size);
    expect(sha256(bytes)).toBe(entry.sha256);
    expect(sha256(await readFile(mediaFilePath(mediaId, "image/jpeg")))).toBe(entry.sha256);
  });

  it("refuses to delete a playlist that a device or a schedule uses", async () => {
    const { client } = await login(app, "editor");
    const playlist = await detail(await client.post("/api/playlists", { json: { name: "Genel" } }));
    const spare = await detail(await client.post("/api/playlists", { json: { name: "Yedek" } }));
    const { device } = await createDevice(location.id, { defaultPlaylistId: playlist.id });

    const asDefault = await client.delete(`/api/playlists/${playlist.id}`);
    expect(asDefault.status).toBe(409);
    expect((await errorBody(asDefault)).error).toMatchObject({ code: "playlist_in_use" });
    expect((await errorBody(asDefault)).error.message).toContain("1 cihazın varsayılan listesi");

    await prisma.device.update({ where: { id: device.id }, data: { defaultPlaylistId: spare.id } });
    const schedule = await prisma.schedule.create({
      data: { playlistId: playlist.id, targetType: "location", targetId: location.id, days: [], startTime: "08:00", endTime: "12:00", priority: 1 },
    });
    const inSchedule = await client.delete(`/api/playlists/${playlist.id}`);
    expect(inSchedule.status).toBe(409);
    expect((await errorBody(inSchedule)).error).toMatchObject({ code: "playlist_in_use" });
    expect((await errorBody(inSchedule)).error.message).toContain("1 zamanlamada");

    await prisma.schedule.delete({ where: { id: schedule.id } });
    expect((await client.delete(`/api/playlists/${playlist.id}`)).status).toBe(204);
    expect((await client.get(`/api/playlists/${playlist.id}`)).status).toBe(404);
    expect((await client.delete(`/api/playlists/${playlist.id}`)).status).toBe(404);
  });
});

describe("media management", () => {
  it("renames media; viewers cannot change anything", async () => {
    const { client: editor } = await login(app, "editor");
    const { client: viewer } = await login(app, "viewer");
    const { media } = await createReadyMedia("Eski Ad", { type: "image" });

    const renamed = await editor.patch(`/api/media/${media.id}`, { json: { name: "Yeni Ad" } });
    expect(renamed.status).toBe(200);
    expect(api.Media.parse(await body(renamed)).name).toBe("Yeni Ad");
    expect((await editor.patch(`/api/media/${media.id}`, { json: { name: "" } })).status).toBe(400);
    expect((await editor.patch("/api/media/yok", { json: { name: "X" } })).status).toBe(404);

    expect((await viewer.patch(`/api/media/${media.id}`, { json: { name: "X" } })).status).toBe(403);
    expect((await viewer.delete(`/api/media/${media.id}`)).status).toBe(403);
    expect(api.Media.parse(await body(await viewer.get(`/api/media/${media.id}`))).name).toBe("Yeni Ad");
    expect((await viewer.get("/api/media/yok")).status).toBe(404);
  });

  it("lists media newest first", async () => {
    const { client } = await login(app, "viewer");
    const first = (await createReadyMedia("Birinci")).media;
    const second = (await createReadyMedia("İkinci")).media;
    await prisma.media.update({ where: { id: first.id }, data: { createdAt: new Date("2026-01-01T00:00:00Z") } });
    const list = api.Media.array().parse(await body(await client.get("/api/media")));
    expect(list.map((m) => m.id)).toEqual([second.id, first.id]);
  });

  it("refuses to delete media in a playlist; editors delete only their own uploads", async () => {
    const { client: owner, user } = await login(app, "editor");
    const { client: otherEditor } = await login(app, "editor");
    const { client: admin } = await login(app, "admin");
    const { media } = await createReadyMedia("Tanıtım", { uploadedById: user.id });
    const foreign = (await createReadyMedia("Başkasının")).media;
    const playlist = await detail(await owner.post("/api/playlists", { json: { name: "Genel" } }));
    await detail(await owner.put(`/api/playlists/${playlist.id}/items`, { json: { items: [{ mediaId: media.id, durationSec: null }] } }));

    const inUse = await owner.delete(`/api/media/${media.id}`);
    expect(inUse.status).toBe(409);
    const error = (await errorBody(inUse)).error;
    expect(error.code).toBe("media_in_use");
    expect(error.message).toContain('"Genel"');
    expect((await admin.delete(`/api/media/${media.id}`)).status).toBe(409);

    await detail(await owner.put(`/api/playlists/${playlist.id}/items`, { json: { items: [] } }));
    // Another editor may not delete it; an admin could.
    const notOwner = await otherEditor.delete(`/api/media/${media.id}`);
    expect(notOwner.status).toBe(403);
    expect((await errorBody(notOwner)).error.code).toBe("forbidden");
    expect((await owner.delete(`/api/media/${foreign.id}`)).status).toBe(403);

    expect(await exists(mediaFilePath(media.id, "video/mp4"))).toBe(true);
    expect((await owner.delete(`/api/media/${media.id}`)).status).toBe(204);
    expect(await prisma.media.findUnique({ where: { id: media.id } })).toBeNull();
    expect(await exists(mediaFilePath(media.id, "video/mp4"))).toBe(false);
    expect(await exists(thumbnailPath(media.id))).toBe(false);
    expect((await owner.get(`/api/media/${media.id}`)).status).toBe(404);
    expect((await owner.delete(`/api/media/${media.id}`)).status).toBe(404);

    expect((await admin.delete(`/api/media/${foreign.id}`)).status).toBe(204);
  });
});

describe("audit trail of content changes", () => {
  it("records media, playlist and item changes", async () => {
    const { client, user } = await login(app, "editor");
    const { media } = await createReadyMedia("Tanıtım", { uploadedById: user.id });
    const playlist = await detail(await client.post("/api/playlists", { json: { name: "Genel" } }));
    await client.patch(`/api/playlists/${playlist.id}`, { json: { name: "Genel 2" } });
    await client.put(`/api/playlists/${playlist.id}/items`, { json: { items: [{ mediaId: media.id, durationSec: null }] } });
    await client.put(`/api/playlists/${playlist.id}/items`, { json: { items: [] } });
    await client.patch(`/api/media/${media.id}`, { json: { name: "Tanıtım 2" } });
    await client.delete(`/api/media/${media.id}`);
    await client.delete(`/api/playlists/${playlist.id}`);

    const rows = await prisma.auditLog.findMany({ orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
    expect(rows.map((row) => row.action)).toEqual([
      "user.invite",
      "invite.accept",
      "playlist.create",
      "playlist.update",
      "playlist.items",
      "playlist.items",
      "media.update",
      "media.delete",
      "playlist.delete",
    ]);
    const mine = rows.filter((row) => row.action.startsWith("playlist.") || row.action.startsWith("media."));
    expect(mine.every((row) => row.userId === user.id)).toBe(true);
    expect(mine.map((row) => row.summary)).toEqual([
      '"Genel" oynatma listesi oluşturuldu',
      '"Genel" oynatma listesinin adı "Genel 2" olarak değiştirildi',
      '"Genel 2" oynatma listesinin içeriği güncellendi (0 → 1 öğe)',
      '"Genel 2" oynatma listesinin içeriği güncellendi (1 → 0 öğe)',
      '"Tanıtım" medyasının adı "Tanıtım 2" olarak değiştirildi',
      '"Tanıtım 2" medyası silindi',
      '"Genel 2" oynatma listesi silindi',
    ]);
  });
});
