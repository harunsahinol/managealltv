import type { Context } from "hono";
import type { IncomingMessage } from "node:http";
import { env } from "../env";

function socketAddress(c: Context): string | null {
  // c.env is undefined when the app is driven through app.request() (tests).
  const bindings: unknown = c.env;
  if (typeof bindings !== "object" || bindings === null || !("incoming" in bindings)) return null;
  const incoming = (bindings as { incoming?: IncomingMessage }).incoming;
  return incoming?.socket?.remoteAddress ?? null;
}

/**
 * Best-effort client IP. Behind Caddy (TRUST_PROXY=true) the right-most X-Forwarded-For entry is the
 * address Caddy saw; without a trusted proxy the header is ignored because clients can forge it.
 */
export function clientIp(c: Context): string | null {
  if (env.TRUST_PROXY) {
    const forwarded = c.req.header("x-forwarded-for");
    if (forwarded) {
      const parts = forwarded.split(",").map((p) => p.trim()).filter((p) => p.length > 0);
      const last = parts[parts.length - 1];
      if (last) return normalizeIp(last);
    }
  }
  const address = socketAddress(c);
  return address ? normalizeIp(address) : null;
}

function normalizeIp(ip: string): string {
  return ip.startsWith("::ffff:") ? ip.slice(7) : ip;
}
