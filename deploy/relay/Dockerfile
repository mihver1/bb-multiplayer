# Pinned official multi-platform Node image; update explicitly after verification.
FROM node:22-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d AS dependencies
WORKDIR /app
# This pinned Node ABI has an upstream SQLite Linux prebuild. Fail rather than
# install a compiler or change the host when a prebuild is unavailable.
COPY deploy/relay/package.json deploy/relay/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
    && node -e "const db=require('better-sqlite3')(':memory:');db.prepare('SELECT 1').get();db.close()"

FROM node:22-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d
LABEL org.opencontainers.image.title="BB Multiplayer relay" \
      org.opencontainers.image.description="Isolated experimental collaboration relay; no BB or provider credentials."
WORKDIR /app
ENV NODE_ENV=production \
    MULTIPLAYER_HOST=0.0.0.0 \
    MULTIPLAYER_PORT=4789 \
    MULTIPLAYER_DATA_DIR=/data
COPY --from=dependencies /app/node_modules ./node_modules
COPY deploy/relay/package.json ./package.json
COPY relay/ ./relay/
COPY shared/protocol.ts ./shared/protocol.ts
USER 1000:1000
EXPOSE 4789
ENTRYPOINT ["node", "--import", "tsx", "relay/main.ts"]
CMD ["serve"]
