'use strict';

/**
 * Callsign Team-segment separator toggle: adds a nullable
 * `teams.callsign_team_hyphenated` boolean column controlling how an
 * Organisation's Team segment (the concatenation of Team-Depth
 * `callsign_prefix` values selected by `callsign_level_selection`) is
 * joined when a callsign is assembled.
 *
 * Semantics (mirroring the existing Organisation-only tri-state columns
 * `pseudonymous_usernames`/`response_channel_access`/`support_channel_access`,
 * which are likewise nullable with NO default and documented via a
 * `COMMENT ON COLUMN`):
 *
 *   - NULL/false -> the Team segment concatenates with NO separator
 *                   (e.g. Level 1 `NSW` + Level 2 `SYD` -> `NSWSYD`).
 *                   This is the pre-existing behaviour and the default
 *                   for every Organisation that does not opt in.
 *   - true       -> the Team segment concatenates with a single `-`
 *                   between each pair of PRESENT levels only (e.g.
 *                   `NSW-SYD`) -- never a leading/trailing/doubled `-`
 *                   when an intermediate level is unselected or absent
 *                   from the hierarchy (see `CallsignService
 *                   .assembleCallsign`'s `teamSegmentSeparator` param).
 *
 * NULL is only ever stored on a Sub_Team (the column is only ever SET on
 * an Organisation row, `parent_team_id IS NULL`; a Sub_Team always
 * stores NULL, enforced in `Team.create`/`Team.update`, exactly like
 * `pseudonymous_usernames`). UNLIKE `country_code`/`callsign_prefix`,
 * this is freely editable on an existing Organisation at any time (like
 * `response_channel_access`/`support_channel_access`, and like
 * `callsign_name_format`) -- it changes how existing prefixes are
 * DISPLAYED going forward, it does not invalidate any already-minted
 * Managed_Identifier (those are derived from `callsign_prefix`/
 * `country_code` alone, never from this toggle).
 *
 * `boolean`, no default and no NOT NULL: the overwhelming-majority case
 * (every pre-existing Organisation) is NULL/false (no separator,
 * unchanged behaviour).
 *
 * `down()` drops the column. Every Organisation reverts to the
 * no-separator Team segment -- an honest, intentional rollback of a
 * purely additive, freely-editable column.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
const shorthands = undefined;

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE teams ADD COLUMN callsign_team_hyphenated boolean;
    COMMENT ON COLUMN teams.callsign_team_hyphenated IS 'Whether this Organisation''s callsign Team segment (its selected Team-Depth prefixes) is joined with a hyphen between each present level (true) or concatenated with no separator (false/NULL, the pre-existing default). NULL on a Sub_Team, always. Organisation-only, freely editable at any time, enforced in Team.create/Team.update.';
  `);
};

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
const down = (pgm) => {
  pgm.sql(`
    ALTER TABLE teams DROP COLUMN callsign_team_hyphenated;
  `);
};

module.exports = { shorthands, up, down };
