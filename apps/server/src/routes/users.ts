import { api } from "@managealltv/protocol";
import type { Prisma } from "@prisma/client";
import { Hono } from "hono";
import { z } from "zod";
import { prisma } from "../db";
import { conflict, notFound } from "../lib/errors";
import { validate } from "../lib/validation";
import { requireRole, requireUser } from "../middleware/session";
import { audit, q } from "../services/audit";
import { assertLocationsExist, createInvite, createPasswordReset, revokeUserSessions } from "../services/invites";
import type { AppEnv } from "../types";

export const ROLE_LABELS: Record<api.Role, string> = { admin: "Yönetici", editor: "Editör", viewer: "İzleyici" };

// Arbitrary constant for pg_advisory_xact_lock: serialises "is this the last admin?" decisions.
const LAST_ADMIN_LOCK = 724_002;

type UserRow = Prisma.UserGetPayload<{ include: { locations: { select: { locationId: true } } } }>;

export function toUserView(user: UserRow): api.User {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    locationIds: user.role === "admin" ? [] : user.locations.map((l) => l.locationId).sort(),
    disabled: user.disabled,
    twoFactorEnabled: user.twoFactorEnabled === true,
    createdAt: user.createdAt.toISOString(),
  };
}

const userInclude = { locations: { select: { locationId: true } } } as const;
const IdParam = z.object({ id: z.string().min(1).max(64) });

export function usersRoutes() {
  const router = new Hono<AppEnv>();
  router.use("*", requireUser, requireRole("admin"));

  router.get("/", async (c) => {
    const users = await prisma.user.findMany({ orderBy: [{ createdAt: "asc" }, { id: "asc" }], include: userInclude });
    return c.json(users.map(toUserView));
  });

  router.post("/invites", validate("json", api.InviteCreate), async (c) => {
    const body = c.req.valid("json");
    const { link, invite } = await createInvite(body, c.get("user").id);
    await audit(c, {
      action: "user.invite",
      entityType: "invite",
      entityId: invite.id,
      summary: `${q(invite.name)} (${invite.email}) ${ROLE_LABELS[body.role].toLocaleLowerCase("tr")} olarak davet edildi`,
    });
    return c.json(link);
  });

  router.post("/:id/password-reset", validate("param", IdParam), async (c) => {
    const { id } = c.req.valid("param");
    const { link, invite, user } = await createPasswordReset(id, c.get("user").id);
    await audit(c, {
      action: "user.password_reset",
      entityType: "user",
      entityId: user.id,
      summary: `${q(user.name)} için parola sıfırlama bağlantısı oluşturuldu`,
      details: { inviteId: invite.id },
    });
    return c.json(link);
  });

  router.patch("/:id", validate("param", IdParam), validate("json", api.UserUpdate), async (c) => {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const me = c.get("user");

    const target = await prisma.user.findUnique({ where: { id }, include: userInclude });
    if (!target) throw notFound("Kullanıcı bulunamadı");
    if (body.disabled === true && target.id === me.id) {
      throw conflict("cannot_disable_self", "Kendi hesabınızı devre dışı bırakamazsınız.");
    }

    const role = body.role ?? target.role;
    const disabled = body.disabled ?? target.disabled;
    const locationIds = body.locationIds === undefined ? undefined : await assertLocationsExist(body.locationIds);

    const updated = await prisma.$transaction(async (tx) => {
      const losesAdmin = target.role === "admin" && !target.disabled && (role !== "admin" || disabled);
      if (losesAdmin) {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LAST_ADMIN_LOCK})`;
        const others = await tx.user.count({ where: { role: "admin", disabled: false, id: { not: target.id } } });
        if (others === 0) {
          throw conflict("last_admin", "Son etkin yönetici devre dışı bırakılamaz veya rolü değiştirilemez.");
        }
      }
      await tx.user.update({
        where: { id },
        data: { ...(body.name === undefined ? {} : { name: body.name }), role, disabled },
      });
      if (role === "admin") {
        await tx.userLocation.deleteMany({ where: { userId: id } });
      } else if (locationIds !== undefined) {
        await tx.userLocation.deleteMany({ where: { userId: id } });
        await tx.userLocation.createMany({ data: locationIds.map((locationId) => ({ userId: id, locationId })) });
      }
      return tx.user.findUniqueOrThrow({ where: { id }, include: userInclude });
    });

    if (disabled && !target.disabled) await revokeUserSessions(id);

    const changes: string[] = [];
    if (body.name !== undefined && body.name !== target.name) changes.push(`ad ${q(body.name)}`);
    if (role !== target.role) changes.push(`rol ${ROLE_LABELS[role].toLocaleLowerCase("tr")}`);
    if (disabled !== target.disabled) changes.push(disabled ? "devre dışı bırakıldı" : "etkinleştirildi");
    if (locationIds !== undefined) changes.push(`${locationIds.length} konum`);
    await audit(c, {
      action: "user.update",
      entityType: "user",
      entityId: id,
      summary: `${q(updated.name)} kullanıcısı güncellendi${changes.length > 0 ? `: ${changes.join(", ")}` : ""}`,
      details: { before: toUserView(target), after: toUserView(updated) },
    });
    return c.json(toUserView(updated));
  });

  return router;
}
