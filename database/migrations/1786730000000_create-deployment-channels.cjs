/**
 * Creates the `deployment_channels` table for the Deployment-Scoped
 * Overseas Channel Self-Service Subscription feature (Requirement 22).
 *
 * A `deployment_channels` row represents either an `Overseas - `
 * prefixed Deployment_Channel (e.g. `Overseas - Tonga`) or a
 * Domestic_Mission_Channel matching the
 * `[COUNTRY]-[FUNCTION]-[REGION]-[SUFFIX]` naming pattern (e.g.
 * `AUS-FIRE-STL-2026`) -- both flow through the exact same table and
 * the exact same `DeploymentChannelService` methods
 * (`createDeploymentChannel`/`subscribe`/`unsubscribe`/
 * `deactivateExpired`), per Requirement 22 Criterion 12 and
 * `design.md`'s Section 18. It is deliberately distinct from
 * `bch_channels`, `region_channels`, `vendor_channels`, and team-scoped
 * `channels` (Requirement 22 Criterion 1).
 *
 * Column shape, per Requirement 22 Criterion 1 and `design.md`'s Data
 * Models table entry for `deployment_channels`:
 *   - `name`                 the channel name (either naming pattern)
 *   - `description`          free-text description
 *   - `deployment_end_date`  nullable; NULL means "standing Pacific-
 *                            partner channel, never auto-deactivated"
 *                            per the Deployment_Channel glossary entry
 *                            and Requirement 22 Criterion 2
 *   - `authentik_group_id`   the corresponding Authentik group id
 *   - `is_active`            whether the channel is currently active
 *   - `requested_by`         the requesting Deployment_Coordinator's
 *                            user id (every Global_Manager is an
 *                            authorized Deployment_Coordinator per
 *                            Requirement 22 Criterion 3)
 *   - `created_at`           creation timestamp
 *
 * `deployment_end_date` is intentionally `TIMESTAMP` rather than `DATE`,
 * for consistency with every other point-in-time column already in this
 * schema (`expires_at`, `revoked_at`, `granted_at`,
 * `email_verification_expires_at`, etc. all use `TIMESTAMP`), and
 * because `design.md`'s `deactivateExpired()` comparison
 * (`deployment_end_date <= NOW()`) compares directly against a
 * timestamp -- requirements.md does not call out a `DATE`-only
 * requirement anywhere in Requirement 22.
 *
 * `name` deliberately carries no `CHECK` constraint enforcing either the
 * `Overseas - ` prefix or the domestic `[COUNTRY]-[FUNCTION]-[REGION]-
 * [SUFFIX]` pattern: per `design.md`'s Section 18,
 * `createDeploymentChannel` validates `name` against those two regexes
 * (and the domestic pattern's `deploymentEndDate`-required rule) at the
 * application layer before insert, and Requirement 22 does not ask for
 * a database-level constraint. This mirrors the existing convention in
 * this schema of enforcing format/business rules (e.g. the 3-channel-
 * per-team limit) at the application/transaction layer rather than via
 * `CHECK` constraints on free-text naming columns.
 *
 * ## Supporting index
 *
 * Requirement 22 Criteria 8-9 require a periodic check (interval <= 24
 * hours) that finds every Deployment_Channel whose `deployment_end_date`
 * has passed and whose `is_active` is still `true`
 * (`design.md`: `WHERE deployment_end_date <= NOW() AND is_active =
 * true`). A partial index on `deployment_end_date`, restricted to
 * exactly the rows that query scans (`is_active = true AND
 * deployment_end_date IS NOT NULL` -- standing channels with a null
 * `deployment_end_date` are excluded per Requirement 22 Criterion 2 and
 * never matched by this query), keeps that periodic scan cheap. This
 * mirrors the `idx_vendor_channel_grants_pending_expiry` partial index
 * from `1786720000000_create-vendor-channel-grants.cjs`, which supports
 * the analogous "find due, unprocessed rows" query shape for vendor
 * grants.
 *
 * This task is scoped to ONLY the migration adding this table; the
 * `DeploymentChannelService` methods that read/write it (task 42.x) are
 * deliberately out of scope here, per `tasks.md`'s dependency-ordering
 * note ("Every new table or column lands as its own migration task ahead
 * of the service/route tasks that depend on it").
 *
 * Uses node-pg-migrate's schema-builder API (`pgm.createTable`,
 * `pgm.createIndex` with a `where` clause), matching the convention
 * established by every migration after the baseline (e.g.
 * `1786720000000_create-vendor-channel-grants.cjs`).
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
const shorthands = undefined;

const PENDING_DEACTIVATION_INDEX = 'idx_deployment_channels_pending_deactivation';

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
const up = (pgm) => {
  pgm.createTable('deployment_channels', {
    id: 'id',
    name: {
      type: 'varchar(255)',
      notNull: true,
    },
    description: {
      type: 'text',
    },
    // Nullable: NULL means "standing Pacific-partner channel, never
    // automatically deactivated" (Requirement 22 Criterion 2).
    deployment_end_date: {
      type: 'timestamp',
    },
    authentik_group_id: {
      type: 'varchar(255)',
    },
    is_active: {
      type: 'boolean',
      default: true,
    },
    requested_by: {
      type: 'integer',
      references: 'users',
      onDelete: 'SET NULL',
    },
    created_at: {
      type: 'timestamp',
      default: pgm.func('NOW()'),
    },
  });

  // Requirement 22 Criteria 8-9: efficiently find active channels whose
  // deployment_end_date has passed.
  pgm.createIndex('deployment_channels', 'deployment_end_date', {
    name: PENDING_DEACTIVATION_INDEX,
    where: 'is_active = true AND deployment_end_date IS NOT NULL',
  });
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
const down = (pgm) => {
  pgm.dropIndex('deployment_channels', 'deployment_end_date', {
    name: PENDING_DEACTIVATION_INDEX,
  });
  pgm.dropTable('deployment_channels');
};

module.exports = {
  shorthands,
  up,
  down,
};
