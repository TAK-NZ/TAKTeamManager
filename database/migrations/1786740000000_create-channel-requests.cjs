/**
 * Creates the `channel_requests` table for the Channel Creation Approval
 * Workflow for Teams (Requirement 23).
 *
 * A `channel_requests` row represents a pending, team-admin-submitted
 * request to create a custom team Channel that has not yet been
 * approved -- distinct from the existing Access_Request table used for
 * user access requests (see the Channel_Request glossary entry). Per
 * `design.md`'s Section 19, `ChannelRequestService.requestChannel`
 * inserts a row here (`status='pending'`) only for the non-Global_Manager
 * path (Req 23.2); the Global_Manager path bypasses this table entirely
 * and calls `Channel.createCustomChannel` immediately (Req 23.3).
 * `approveChannelRequest`/`denyChannelRequest` (task 45.2/45.3) then
 * transition a row from `pending` to `approved`/`denied`.
 *
 * Column shape, per Requirement 23 Criterion 1 and `design.md`'s Data
 * Models table entry for `channel_requests`:
 *   - `team_id`             the team the requested channel belongs to
 *   - `custom_suffix`       the requested channel's suffix, matching the
 *                           shape currently accepted directly by
 *                           `POST /api/channels/custom` and passed
 *                           straight through to
 *                           `Channel.createCustomChannel(teamId,
 *                           customSuffix, memberPermissions)` at approval
 *                           time
 *   - `member_permissions`  JSONB payload matching the `memberPermissions`
 *                           array (`{userId, permission}` objects)
 *                           accepted by the same existing endpoint/method
 *   - `requested_by`        the requesting team admin's user id
 *   - `status`               `'pending'` / `'approved'` / `'denied'`
 *   - `processed_by`        nullable; the approving/denying user's id
 *   - `processed_at`        nullable; when approved/denied
 *   - `denial_reason`       nullable; set only when denied
 *   - `created_at`          creation timestamp
 *
 * `custom_suffix` is `VARCHAR(100)`, matching the exact length constraint
 * already enforced on this same value by `POST /api/channels/custom`'s
 * validator (`body('customSuffix').trim().isLength({ min: 1, max: 100
 * })` in `server/routes/channels.js`) -- there is no reason for the
 * column backing a request for that value to allow a longer string than
 * the endpoint that eventually consumes it via
 * `Channel.createCustomChannel` ever would.
 *
 * `status` is a plain `VARCHAR(20)` with an application-enforced value
 * set (`'pending'`/`'approved'`/`'denied'`) and a `'pending'` default,
 * matching `access_requests.status`'s exact column shape in the baseline
 * schema (also `VARCHAR(20) DEFAULT 'pending'`, no `CHECK` constraint) --
 * this schema's established convention of enforcing enum-like text
 * columns at the application layer rather than via `CHECK` (see also the
 * reasoning note in `1786653600000_add-sync-operations-correlation-
 * failure-category.cjs`).
 *
 * `processed_by`/`processed_at`/`denial_reason` mirror
 * `access_requests`'s identically-named columns exactly (same types, no
 * `ON DELETE` clause on `processed_by`), since Requirement 23 Criteria
 * 5-7 explicitly describe this table's approve/deny transitions as
 * mirroring the existing Access_Request approval pattern from
 * Requirement 18.
 *
 * `team_id` uses `ON DELETE CASCADE`, matching `channels.team_id`'s exact
 * behavior in the baseline schema -- a `channel_requests` row has no
 * meaning once its parent team no longer exists, exactly like a
 * `channels` row.
 *
 * `requested_by` uses `ON DELETE SET NULL`, matching the same-named
 * `deployment_channels.requested_by` column added by
 * `1786730000000_create-deployment-channels.cjs`: the request record
 * (and its audit value) should survive the requesting user account being
 * removed later, rather than being deleted along with it or blocking the
 * user's deletion outright.
 *
 * ## Supporting index
 *
 * Unlike `deployment_channels`/`vendor_channel_grants` (Requirement 22/21),
 * neither Requirement 23 nor `design.md`'s Section 19 describes any
 * periodic or bulk "find due/pending rows across all teams" query against
 * this table -- approval/denial is a per-request, id-addressed action
 * (`approveChannelRequest(requestId, ...)` /
 * `denyChannelRequest(requestId, ...)`), and no "list pending requests"
 * query shape is specified anywhere in requirements.md or design.md for
 * this table. Adding a `status`/`team_id` index here would therefore be
 * speculative rather than tied to a described query pattern, so none is
 * added in this migration -- consistent with this task's guidance to add
 * a supporting index only when clearly justified by a described query
 * pattern.
 *
 * This task is scoped to ONLY the migration adding this table; the
 * `ChannelRequestService` methods that read/write it (task 45.x) are
 * deliberately out of scope here, per `tasks.md`'s dependency-ordering
 * note ("Every new table or column lands as its own migration task ahead
 * of the service/route tasks that depend on it").
 *
 * Uses node-pg-migrate's schema-builder API (`pgm.createTable`), matching
 * the convention established by every migration after the baseline (e.g.
 * `1786730000000_create-deployment-channels.cjs`).
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
const up = (pgm) => {
  pgm.createTable('channel_requests', {
    id: 'id',
    team_id: {
      type: 'integer',
      notNull: true,
      references: 'teams',
      onDelete: 'CASCADE',
    },
    custom_suffix: {
      type: 'varchar(100)',
      notNull: true,
    },
    member_permissions: {
      type: 'jsonb',
      notNull: true,
    },
    requested_by: {
      type: 'integer',
      references: 'users',
      onDelete: 'SET NULL',
    },
    // 'pending' | 'approved' | 'denied' -- enforced at the application
    // layer, matching access_requests.status's exact column shape.
    status: {
      type: 'varchar(20)',
      default: 'pending',
    },
    processed_by: {
      type: 'integer',
      references: 'users',
    },
    processed_at: {
      type: 'timestamp',
    },
    denial_reason: {
      type: 'text',
    },
    created_at: {
      type: 'timestamp',
      default: pgm.func('NOW()'),
    },
  });
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
const down = (pgm) => {
  pgm.dropTable('channel_requests');
};

module.exports = {
  shorthands,
  up,
  down,
};
