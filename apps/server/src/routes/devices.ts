import { api, Command } from "@managealltv/protocol";
import { Hono } from "hono";
import { z } from "zod";
import { prisma } from "../db";
import { badRequest, forbidden } from "../lib/errors";
import { rateLimit } from "../lib/rate-limit";
import { validate } from "../lib/validation";
import { requireRole, requireUser } from "../middleware/session";
import { audit, q } from "../services/audit";
import { createCommand, deleteDevice, listCommands, toDeviceView, toDeviceViews } from "../services/devices";
import { refreshManifests } from "../services/manifest";
import { claimPairing } from "../services/pairing";
import { deviceScopeWhere, findDeviceInScope, isAdmin } from "../services/permissions";
import type { AppEnv } from "../types";

const IdParam = z.object({ id: z.string().min(1).max(64) });

const COMMAND_LABELS: Record<Command["type"], string> = {
  reload: "yeniden yükleme",
  restart_app: "uygulamayı yeniden başlatma",
  identify: "tanımlama",
  set_volume: "ses ayarı",
  reboot: "yeniden başlatma",
};

/** Fields an editor may change on an in-scope device (docs/API.md). */
const EDITOR_FIELDS = new Set<keyof api.DeviceUpdate>(["defaultPlaylistId", "volume"]);

export interface DevicesRoutesOptions {
  rateLimit: boolean;
}

export function devicesRoutes(options: DevicesRoutesOptions) {
  const router = new Hono<AppEnv>();
  router.use("*", requireUser);

  router.get("/", async (c) => {
    const devices = await prisma.device.findMany({
      where: deviceScopeWhere(c.get("user")),
      orderBy: [{ name: "asc" }, { id: "asc" }],
      include: { location: true },
    });
    return c.json(await toDeviceViews(devices));
  });

  router.post(
    "/claim",
    requireRole("admin"),
    rateLimit({ limit: 20, windowMs: 60_000, key: (c) => c.get("user").id, enabled: options.rateLimit }),
    validate("json", api.DeviceClaim),
    async (c) => {
      const body = c.req.valid("json");
      const device = await claimPairing(body);
      await audit(c, {
        action: "device.claim",
        entityType: "device",
        entityId: device.id,
        summary: `${q(device.name)} cihazı ${q(device.location.name)} konumuna eşleştirildi (${device.manufacturer} ${device.model})`,
      });
      return c.json(await toDeviceView(device));
    },
  );

  router.get("/:id", validate("param", IdParam), async (c) => {
    const device = await findDeviceInScope(c.get("user"), c.req.valid("param").id);
    return c.json(await toDeviceView(device));
  });

  router.patch("/:id", requireRole("admin", "editor"), validate("param", IdParam), validate("json", api.DeviceUpdate), async (c) => {
    const user = c.get("user");
    const body = c.req.valid("json");
    const device = await findDeviceInScope(user, c.req.valid("param").id);

    if (!isAdmin(user)) {
      const disallowed = (Object.keys(body) as (keyof api.DeviceUpdate)[]).filter(
        (key) => body[key] !== undefined && !EDITOR_FIELDS.has(key),
      );
      if (disallowed.length > 0) throw forbidden("Editörler yalnız varsayılan listeyi ve ses düzeyini değiştirebilir.");
    }
    if (body.locationId !== undefined && !(await prisma.location.findUnique({ where: { id: body.locationId }, select: { id: true } }))) {
      throw badRequest("Seçilen konum bulunamadı.");
    }
    if (
      body.defaultPlaylistId !== undefined &&
      body.defaultPlaylistId !== null &&
      !(await prisma.playlist.findUnique({ where: { id: body.defaultPlaylistId }, select: { id: true } }))
    ) {
      throw badRequest("Seçilen oynatma listesi bulunamadı.");
    }

    await prisma.device.update({
      where: { id: device.id },
      data: {
        ...(body.name === undefined ? {} : { name: body.name }),
        ...(body.locationId === undefined ? {} : { locationId: body.locationId }),
        ...(body.defaultPlaylistId === undefined ? {} : { defaultPlaylistId: body.defaultPlaylistId }),
        ...(body.volume === undefined ? {} : { volume: body.volume }),
      },
    });
    await refreshManifests([device.id]);
    const updated = await prisma.device.findUniqueOrThrow({ where: { id: device.id }, include: { location: true } });

    const changes: string[] = [];
    if (body.name !== undefined && body.name !== device.name) changes.push(`ad ${q(body.name)}`);
    if (body.locationId !== undefined && body.locationId !== device.locationId) changes.push(`konum ${q(updated.location.name)}`);
    if (body.defaultPlaylistId !== undefined && body.defaultPlaylistId !== device.defaultPlaylistId) changes.push("varsayılan liste");
    if (body.volume !== undefined && body.volume !== device.volume) changes.push(`ses ${body.volume ?? "TV ayarı"}`);
    await audit(c, {
      action: "device.update",
      entityType: "device",
      entityId: device.id,
      summary: `${q(updated.name)} cihazı güncellendi${changes.length > 0 ? `: ${changes.join(", ")}` : ""}`,
      details: {
        before: { name: device.name, locationId: device.locationId, defaultPlaylistId: device.defaultPlaylistId, volume: device.volume },
        after: { name: updated.name, locationId: updated.locationId, defaultPlaylistId: updated.defaultPlaylistId, volume: updated.volume },
      },
    });
    return c.json(await toDeviceView(updated));
  });

  router.delete("/:id", requireRole("admin"), validate("param", IdParam), async (c) => {
    const device = await findDeviceInScope(c.get("user"), c.req.valid("param").id);
    await deleteDevice(device.id);
    await audit(c, {
      action: "device.delete",
      entityType: "device",
      entityId: device.id,
      summary: `${q(device.name)} cihazı silindi; anahtarı iptal edildi`,
    });
    return c.body(null, 204);
  });

  router.get("/:id/commands", validate("param", IdParam), async (c) => {
    const device = await findDeviceInScope(c.get("user"), c.req.valid("param").id);
    return c.json(await listCommands(device.id));
  });

  router.post("/:id/commands", requireRole("admin", "editor"), validate("param", IdParam), validate("json", Command), async (c) => {
    const user = c.get("user");
    const device = await findDeviceInScope(user, c.req.valid("param").id);
    const command = c.req.valid("json");
    const view = await createCommand(device.id, command, user.id);
    await audit(c, {
      action: "device.command",
      entityType: "device",
      entityId: device.id,
      summary: `${q(device.name)} cihazına ${COMMAND_LABELS[command.type]} komutu gönderildi`,
      details: { commandId: view.id, command },
    });
    return c.json(view);
  });

  return router;
}
