/**
 * Admin (panel) API contract, shared by apps/server and apps/web.
 * All routes are under /api, authenticated with the Better Auth session cookie.
 * See docs/API.md for routes and permissions.
 */
import { z } from "zod";
import { Id, IsoDateTime, LocalDate, MediaType, TimeOfDay, Weekday } from "./common";
import { DeviceStatus } from "./device";
import { Command } from "./ws";

export const Role = z.enum(["admin", "editor", "viewer"]);
export type Role = z.infer<typeof Role>;

export const Password = z.string().min(12, "En az 12 karakter").max(128);

// ---------------------------------------------------------------- me / users / invites

export const Me = z.object({
  id: Id,
  name: z.string(),
  email: z.email(),
  role: Role,
  /** Locations the user is limited to; empty for admins (they see everything). */
  locationIds: z.array(Id),
  twoFactorEnabled: z.boolean(),
});
export type Me = z.infer<typeof Me>;

export const User = z.object({
  id: Id,
  name: z.string(),
  email: z.email(),
  role: Role,
  locationIds: z.array(Id),
  disabled: z.boolean(),
  twoFactorEnabled: z.boolean(),
  createdAt: IsoDateTime,
});
export type User = z.infer<typeof User>;

export const UserUpdate = z.object({
  name: z.string().min(1).max(100).optional(),
  role: Role.optional(),
  locationIds: z.array(Id).optional(),
  disabled: z.boolean().optional(),
});
export type UserUpdate = z.infer<typeof UserUpdate>;

export const InviteCreate = z.object({
  name: z.string().min(1).max(100),
  email: z.email(),
  role: Role,
  locationIds: z.array(Id),
});
export type InviteCreate = z.infer<typeof InviteCreate>;

/** One-time link handed to a person (no e-mail server needed). */
export const InviteLink = z.object({
  url: z.url(),
  expiresAt: IsoDateTime,
});
export type InviteLink = z.infer<typeof InviteLink>;

/** GET /api/invites/:token (public) */
export const InviteInfo = z.object({
  kind: z.enum(["invite", "password_reset"]),
  name: z.string(),
  email: z.email(),
  expiresAt: IsoDateTime,
});
export type InviteInfo = z.infer<typeof InviteInfo>;

/** POST /api/invites/:token/accept (public) */
export const InviteAccept = z.object({
  password: Password,
});
export type InviteAccept = z.infer<typeof InviteAccept>;

// ---------------------------------------------------------------- locations

export const Location = z.object({
  id: Id,
  name: z.string(),
  address: z.string().nullable(),
  timezone: z.string(),
  deviceCount: z.number().int().min(0),
});
export type Location = z.infer<typeof Location>;

export const LocationInput = z.object({
  name: z.string().min(1).max(100),
  address: z.string().max(300).nullable(),
  timezone: z.string().min(1).max(64),
});
export type LocationInput = z.infer<typeof LocationInput>;

// ---------------------------------------------------------------- devices

export const Device = z.object({
  id: Id,
  name: z.string(),
  locationId: Id,
  locationName: z.string(),
  online: z.boolean(),
  lastSeenAt: IsoDateTime.nullable(),
  manufacturer: z.string(),
  model: z.string(),
  androidVersion: z.string(),
  appVersionName: z.string(),
  /** Latest manifest version on the server; compare with status.manifestVersion to see if the TV is in sync. */
  manifestVersion: z.number().int().min(1),
  defaultPlaylistId: Id.nullable(),
  volume: z.number().int().min(0).max(100).nullable(),
  /** Playlist that should be playing right now according to the schedule (server's view). */
  expectedPlaylistId: Id.nullable(),
  /** Last status the device reported; null if it never reported. */
  status: DeviceStatus.nullable(),
  createdAt: IsoDateTime,
});
export type Device = z.infer<typeof Device>;

/** POST /api/devices/claim — admin types the code shown on the TV. */
export const DeviceClaim = z.object({
  pairingCode: z.string().regex(/^\d{6}$/, "6 haneli kod"),
  name: z.string().min(1).max(100),
  locationId: Id,
});
export type DeviceClaim = z.infer<typeof DeviceClaim>;

export const DeviceUpdate = z.object({
  name: z.string().min(1).max(100).optional(),
  locationId: Id.optional(),
  defaultPlaylistId: Id.nullable().optional(),
  volume: z.number().int().min(0).max(100).nullable().optional(),
});
export type DeviceUpdate = z.infer<typeof DeviceUpdate>;

export const CommandStatus = z.enum(["pending", "sent", "succeeded", "failed", "expired"]);
export type CommandStatus = z.infer<typeof CommandStatus>;

export const CommandView = z.object({
  id: Id,
  deviceId: Id,
  command: Command,
  status: CommandStatus,
  message: z.string().nullable(),
  createdAt: IsoDateTime,
  createdByName: z.string().nullable(),
});
export type CommandView = z.infer<typeof CommandView>;

// ---------------------------------------------------------------- media

export const MediaStatus = z.enum(["processing", "ready", "failed"]);
export type MediaStatus = z.infer<typeof MediaStatus>;

export const Media = z.object({
  id: Id,
  name: z.string(),
  type: MediaType,
  status: MediaStatus,
  error: z.string().nullable(),
  size: z.number().int().nullable(),
  durationMs: z.number().int().nullable(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  /** Number of playlists that contain this media. */
  playlistCount: z.number().int().min(0),
  uploadedByName: z.string().nullable(),
  createdAt: IsoDateTime,
});
export type Media = z.infer<typeof Media>;

export const MediaUpdate = z.object({
  name: z.string().min(1).max(200),
});
export type MediaUpdate = z.infer<typeof MediaUpdate>;

// ---------------------------------------------------------------- playlists

export const Playlist = z.object({
  id: Id,
  name: z.string(),
  itemCount: z.number().int().min(0),
  /** Sum of video lengths and image durations; null if any video length is unknown yet. */
  totalDurationSec: z.number().int().min(0).nullable(),
  updatedAt: IsoDateTime,
});
export type Playlist = z.infer<typeof Playlist>;

export const PlaylistItem = z.object({
  mediaId: Id,
  durationSec: z.number().int().min(1).max(86_400).nullable(),
  media: Media,
});
export type PlaylistItem = z.infer<typeof PlaylistItem>;

export const PlaylistDetail = Playlist.extend({
  items: z.array(PlaylistItem),
});
export type PlaylistDetail = z.infer<typeof PlaylistDetail>;

export const PlaylistInput = z.object({
  name: z.string().min(1).max(100),
});
export type PlaylistInput = z.infer<typeof PlaylistInput>;

/** PUT /api/playlists/:id/items — replaces the whole ordered list. */
export const PlaylistItemsInput = z.object({
  items: z
    .array(
      z.object({
        mediaId: Id,
        durationSec: z.number().int().min(1).max(86_400).nullable(),
      }),
    )
    .max(500),
});
export type PlaylistItemsInput = z.infer<typeof PlaylistItemsInput>;

// ---------------------------------------------------------------- schedules

export const ScheduleTargetType = z.enum(["device", "location"]);
export type ScheduleTargetType = z.infer<typeof ScheduleTargetType>;

export const ScheduleInput = z.object({
  playlistId: Id,
  targetType: ScheduleTargetType,
  targetId: Id,
  days: z.array(Weekday),
  startTime: TimeOfDay,
  endTime: TimeOfDay,
  startDate: LocalDate.nullable(),
  endDate: LocalDate.nullable(),
  priority: z.number().int().min(0).max(1000),
});
export type ScheduleInput = z.infer<typeof ScheduleInput>;

export const Schedule = ScheduleInput.extend({
  id: Id,
  playlistName: z.string(),
  targetName: z.string(),
  createdAt: IsoDateTime,
});
export type Schedule = z.infer<typeof Schedule>;

// ---------------------------------------------------------------- audit

export const AuditEntry = z.object({
  id: Id,
  at: IsoDateTime,
  userName: z.string().nullable(),
  action: z.string(),
  entityType: z.string(),
  entityId: z.string().nullable(),
  summary: z.string(),
});
export type AuditEntry = z.infer<typeof AuditEntry>;
