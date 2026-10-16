# Caddy with the built admin panel. Build context = repository root:
#
#   docker build -f deploy/web.Dockerfile -t managealltv-web .
#
# Caddy serves the panel (a single-page app) and reverse-proxies /api (including the device
# WebSocket) and /health to the server; see deploy/Caddyfile.

ARG NODE_IMAGE=node:22-bookworm-slim
ARG CADDY_IMAGE=caddy:2

# ------------------------------------------------------------------ panel build
FROM ${NODE_IMAGE} AS build

ENV CI=true \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/protocol/package.json packages/protocol/
RUN --mount=type=cache,id=managealltv-pnpm-store,target=/pnpm-store \
    pnpm install --frozen-lockfile --store-dir /pnpm-store --filter "@managealltv/web..."

COPY packages/protocol packages/protocol
COPY apps/web apps/web
RUN pnpm --filter @managealltv/web build

# ------------------------------------------------------------------ Caddy
FROM ${CADDY_IMAGE}

COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/apps/web/dist /srv/panel
