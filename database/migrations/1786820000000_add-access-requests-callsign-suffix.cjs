/**
 * Adds `access_requests.callsign_suffix` (`varchar(255)`, nullable), the
 * schema change needed to carry a requester's optionally-submitted
 * preferred Callsign_Suffix through the public team-access-request flow
 * to admin review/approval (Requirement 11.9, 11.11, 11.12).
 *
 * Background: Requirement 11.9 requires the public, unauthenticated
 * team-access-request flow to accept and store an optional
 * `callsignSuffix` value when the target Team's Organisation's
 * `callsign_name_format` is `user_defined` (a format that computes no
 * default at all, per Requirement 11.5). That submitted value must
 * survive from request submission through to admin approval, so a
 * reviewer can see and, per Requirement 11.11/11.12, edit it before the
 * resulting user is actually created -- `access_requests` is exactly
 * where the analogous `requested_first_name`/`requested_last_name`
 * fields already live for the same request/approval lifecycle, so this
 * new column follows that existing precedent rather than introducing a
 * separate table.
 *
 * `varchar(255)` and nullable match `users.callsign_suffix`'s own
 * column definition (see the sibling `add-users-callsign-suffix.cjs`
 * migration in this same task-1 batch): nullable because a request
 * targeting a non-`user_defined` Organisation never populates this
 * column (Requirement 11.10 -- the Client does not even prompt for one
 * in that case), and `varchar(255)` for consistency with every other
 * per-user text attribute in this schema.
 *
 * Uses node-pg-migrate's schema-builder API (`pgm.addColumn`), matching
 * the convention established by every migration after the baseline
 * (see e.g. `1786700000000_add-users-is-vendor.cjs`).
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
const up = (pgm) => {
  pgm.addColumn('access_requests', {
    callsign_suffix: {
      type: 'varchar(255)',
      notNull: false,
    },
  });
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
const down = (pgm) => {
  pgm.dropColumn('access_requests', 'callsign_suffix');
};

module.exports = {
  shorthands,
  up,
  down,
};
