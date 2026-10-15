import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

export function sha256Hex(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

/** 32 random bytes as base64url (43 chars). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export const DEVICE_TOKEN_PREFIX = "mtv_d_";

/** Device bearer token: "mtv_d_" + 43 base64url chars. Only its SHA-256 is stored. */
export function generateDeviceToken(): { token: string; hash: string } {
  const token = `${DEVICE_TOKEN_PREFIX}${randomToken(32)}`;
  return { token, hash: sha256Hex(token) };
}

/** Six decimal digits, leading zeros allowed. */
export function randomPairingCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
