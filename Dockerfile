# BaitNet — single-service image (API + dashboard on one port), used by Railway (railway.json).
# The server runs TypeScript directly with tsx (no compile step); the web app is built to
# apps/web/dist and served by the server itself.
#
#   docker build -t baitnet .
#   docker run --rm -p 8080:8080 -e PORT=8080 -v baitnet-data:/data baitnet
#
# No .env and no data/ ever enter the image (.dockerignore); all config comes from env vars,
# all state lives in the volume at /data. Single replica only (sqlite on a volume).

ARG NODE_VERSION=22.22.2

# ---------------------------------------------------------------- build
FROM node:${NODE_VERSION}-bookworm-slim AS build
ARG PNPM_VERSION=10.34.9
ENV CI=true
RUN npm install -g --no-fund --no-audit "pnpm@${PNPM_VERSION}"
WORKDIR /app
# manifests first so the dependency layer is cached across code-only changes
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/agent/package.json apps/agent/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/arena/package.json packages/arena/
COPY packages/guard/package.json packages/guard/
COPY packages/im/package.json packages/im/
COPY packages/scriptlab/package.json packages/scriptlab/
COPY packages/shared/package.json packages/shared/
COPY packages/training/package.json packages/training/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter @baitnet/web build \
  && test -f apps/web/dist/index.html \
  && rm -rf data .env .env.* .cache

# ---------------------------------------------------------------- runtime
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
# gosu: drop from root to `node` after fixing volume ownership (docker-entrypoint.sh)
RUN apt-get update \
  && apt-get install -y --no-install-recommends gosu \
  && rm -rf /var/lib/apt/lists/* \
  && gosu nobody true
ENV NODE_ENV=production \
  HOST=0.0.0.0 \
  PORT=8080 \
  BAITNET_DATA_DIR=/data \
  BAITNET_WEB_DIST=/app/apps/web/dist \
  NODE_OPTIONS=--disable-warning=ExperimentalWarning
WORKDIR /app
COPY --from=build --chown=node:node /app /app
COPY deploy/docker-entrypoint.sh /usr/local/bin/baitnet
RUN chmod 755 /usr/local/bin/baitnet && mkdir -p /data && chown node:node /data
EXPOSE 8080
# Starts as root only to chown the mounted volume, then runs everything as `node` (see entrypoint).
ENTRYPOINT ["/usr/local/bin/baitnet"]
CMD ["start"]
