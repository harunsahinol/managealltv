# API Contract

Request/response schemas live in `packages/protocol` (Zod). This document lists routes, permissions
and behaviour. Every JSON error response has the shape `{ "error": { "code": string, "message": string } }`
(`ApiError`); `message` is Turkish and may be shown to users, `code` is stable English snake_case.

Common error codes: `validation_error` (400), `unauthorized` (401), `forbidden` (403), `not_found` (404),
`conflict` / specific codes (409), `rate_limited` (429), `internal` (500).

## Roles and scope

| Role | Can do |
|---|---|
| `admin` | Everything. Sees all locations. |
| `editor` | Upload/edit media, create/edit playlists. For devices **in their locations**: change default playlist and volume, send commands, manage schedules. |
| `viewer` | Read-only, devices/schedules **in their locations**; media and playlists read-only. |

"Scoped" below means: admins see everything, editors/viewers only devices whose `locationId` is in their
`locationIds`, and schedules whose target is such a device or location. Out-of-scope single resources
return `404` (not 403) so existence is not leaked.

## Health

- `GET /health` → `{ "status": "ok" }`

## Device API — `/api/device/v1`

Authentication: `Authorization: Bearer <deviceToken>` (except pairing). An unknown or revoked token
returns `401 { error: { code: "unauthorized" } }`; the device must then delete its token and pair again.
Device tokens are `mtv_d_` + 43 base64url chars (32 random bytes); the server stores only a SHA-256 hash.

| Method & path | Body → Response | Notes |
|---|---|---|
| `POST /pair` | `PairRequest` → `PairResponse` | Creates a pairing valid for 15 min. Code: 6 digits, unique among open pairings. Rate limited per IP (10/min). |
| `POST /pair/poll` | `PairPollRequest` → `PairPollResponse` | `pending` until an admin claims the code, then `paired` with the token **exactly once** (the token is generated at that moment; the pairing is consumed). `expired` after 15 min. Rate limited per IP (60/min). Unknown secret → `expired`. |
| `GET /manifest` | → `Manifest` | Sends `ETag: "<version>"`. With matching `If-None-Match` → `304`. |
| `GET /media/:mediaId` | → file bytes | Only media present in this device's current manifest (else 404). Supports `Range` (206), `Accept-Ranges`, `Content-Length`, `ETag: "<sha256>"`, correct `Content-Type`. |
| `POST /status` | `DeviceStatus` → `StatusAck` | HTTP fallback heartbeat when the WebSocket is down. Updates last seen. |
| `POST /commands/:id/result` | `CommandResult` → `204` | HTTP fallback for command results. |
| `GET /ws` | WebSocket | Same bearer header on the upgrade request. Messages: `ServerToDevice` / `DeviceToServer`. |

WebSocket behaviour:
- One connection per device; a new connection closes the previous one.
- On connect the server sends pending commands created in the last 10 minutes (older pending commands
  become `expired`), marking them `sent`.
- On every `status` message: update `lastSeenAt` and the stored status; if `status.manifestVersion`
  differs from the server's version, reply `manifest_updated`.
- When a device is deleted in the panel: send `unpaired`, then close.
- A device is online when `lastSeenAt` is within `OFFLINE_AFTER_SEC` (90 s).

### Manifest building

For device D in location L:
- `schedule`: rules targeting D or L, ordered by `priority` desc, then `createdAt` asc.
- `playlists`: D's default playlist plus every playlist referenced by those rules. Items whose media is
  not `ready` are left out.
- `media`: every ready media referenced by those playlists, once. `path` = `/api/device/v1/media/<id>`.
- `timezone` = L's timezone, `settings.volume` = D's volume, `settings.defaultImageDurationSec` = 10.
- The server hashes the manifest content (everything except `version` and `generatedAt`). When the hash
  differs from the stored one, `version` is incremented and a `manifest_updated` message is pushed.
  This check runs after every mutation that can affect manifests (media ready/deleted, playlist changes,
  schedule changes, device or location changes) and also when a manifest is requested.
- `manifestIssues()` from the protocol package must return no problems.

## Admin API — `/api`

Authentication: Better Auth session cookie (`/api/auth/*`). E-mail + password, public sign-up disabled,
TOTP two-factor plugin available. Disabled users cannot sign in and lose their sessions.

### Me, users, invites

| Method & path | Who | Body → Response |
|---|---|---|
| `GET /api/me` | any | → `Me` |
| `GET /api/users` | admin | → `User[]` |
| `PATCH /api/users/:id` | admin | `UserUpdate` → `User`. The last active admin cannot be demoted or disabled (`409 last_admin`); you cannot disable yourself. Disabling revokes sessions. |
| `POST /api/users/invites` | admin | `InviteCreate` → `InviteLink` (`409 email_taken` if the e-mail exists) |
| `POST /api/users/:id/password-reset` | admin | → `InviteLink` (kind `password_reset`) |
| `GET /api/invites/:token` | public | → `InviteInfo` (`404` if unknown, used or expired) |
| `POST /api/invites/:token/accept` | public | `InviteAccept` → `204`. Invite: creates the user with the role/locations. Reset: sets the new password and revokes sessions. Tokens are single-use, valid 72 h, stored hashed. Link: `{PUBLIC_URL}/invite/<token>`. |

### Locations

| Method & path | Who | Body → Response |
|---|---|---|
| `GET /api/locations` | any (scoped) | → `Location[]` |
| `POST /api/locations` | admin | `LocationInput` → `Location` |
| `PATCH /api/locations/:id` | admin | `LocationInput` (partial) → `Location` |
| `DELETE /api/locations/:id` | admin | → `204`; `409 location_not_empty` if it has devices |

### Devices

| Method & path | Who | Body → Response |
|---|---|---|
| `GET /api/devices` | any (scoped) | → `Device[]` |
| `GET /api/devices/:id` | any (scoped) | → `Device` |
| `POST /api/devices/claim` | admin | `DeviceClaim` → `Device` (`404 pairing_not_found` for an unknown/expired code). Rate limited. |
| `PATCH /api/devices/:id` | admin; editor (scoped) | `DeviceUpdate` → `Device`. Editors may only change `defaultPlaylistId` and `volume`. |
| `DELETE /api/devices/:id` | admin | → `204`. Revokes the token, sends `unpaired`. |
| `GET /api/devices/:id/commands` | any (scoped) | → `CommandView[]` (latest 50) |
| `POST /api/devices/:id/commands` | admin; editor (scoped) | `Command` → `CommandView`. Delivered immediately if connected, otherwise kept `pending`. |

### Media

| Method & path | Who | Body → Response |
|---|---|---|
| tus `/api/uploads` | admin, editor | tus 1.0 resumable upload. Metadata: `filename` (required), `filetype`. Max `MAX_UPLOAD_BYTES`. When finished a `Media` (`processing`) is created and a processing job queued; the final response carries a `Media-Id` header. |
| `GET /api/media` | any | → `Media[]` (newest first) |
| `GET /api/media/:id` | any | → `Media` |
| `PATCH /api/media/:id` | admin, editor | `MediaUpdate` → `Media` |
| `DELETE /api/media/:id` | admin; editor (own uploads) | → `204`; `409 media_in_use` if a playlist contains it |
| `GET /api/media/:id/thumbnail` | any | → JPEG (404 until ready) |
| `GET /api/media/:id/file` | any | → processed file, supports `Range` (preview in the panel) |

Processing (one job at a time):
- Images: auto-rotate by EXIF, fit inside 1920×1080 without enlarging, JPEG quality 85, metadata stripped.
- Videos: H.264 High ≤ level 4.1, ≤ 1920×1080, ≤ 30 fps, yuv420p, keyframe every 2 s, AAC-LC 48 kHz stereo,
  loudness normalised (`loudnorm=I=-16:TP=-1.5:LRA=11`), MP4 with `+faststart`. If the video stream is already
  compatible it is copied and only the audio is re-encoded.
- Thumbnail 480 px wide JPEG. SHA-256, size, duration, width and height are stored.
- Failure → status `failed` with a message. The uploaded original is deleted afterwards.

### Playlists

| Method & path | Who | Body → Response |
|---|---|---|
| `GET /api/playlists` | any | → `Playlist[]` |
| `POST /api/playlists` | admin, editor | `PlaylistInput` → `PlaylistDetail` |
| `GET /api/playlists/:id` | any | → `PlaylistDetail` |
| `PATCH /api/playlists/:id` | admin, editor | `PlaylistInput` → `PlaylistDetail` |
| `PUT /api/playlists/:id/items` | admin, editor | `PlaylistItemsInput` → `PlaylistDetail` (unknown media → `400`) |
| `DELETE /api/playlists/:id` | admin, editor | → `204`; `409 playlist_in_use` if a device default or a schedule uses it |

### Schedules

| Method & path | Who | Body → Response |
|---|---|---|
| `GET /api/schedules` | any (scoped) | → `Schedule[]` |
| `POST /api/schedules` | admin; editor (scoped target) | `ScheduleInput` → `Schedule` |
| `PATCH /api/schedules/:id` | admin; editor (scoped) | `ScheduleInput` (partial) → `Schedule` |
| `DELETE /api/schedules/:id` | admin; editor (scoped) | → `204` |

### Audit log

| Method & path | Who | Body → Response |
|---|---|---|
| `GET /api/audit?limit=100&before=<ISO>` | admin | → `AuditEntry[]` newest first |

Every mutating admin action writes an entry (user, action such as `device.claim`, entity, Turkish summary, IP).
