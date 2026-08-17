/**
 * Adds `users.callsign_suffix` (`varchar(255)`, nullable), the per-user
 * Name-segment value introduced by Requirement 11 of the
 * org-team-hierarchy feature (design.md's Data Models section).
 *
 * Per Requirement 11.1/11.2, every user -- regardless of Organisation --
 * gains a `callsign_suffix` column used as the Name segment of every
 * generated callsign (Requirement 8 Criterion 4), read directly rather
 * than computed live at callsign-generation time. It is defaulted at
 * user-creation time from that user's Organisation's `callsign_name_format`
 * rule (Requirement 11.6/11.7, implemented by a later task's
 * `UserProvisioningService.resolveCallsignSuffixForNewUser`), and is
 * thereafter only ever changed by an explicit Team_Admin/Global_Manager
 * edit (Requirement 11.4/11.8) -- never silently recomputed.
 *
 * Nullable (rather than `NOT NULL`) because a pre-existing user row
 * predates this feature and has no computed value; application code
 * treats a null `callsign_suffix` the same way `users.tak_role`'s
 * companion migration treats "no value yet" for rows that predate a
 * newly added column, and per design.md's Data Models section this
 * mirrors "a pre-existing user row predates this feature and has no
 * computed value". `varchar(255)` matches the existing convention for
 * other free-text per-user identifier columns in the baseline schema
 * (e.g. `users.first_name`/`last_name`).
 *
 * No column-level `CHECK` constraint is added for the Requirement 11.3
 * character-class restriction (letters, digits, `-`, `.`); consistent
 * with this schema's established convention (see
 * `1786810000000_add-teams-callsign-subteam-depth-and-name-format.cjs`'s
 * own note that no `teams` text column uses a `CHECK` constraint), that
 * validation is enforced in application code instead
 * (`server/utils/callsignValidation.js`'s `isValidCallsignSuffix`).
 *
 * Uses node-pg-migrate's schema-builder API (`pgm.addColumn`), matching
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
  pgm.addColumn('users', {
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
  pgm.dropColumn('users', 'callsign_suffix');
};

module.exports = {
  shorthands,
  up,
  down,
};
