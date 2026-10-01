# One image, two modes: FILEDECK_MODE=agent (per node, hostPath mounted at /host)
# or FILEDECK_MODE=hub (serves the SPA and proxies to the agents).
FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS build
WORKDIR /src
# bsdtar (libarchive) is needed by the archive integration tests too; ffmpeg by the thumbnail tests.
RUN apk add --no-cache libarchive-tools ffmpeg
COPY package.json package-lock.json tsconfig.base.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --no-audit --no-fund
COPY server server
COPY web web
# Optional deployment overlay: a `deploy/brand/` folder (logos) is served from /assets/brand. The wildcard keeps a
# bare clone of the core (no deploy/ folder) building; package.json is only there so the COPY always has a source.
COPY package.json deploy* deploy-in/
RUN npm run build \
 && if [ -d deploy-in/brand ]; then mkdir -p web/dist/assets/brand && cp deploy-in/brand/* web/dist/assets/brand/; fi \
 && npm test && npm prune --omit=dev --workspace=server

FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402
ENV NODE_ENV=production FILEDECK_STATIC=/app/web PORT=8080
WORKDIR /app
# libarchive's bsdtar does zip/tar.*/7z encode and decode for the archive jobs;
# samba-client's smbclient backs the SMB network sources (hub mode);
# ffmpeg makes the image/video thumbnails (run as an unprivileged child, see server/src/thumbs.ts);
# `apk upgrade` keeps the base packages on patched versions for the Trivy gate.
RUN apk upgrade --no-cache && apk add --no-cache libarchive-tools samba-client ffmpeg
COPY --from=build /src/node_modules node_modules
COPY --from=build /src/server/package.json server/package.json
COPY --from=build /src/server/dist server/dist
COPY --from=build /src/web/dist web
# Alpine ships npm/yarn, which this image never runs; drop them to shrink the scan surface.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx /opt/yarn* /usr/local/bin/yarn*
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD ["wget", "-qO-", "http://127.0.0.1:8080/healthz"]
CMD ["node", "server/dist/main.js"]
