import { api } from "@managealltv/protocol";
import { Hono } from "hono";
import { z } from "zod";
import { clientIp } from "../lib/client-ip";
import { notFound } from "../lib/errors";
import { rateLimit } from "../lib/rate-limit";
import { validate } from "../lib/validation";
import { auditAs, q } from "../services/audit";
import { acceptInvite, findOpenInvite, toInviteInfo } from "../services/invites";
import type { AppEnv } from "../types";

// Tokens are 43 base64url chars; anything else cannot exist, answer 404 without touching the database.
const TokenParam = z.object({ token: z.string() });
const isPlausibleToken = (token: string) => /^[A-Za-z0-9_-]{32,128}$/.test(token);

export interface InvitesRoutesOptions {
  rateLimit: boolean;
}

/** Public endpoints behind the "{PUBLIC_URL}/invite/<token>" page. */
export function invitesRoutes(options: InvitesRoutesOptions) {
  const router = new Hono<AppEnv>();
  router.use("*", rateLimit({ limit: 30, windowMs: 60_000, enabled: options.rateLimit }));

  router.get("/:token", validate("param", TokenParam), async (c) => {
    const { token } = c.req.valid("param");
    const invite = isPlausibleToken(token) ? await findOpenInvite(token) : null;
    if (!invite) throw notFound("Bağlantı geçersiz, kullanılmış veya süresi dolmuş.");
    return c.json(toInviteInfo(invite));
  });

  router.post("/:token/accept", validate("param", TokenParam), validate("json", api.InviteAccept), async (c) => {
    const { token } = c.req.valid("param");
    const { password } = c.req.valid("json");
    if (!isPlausibleToken(token)) throw notFound("Bağlantı geçersiz, kullanılmış veya süresi dolmuş.");
    const result = await acceptInvite(token, password);
    await auditAs(
      { userId: result.userId, ip: clientIp(c) },
      result.kind === "invite"
        ? { action: "invite.accept", entityType: "user", entityId: result.userId, summary: `${q(result.name)} daveti kabul ederek hesabını oluşturdu` }
        : { action: "user.password_set", entityType: "user", entityId: result.userId, summary: `${q(result.name)} parolasını sıfırladı; tüm oturumları kapatıldı` },
    );
    return c.body(null, 204);
  });

  return router;
}
