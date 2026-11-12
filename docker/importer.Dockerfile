# One-off iVengi importer, run as a manually started Container Apps Job.
# Build from the repo root:  docker build -f docker/importer.Dockerfile .
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
COPY tools/importer tools/importer
RUN npm run build -w @tdc/core && npm run build -w @tdc/importer

FROM node:25-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY apps/web/package.json apps/web/
COPY apps/admin/package.json apps/admin/
COPY apps/encoder/package.json apps/encoder/
COPY tools/importer/package.json tools/importer/
RUN npm ci --omit=dev --ignore-scripts -w @tdc/importer -w @tdc/core && npm cache clean --force
COPY --from=build /src/packages/core/dist packages/core/dist
COPY --from=build /src/tools/importer/dist tools/importer/dist
USER node
WORKDIR /app/tools/importer
ENTRYPOINT ["node", "dist/index.js"]
# Arguments are supplied when the job is started, for example: --blob ivengi-export.xlsx --write
CMD ["--help"]
