/**
 * Adds `teams.callsign_subteam_depth` and `teams.callsign_name_format`,
 * closing a real schema/code drift gap surfaced by the schema-consistency
 * test (task 35.5, Requirement 16.5): `server/models/Team.js`
 * (`create`/`update`) and `server/services/userAttributes.js`
 * (`computeCallsignAttributes`'s recursive team-hierarchy query) have
 * read and written these two `teams` columns since before this spec
 * started, but no migration -- baseline or otherwise -- ever created
 * them, and they are absent from both `database/schema.sql` and every
 * `*.cjs` file under `database/migrations/`.
 *
 * Column semantics, inferred directly from their sole consumers:
 *   - `callsign_subteam_depth` (`server/services/userAttributes.js`,
 *     `computeCallsignAttributes`): "how many levels of the team
 *     hierarchy's `callsign_prefix` values (root-ward) to prepend to a
 *     generated callsign", read only off the ROOT team of a hierarchy
 *     (`rootTeam.callsign_subteam_depth || 1`) and defaulted to `1` in
 *     application code whenever null/unset -- so this migration mirrors
 *     that same default at the column level for a consistent value on
 *     every row (matching `ARCHITECTURE.md`'s "Team Hierarchy: ...
 *     configurable depth" description of this feature). An `integer`
 *     type matches its use as a loop bound (`Math.min(teamPath.length,
 *     depth + 1)`).
 *   - `callsign_name_format` (same call site): a small closed set of
 *     string enum values (`'first_initial_last'`, `'first_last_initial'`,
 *     and a default/fallback case in the `switch` for "full name" --
 *     `client/src/pages/Teams.jsx`'s corresponding form field spells
 *     this default value `'full_name'`), read only off the root team.
 *     `VARCHAR(50)` and a `'full_name'` default follow this schema's
 *     established convention for other enum-like text columns (e.g.
 *     `teams.visibility`, `access_requests.status`), none of which use a
 *     `CHECK` constraint -- the valid value set is enforced in
 *     application code instead (see `computeCallsignAttributes`'s
 *     `switch` statement).
 *
 * Both columns are nullable with a non-null default (rather than
 * `NOT NULL`) so this migration is safe to apply against any existing
 * `teams` row without a backfill statement, while every *newly inserted*
 * row still gets a deterministic non-null value.
 *
 * Uses node-pg-migrate's schema-builder API (`pgm.addColumns`), matching
 * the convention established by every migration after the baseline (see
 * e.g. `1786700000000_add-users-is-vendor.cjs`).
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
const up = (pgm) => {
  pgm.addColumns('teams', {
    callsign_subteam_depth: {
      type: 'integer',
      default: 1,
    },
    callsign_name_format: {
      type: 'varchar(50)',
      default: 'full_name',
    },
  });
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
const down = (pgm) => {
  pgm.dropColumns('teams', ['callsign_subteam_depth', 'callsign_name_format']);
};

module.exports = {
  shorthands,
  up,
  down,
};
