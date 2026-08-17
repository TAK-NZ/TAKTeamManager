/**
 * Adds `teams.callsign_level_selection` (`integer[]`, nullable, no
 * column-level default), the storage for Callsign_Level_Selection
 * (Requirement 5): the set of Team_Depth positions (1..Max_Team_Depth)
 * whose `callsign_prefix` value is included when generating a callsign
 * for a user, configured per Organisation.
 *
 * This column supersedes `teams.callsign_subteam_depth` (a contiguous
 * "first N levels" dial) with a non-contiguous set of selected levels.
 * `callsign_subteam_depth` itself is dropped in a LATER migration (task
 * 11.3, `drop-teams-callsign-subteam-depth.cjs`), sequenced after the
 * code that reads it (`computeCallsignAttributes`) is rewritten to stop
 * doing so -- see tasks.md's note on why that destructive migration is
 * deliberately NOT part of this additive Phase 1 batch.
 *
 * No column-level default, and nullable, by design (design.md's Data
 * Models section, `callsign_level_selection` row):
 *   - Requirement 5.3's "default to every Team_Depth 1..Max_Team_Depth
 *     when omitted on Organisation creation" is an APPLICATION-level
 *     default applied in `Team.create` (a later task), not a DB-level
 *     default -- Max_Team_Depth (5) is a shared JS constant
 *     (`server/config/constants.js`, also a later task), not something
 *     a static SQL column default could reference in a way that stays
 *     in sync if that constant ever needed to change.
 *   - This column is only ever meaningful on an Organisation row
 *     (`parent_team_id IS NULL`); a Sub_Team's value is always left
 *     `NULL` and is never read (Requirement 5.6), so a non-null
 *     column-level default would be actively wrong for every Sub_Team
 *     row.
 *   - Nullable so this migration is safe to apply against any existing
 *     `teams` row (including existing Organisations) without a backfill
 *     statement, consistent with the nullable-with-app-level-default
 *     pattern already used by this schema (see this file's sibling,
 *     `1786810000000_add-teams-callsign-subteam-depth-and-name-format
 *     .cjs`, for the same rationale applied to a scalar column; this
 *     column differs only in being an array type).
 *
 * `integer[]` (rather than a joined string or a separate join table)
 * matches this column's sole consumer shape: a small, order-independent
 * set of Team_Depth positions (at most Max_Team_Depth = 5 elements),
 * checked with `ANY(...)`/membership tests, not queried relationally --
 * consistent with this schema's existing precedent of using no
 * `CHECK` constraint on `teams` columns and enforcing shape/range
 * validation in application code instead (see `callsign_prefix`'s
 * character-class validation, enforced in `server/routes/teams.js`, not
 * the DB layer).
 *
 * Uses node-pg-migrate's schema-builder API (`pgm.addColumn`), matching
 * the convention established by every migration after the baseline (see
 * e.g. `1786810000000_add-teams-callsign-subteam-depth-and-name-format
 * .cjs`, `1786700000000_add-users-is-vendor.cjs`).
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
const up = (pgm) => {
  pgm.addColumn('teams', {
    callsign_level_selection: {
      type: 'integer[]',
      notNull: false,
    },
  });
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
const down = (pgm) => {
  pgm.dropColumn('teams', 'callsign_level_selection');
};

module.exports = {
  shorthands,
  up,
  down,
};
