# HLS encoder job image (Node + ffmpeg). Build from the repo root:  docker build -f docker/encoder.Dockerfile .
FROM node:25-alpine AS build
WORKDIR /src
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY apps/web/package.json apps/web/
COPY apps/admin/package.json apps/admin/
COPY apps/encoder/package.json apps/encoder/
COPY tools/importer/package.json tools/importer/
RUN npm ci --ignore-scripts
COPY packages/core packages/core
COPY apps/encoder apps/encoder
RUN npm run build -w @tdc/core && npm run build -w @tdc/encoder

FROM node:25-alpine
RUN apk add --no-cache ffmpeg
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY apps/web/package.json apps/web/
COPY apps/admin/package.json apps/admin/
COPY apps/encoder/package.json apps/encoder/
COPY tools/importer/package.json tools/importer/
RUN npm ci --omit=dev --ignore-scripts -w @tdc/encoder -w @tdc/core && npm cache clean --force
COPY --from=build /src/packages/core/dist packages/core/dist
COPY --from=build /src/apps/encoder/dist apps/encoder/dist
USER node
CMD ["node", "apps/encoder/dist/index.js"]
