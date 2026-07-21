# syntax=docker/dockerfile:1.7

FROM node:24-alpine AS dependencies
RUN corepack enable
WORKDIR /app
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml .npmrc ./
COPY apps/server/package.json ./apps/server/
COPY apps/web/package.json ./apps/web/
COPY packages/config/package.json ./packages/config/
# Every workspace package needs its manifest listed here before `pnpm install`,
# or the install creates no node_modules for it and its build fails inside the
# image with a misleading "Cannot find type definition file for 'node'" --
# while `pnpm build` on a developer machine passes, because there the install
# already covered the whole workspace. Adding a package under packages/ means
# adding a line here.
COPY packages/crypto/package.json ./packages/crypto/
COPY packages/database/package.json ./packages/database/
COPY packages/logger/package.json ./packages/logger/
COPY packages/shared/package.json ./packages/shared/
RUN pnpm install --frozen-lockfile

FROM dependencies AS builder
WORKDIR /app
COPY . .
RUN pnpm run build
RUN pnpm deploy --filter=@harbor/server --prod --legacy /app/deploy

FROM node:24-alpine AS runtime

# Overridable at build time (e.g. `--build-arg HARBOR_VERSION=1.2.3` from CI using the
# release tag). Defaults to the workspace version so a manual `docker build` still reports
# something meaningful instead of falling back to the "0.1.0-dev" placeholder baked into
# apps/server/src/modules/health/routes.ts.
ARG HARBOR_VERSION=0.1.0

RUN apk add --no-cache wget && addgroup -S harbor && adduser -S harbor -G harbor
WORKDIR /app

COPY --from=builder --chown=harbor:harbor /app/deploy/node_modules ./node_modules
COPY --from=builder --chown=harbor:harbor /app/apps/server/dist ./dist
COPY --from=builder --chown=harbor:harbor /app/apps/server/public ./public
COPY --from=builder --chown=harbor:harbor /app/packages/database/drizzle ./packages/database/drizzle

ENV NODE_ENV=production \
    HARBOR_PORT=3000 \
    HARBOR_HOST=0.0.0.0 \
    HARBOR_DATA_DIRECTORY=/data \
    HARBOR_MIGRATIONS_DIR=/app/packages/database/drizzle \
    HARBOR_VERSION=${HARBOR_VERSION}

RUN mkdir -p /data && chown -R harbor:harbor /data
VOLUME ["/data"]

USER harbor
EXPOSE 3000

# Probe readiness, not liveness: readiness only returns 200 once the DB is reachable,
# migrations are applied, and /data is writable, so this reflects whether Harbor can
# actually serve requests. Failures during start_period count as "starting", not
# unhealthy, so the longer window just covers first-boot migrations.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=5 \
  CMD wget --spider --quiet http://localhost:3000/api/v1/health/ready || exit 1

CMD ["node", "dist/server.js"]
