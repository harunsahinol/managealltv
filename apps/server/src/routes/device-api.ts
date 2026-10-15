import type { NodeWebSocket } from "@hono/node-ws";
import {
  CommandResult,
  DeviceStatus,
  DeviceToServer,
  PairPollRequest,
  PairRequest,
  type StatusAck,
} from "@managealltv/protocol";
import { Hono } from "hono";
import type { WSContext } from "hono/ws";
import { z } from "zod";
import { prisma } from "../db";
import { clientIp } from "../lib/client-ip";
import { notFound, unauthorized } from "../lib/errors";
import { sendFile } from "../lib/file-sender";
import { rateLimit } from "../lib/rate-limit";
import { mediaFilePath } from "../lib/storage";
import { validate } from "../lib/validation";
import { logger } from "../logger";
import { requireDevice } from "../middleware/device-auth";
import { deviceHub } from "../services/device-hub";
import { deliverPendingCommands, recordCommandResult, recordDeviceStatus } from "../services/devices";
import { manifestMediaIds, syncManifest } from "../services/manifest";
import { createPairing, pollPairing } from "../services/pairing";
import type { AppEnv } from "../types";

const IdParam = z.object({ id: z.string().min(1).max(64) });
const MediaParam = z.object({ mediaId: z.string().min(1).max(64) });

function etagMatches(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  return header.split(",").some((part) => part.trim().replace(/^W\//, "") === etag || part.trim() === "*");
}

async function handleSocketMessage(deviceId: string, ws: WSContext, raw: unknown): Promise<void> {
  if (typeof raw !== "string") return;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    logger.debug("Ignoring non-JSON WebSocket message", { deviceId });
    return;
  }
  const parsed = DeviceToServer.safeParse(json);
  if (!parsed.success) {
    // Newer players may send message types this server does not know yet; ignore instead of disconnecting.
    logger.debug("Ignoring invalid WebSocket message", { deviceId, issues: parsed.error.issues.length });
    return;
  }
  const message = parsed.data;
  if (message.type === "status") {
    const version = await recordDeviceStatus(deviceId, message.status);
    if (message.status.manifestVersion !== version && deviceHub.isCurrent(deviceId, ws)) {
      deviceHub.send(deviceId, { type: "manifest_updated", version });
    }
    return;
  }
  await recordCommandResult(deviceId, message.id, message.ok, message.message);
}

export interface DeviceApiOptions {
  upgradeWebSocket: NodeWebSocket["upgradeWebSocket"];
  rateLimit: boolean;
}

/** Device-facing API, mounted at DEVICE_API_BASE (/api/device/v1). */
export function deviceApiRoutes(options: DeviceApiOptions) {
  const router = new Hono<AppEnv>();

  router.post("/pair", rateLimit({ limit: 10, windowMs: 60_000, enabled: options.rateLimit }), validate("json", PairRequest), async (c) => {
    const { device } = c.req.valid("json");
    return c.json(await createPairing(device, clientIp(c)));
  });

  router.post(
    "/pair/poll",
    rateLimit({ limit: 60, windowMs: 60_000, enabled: options.rateLimit }),
    validate("json", PairPollRequest),
    async (c) => c.json(await pollPairing(c.req.valid("json").pairingSecret)),
  );

  router.get("/manifest", requireDevice, async (c) => {
    const synced = await syncManifest(c.get("device").id);
    if (!synced) throw unauthorized();
    const etag = `"${synced.manifest.version}"`;
    c.header("ETag", etag);
    c.header("Cache-Control", "no-cache");
    if (etagMatches(c.req.header("if-none-match"), etag)) return c.body(null, 304);
    return c.json(synced.manifest);
  });

  router.get("/media/:mediaId", requireDevice, validate("param", MediaParam), async (c) => {
    const { mediaId } = c.req.valid("param");
    // Authorisation: a device may only download what its current manifest references.
    if (!(await manifestMediaIds(c.get("device").id)).has(mediaId)) throw notFound("Medya bulunamadı");
    const media = await prisma.media.findUnique({ where: { id: mediaId } });
    if (!media || media.status !== "ready" || !media.mimeType || !media.sha256) throw notFound("Medya bulunamadı");
    return sendFile(c, { path: mediaFilePath(media.id, media.mimeType), contentType: media.mimeType, etag: media.sha256 });
  });

  router.post("/status", requireDevice, validate("json", DeviceStatus), async (c) => {
    const ack: StatusAck = { manifestVersion: await recordDeviceStatus(c.get("device").id, c.req.valid("json")) };
    return c.json(ack);
  });

  router.post("/commands/:id/result", requireDevice, validate("param", IdParam), validate("json", CommandResult), async (c) => {
    const { ok, message } = c.req.valid("json");
    if (!(await recordCommandResult(c.get("device").id, c.req.valid("param").id, ok, message))) {
      throw notFound("Komut bulunamadı");
    }
    return c.body(null, 204);
  });

  router.get(
    "/ws",
    requireDevice,
    options.upgradeWebSocket((c) => {
      const deviceId = c.get("device").id;
      return {
        onOpen: (_event, ws) => {
          deviceHub.attach(deviceId, ws);
          void (async () => {
            await prisma.device.update({ where: { id: deviceId }, data: { lastSeenAt: new Date() } });
            await deliverPendingCommands(deviceId);
          })().catch((error: unknown) => logger.error("WebSocket connect handling failed", { deviceId, error }));
        },
        onMessage: (event, ws) => {
          deviceHub.touch(deviceId, ws);
          handleSocketMessage(deviceId, ws, event.data).catch((error: unknown) =>
            logger.error("WebSocket message handling failed", { deviceId, error }),
          );
        },
        onClose: (_event, ws) => {
          deviceHub.detach(deviceId, ws);
        },
        onError: (event) => {
          logger.warn("WebSocket error", { deviceId, type: event.type });
        },
      };
    }),
  );

  return router;
}
