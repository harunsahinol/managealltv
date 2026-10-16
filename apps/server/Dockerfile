# ManageAllTV API server (Hono + WebSocket + media processing). Build context = repository root:
#
#   docker build -f apps/server/Dockerfile -t managealltv-server .
#
# deploy/docker-compose.yml builds it this way. The server runs TypeScript through tsx (no build
# step), so the image carries the server sources, the shared protocol package and node_modules.
# Apply migrations and start: the default command does both.

ARG NODE_IMAGE=node:22-bookworm-slim

# ------------------------------------------------------------------ dependencies + Prisma client
FROM ${NODE_IMAGE} AS build

# Prisma downloads the engine matching the installed OpenSSL; the slim image has none, so install the
# same Debian package the runtime stage gets (otherwise the engine would be built for the wrong one).
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ENV CI=true \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    CHECKPOINT_DISABLE=1 \
    PRISMA_HIDE_UPDATE_MESSAGE=1
# pnpm comes from the root package.json "packageManager" field.
RUN corepack enable

WORKDIR /app

# Manifests first: the dependency layer is reused until a package.json or the lockfile changes.
# --frozen-lockfile needs every workspace manifest, even though only the server's tree is installed.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/protocol/package.json packages/protocol/
# Dev dependencies stay: the Prisma CLI (migrate deploy at start-up) is one.
RUN --mount=type=cache,id=managealltv-pnpm-store,target=/pnpm-store \
    pnpm install --frozen-lockfile --store-dir /pnpm-store --filter "@managealltv/server..."

COPY packages/protocol packages/protocol
COPY apps/server apps/server
RUN cd apps/server && node_modules/.bin/prisma generate

# ------------------------------------------------------------------ runtime
FROM ${NODE_IMAGE} AS runtime

# ffmpeg/ffprobe for video processing, openssl for the Prisma engines.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PORT=3000 \
    MEDIA_DIR=/data/media \
    CHECKPOINT_DISABLE=1 \
    PRISMA_HIDE_UPDATE_MESSAGE=1

# Owned by root and read-only for the service user: the process can write only to MEDIA_DIR and /tmp.
COPY --from=build /app /app
WORKDIR /app/apps/server

# A new named volume takes over this directory's owner, so the unprivileged user can write to it.
RUN mkdir -p /data/media \
 && chown node:node /data/media \
 && printf '#!/bin/sh\ncd /app/apps/server && MANAGEALLTV_CLI_COMMAND=admin-invite exec node --import tsx src/cli/create-admin-invite.ts "$@"\n' > /usr/local/bin/admin-invite \
 && chmod 755 /usr/local/bin/admin-invite

# The "node" user (uid 1000) of the official image.
USER node
VOLUME ["/data/media"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

# node runs as PID 1's child of the compose init (tini) and handles SIGTERM itself (graceful
# shutdown); `node --import tsx` keeps it a single process, unlike the tsx CLI wrapper.
CMD ["sh", "-c", "node_modules/.bin/prisma migrate deploy && exec node --import tsx src/index.ts"]
