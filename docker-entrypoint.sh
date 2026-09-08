#!/bin/sh
# Container entrypoint: initialize the database schema + baseline seed data,
# then start the app.
#
# WHY THIS EXISTS: the app boots against Aurora with an empty schema on a fresh
# deploy — nothing else runs migrations. `/health` only does a trivial
# connectivity check, so it goes green even on an un-migrated DB, and the first
# real query (e.g. GET /api/config/public -> SELECT FROM site_config) then 500s.
# `database/init.js` runs all pending node-pg-migrate migrations and seeds the
# baseline rows (site_config/system_config/email_templates/...). It is
# idempotent — migrations track applied state and every seed INSERT is
# `ON CONFLICT DO NOTHING` — and node-pg-migrate takes a Postgres advisory lock
# while migrating, so running it on every task start (including several tasks
# starting in parallel at desiredCount > 1) is safe.
#
# We run it as a BLOCKING pre-start step, not `init && npm start` in CMD, so a
# migration failure aborts startup with a clear non-zero exit instead of the
# container silently serving against a broken schema.
set -e

echo "[entrypoint] Running database initialization (migrations + seed)..."
node database/init.js
echo "[entrypoint] Database initialization complete; starting the app."

# Replace the shell with the app process so it receives signals directly (PID 1
# semantics for graceful ECS shutdown). "$@" is the image CMD.
exec "$@"
