import { api } from "@managealltv/protocol";
import type { Prisma } from "@prisma/client";
import { Hono } from "hono";
import { z } from "zod";
import { prisma } from "../db";
import { badRequest, notFound } from "../lib/errors";
import { validate } from "../lib/validation";
import { requireRole, requireUser } from "../middleware/session";
import { audit, q } from "../services/audit";
import { refreshManifestsForScheduleTarget, SCHEDULE_ORDER } from "../services/manifest";
import { findScheduleTargetInScope, scheduleScopeWhere } from "../services/permissions";
import {
  assertScheduleDates,
  describeWindow,
  normalizeDays,
  scheduleInclude,
  type ScheduleRow,
  toScheduleView,
  toScheduleViews,
} from "../services/schedules";
import type { AppEnv, AuthUser } from "../types";

const IdParam = z.object({ id: z.string().min(1).max(64) });

const TARGET_LABELS: Record<api.ScheduleTargetType, string> = { device: "cihazı", location: "konumu" };

async function assertPlaylistExists(playlistId: string): Promise<{ id: string; name: string }> {
  const playlist = await prisma.playlist.findUnique({ where: { id: playlistId }, select: { id: true, name: true } });
  if (!playlist) throw badRequest("Seçilen oynatma listesi bulunamadı.");
  return playlist;
}

/** Loads a schedule the user may see (target in scope); out of scope looks like missing (404). */
async function findScheduleInScope(user: AuthUser, id: string): Promise<ScheduleRow> {
  const schedule = await prisma.schedule.findFirst({ where: { AND: [{ id }, await scheduleScopeWhere(user)] }, include: scheduleInclude });
  if (!schedule) throw notFound("Zamanlama bulunamadı");
  return schedule;
}

function ruleSnapshot(rule: api.ScheduleInput): Prisma.InputJsonObject {
  return {
    playlistId: rule.playlistId,
    targetType: rule.targetType,
    targetId: rule.targetId,
    days: [...rule.days],
    startTime: rule.startTime,
    endTime: rule.endTime,
    startDate: rule.startDate,
    endDate: rule.endDate,
    priority: rule.priority,
  };
}

export function schedulesRoutes() {
  const router = new Hono<AppEnv>();
  router.use("*", requireUser);

  router.get("/", async (c) => {
    const rows = await prisma.schedule.findMany({
      where: await scheduleScopeWhere(c.get("user")),
      orderBy: SCHEDULE_ORDER,
      include: scheduleInclude,
    });
    return c.json(await toScheduleViews(rows));
  });

  router.post("/", requireRole("admin", "editor"), validate("json", api.ScheduleInput), async (c) => {
    const user = c.get("user");
    const body = c.req.valid("json");
    // Editors may only schedule devices/locations of their own locations (404 otherwise).
    const target = await findScheduleTargetInScope(user, body.targetType, body.targetId);
    const playlist = await assertPlaylistExists(body.playlistId);
    assertScheduleDates(body.startDate, body.endDate);

    const data = { ...body, days: normalizeDays(body.days) };
    const created = await prisma.$transaction(async (tx) => {
      const row = await tx.schedule.create({ data: { ...data, createdById: user.id }, include: scheduleInclude });
      await audit(
        c,
        {
          action: "schedule.create",
          entityType: "schedule",
          entityId: row.id,
          summary: `${q(target.name)} ${TARGET_LABELS[body.targetType]} için ${q(playlist.name)} zamanlaması eklendi (${describeWindow(row)}, öncelik ${row.priority})`,
          details: { after: ruleSnapshot(data) },
        },
        tx,
      );
      return row;
    });
    await refreshManifestsForScheduleTarget(created.targetType, created.targetId);
    return c.json(await toScheduleView(created));
  });

  router.patch("/:id", requireRole("admin", "editor"), validate("param", IdParam), validate("json", api.ScheduleInput.partial()), async (c) => {
    const user = c.get("user");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const before = await findScheduleInScope(user, id);

    const merged: api.ScheduleInput = {
      playlistId: body.playlistId ?? before.playlistId,
      targetType: body.targetType ?? before.targetType,
      targetId: body.targetId ?? before.targetId,
      days: normalizeDays(body.days ?? before.days),
      startTime: body.startTime ?? before.startTime,
      endTime: body.endTime ?? before.endTime,
      startDate: body.startDate === undefined ? before.startDate : body.startDate,
      endDate: body.endDate === undefined ? before.endDate : body.endDate,
      priority: body.priority ?? before.priority,
    };
    const targetChanged = merged.targetType !== before.targetType || merged.targetId !== before.targetId;
    // Moving a rule needs the same right on the new target as creating one there.
    const target = await findScheduleTargetInScope(user, merged.targetType, merged.targetId);
    const playlist = merged.playlistId === before.playlistId ? before.playlist : await assertPlaylistExists(merged.playlistId);
    assertScheduleDates(merged.startDate, merged.endDate);

    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.schedule.update({ where: { id }, data: merged, include: scheduleInclude });
      await audit(
        c,
        {
          action: "schedule.update",
          entityType: "schedule",
          entityId: id,
          summary: `${q(target.name)} ${TARGET_LABELS[merged.targetType]} için ${q(playlist.name)} zamanlaması güncellendi (${describeWindow(row)}, öncelik ${row.priority})`,
          details: { before: ruleSnapshot(before), after: ruleSnapshot(merged) },
        },
        tx,
      );
      return row;
    });
    await refreshManifestsForScheduleTarget(updated.targetType, updated.targetId);
    if (targetChanged) await refreshManifestsForScheduleTarget(before.targetType, before.targetId);
    return c.json(await toScheduleView(updated));
  });

  router.delete("/:id", requireRole("admin", "editor"), validate("param", IdParam), async (c) => {
    const user = c.get("user");
    const { id } = c.req.valid("param");
    const schedule = await findScheduleInScope(user, id);
    const [view] = await toScheduleViews([schedule]);
    await prisma.$transaction(async (tx) => {
      await tx.schedule.delete({ where: { id } });
      await audit(
        c,
        {
          action: "schedule.delete",
          entityType: "schedule",
          entityId: id,
          summary: `${q(view?.targetName ?? "")} ${TARGET_LABELS[schedule.targetType]} için ${q(schedule.playlist.name)} zamanlaması silindi (${describeWindow(schedule)})`,
          details: { before: ruleSnapshot(schedule) },
        },
        tx,
      );
    });
    await refreshManifestsForScheduleTarget(schedule.targetType, schedule.targetId);
    return c.body(null, 204);
  });

  return router;
}
