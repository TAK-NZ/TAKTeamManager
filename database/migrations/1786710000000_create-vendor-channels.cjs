/**
 * Creates the `vendor_channels` table for the Vendor Time-Limited Channel
 * Access feature (Requirement 21).
 *
 * `vendor_channels` is the singleton record representing the base Vendor
 * Channel (Authentik group `VND`) that a Vendor_User (`users.is_vendor`,
 * added by the previous migration,
 * `1786700000000_add-users-is-vendor.cjs`) is assigned to by default
 * (Requirement 21 Criterion 2). It is deliberately distinct from
 * `bch_channels`, `region_channels`, `deployment_channels`, and
 * team-scoped `channels` (Requirement 21 Criterion 10).
 *
 * Column shape mirrors the existing `bch_channels`/`region_channels`
 * tables from the baseline migration (`name`, `display_name`,
 * `description`, a group-id-style column, `is_active BOOLEAN DEFAULT
 * true`, `created_by INTEGER REFERENCES users(id)`, `created_at
 * TIMESTAMP DEFAULT NOW()`), with `name` defaulting to `'VND'` per
 * Requirement 21 Criterion 10, and `authentik_group_id` in place of
 * `region_channels.group_id` (the requirement names this column
 * `authentik_group_id` explicitly).
 *
 * Singleton enforcement (Requirement 21 Criterion 11 — "at most one
 * `vendor_channels` row SHALL have `is_active` set to `true` at any
 * time") is implemented as a partial unique index on `is_active`
 * `WHERE is_active = true`. Since every row visible to this index has
 * `is_active = true`, a second such row would collide on that value and
 * be rejected by Postgres — the same "at most one row satisfying a
 * condition" idiom already used for `team_memberships` in
 * `1786670000000_partial-unique-team-memberships.cjs` (there via
 * `WHERE inherited_from_team_id IS NULL`, here via `WHERE is_active =
 * true`).
 *
 * This task is scoped to ONLY the migration adding this table; the
 * `VendorChannelService` methods that read/write it (task 40.x) are
 * deliberately out of scope here and land in a later task, per
 * `tasks.md`'s dependency-ordering note ("Every new table or column
 * lands as its own migration task ahead of the service/route tasks that
 * depend on it").
 *
 * Uses node-pg-migrate's schema-builder API (`pgm.createTable`,
 * `pgm.createIndex` with a `where` clause), matching the convention
 * established by every migration after the baseline.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
const shorthands = undefined;

const ACTIVE_SINGLETON_INDEX = 'idx_vendor_channels_one_active';

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
const up = (pgm) => {
  pgm.createTable('vendor_channels', {
    id: 'id',
    name: {
      type: 'varchar(255)',
      notNull: true,
      default: 'VND',
    },
    display_name: {
      type: 'varchar(255)',
      notNull: true,
      default: 'VND',
    },
    description: {
      type: 'text',
    },
    authentik_group_id: {
      type: 'varchar(255)',
    },
    is_active: {
      type: 'boolean',
      default: true,
    },
    created_by: {
      type: 'integer',
      references: 'users',
      onDelete: 'SET NULL',
    },
    created_at: {
      type: 'timestamp',
      default: pgm.func('NOW()'),
    },
  });

  // Requirement 21 Criterion 11: at most one active Vendor_Channel at a time.
  pgm.createIndex('vendor_channels', 'is_active', {
    name: ACTIVE_SINGLETON_INDEX,
    unique: true,
    where: 'is_active = true',
  });
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
const down = (pgm) => {
  pgm.dropIndex('vendor_channels', 'is_active', { name: ACTIVE_SINGLETON_INDEX });
  pgm.dropTable('vendor_channels');
};

module.exports = {
  shorthands,
  up,
  down,
};
