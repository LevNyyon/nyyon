# Nyyon Command Center — a self-owned install.
#
# Everything runs in THIS container: the app, its SQLite database (on the
# mounted volume), and the scheduled work. Nothing is hosted elsewhere.
#
# The web bundle and the plugin packs are built HERE, once, at image build
# time — so the running instance never spends memory rebuilding itself and
# fits comfortably in a small machine.
FROM node:22-slim AS build
WORKDIR /app

# Dependencies first, so a code change does not re-download the world.
COPY package*.json ./
COPY web/package*.json ./web/
COPY workers/api/package*.json ./workers/api/
RUN npm install --no-audit --no-fund \
 && (cd web && npm install --no-audit --no-fund) \
 && (cd workers/api && npm install --no-audit --no-fund)

COPY . .

# Bake the bundled plugins into the tree (the applier's build-time twin), then
# build the SPA. A pack the validator refuses fails the image, not the user.
RUN node scripts/materialize-bundled.mjs \
 && (cd web && npm run build)

FROM node:22-slim
WORKDIR /app
# sqlite3 for nothing at runtime, ca-certificates for outbound TLS.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /app /app

# The build already happened; the instance serves the artifact.
ENV NYYON_PREBUILT=1 \
    NYYON_SKIP_APPLIER=1 \
    NYYON_INTERNAL_CRON=1 \
    NYYON_BIND_IP=0.0.0.0 \
    NYYON_STATE_DIR=/data/wrangler \
    PORT=8080
EXPOSE 8080
CMD ["bash", "./deploy/render-start.sh"]
