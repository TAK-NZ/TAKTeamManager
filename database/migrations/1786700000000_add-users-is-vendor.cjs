/**
 * Adds `users.is_vendor` (boolean, default `false`) as the first schema
 * change for the Vendor Time-Limited Channel Access feature
 * (Requirement 21).
 *
 * `is_vendor` flags a user record as a Vendor_User: a vendor or
 * technical support person who, per `user-docs/docs/concepts/
 * channels.md`'s "Vendor channels" section, by default has access only
 * to the base `VND` Channel and no regional or organisation Channel
 * (Requirement 21 Criterion 1). Setting this flag to `true` is gated by
 * a Global_Manager-only endpoint (task 40.2, not implemented here) that
 * also requires an active `vendor_channels` row (task 39.2) to exist
 * before the flag can be set (Requirement 21 Criterion 12).
 *
 * This task is scoped to ONLY the migration adding the column; the
 * `vendor_channels`/`vendor_channel_grants` tables (tasks 39.2/39.3) and
 * the `VendorChannelService`/routes that read and write this column
 * (task 40.x) are deliberately out of scope here and land in later
 * tasks, per `tasks.md`'s dependency-ordering note ("Every new table or
 * column lands as its own migration task ahead of the service/route
 * tasks that depend on it").
 *
 * `NOT NULL DEFAULT false` (rather than a nullable boolean) is used so
 * every existing and future row has a deterministic, non-null value
 * with no code needing to treat `NULL` as a third state — matching the
 * style of every other boolean flag in the baseline schema (e.g.
 * `teams.can_join`, `bch_channels.is_active`).
 *
 * Uses node-pg-migrate's schema-builder API (`pgm.addColumn`),
 * matching the convention established by every migration after the
 * baseline (see e.g. `1786670000000_partial-unique-team-memberships
 * .cjs`, `1786653600000_add-sync-operations-correlation-failure
 * -category.cjs`).
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
    is_vendor: {
      type: 'boolean',
      notNull: true,
      default: false,
    },
  });
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
const down = (pgm) => {
  pgm.dropColumn('users', 'is_vendor');
};

module.exports = {
  shorthands,
  up,
  down,
};
