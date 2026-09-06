'use strict';

/**
 * Adds a nullable `user_cache.last_login` column holding the timestamp of the
 * user's most recent login, as reported by Authentik's own `last_login` field
 * on `GET /core/users/`.
 *
 * Why this exists: `GET /api/users` was migrated off a live per-request
 * Authentik fetch to the local `users`/`user_cache` mirror. Authentik's
 * `last_login` was one of the few fields the old live-sourced list surfaced
 * that had NO local column behind it, so after the migration the /users "Last
 * Login" column rendered "Never" for everyone. This column gives the periodic
 * Authentik sync (`authentikSync.js`) somewhere to persist `last_login` so the
 * list can read it locally like every other field it renders.
 *
 * Semantics:
 *   - NULL  -> the user has never logged in (Authentik reports `last_login:
 *              null`), OR the sync has not yet run against a row. Rendered as
 *              "Never" by the /users page's existing ternary.
 *   - a ts  -> the last login Authentik reported at the most recent sync.
 *
 * NOT write-once, unlike most cached fields: `last_login` is inherently
 * mutable and advances on every login, so the sync overwrites it each run
 * (`EXCLUDED.last_login`), exactly as it already does for the other
 * per-sync-refreshed cache columns. It is a cached MIRROR of Authentik's
 * value, never locally authoritative.
 *
 * `timestamp without time zone` matches the other timestamp columns already on
 * `user_cache` (`last_synced`/`created_at`/`updated_at`); Authentik returns an
 * ISO-8601 instant, stored as-is. No default and no NOT NULL: the never-logged-
 * in case is legitimately NULL and must not be back-filled with a misleading
 * `now()`.
 *
 * `down()` drops the column -- a purely additive change; on rollback the
 * /users list simply returns to showing "Never" for everyone (the pre-migration
 * state this fixed).
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
const shorthands = undefined;

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE user_cache ADD COLUMN last_login timestamp without time zone;
    COMMENT ON COLUMN user_cache.last_login IS 'Cached mirror of Authentik''s last_login for this user, refreshed every periodic sync (authentikSync.js). NULL means never logged in (or not yet synced). Not locally authoritative and not write-once -- overwritten each sync from EXCLUDED.last_login.';
  `);
};

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
const down = (pgm) => {
  pgm.sql(`
    ALTER TABLE user_cache DROP COLUMN last_login;
  `);
};

module.exports = { shorthands, up, down };
