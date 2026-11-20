# One image for setup, api, worker and web; workspace TypeScript sources stay in place.
# NPM_REGISTRY may select an installation mirror without changing the committed lock.
FROM node:24.22.3-trixie-slim@sha256:af02d57b57719b9657a45199a79264a9437940cd55b3c7b3fc99615654f124a0 AS base
ARG NPM_REGISTRY=
# Install tools and prepare writable directories before copying any application code.
# Normalize only entries created or changed by this install; keep the pinned Node layers reusable.
ARG SOURCE_DATE_EPOCH=0
RUN set -eu; \
    stamp=$(mktemp); \
    apt-get update; \
    apt-get install -y --no-install-recommends postgresql-client ca-certificates; \
    npm install -g npm@11.19.0 --ignore-scripts --no-audit --no-fund ${NPM_REGISTRY:+--registry=$NPM_REGISTRY}; \
    rm -rf /var/lib/apt/lists/* /var/log/* /var/cache/ldconfig/aux-cache /root/.npm /tmp/node-compile-cache*; \
    mkdir -p /app /data /backups; chown node:node /data /backups; chmod 700 /backups; \
    find /etc /usr /var /root /run /opt /tmp /app /data /backups -xdev -depth \
      ! -path /etc/hosts ! -path /etc/resolv.conf ! -path /etc/hostname \
      -cnewer "$stamp" -exec touch -h -d "@$SOURCE_DATE_EPOCH" {} +; \
    rm "$stamp"; touch -d "@$SOURCE_DATE_EPOCH" /tmp /app /data /backups
WORKDIR /app

FROM base AS dependencies
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
FROM dependencies AS production-dependencies
RUN npm prune --omit=dev --no-audit --no-fund ${NPM_REGISTRY:+--registry=$NPM_REGISTRY} \
 && npm cache clean --force

# npm extraction and workspace links inherit wall-clock mtimes on fresh builders.
RUN find /app -depth -exec touch -h -d @0 {} +

FROM dependencies AS build
COPY . .
RUN npm run build --workspace @amp/web

FROM base
ENV NODE_ENV=production
COPY --from=production-dependencies --chown=node:node /app /app
COPY --chown=node:node . .
COPY --from=build --chown=node:node /app/apps/web/build /app/apps/web/build
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.ts"]
