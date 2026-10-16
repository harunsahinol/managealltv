/**
 * Periodic in-process housekeeping (single server process, so a timer is enough; nothing here must
 * survive a restart).
 */
import { HEARTBEAT_INTERVAL_SEC, OFFLINE_AFTER_SEC } from "@managealltv/protocol";
import { prisma } from "./db";
import { logger } from "./logger";
import { deviceHub } from "./services/device-hub";
import { expireStaleCommands } from "./services/devices";
import { cleanupStaleUploads, failStuckMedia, requeueProcessingMedia } from "./services/media-processing";
import { purgeOldPairings } from "./services/pairing";

const INTERVAL_MS = 60_000;
/** Used invite rows are kept this long for reference, expired ones as well. */
const INVITE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * A healthy player sends a status every HEARTBEAT_INTERVAL_SEC; a socket silent for longer than the
 * offline threshold plus one beat is a dead Wi-Fi link that TCP has not noticed yet.
 */
const SOCKET_IDLE_MS = (OFFLINE_AFTER_SEC + HEARTBEAT_INTERVAL_SEC) * 1000;

export async function runMaintenance(now = new Date()): Promise<void> {
  const idle = deviceHub.closeIdle(SOCKET_IDLE_MS, now.getTime());
  const expired = await expireStaleCommands(now);
  const pairings = await purgeOldPairings(now);
  const cutoff = new Date(now.getTime() - INVITE_RETENTION_MS);
  const invites = await prisma.invite.deleteMany({
    where: { OR: [{ usedAt: { lt: cutoff } }, { expiresAt: { lt: cutoff } }] },
  });
  const stuckMedia = await failStuckMedia(now);
  const staleUploads = await cleanupStaleUploads(now);
  // Self-healing for a job that could not be queued (singleton keys make repeats free).
  await requeueProcessingMedia();
  if (idle + expired + pairings + invites.count + stuckMedia + staleUploads > 0) {
    logger.info("Maintenance", {
      idleSockets: idle,
      expiredCommands: expired,
      purgedPairings: pairings,
      purgedInvites: invites.count,
      failedStuckMedia: stuckMedia,
      removedUploads: staleUploads,
    });
  }
}

/** Starts the timer; returns a function that stops it. */
export function startMaintenance(): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    runMaintenance()
      .catch((error: unknown) => logger.error("Maintenance failed", { error }))
      .finally(() => {
        running = false;
      });
  }, INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
