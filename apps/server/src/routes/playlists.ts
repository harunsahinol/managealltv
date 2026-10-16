import { api } from "@managealltv/protocol";
import { Hono } from "hono";
import { z } from "zod";
import { prisma } from "../db";
import { badRequest, conflict } from "../lib/errors";
import { validate } from "../lib/validation";
import { requireRole, requireUser } from "../middleware/session";
import { audit, q } from "../services/audit";
import { refreshManifestsForPlaylists } from "../services/manifest";
import { findPlaylistOrThrow, listPlaylists, playlistDetail } from "../services/playlists";
import type { AppEnv } from "../types";

const IdParam = z.object({ id: z.string().min(1).max(64) });

export function playlistsRoutes() {
  const router = new Hono<AppEnv>();
  router.use("*", requireUser);

  router.get("/", async (c) => c.json(await listPlaylists()));

  router.post("/", requireRole("admin", "editor"), validate("json", api.PlaylistInput), async (c) => {
    const { name } = c.req.valid("json");
    const playlist = await prisma.$transaction(async (tx) => {
      const row = await tx.playlist.create({ data: { name, createdById: c.get("user").id } });
      await audit(c, { action: "playlist.create", entityType: "playlist", entityId: row.id, summary: `${q(name)} oynatma listesi oluşturuldu` }, tx);
      return row;
    });
    return c.json(await playlistDetail(playlist.id));
  });

  router.get("/:id", validate("param", IdParam), async (c) => c.json(await playlistDetail(c.req.valid("param").id)));

  router.patch("/:id", requireRole("admin", "editor"), validate("param", IdParam), validate("json", api.PlaylistInput), async (c) => {
    const { id } = c.req.valid("param");
    const { name } = c.req.valid("json");
    const before = await findPlaylistOrThrow(id);
    await prisma.$transaction(async (tx) => {
      await tx.playlist.update({ where: { id }, data: { name } });
      await audit(
        c,
        {
          action: "playlist.update",
          entityType: "playlist",
          entityId: id,
          summary: `${q(before.name)} oynatma listesinin adı ${q(name)} olarak değiştirildi`,
          details: { before: { name: before.name }, after: { name } },
        },
        tx,
      );
    });
    // Playlist names are part of the manifest.
    if (name !== before.name) await refreshManifestsForPlaylists([id]);
    return c.json(await playlistDetail(id));
  });

  router.put("/:id/items", requireRole("admin", "editor"), validate("param", IdParam), validate("json", api.PlaylistItemsInput), async (c) => {
    const { id } = c.req.valid("param");
    const { items } = c.req.valid("json");
    const before = await findPlaylistOrThrow(id);

    const mediaIds = [...new Set(items.map((item) => item.mediaId))];
    const known = await prisma.media.findMany({ where: { id: { in: mediaIds } }, select: { id: true } });
    const knownIds = new Set(known.map((m) => m.id));
    const unknown = mediaIds.filter((mediaId) => !knownIds.has(mediaId));
    if (unknown.length > 0) throw badRequest(`Bilinmeyen medya: ${unknown.slice(0, 5).join(", ")}`);

    await prisma.$transaction(async (tx) => {
      await tx.playlistItem.deleteMany({ where: { playlistId: id } });
      if (items.length > 0) {
        await tx.playlistItem.createMany({
          data: items.map((item, position) => ({ playlistId: id, mediaId: item.mediaId, position, durationSec: item.durationSec })),
        });
      }
      // Item changes do not touch the playlist row itself, but api.Playlist.updatedAt must move.
      await tx.playlist.update({ where: { id }, data: { updatedAt: new Date() } });
      await audit(
        c,
        {
          action: "playlist.items",
          entityType: "playlist",
          entityId: id,
          summary: `${q(before.name)} oynatma listesinin içeriği güncellendi (${before.items.length} → ${items.length} öğe)`,
          details: {
            before: before.items.map((item) => ({ mediaId: item.mediaId, durationSec: item.durationSec })),
            after: items,
          },
        },
        tx,
      );
    });
    await refreshManifestsForPlaylists([id]);
    return c.json(await playlistDetail(id));
  });

  router.delete("/:id", requireRole("admin", "editor"), validate("param", IdParam), async (c) => {
    const { id } = c.req.valid("param");
    const playlist = await findPlaylistOrThrow(id);
    const [devices, schedules] = await Promise.all([
      prisma.device.count({ where: { defaultPlaylistId: id } }),
      prisma.schedule.count({ where: { playlistId: id } }),
    ]);
    if (devices > 0 || schedules > 0) {
      const uses = [devices > 0 ? `${devices} cihazın varsayılan listesi` : null, schedules > 0 ? `${schedules} zamanlamada` : null]
        .filter((part) => part !== null)
        .join(" ve ");
      throw conflict("playlist_in_use", `Bu liste kullanımda (${uses}). Önce cihazları ve zamanlamaları başka bir listeye geçirin.`);
    }
    // Unused, so it is in no manifest. A concurrent assignment loses against the Restrict foreign keys (409).
    await prisma.$transaction(async (tx) => {
      await tx.playlist.delete({ where: { id } });
      await audit(c, { action: "playlist.delete", entityType: "playlist", entityId: id, summary: `${q(playlist.name)} oynatma listesi silindi` }, tx);
    });
    return c.body(null, 204);
  });

  return router;
}
