import { z } from "zod";

/** Device protocol version. Bumped only on breaking changes to device-facing messages. */
export const PROTOCOL_VERSION = 1 as const;

/** Base path of the device-facing API. */
export const DEVICE_API_BASE = "/api/device/v1" as const;

export const Id = z.string().min(1).max(64);

export const Sha256Hex = z.string().regex(/^[a-f0-9]{64}$/, "lowercase hex SHA-256");

/** ISO-8601 timestamp with offset, e.g. 2026-10-15T09:00:00.000Z */
export const IsoDateTime = z.iso.datetime({ offset: true });

/** Calendar day in the location's time zone, e.g. 2026-10-29 */
export const LocalDate = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, "YYYY-MM-DD");

/** Time of day in the location's time zone, 24h, e.g. 07:30 */
export const TimeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "HH:MM");

export const Weekday = z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);
export type Weekday = z.infer<typeof Weekday>;

export const MediaType = z.enum(["image", "video"]);
export type MediaType = z.infer<typeof MediaType>;

/** Every non-2xx JSON response from the server uses this shape. */
export const ApiError = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});
export type ApiError = z.infer<typeof ApiError>;
