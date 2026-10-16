import { api } from "@managealltv/protocol";
import { Hono } from "hono";
import { z } from "zod";
import { prisma } from "../db";
import { conflict, forbidden, notFound } from "../lib/errors";
import { sendFile } from "../lib/file-sender";
import { extensionForMime, mediaFilePath, removeMediaFiles, removeUploadFiles, thumbnailPath } from "../lib/storage";
import { validate } from "../lib/validation";
import { requireRole, requireUser } from "../middleware/session";
import { audit, q } from "../services/audit";
import { findMediaOrThrow, MEDIA_ORDER, mediaInclude, toMediaViews } from "../services/media";
import { isAdmin } from "../services/permissions";
import type { AppEnv } from "../types";

const IdParam = z.object({ id: z.string().min(1).max(64) });

/** A processed file never changes for a given media id, so browsers may keep thumbnails for a day. */
const THUMBNAIL_CACHE_CONTROL = "private, max-age=86400";

async function mediaView(id: string): Promise<api.Media> {
  const [view] = await toMediaViews([await findMediaOrThrow(id)]);
  if (!view) throw new Error("unreachable");
  return view;
}

/** Loads media that finished processing (file, size and hash present); 404 otherwise. */
async function findReadyMedia(id: string, message: string) {
  const media = await prisma.media.findUnique({ where: { id } });
  if (!media || media.status !== "ready" || media.mimeType === null || media.sha256 === null) throw notFound(message);
  return { ...media, mimeType: media.mimeType, sha256: media.sha256 };
}

export function mediaRoutes() {
  const router = new Hono<AppEnv>();
  router.use("*", requireUser);

  router.get("/", async (c) => {
    const rows = await prisma.media.findMany({ orderBy: MEDIA_ORDER, include: mediaInclude });
    return c.json(await toMediaViews(rows));
  });

  router.get("/:id", validate("param", IdParam), async (c) => c.json(await mediaView(c.req.valid("param").id)));

  router.patch("/:id", requireRole("admin", "editor"), validate("param", IdParam), validate("json", api.MediaUpdate), async (c) => {
    const { id } = c.req.valid("param");
    const { name } = c.req.valid("json");
    const before = await findMediaOrThrow(id);
    // The name is not part of any manifest, so devices need no refresh.
    await prisma.$transaction(async (tx) => {
      await tx.media.update({ where: { id }, data: { name } });
      await audit(
        c,
        {
          action: "media.update",
          entityType: "media",
          entityId: id,
          summary: `${q(before.name)} medyasının adı ${q(name)} olarak değiştirildi`,
          details: { before: { name: before.name }, after: { name } },
        },
        tx,
      );
    });
    return c.json(await mediaView(id));
  });

  router.delete("/:id", requireRole("admin", "editor"), validate("param", IdParam), async (c) => {
    const user = c.get("user");
    const { id } = c.req.valid("param");
    const media = await findMediaOrThrow(id);
    if (!isAdmin(user) && media.uploadedById !== user.id) {
      throw forbidden("Editörler yalnız kendi yükledikleri medyayı silebilir.");
    }
    const usedIn = await prisma.playlistItem.findMany({
      where: { mediaId: id },
      distinct: ["playlistId"],
      select: { playlist: { select: { name: true } } },
      orderBy: { playlistId: "asc" },
    });
    if (usedIn.length > 0) {
      const names = usedIn.map((item) => q(item.playlist.name)).join(", ");
      throw conflict("media_in_use", `Bu medya ${usedIn.length} oynatma listesinde kullanılıyor (${names}). Önce listelerden çıkarın.`);
    }

    // Not in any playlist, hence in no manifest: no device refresh needed. A concurrent "add to
    // playlist" loses against the Restrict foreign key and answers 409.
    await prisma.$transaction(async (tx) => {
      await tx.media.delete({ where: { id } });
      await audit(c, { action: "media.delete", entityType: "media", entityId: id, summary: `${q(media.name)} medyası silindi` }, tx);
    });
    // A running processing job notices the missing row and removes whatever it produced.
    await removeMediaFiles(id, media.mimeType);
    if (media.uploadId !== null) await removeUploadFiles(media.uploadId);
    return c.body(null, 204);
  });

  router.get("/:id/thumbnail", validate("param", IdParam), async (c) => {
    const media = await findReadyMedia(c.req.valid("param").id, "Küçük resim henüz hazır değil");
    return sendFile(c, {
      path: thumbnailPath(media.id),
      contentType: "image/jpeg",
      etag: `${media.sha256}-thumb`,
      cacheControl: THUMBNAIL_CACHE_CONTROL,
    });
  });

  router.get("/:id/file", validate("param", IdParam), async (c) => {
    const media = await findReadyMedia(c.req.valid("param").id, "Dosya henüz hazır değil");
    return sendFile(c, {
      path: mediaFilePath(media.id, media.mimeType),
      contentType: media.mimeType,
      etag: media.sha256,
      downloadName: `${media.name}.${extensionForMime(media.mimeType)}`,
    });
  });

  return router;
}
