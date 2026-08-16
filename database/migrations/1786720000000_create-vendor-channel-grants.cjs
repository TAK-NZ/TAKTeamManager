/**
 * Creates the `vendor_channel_grants` table for the Vendor Time-Limited
 * Channel Access feature (Requirement 21 Criterion 3).
 *
 * A `vendor_channel_grants` row records that a Vendor_User
 * (`users.is_vendor = true`, added by `1786700000000_add-users-is-vendor
 * .cjs`) has been granted access to a specific Channel, either for a
 * bounded duration (`expires_at`) or until manually revoked, along with
 * which Global_Manager granted or revoked it and when (Requirement 21
 * Criteria 4-9).
 *
 * Column shape, per Requirement 21 Criterion 3 and `design.md`'s Data
 * Models table:
 *   - `user_id`        the Vendor_User the grant applies to
 *   - `channel_id`     the granted Channel (see reasoning below)
 *   - `granted_by`     the granting Global_Manager's user id
 *   - `granted_at`     when the grant was created
 *   - `expires_at`     optional bound; NULL means "until manually revoked"
 *   - `revoked_at`     NULL while the grant is active
 *   - `revoked_by`     see reasoning below
 *
 * ## `channel_id` FK target reasoning
 *
 * Requirement 21 Criterion 4 speaks of granting access to "a target
 * Channel" and enqueuing a Sync_Operation to add the Vendor_User "to the
 * target Channel's Authentik group". The requirements.md Glossary entry
 * for Vendor_Channel_Grant is more specific, though: it defines the
 * grant as access to a "specific **non-team** Channel" -- explicitly
 * distinguishing it from the team-scoped `channels` table. Read together
 * with the Channel glossary entry ("a row in the `channels` table (or,
 * for global channels, the `bch_channels`/`region_channels` tables) ...")
 * and Requirement 21 Criterion 10's list of channel-like tables distinct
 * from one another (`bch_channels`, `region_channels`,
 * `deployment_channels`, `vendor_channels`, and team-scoped `channels`),
 * the realistic set of grant targets for a vendor (who by design has no
 * team membership at all -- Criterion 2 explicitly withholds regional/
 * organisation Channel access) is `bch_channels`, `region_channels`,
 * `deployment_channels`, or `vendor_channels` itself, not the
 * `channels` table.
 *
 * Because `channel_id` can therefore reference a row in one of several
 * different, structurally-independent tables depending on which kind of
 * Channel a given grant targets, no single `REFERENCES` clause can
 * correctly constrain it -- a hard FK to any one of those tables would
 * silently forbid grants against every other channel type. This is the
 * same "polymorphic reference, no single hard FK" situation already
 * accepted elsewhere in this schema for `sync_operations.target_group_id`
 * (a plain `VARCHAR` naming an Authentik group id that may belong to any
 * channel-like table, with no FK). This migration follows that existing
 * precedent: `channel_id` is a plain, required `INTEGER` column with no
 * foreign-key constraint. Referential integrity for whichever table a
 * given `channel_id` actually belongs to is enforced at the application
 * layer (`VendorChannelService.createGrant`, task 40.3), which knows
 * which channel-type table it just resolved the id from.
 *
 * ## `revoked_by` reasoning
 *
 * Per `design.md`'s `VendorChannelService.expireGrants()` note, automatic
 * (expiry-driven) revocations are distinguished from manual
 * Global_Manager revocations via a sentinel value (`revoked_by = -1`, or
 * an equivalent `SYSTEM_USER_ID` constant) per Requirement 21 Criterion
 * 7. A sentinel value such as `-1` would violate a strict
 * `REFERENCES users(id)` foreign key (no user with id `-1` exists), so
 * `revoked_by` is a plain nullable `INTEGER` with no FK constraint,
 * matching the design's stated approach. `granted_by`, by contrast, is
 * always a real Global_Manager-initiated action (Requirement 21
 * Criterion 4), so it keeps a normal FK to `users(id)`.
 *
 * ## Supporting index
 *
 * Requirement 21 Criteria 6-7 require a periodic check (interval <= 15
 * minutes) that finds every grant whose `expires_at` has passed and
 * whose `revoked_at` is still NULL (`WHERE expires_at <= NOW() AND
 * revoked_at IS NULL`). A partial index on `expires_at`, restricted to
 * exactly the rows that query scans (`revoked_at IS NULL AND expires_at
 * IS NOT NULL`), keeps that periodic scan cheap without indexing the
 * (majority, in steady state) rows that are either already revoked or
 * have no expiry at all. This mirrors the existing
 * `idx_access_requests_escalates_at` partial index
 * (`ON access_requests(escalates_at) WHERE status = 'pending'`) from the
 * baseline migration, which supports the same "find due, unprocessed
 * rows" query shape.
 *
 * This task is scoped to ONLY the migration adding this table; the
 * `VendorChannelService` methods that read/write it (task 40.x) are
 * deliberately out of scope here, per `tasks.md`'s dependency-ordering
 * note ("Every new table or column lands as its own migration task ahead
 * of the service/route tasks that depend on it").
 *
 * Uses node-pg-migrate's schema-builder API (`pgm.createTable`,
 * `pgm.createIndex` with a `where` clause), matching the convention
 * established by every migration after the baseline (e.g.
 * `1786710000000_create-vendor-channels.cjs`).
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
const shorthands = undefined;

const PENDING_EXPIRY_INDEX = 'idx_vendor_channel_grants_pending_expiry';

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
const up = (pgm) => {
  pgm.createTable('vendor_channel_grants', {
    id: 'id',
    user_id: {
      type: 'integer',
      notNull: true,
      references: 'users',
      onDelete: 'CASCADE',
    },
    // Polymorphic reference to whichever channel-like table the grant
    // targets (bch_channels / region_channels / deployment_channels /
    // vendor_channels) -- intentionally not a hard FK. See the
    // "channel_id FK target reasoning" note above.
    channel_id: {
      type: 'integer',
      notNull: true,
    },
    granted_by: {
      type: 'integer',
      references: 'users',
      onDelete: 'SET NULL',
    },
    granted_at: {
      type: 'timestamp',
      notNull: true,
      default: pgm.func('NOW()'),
    },
    expires_at: {
      type: 'timestamp',
    },
    revoked_at: {
      type: 'timestamp',
    },
    // No FK: automated expiry-driven revocations use a sentinel value
    // (e.g. -1) that does not correspond to a real users.id row. See the
    // "revoked_by reasoning" note above.
    revoked_by: {
      type: 'integer',
    },
  });

  // Requirement 21 Criteria 6-7: efficiently find due, unrevoked grants.
  pgm.createIndex('vendor_channel_grants', 'expires_at', {
    name: PENDING_EXPIRY_INDEX,
    where: 'revoked_at IS NULL AND expires_at IS NOT NULL',
  });
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
const down = (pgm) => {
  pgm.dropIndex('vendor_channel_grants', 'expires_at', { name: PENDING_EXPIRY_INDEX });
  pgm.dropTable('vendor_channel_grants');
};

module.exports = {
  shorthands,
  up,
  down,
};
