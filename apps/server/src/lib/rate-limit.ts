import type { Context, MiddlewareHandler } from "hono";
import { clientIp } from "./client-ip";
import { HttpError } from "./errors";

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * Fixed-window in-memory counter. Good enough for a single server process with ~10 devices and a
 * handful of panel users; state is lost on restart, which only ever makes the limiter more lenient.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    readonly limit: number,
    readonly windowMs: number,
  ) {}

  /** Counts one hit; returns seconds to wait when the limit is exceeded, otherwise null. */
  hit(key: string, now = Date.now()): number | null {
    let bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + this.windowMs };
      this.buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count > this.limit) return Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
    if (this.buckets.size > 10_000) this.sweep(now);
    return null;
  }

  sweep(now = Date.now()): void {
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
  }

  reset(): void {
    this.buckets.clear();
  }
}

export interface RateLimitOptions {
  limit: number;
  windowMs: number;
  /** Bucket key; defaults to the client IP. Return null to skip limiting for this request. */
  key?: (c: Context) => string | null;
  /** When false the middleware is a no-op (tests). */
  enabled?: boolean;
}

export function rateLimit(options: RateLimitOptions): MiddlewareHandler {
  const limiter = new RateLimiter(options.limit, options.windowMs);
  const keyOf = options.key ?? ((c: Context) => clientIp(c) ?? "unknown");
  return async (c, next) => {
    if (options.enabled === false) return next();
    const key = keyOf(c);
    if (key !== null) {
      const retryAfter = limiter.hit(key);
      if (retryAfter !== null) {
        throw new HttpError(429, "rate_limited", "Çok fazla istek gönderildi. Lütfen biraz bekleyip tekrar deneyin.", {
          "Retry-After": String(retryAfter),
        });
      }
    }
    return next();
  };
}
