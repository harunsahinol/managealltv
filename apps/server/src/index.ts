import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { createApp } from "./app";
import { prisma } from "./db";
import { env } from "./env";
import { startJobs, stopJobs } from "./jobs";
import { ensureStorageDirs, mediaRoot } from "./lib/storage";
import { logger } from "./logger";
import { startMaintenance } from "./maintenance";
import { requeueProcessingMedia } from "./services/media-processing";
import { deviceHub } from "./services/device-hub";

/** Hard stop if a graceful shutdown hangs (e.g. a stuck ffmpeg job). */
const SHUTDOWN_TIMEOUT_MS = 25_000;

async function main(): Promise<void> {
  await ensureStorageDirs();
  await prisma.$connect();

  const { app, injectWebSocket } = createApp();
  const server = serve({ fetch: app.fetch, port: env.PORT }, (info: AddressInfo) => {
    logger.info("Server listening", { port: info.port, publicUrl: env.PUBLIC_URL, mediaDir: mediaRoot });
  });
  injectWebSocket(server);

  await startJobs();
  // Media whose upload finished while the queue was down (or whose job was lost) gets a job now.
  const requeued = await requeueProcessingMedia();
  if (requeued > 0) logger.info("Queued pending media processing", { media: requeued });
  const stopMaintenance = startMaintenance();

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("Shutting down", { signal });
    const killTimer = setTimeout(() => {
      logger.error("Graceful shutdown timed out; exiting");
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    killTimer.unref();

    void (async () => {
      stopMaintenance();
      // Close sockets first: players reconnect to the restarted server on their own.
      deviceHub.closeAll();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        // Keep-alive connections would otherwise hold close() open until they time out.
        if ("closeIdleConnections" in server) server.closeIdleConnections();
      });
      await stopJobs();
      await prisma.$disconnect();
      logger.info("Shutdown complete");
      process.exit(0);
    })().catch((error: unknown) => {
      logger.error("Shutdown failed", { error });
      process.exit(1);
    });
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled promise rejection", { error: reason });
});

main().catch((error: unknown) => {
  logger.error("Server failed to start", { error });
  process.exit(1);
});
