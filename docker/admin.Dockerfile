# Admin portal image. Build from the repo root:  docker build -f docker/admin.Dockerfile .
FROM node:24-alpine AS build
WORKDIR /src
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY apps/web/package.json apps/web/
COPY apps/admin/package.json apps/admin/
COPY apps/encoder/package.json apps/encoder/
COPY tools/importer/package.json tools/importer/
RUN npm ci --ignore-scripts
COPY packages/core packages/core
COPY apps/admin apps/admin
RUN npm run build -w @tdc/core && npm run build -w @tdc/admin

FROM node:24-alpine
# Recorded in backups so it's clear which build made them.
ARG APP_VERSION=dev
ENV NODE_ENV=production PORT=8080 APP_VERSION=$APP_VERSION
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY apps/web/package.json apps/web/
COPY apps/admin/package.json apps/admin/
COPY apps/encoder/package.json apps/encoder/
COPY tools/importer/package.json tools/importer/
RUN npm ci --omit=dev --ignore-scripts -w @tdc/admin -w @tdc/core && npm cache clean --force
COPY --from=build /src/packages/core/dist packages/core/dist
COPY --from=build /src/apps/admin/dist apps/admin/dist
USER node
EXPOSE 8080
CMD ["node", "apps/admin/dist/server/server.js"]
