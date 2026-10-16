import { createNodeWebSocket, type NodeWebSocket } from "@hono/node-ws";
import { DEVICE_API_BASE } from "@managealltv/protocol";
import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import { z } from "zod";
import { trustedOrigins } from "./auth";
import { handleError } from "./lib/error-handler";
import { apiErrorBody, HttpError } from "./lib/errors";
import { originCheck } from "./lib/origin-check";
import { logger } from "./logger";
import { auditRoutes } from "./routes/audit";
import { authRoutes } from "./routes/auth";
import { deviceApiRoutes } from "./routes/device-api";
import { devicesRoutes } from "./routes/devices";
import { healthRoutes } from "./routes/health";
import { invitesRoutes } from "./routes/invites";
import { locationsRoutes } from "./routes/locations";
import { mediaRoutes } from "./routes/media";
import { meRoutes } from "./routes/me";
import { playlistsRoutes } from "./routes/playlists";
import { schedulesRoutes } from "./routes/schedules";
import { UPLOADS_PATH, uploadsRoutes } from "./routes/uploads";
import { usersRoutes } from "./routes/users";
import type { AppEnv } from "./types";

// Validation messages users see (400 validation_error) come from zod's Turkish locale.
z.config(z.locales.tr());

/** Largest JSON body accepted by the API (uploads go through tus, which is exempt). */
const JSON_BODY_LIMIT_BYTES = 1024 * 1024;

/** Paths whose bodies are not small JSON documents: the tus upload endpoint streams files. */
const BODY_LIMIT_EXEMPT_PREFIXES = [UPLOADS_PATH];

/** Cookie-authenticated paths are origin-checked; the device API uses bearer tokens and Better Auth checks its own. */
const ORIGIN_CHECK_EXEMPT_PREFIXES = [DEVICE_API_BASE, "/api/auth"];

export interface AppOptions {
  /** In-memory rate limits (pairing, claim, sign-in, invites). Default true; tests turn them off. */
  rateLimit?: boolean;
}

export interface CreatedApp {
  /** The Hono app; drive it with app.request() in tests or serve app.fetch. */
  app: Hono<AppEnv>;
  /** Attaches WebSocket upgrade handling (device /ws) to a listening Node server. */
  injectWebSocket: NodeWebSocket["injectWebSocket"];
}

const startsWithAny = (path: string, prefixes: readonly string[]): boolean =>
  prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));

function unless(prefixes: readonly string[], middleware: MiddlewareHandler<AppEnv>): MiddlewareHandler<AppEnv> {
  return async (c, next) => (startsWithAny(c.req.path, prefixes) ? next() : middleware(c, next));
}

const requestLog: MiddlewareHandler<AppEnv> = async (c, next) => {
  const startedAt = performance.now();
  await next();
  logger.debug("request", {
    method: c.req.method,
    path: c.req.path,
    status: c.res.status,
    ms: Math.round(performance.now() - startedAt),
  });
};

/**
 * Builds the whole HTTP application without listening, so tests can call app.request(). Feature
 * modules mount their routers here (see the route list below).
 */
export function createApp(options: AppOptions = {}): CreatedApp {
  const rateLimit = options.rateLimit ?? true;
  const app = new Hono<AppEnv>();
  // The upgrade request is routed through this same app, so /ws gets the normal middleware chain.
  const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket({ app });

  app.onError(handleError);
  app.notFound((c) => c.json(apiErrorBody("not_found", "İstenen adres bulunamadı."), 404));

  app.use("*", requestLog);
  app.use(
    "*",
    secureHeaders({
      // same-site instead of same-origin so a dev panel on another port can still show thumbnails.
      crossOriginResourcePolicy: "same-site",
      referrerPolicy: "no-referrer",
    }),
  );
  app.use(
    "/api/*",
    unless(
      BODY_LIMIT_EXEMPT_PREFIXES,
      bodyLimit({
        maxSize: JSON_BODY_LIMIT_BYTES,
        onError: () => {
          throw new HttpError(413, "payload_too_large", "İstek gövdesi çok büyük.");
        },
      }),
    ),
  );
  app.use("/api/*", unless(ORIGIN_CHECK_EXEMPT_PREFIXES, originCheck(trustedOrigins())));

  app.route("/health", healthRoutes());
  app.route("/api/auth", authRoutes({ rateLimit }));
  app.route(DEVICE_API_BASE, deviceApiRoutes({ upgradeWebSocket, rateLimit }));
  app.route("/api/me", meRoutes());
  app.route("/api/users", usersRoutes());
  app.route("/api/invites", invitesRoutes({ rateLimit }));
  app.route("/api/locations", locationsRoutes());
  app.route("/api/devices", devicesRoutes({ rateLimit }));
  app.route(UPLOADS_PATH, uploadsRoutes());
  app.route("/api/media", mediaRoutes());
  app.route("/api/playlists", playlistsRoutes());
  app.route("/api/schedules", schedulesRoutes());
  app.route("/api/audit", auditRoutes());

  return { app, injectWebSocket };
}
