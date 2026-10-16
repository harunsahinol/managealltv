import type { ServerToDevice } from "@managealltv/protocol";
import type { WSContext } from "hono/ws";
import { logger } from "../logger";

/** Close codes the player can act on (4000-4999 are application defined). */
export const WS_CLOSE = {
  replaced: { code: 4000, reason: "replaced by a newer connection" },
  unpaired: { code: 4001, reason: "unpaired" },
  idle: { code: 4002, reason: "idle" },
  shutdown: { code: 1001, reason: "server shutting down" },
} as const;

const WS_OPEN = 1;

interface Connection {
  ws: WSContext;
  connectedAt: number;
  lastMessageAt: number;
}

/**
 * Live WebSocket connections of devices, one per device (a new connection closes the previous one).
 * In-memory: the server runs as a single process.
 */
export class DeviceHub {
  private readonly connections = new Map<string, Connection>();

  attach(deviceId: string, ws: WSContext): void {
    const previous = this.connections.get(deviceId);
    const now = Date.now();
    this.connections.set(deviceId, { ws, connectedAt: now, lastMessageAt: now });
    if (previous && previous.ws !== ws) {
      logger.info("Device reconnected; closing previous connection", { deviceId });
      safeClose(previous.ws, WS_CLOSE.replaced);
    }
  }

  /** Removes the connection only if it is still the current one (an old socket closing must not evict the new one). */
  detach(deviceId: string, ws: WSContext): boolean {
    const current = this.connections.get(deviceId);
    if (current?.ws !== ws) return false;
    this.connections.delete(deviceId);
    return true;
  }

  isCurrent(deviceId: string, ws: WSContext): boolean {
    return this.connections.get(deviceId)?.ws === ws;
  }

  touch(deviceId: string, ws: WSContext): void {
    const current = this.connections.get(deviceId);
    if (current?.ws === ws) current.lastMessageAt = Date.now();
  }

  isConnected(deviceId: string): boolean {
    return this.connections.has(deviceId);
  }

  connectedDeviceIds(): string[] {
    return [...this.connections.keys()];
  }

  /** Sends a message if the device is connected; returns whether it was handed to the socket. */
  send(deviceId: string, message: ServerToDevice): boolean {
    const connection = this.connections.get(deviceId);
    if (!connection) return false;
    // ws silently drops data on a closing socket; report it as undelivered so commands stay pending.
    if (connection.ws.readyState !== WS_OPEN) {
      this.detach(deviceId, connection.ws);
      return false;
    }
    try {
      connection.ws.send(JSON.stringify(message));
      return true;
    } catch (error) {
      logger.warn("WebSocket send failed", { deviceId, error });
      this.detach(deviceId, connection.ws);
      safeClose(connection.ws, WS_CLOSE.idle);
      return false;
    }
  }

  /** Device deleted in the panel: tell it to forget its token, then hang up. */
  unpair(deviceId: string): void {
    const connection = this.connections.get(deviceId);
    if (!connection) return;
    this.send(deviceId, { type: "unpaired" });
    this.connections.delete(deviceId);
    safeClose(connection.ws, WS_CLOSE.unpaired);
  }

  /** Closes connections that have been silent for longer than maxIdleMs (dead Wi-Fi links). */
  closeIdle(maxIdleMs: number, now = Date.now()): number {
    let closed = 0;
    for (const [deviceId, connection] of this.connections) {
      if (now - connection.lastMessageAt > maxIdleMs) {
        this.connections.delete(deviceId);
        safeClose(connection.ws, WS_CLOSE.idle);
        closed += 1;
      }
    }
    return closed;
  }

  closeAll(): void {
    for (const connection of this.connections.values()) safeClose(connection.ws, WS_CLOSE.shutdown);
    this.connections.clear();
  }
}

function safeClose(ws: WSContext, close: { code: number; reason: string }): void {
  try {
    ws.close(close.code, close.reason);
  } catch {
    // Already closed.
  }
}

export const deviceHub = new DeviceHub();
