# syntax=docker/dockerfile:1
# One image, one process: the API, the web app and the webhook worker (see docs/deployment.md).

FROM node:22-bookworm-slim AS build
# Toolchain for better-sqlite3, in case no prebuilt binary matches the platform.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /src
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm build
# The bundles inline every pure-JS dependency; only the native SQLite driver is installed beside them.
RUN mkdir -p /out \
  && cp -r dist /out/dist \
  && cp -r apps/web/build /out/web \
  && cd /out \
  && printf '{"name":"tracker-runtime","private":true,"type":"module","dependencies":{"better-sqlite3":"%s"}}\n' \
       "$(node -p "require('/src/packages/db/node_modules/better-sqlite3/package.json').version")" > package.json \
  && npm install --omit=dev --no-audit --no-fund

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    NODE_OPTIONS=--enable-source-maps \
    POIETIC_ISSUES_HOST=0.0.0.0 \
    POIETIC_ISSUES_PORT=3000 \
    POIETIC_ISSUES_WEB_DIR=/app/web \
    POIETIC_ISSUES_DATABASE_URL=sqlite:/data/tracker.db \
    POIETIC_ISSUES_BLOB_DIR=/data/blobs \
    POIETIC_ISSUES_AUTO_MIGRATE=1
WORKDIR /app
COPY --from=build /out /app
# The operator tool (local mode on the image's database); there is no remote CLI in the image.
RUN printf '#!/bin/sh\nexec node /app/dist/poietic-issues-admin.mjs "$@"\n' > /usr/local/bin/poietic-issues-admin \
  && chmod +x /usr/local/bin/poietic-issues-admin \
  && mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:3000/readyz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["node", "dist/server.mjs"]
