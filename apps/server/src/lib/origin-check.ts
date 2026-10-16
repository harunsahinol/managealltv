import type { MiddlewareHandler } from "hono";
import { HttpError } from "./errors";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * CSRF defence for cookie-authenticated routes: a state-changing request carrying an Origin header
 * must come from one of the trusted origins, and browsers' Sec-Fetch-Site must not say cross-site.
 * Requests without either header (curl, the CLI, tests) pass: browsers always send Origin on
 * cross-origin POST/PATCH/PUT/DELETE, so the absence cannot be forged from a malicious page.
 * The session cookie is SameSite=Lax as a second layer.
 */
export function originCheck(allowedOrigins: readonly string[]): MiddlewareHandler {
  const allowed = new Set(allowedOrigins);
  return async (c, next) => {
    if (!SAFE_METHODS.has(c.req.method)) {
      const origin = c.req.header("origin");
      const fetchSite = c.req.header("sec-fetch-site");
      const badOrigin = origin !== undefined && !allowed.has(origin);
      const crossSite = fetchSite === "cross-site" && (origin === undefined || !allowed.has(origin));
      if (badOrigin || crossSite) {
        throw new HttpError(403, "forbidden", "İstek izin verilmeyen bir kaynaktan geldi.");
      }
    }
    await next();
  };
}
