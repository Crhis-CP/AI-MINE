# One image for setup, api, worker and web; workspace TypeScript sources stay in place.
# NPM_REGISTRY may select an installation mirror without changing the committed lock.
FROM node:24.21.0-trixie-slim@sha256:8ec5d7557396cfe32d21c3f9c13072355ceab22b584578ca4bb28af31120cffe AS base
ARG NPM_REGISTRY=
WORKDIR /app
# pg_dump for the optional database backups (Debian's client matches the PostgreSQL 17 server in compose).
RUN apt-get update \
 && apt-get install -y --no-install-recommends postgresql-client ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN npm install -g npm@11.19.0 --ignore-scripts --no-audit --no-fund ${NPM_REGISTRY:+--registry=$NPM_REGISTRY}

FROM base AS build
ARG NPM_REGISTRY=
COPY package.json package-lock.json .npmrc ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/backend/package.json packages/backend/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY industry/package.json industry/package.json
COPY site/package.json site/package.json
COPY modules/metals/package.json modules/metals/package.json
COPY modules/policy/package.json modules/policy/package.json
COPY modules/site-admin/package.json modules/site-admin/package.json
# Source edits reuse the installed workspace dependencies; installation scripts stay disabled by .npmrc.
RUN npm ci --no-audit --no-fund ${NPM_REGISTRY:+--registry=$NPM_REGISTRY} \
 && npm cache clean --force
COPY . .
RUN npm run build --workspace @amp/web \
 && npm prune --omit=dev --no-audit --no-fund ${NPM_REGISTRY:+--registry=$NPM_REGISTRY} \
 && npm cache clean --force

FROM base
ENV NODE_ENV=production
COPY --from=build --chown=node:node /app /app
RUN mkdir -p /data /backups && chown node:node /data /backups && chmod 700 /backups
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.ts"]
