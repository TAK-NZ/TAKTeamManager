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

COPY server/ ./server/
COPY database/ ./database/
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
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -q -O /dev/null http://localhost:3000/health || exit 1

CMD ["npm", "start"]
