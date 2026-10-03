# One image for every role: setup (migrations and seed), api, worker and web.
# Build arg NPM_REGISTRY switches the npm registry (e.g. https://registry.npmmirror.com in mainland China).
# Base image pinned to a patch version and its digest (T-0001); bump both together.
# Dependencies are installed with pnpm over the whole repository: `pnpm deploy` is not used, it does not
# work with Node's TypeScript type stripping (the workspace packages export .ts sources).
FROM node:24.21.0-trixie-slim@sha256:8ec5d7557396cfe32d21c3f9c13072355ceab22b584578ca4bb28af31120cffe AS base
ARG NPM_REGISTRY=
WORKDIR /app
# pg_dump for the optional database backups (Debian's client matches the PostgreSQL 17 server in compose).
RUN apt-get update \
 && apt-get install -y --no-install-recommends postgresql-client ca-certificates \
 && rm -rf /var/lib/apt/lists/*
# pnpm at the version package.json's packageManager names.
RUN npm install -g pnpm@12.8.1 --no-audit --no-fund ${NPM_REGISTRY:+--registry=$NPM_REGISTRY}

FROM base AS build
ARG NPM_REGISTRY=
COPY . .
RUN pnpm install --frozen-lockfile ${NPM_REGISTRY:+--registry=$NPM_REGISTRY} \
 && pnpm --filter @amp/web build

FROM base
ARG NPM_REGISTRY=
ENV NODE_ENV=production
COPY . .
COPY --from=build /app/apps/web/build apps/web/build
# Production dependencies only; the package store is dropped in the same layer. The root scripts this image
# runs (setup's migrate and seed, verify's smoke) find their imports through the root package.json's dependencies.
RUN pnpm install --prod --frozen-lockfile --store-dir /tmp/pnpm-store ${NPM_REGISTRY:+--registry=$NPM_REGISTRY} \
 && rm -rf /tmp/pnpm-store \
 && chown -R node:node /app \
 && mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.ts"]
