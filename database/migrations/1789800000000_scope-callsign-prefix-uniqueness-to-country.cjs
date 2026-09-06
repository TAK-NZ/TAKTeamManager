'use strict';

/**
 * Bugfix: `idx_teams_callsign_prefix` (see
 * `1789400000000_scope-callsign-prefix-uniqueness-to-organisations.cjs`)
 * is `UNIQUE (callsign_prefix) WHERE callsign_prefix IS NOT NULL AND
 * parent_team_id IS NULL` -- it was defined BEFORE the Foreign_Partner
 * Organisation country prefix feature added `teams.country_code`
 * (`1789600000000_add-teams-country-code.cjs`) and was never widened to
 * include it. The column this index protects is only ever a Managed_
 * Identifier's Organisation-prefix SEGMENT, not the Organisation's
 * EFFECTIVE prefix (`country_code` + `-` + `callsign_prefix` when a
 * country is set, per `userAttributes.computeCallsignAttributes` and
 * `CallsignService.assembleCallsign`) -- so two Foreign_Partner
 * Organisations sharing a bare `callsign_prefix` value under DIFFERENT
 * countries collided here even though their effective prefixes
 * (`FJI-FIRE` vs `AUS-FIRE`) are entirely distinct and never actually
 * ambiguous to `ManagedIdentifierService`.
 *
 * Confirmed live: importing `examples/team-import/foreign-partner-team-import.csv`
 * (Fiji, `callsign_prefix='FIRE'`, `country_code='FJI'`) then attempting
 * to create a second Organisation with `callsign_prefix='FIRE'`,
 * `country_code='AUS'` failed with `duplicate key value violates unique
 * constraint "idx_teams_callsign_prefix"` -- a false positive.
 *
 * The fix: widen the index to `(country_code, callsign_prefix)`, using
 * Postgres 15's `NULLS NOT DISTINCT` (verified against the live
 * PostgreSQL 15.18 this app runs, `docker-compose.yml`'s pinned
 * `postgres:15` image). This is NOT the ordinary unique-index default --
 * a bare multi-column `UNIQUE` treats two NULLs as never conflicting
 * (confirmed live: two `(NULL, 'FENZ')` rows inserted successfully under
 * a plain `UNIQUE (country_code, callsign_prefix)` index), which would
 * silently stop protecting the overwhelming-majority domestic case (no
 * `country_code`) -- two domestic Organisations both named `FENZ` must
 * still collide. `NULLS NOT DISTINCT` restores that: it treats NULL as
 * equal to NULL for uniqueness purposes, so `(NULL, 'FENZ')` still
 * collides with `(NULL, 'FENZ')`, while `('FJI', 'FIRE')` and
 * `('AUS', 'FIRE')` -- two genuinely different, non-null values -- do
 * not collide with each other. Both directions verified live before
 * writing this migration.
 *
 * `down()` restores the prior single-column index exactly, so a rollback
 * returns to a database that is byte-for-byte the pre-migration state.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
const shorthands = undefined;

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
const up = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS idx_teams_callsign_prefix;
  `);

  pgm.sql(`
    CREATE UNIQUE INDEX idx_teams_callsign_prefix
      ON teams (country_code, callsign_prefix)
      NULLS NOT DISTINCT
      WHERE (callsign_prefix IS NOT NULL AND parent_team_id IS NULL);
  `);
};

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
const down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS idx_teams_callsign_prefix;
  `);

  pgm.sql(`
    CREATE UNIQUE INDEX idx_teams_callsign_prefix
      ON teams (callsign_prefix)
      WHERE (callsign_prefix IS NOT NULL AND parent_team_id IS NULL);
  `);
};

module.exports = { shorthands, up, down };
