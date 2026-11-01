# syntax=docker/dockerfile:1
# The GitHub ↔ Poietic Issues sync: one process, built from the repository root:
#   docker build --platform linux/amd64 -f apps/github-sync/Dockerfile -t poietic-issues-github-sync:<tag> .

FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS build
RUN corepack enable
WORKDIR /src
COPY . .
RUN pnpm install --frozen-lockfile --ignore-scripts
RUN pnpm --filter @poietic-tech/issues-github-sync build

FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
ENV NODE_ENV=production \
    NODE_OPTIONS=--enable-source-maps \
    SYNC_STATE_FILE=/data/sync.db
WORKDIR /app
COPY --from=build /src/apps/github-sync/dist /app/dist
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8080
CMD ["node", "dist/github-sync.mjs"]
