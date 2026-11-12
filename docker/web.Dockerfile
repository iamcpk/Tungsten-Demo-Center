# Public site image. Build from the repo root:  docker build -f docker/web.Dockerfile .
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
COPY apps/web apps/web
RUN npm run build -w @tdc/core && npm run build -w @tdc/web

FROM node:25-alpine
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY apps/web/package.json apps/web/
COPY apps/admin/package.json apps/admin/
COPY apps/encoder/package.json apps/encoder/
COPY tools/importer/package.json tools/importer/
RUN npm ci --omit=dev --ignore-scripts -w @tdc/web -w @tdc/core && npm cache clean --force
COPY --from=build /src/packages/core/dist packages/core/dist
COPY --from=build /src/apps/web/dist apps/web/dist
USER node
EXPOSE 8080
CMD ["node", "apps/web/dist/server/server.js"]
