# ---------------------------------------------------------------------------
# Builder stage: installs full (dev + prod) dependencies for both the root
# server package and the client package, then builds the client bundle.
# Nothing from this stage ships in the final image except client/dist.
# ---------------------------------------------------------------------------
FROM node:24-alpine AS builder
WORKDIR /app

# Install dependencies first (better layer caching) using the committed
# lockfiles for deterministic installs.
COPY package.json package-lock.json ./
COPY client/package.json client/package-lock.json ./client/
RUN npm ci
RUN cd client && npm ci

# Copy the rest of the source and build the client bundle. Root's "build"
# script runs "cd client && npm run build" (vite build), producing
# client/dist.
COPY . .
RUN npm run build

# ---------------------------------------------------------------------------
# Final stage: production-only image. Installs only root production
# dependencies (server-side runtime deps such as express/pg/etc) and copies
# in just the application code and the pre-built client bundle from the
# builder stage. No client devDependencies (vite, @vitejs/*, tailwindcss,
# etc.) and no root devDependencies (jest, eslint, nodemon, etc.) are
# present in this image.
# ---------------------------------------------------------------------------
FROM node:24-alpine
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Amazon RDS TLS root CA bundle. Aurora/RDS server certificates chain to the
# Amazon RDS regional root CA, which is NOT in Node's default (public/Mozilla)
# trust store -- so a production DB connection with rejectUnauthorized:true and
# no explicit CA fails with UNABLE_TO_GET_ISSUER_CERT_LOCALLY. The app's pool
# (server/config/database.js) verifies against DB_CA_PATH when set, so bake the
# region-agnostic global bundle into the image and point DB_CA_PATH at it. This
# keeps rejectUnauthorized:true (no verification weakening) and works in every
# region. `ca-certificates` is required so wget can validate the truststore
# host's own (public) TLS cert while downloading.
RUN apk add --no-cache ca-certificates \
  && wget -q -O /app/rds-global-bundle.pem https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem \
  && test -s /app/rds-global-bundle.pem
ENV DB_CA_PATH=/app/rds-global-bundle.pem

COPY server/ ./server/
COPY database/ ./database/
COPY docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh
COPY --from=builder /app/client/dist ./client/dist

# node:24-alpine ships a pre-existing non-root "node" user/group at UID/GID
# 1000 (home /home/node), so there is no need to create a new one. All
# preceding steps (npm ci, COPY) run as root and therefore leave /app
# root-owned; chown it to "node" before switching users so the runtime
# process has read access to its own application files without needing
# write access to anything it doesn't own.
RUN chown -R node:node /app
USER node

EXPOSE 3000

# Requirement 19.4 / 14.7: Docker-level HEALTHCHECK against GET /health (the
# DB-connectivity-checking liveness route from server/routes/health.js, not
# /health/ready or /health/live). node:24-alpine does not ship curl, but it
# does ship BusyBox's wget, so that's used here instead of a Node one-liner.
# `wget -q -O /dev/null` discards the response body and, by default, treats
# any non-2xx HTTP status (e.g. the 503 returned when the DB check fails) as
# a failure, exiting non-zero -- so a 503 correctly makes Docker report the
# container unhealthy rather than just "reachable".
# start-period is generous because the entrypoint runs DB migrations + seed
# BEFORE the app listens on 3000; on a fresh Aurora the baseline migration can
# take a while, and health probes during that window must not count as
# failures. (The ECS service also sets its own healthCheckGracePeriod.)
HEALTHCHECK --interval=30s --timeout=5s --start-period=180s --retries=3 \
  CMD wget -q -O /dev/null http://localhost:3000/health || exit 1

# Run DB init (migrations + seed) before starting the app — see
# docker-entrypoint.sh. CMD is passed as "$@" to the entrypoint.
ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["npm", "start"]
