import { type api, IsoDateTime } from "@managealltv/protocol";
import { Hono } from "hono";
import { z } from "zod";
import { prisma } from "../db";
import { validate } from "../lib/validation";
import { requireRole, requireUser } from "../middleware/session";
import type { AppEnv } from "../types";

export const AUDIT_DEFAULT_LIMIT = 100;
export const AUDIT_MAX_LIMIT = 500;

/** GET /api/audit?limit=100&before=<ISO>: `before` is the `at` of the last entry already shown. */
const AuditQuery = z.object({
  limit: z.coerce.number().int().min(1).max(AUDIT_MAX_LIMIT).default(AUDIT_DEFAULT_LIMIT),
  before: IsoDateTime.optional(),
});

export function auditRoutes() {
  const router = new Hono<AppEnv>();
  router.use("*", requireUser);

  router.get("/", requireRole("admin"), validate("query", AuditQuery), async (c) => {
    const { limit, before } = c.req.valid("query");
    const rows = await prisma.auditLog.findMany({
      where: before === undefined ? {} : { createdAt: { lt: new Date(before) } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit,
      include: { user: { select: { name: true } } },
    });
    const entries: api.AuditEntry[] = rows.map((row) => ({
      id: row.id,
      at: row.createdAt.toISOString(),
      userName: row.user?.name ?? null,
      action: row.action,
      entityType: row.entityType,
      entityId: row.entityId,
      summary: row.summary,
    }));
    return c.json(entries);
  });

  return router;
}
