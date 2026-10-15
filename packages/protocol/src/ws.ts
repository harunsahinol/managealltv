import { z } from "zod";
import { Id } from "./common";
import { DeviceStatus } from "./device";

/** Remote commands an authorised panel user can send to a device. */
export const Command = z.discriminatedUnion("type", [
  /** Fetch the manifest again and re-sync. */
  z.object({ type: z.literal("reload") }),
  /** Restart the player app. */
  z.object({ type: z.literal("restart_app") }),
  /** Show the device name full screen for a while, to find the TV. */
  z.object({ type: z.literal("identify"), durationSec: z.number().int().min(1).max(600) }),
  z.object({ type: z.literal("set_volume"), volume: z.number().int().min(0).max(100) }),
  /** Reboot the TV. Only works when the app is Device Owner. */
  z.object({ type: z.literal("reboot") }),
]);
export type Command = z.infer<typeof Command>;
export type CommandType = Command["type"];

/**
 * Messages the server sends on the device WebSocket (GET {DEVICE_API_BASE}/ws,
 * authenticated with "Authorization: Bearer <deviceToken>").
 */
export const ServerToDevice = z.discriminatedUnion("type", [
  z.object({ type: z.literal("manifest_updated"), version: z.number().int().min(1) }),
  z.object({ type: z.literal("command"), id: Id, command: Command }),
  /** The device was removed in the panel; it must forget its token and show pairing again. */
  z.object({ type: z.literal("unpaired") }),
]);
export type ServerToDevice = z.infer<typeof ServerToDevice>;

/** Messages the device sends on the WebSocket. */
export const DeviceToServer = z.discriminatedUnion("type", [
  /** Sent on connect and then every 30 seconds. */
  z.object({ type: z.literal("status"), status: DeviceStatus }),
  z.object({
    type: z.literal("command_result"),
    id: Id,
    ok: z.boolean(),
    message: z.string().max(1000).nullable(),
  }),
]);
export type DeviceToServer = z.infer<typeof DeviceToServer>;

/** Devices send a status message at least this often; the server treats them as offline after 3 missed beats. */
export const HEARTBEAT_INTERVAL_SEC = 30;
export const OFFLINE_AFTER_SEC = 90;
