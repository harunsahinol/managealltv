# @managealltv/server

Hono API + device WebSocket + background jobs. Contract: [`docs/API.md`](../../docs/API.md) and
[`packages/protocol`](../../packages/protocol). Runs with `tsx` (no build step).

## Development

```bash
cp .env.example .env            # adjust DATABASE_URL / BETTER_AUTH_SECRET / PUBLIC_URL
pnpm db:deploy                  # apply prisma/migrations (pnpm db:migrate to create a new one)
pnpm admin:invite -- --email you@example.com --name 'Ad Soyad'   # first admin: prints a one-time link
pnpm dev                        # http://localhost:3000, /health
```

`pnpm start` runs `src/index.ts` without loading `.env` (production passes the environment).
Behind Caddy set `TRUST_PROXY=true`, otherwise every client shares the proxy's IP for rate limits.

## Production

`Dockerfile` (build context: the repository root) produces the image that `deploy/docker-compose.yml`
runs behind Caddy: Node 22 + ffmpeg, non-root user, `prisma migrate deploy` before start, media in
the `/data/media` volume, `admin-invite` wrapper for the first admin. See [`deploy/README.md`](../../deploy/README.md)
(Turkish) for installation, backups and updates.

## Tests

`pnpm test` uses the PostgreSQL database `managealltv_test` (override with `TEST_DATABASE_URL`; the
name must end in `_test`). The global setup drops and recreates its `public` and `pgboss` schemas and
applies the migrations, then the files run one after another and truncate the tables between tests.

## Layout

| Path | What |
|---|---|
| `src/app.ts` | `createApp()` — the whole HTTP app without listening; route mounting point |
| `src/index.ts` | listen, WebSockets, jobs, maintenance timer, graceful shutdown |
| `src/auth.ts` | Better Auth (e-mail + password, sign-up disabled, TOTP) |
| `src/jobs.ts` | pg-boss: `registerJob`, `sendJob`, `startJobs`, `stopJobs` |
| `src/maintenance.ts` | minute timer: idle sockets, stale commands, old pairings/invites, stuck media, abandoned uploads |
| `src/lib/` | errors, validation, rate limit, origin check, client IP, crypto, storage paths, Range file sender |
| `src/middleware/` | `requireUser` / `requireRole` (session), `requireDevice` (bearer token) |
| `src/services/` | permissions (scope), audit, invites, pairing, devices, manifest, device hub, media views, playlists, schedules |
| `src/services/media-processing.ts` | pg-boss job `media.process`: sharp (images), ffprobe/ffmpeg (videos), thumbnails, hashes; housekeeping |
| `src/routes/uploads.ts` | tus 1.0 endpoint `/api/uploads` (`@tus/server`, file store under `MEDIA_DIR/uploads`) |
| `src/routes/` | one router per resource |
| `src/cli/create-admin-invite.ts` | `pnpm admin:invite` |
