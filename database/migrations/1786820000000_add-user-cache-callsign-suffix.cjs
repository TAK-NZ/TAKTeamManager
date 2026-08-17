/**
 * Adds `user_cache.callsign_suffix` (`varchar(255)`, nullable), mirroring
 * the sibling migration that adds the same column to `users`
 * (`1786820000000_add-users-callsign-suffix.cjs`), per the existing
 * "every per-user display attribute is duplicated across `users` and
 * `user_cache`" convention documented in
 * `1786760000000_add-is-team-device-device-label.cjs`'s own comment,
 * which explicitly cites `tak_role`/`tak_color`/`tak_callsign` as
 * precedent for this dual-table pattern.
 *
 * `users.callsign_suffix` is the authoritative, admin-edited
 * source-of-truth column (Requirement 11.1/11.4). `user_cache` is the
 * read-optimized, Authentik-sync-refreshed mirror queried by
 * `GET /api/users` and roster/dashboard views -- unlike
 * `tak_role`/`tak_color`/`tak_callsign`, however, `callsign_suffix` has
 * no corresponding Authentik user attribute to sync FROM (per
 * design.md's Data Models section: "there is no Authentik-side
 * `callsign_suffix` attribute -- it is a local-only value"). So
 * `authentikSync.js`'s periodic sync does not populate this column;
 * instead, every write path that sets `users.callsign_suffix` (user
 * creation, Member_List edit, access-request approval -- later tasks)
 * writes the identical value to `user_cache.callsign_suffix` in the
 * same transaction, matching how `tak_role_local`-style values are
 * already dual-written by `UserProvisioningService`/
 * `RequestApprovalService` today.
 *
 * Nullable (rather than `NOT NULL`), `varchar(255)`, and with no
 * column-level `CHECK` constraint, for the same reasons given in the
 * `users.callsign_suffix` sibling migration's comment: a pre-existing
 * user row predates this feature and has no computed value, the type
 * matches the existing convention for other free-text per-user
 * identifier columns, and the Requirement 11.3 character-class
 * restriction is enforced in application code
 * (`server/utils/callsignValidation.js`'s `isValidCallsignSuffix`), not
 * a DB-level constraint, consistent with this schema's established
 * "no `CHECK` constraint on any `teams`/`users` text column" precedent.
 *
 * Uses node-pg-migrate's schema-builder API (`pgm.addColumn`), matching
 * the convention established by every migration after the baseline (see
 * e.g. `1786760000000_add-is-team-device-device-label.cjs`,
 * `1786820000000_add-users-callsign-suffix.cjs`).
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
const up = (pgm) => {
  pgm.addColumn('user_cache', {
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
  pgm.dropColumn('user_cache', 'callsign_suffix');
};

module.exports = {
  shorthands,
  up,
  down,
};
