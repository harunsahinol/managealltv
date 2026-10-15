import { api } from "@managealltv/protocol";
import type { Location } from "@prisma/client";
import { Hono } from "hono";
import { z } from "zod";
import { prisma } from "../db";
import { badRequest, conflict, notFound } from "../lib/errors";
import { validate } from "../lib/validation";
import { requireRole, requireUser } from "../middleware/session";
import { audit, q } from "../services/audit";
import { refreshManifestsForLocations } from "../services/manifest";
import { locationScopeWhere } from "../services/permissions";
import type { AppEnv } from "../types";

const IdParam = z.object({ id: z.string().min(1).max(64) });

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

function assertTimeZone(timeZone: string | undefined): void {
  if (timeZone !== undefined && !isValidTimeZone(timeZone)) {
    throw badRequest(`Geçersiz saat dilimi: ${timeZone} (ör. Europe/Istanbul).`);
  }
}

export function toLocationView(location: Location & { _count: { devices: number } }): api.Location {
  return {
    id: location.id,
    name: location.name,
    address: location.address,
    timezone: location.timezone,
    deviceCount: location._count.devices,
  };
}

const withCount = { _count: { select: { devices: true } } } as const;

export function locationsRoutes() {
  const router = new Hono<AppEnv>();
  router.use("*", requireUser);

  router.get("/", async (c) => {
    const locations = await prisma.location.findMany({
      where: locationScopeWhere(c.get("user")),
      orderBy: [{ name: "asc" }, { id: "asc" }],
      include: withCount,
    });
    return c.json(locations.map(toLocationView));
  });

  router.post("/", requireRole("admin"), validate("json", api.LocationInput), async (c) => {
    const body = c.req.valid("json");
    assertTimeZone(body.timezone);
    const location = await prisma.location.create({ data: body, include: withCount });
    await audit(c, {
      action: "location.create",
      entityType: "location",
      entityId: location.id,
      summary: `${q(location.name)} konumu oluşturuldu`,
    });
    return c.json(toLocationView(location));
  });

  router.patch("/:id", requireRole("admin"), validate("param", IdParam), validate("json", api.LocationInput.partial()), async (c) => {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    assertTimeZone(body.timezone);
    const before = await prisma.location.findUnique({ where: { id } });
    if (!before) throw notFound("Konum bulunamadı");
    const location = await prisma.location.update({ where: { id }, data: body, include: withCount });
    if (body.timezone !== undefined && body.timezone !== before.timezone) await refreshManifestsForLocations([id]);
    await audit(c, {
      action: "location.update",
      entityType: "location",
      entityId: id,
      summary: `${q(location.name)} konumu güncellendi`,
      details: { before: { name: before.name, address: before.address, timezone: before.timezone }, after: body },
    });
    return c.json(toLocationView(location));
  });

  router.delete("/:id", requireRole("admin"), validate("param", IdParam), async (c) => {
    const { id } = c.req.valid("param");
    const location = await prisma.location.findUnique({ where: { id }, include: withCount });
    if (!location) throw notFound("Konum bulunamadı");
    if (location._count.devices > 0) {
      throw conflict("location_not_empty", "Bu konumda cihazlar var; önce cihazları taşıyın veya silin.");
    }
    await prisma.$transaction(async (tx) => {
      // Schedules have a polymorphic target without a foreign key; remove the location's rules here.
      await tx.schedule.deleteMany({ where: { targetType: "location", targetId: id } });
      await tx.location.delete({ where: { id } });
      await audit(c, { action: "location.delete", entityType: "location", entityId: id, summary: `${q(location.name)} konumu silindi` }, tx);
    });
    return c.body(null, 204);
  });

  return router;
}
