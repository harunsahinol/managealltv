import type { api } from "@managealltv/protocol";
import type { MiddlewareHandler } from "hono";
import { auth } from "../auth";
import { prisma } from "../db";
import { forbidden, unauthorized } from "../lib/errors";
import type { AppEnv, AuthUser } from "../types";

/**
 * Resolves the Better Auth session cookie into c.get("user"). Role, disabled flag and locations are
 * read from the database on every request so that permission changes apply immediately.
 */
export const requireUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  const { headers, response: session } = await auth.api.getSession({
    headers: c.req.raw.headers,
    returnHeaders: true,
  });
  if (!session) throw unauthorized();

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    include: { locations: { select: { locationId: true } } },
  });
  if (!user || user.disabled) throw unauthorized("Hesabınız devre dışı bırakılmış.");

  const authUser: AuthUser = {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    locationIds: user.role === "admin" ? [] : user.locations.map((l) => l.locationId).sort(),
    twoFactorEnabled: user.twoFactorEnabled === true,
    sessionId: session.session.id,
  };
  c.set("user", authUser);
  await next();

  // Better Auth may refresh the session (sliding expiry); forward its cookie to the browser.
  for (const cookie of headers.getSetCookie()) c.res.headers.append("Set-Cookie", cookie);
};

/** Must run after requireUser. Responds 403 for other roles. */
export function requireRole(...roles: api.Role[]): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!roles.includes(c.get("user").role)) throw forbidden();
    await next();
  };
}
