/**
 * Widens `channels.authentik_group_id`, `channels.authentik_read_group_id`,
 * and `channels.authentik_write_group_id` from `INTEGER` to
 * `VARCHAR(255)`.
 *
 * Bug fixed: Authentik's REST API identifies a group by its `pk`, which
 * is a UUID string (e.g. "9079e6e0-5615-42dc-8400-1c31c4346324"), NOT the
 * `num_pk` integer Authentik also exposes on each group object.
 * Confirmed directly against a live Authentik instance:
 * `GET /api/v3/core/groups/{pk}/` (the UUID) returns 200; the same
 * request with `{num_pk}` (the integer) returns 404. Every Authentik-
 * calling code path in this codebase that adds/removes a user from a
 * group, or updates/deletes a group (`server/workers/syncWorker.js`'s
 * `addUserToGroup`/`removeUserFromGroup`/etc.) uses the UUID `pk`
 * throughout.
 *
 * These three `channels` columns were declared `INTEGER` in the baseline
 * schema -- the only channel-like columns in the entire schema with this
 * mistake. Every other channel-like table added since correctly uses
 * `varchar(255)` for the same purpose (see `bch_channels.read_group_id`/
 * `write_group_id`, `region_channels.group_id`, `vendor_channels
 * .authentik_group_id`, `deployment_channels.authentik_group_id` --
 * confirmed by grepping every migration file's column definitions). An
 * `INTEGER` column can never actually store a real Authentik group `pk`,
 * so any INSERT/UPDATE attempting to persist a genuine group id into one
 * of these three columns throws a Postgres type error; `Team
 * .createTeamChannel`'s outer `try/catch` (server/models/Team.js) swallows
 * that error and silently falls back to `authentik_group_id = NULL` --
 * which is why an affected team's primary channel shows an empty
 * "Status"/no "Synced" badge in the UI with no visible error anywhere.
 *
 * Safe, additive change: widening `INTEGER` -> `VARCHAR(255)` cannot lose
 * data (every existing value, if any, is losslessly representable as
 * text) and requires no data backfill in this migration itself -- at the
 * time this migration was written, a repo-wide check confirmed zero
 * `channels` rows have a non-null value in any of these three columns
 * (every existing attempt to populate them had already been silently
 * discarded by the very bug described above), so there is nothing to
 * convert.
 *
 * Uses `pgm.alterColumn`, the schema-builder API's column-type-change
 * primitive; `down()` reverses to `INTEGER` for symmetry, consistent
 * with every other migration in this codebase providing a working
 * `down()`.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
const up = (pgm) => {
  pgm.alterColumn('channels', 'authentik_group_id', { type: 'varchar(255)' });
  pgm.alterColumn('channels', 'authentik_read_group_id', { type: 'varchar(255)' });
  pgm.alterColumn('channels', 'authentik_write_group_id', { type: 'varchar(255)' });
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
const down = (pgm) => {
  pgm.alterColumn('channels', 'authentik_group_id', { type: 'integer' });
  pgm.alterColumn('channels', 'authentik_read_group_id', { type: 'integer' });
  pgm.alterColumn('channels', 'authentik_write_group_id', { type: 'integer' });
};

module.exports = {
  shorthands,
  up,
  down,
};
