import type { Device } from "@prisma/client";
import type { MiddlewareHandler } from "hono";
import { prisma } from "../db";
import { DEVICE_TOKEN_PREFIX, sha256Hex } from "../lib/crypto";
import { unauthorized } from "../lib/errors";
import type { AppEnv } from "../types";

const UNKNOWN_TOKEN_MESSAGE = "Cihaz anahtarı geçersiz veya iptal edilmiş. Cihazı yeniden eşleştirin.";

/** Looks up the device for an "Authorization: Bearer mtv_d_..." header; null if missing/unknown. */
export async function deviceFromAuthorization(header: string | undefined): Promise<Device | null> {
  const match = /^Bearer\s+(\S+)$/i.exec(header ?? "");
  const token = match?.[1];
  if (!token || !token.startsWith(DEVICE_TOKEN_PREFIX) || token.length > 256) return null;
  return prisma.device.findUnique({ where: { tokenHash: sha256Hex(token) } });
}

/** Device bearer authentication; sets c.get("device"). Unknown/revoked token → 401 unauthorized. */
export const requireDevice: MiddlewareHandler<AppEnv> = async (c, next) => {
  const device = await deviceFromAuthorization(c.req.header("authorization"));
  if (!device) throw unauthorized(UNKNOWN_TOKEN_MESSAGE);
  c.set("device", device);
  await next();
};
