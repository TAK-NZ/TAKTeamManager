/**
 * Adds `users.tak_role` (`varchar(50)`, `NOT NULL`, default `'Team
 * Member'`) as the first schema change for Requirement 13's Member_List
 * `TAK_Role` editing capability (tasks 1.4, 28.1, 29.1).
 *
 * `user_cache.tak_role` already exists (renamed from `takRole` by
 * `1786660000000_rename-user-cache-tak-columns.cjs`) and already mirrors
 * Authentik's `takRole` user attribute via the periodic sync
 * (`authentikSync.js`). What's missing is a source-of-truth column on
 * `users` itself -- the table a Team_Admin's Member_List edit (task
 * 28.1) actually targets -- since `user_cache` is a read-mostly sync
 * mirror that gets overwritten wholesale on the next periodic sync;
 * writing ONLY to `user_cache.tak_role` would be silently reverted at
 * the next sync interval, violating Requirement 13.8's "a TAK_Role value
 * changes only as the direct result of a Team_Admin or Global_Manager
 * explicitly editing it" (see `design.md`'s "`users.tak_role` (new
 * column -- Requirement 13)" section).
 *
 * `NOT NULL DEFAULT 'Team Member'` (rather than a nullable varchar)
 * directly matches Requirement 13.7 ("A new user SHALL default to a
 * TAK_Role of 'Team Member' at creation time") and Requirement 13.8
 * ("Once a user's TAK_Role has been established ... THE App SHALL NOT
 * recompute ... it"): every existing and future row gets a
 * deterministic, non-null value with no code needing to treat `NULL` as
 * a third state -- matching the style of `1786700000000_add-users-is
 * -vendor.cjs`'s `is_vendor` column (`NOT NULL DEFAULT false`) and this
 * schema's other enum-like text columns with an application-level
 * (rather than `CHECK`-constraint) allow-list (e.g. `teams.visibility`,
 * `access_requests.status`, `teams.callsign_name_format` per
 * `1786810000000_add-teams-callsign-subteam-depth-and-name-format.cjs`'s
 * own comment) -- the 8-value TAK_Role allow-list (task 27.1's
 * `TAK_ROLE_VALUES`) is enforced in application code, not a DB `CHECK`.
 *
 * Uses node-pg-migrate's schema-builder API (`pgm.addColumn`), matching
 * the convention established by every migration after the baseline (see
 * e.g. `1786700000000_add-users-is-vendor.cjs`,
 * `1786760000000_add-is-team-device-device-label.cjs`).
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
    tak_role: {
      type: 'varchar(50)',
      notNull: true,
      default: 'Team Member',
    },
  });
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
const down = (pgm) => {
  pgm.dropColumn('users', 'tak_role');
};

module.exports = {
  shorthands,
  up,
  down,
};
