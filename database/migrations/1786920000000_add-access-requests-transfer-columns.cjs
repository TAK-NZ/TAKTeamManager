/**
 * Adds the two `access_requests` columns a Transfer_Request needs, plus
 * the two partial indexes that support them (Requirements 3.2, 3.7).
 *
 * `approval_team_id` records the Approval_Team -- the side of the
 * transfer that did *not* initiate it -- so the `request:approve` /
 * `request:deny` resolvers can gate on admin status against that Team
 * rather than against `target_team_id` (which for a `team_change` row
 * names the Destination_Team, i.e. possibly the initiator's own side).
 *
 * `initiated_by` records the Initiating_Admin's local `users.id`. It is
 * distinct from the `requester_*` columns, which on a Transfer_Request
 * hold that same admin's *contact* values so the existing approval and
 * denial emails reach them.
 *
 * Both columns are nullable with no default, which is what makes this
 * migration additive: every pre-existing `access_requests` row keeps
 * every other column value unchanged (Requirement 3.2). Neither column
 * is ever populated on a `new_account`, `role_change`, or `name_change`
 * row, so a `NOT NULL` column would be wrong even going forward.
 *
 * `idx_access_requests_approval_team_pending` supports the pending-request
 * visibility query, which scans for pending `team_change` rows and filters
 * by admin status on `approval_team_id`.
 *
 * `idx_access_requests_one_pending_team_change_per_user` is the
 * database-level backstop for Requirement 3.7 (at most one pending
 * Transfer_Request per user). The route's pre-flight `SELECT` is racy on
 * its own; this partial unique index closes the race on the path that
 * inserts, and the route maps a `23505` violation on it to the same 409
 * the pre-flight check returns. Creating a unique index over existing
 * data can fail on duplicates, but it is safe here: no `team_change` row
 * can exist yet (no route creates one before this feature), and the
 * partial predicate excludes every non-`team_change` and non-`pending`
 * row.
 *
 * Uses node-pg-migrate's schema-builder API (`pgm.addColumn`,
 * `pgm.createIndex` with a `where` clause), matching the convention
 * established by every migration after the baseline. `ifNotExists` on
 * every addition matches the idempotency style of
 * `1786880000000_add-access-requests-signup-code-used.cjs` and the
 * `ADD COLUMN IF NOT EXISTS` block in
 * `1786680000000_non-destructive-access-requests.cjs`.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
const shorthands = undefined;

const APPROVAL_TEAM_PENDING_INDEX = 'idx_access_requests_approval_team_pending';
const ONE_PENDING_TEAM_CHANGE_PER_USER_INDEX =
  'idx_access_requests_one_pending_team_change_per_user';

/**
 * Both partial indexes scope to exactly the rows this feature creates:
 * a Transfer_Request that is still awaiting a decision.
 */
const PENDING_TEAM_CHANGE_PREDICATE = "status = 'pending' AND request_type = 'team_change'";

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
const up = (pgm) => {
  pgm.addColumn(
    'access_requests',
    {
      approval_team_id: {
        type: 'integer',
        notNull: false,
        references: 'teams(id)',
        comment:
          'Requirement 3.2/3.3: the Team whose Team_Admins may approve or deny this Transfer_Request.',
      },
    },
    { ifNotExists: true }
  );

  pgm.addColumn(
    'access_requests',
    {
      initiated_by: {
        type: 'integer',
        notNull: false,
        references: 'users(id)',
        comment:
          'Requirement 3.2/3.3: the Initiating_Admin who created this Transfer_Request.',
      },
    },
    { ifNotExists: true }
  );

  // Requirement 4.2: pending-request visibility gates `team_change` rows
  // on admin status against `approval_team_id`.
  pgm.createIndex('access_requests', ['approval_team_id'], {
    name: APPROVAL_TEAM_PENDING_INDEX,
    where: PENDING_TEAM_CHANGE_PREDICATE,
    ifNotExists: true,
  });

  // Requirement 3.7: at most one pending Transfer_Request per user.
  pgm.createIndex('access_requests', ['existing_user_id'], {
    name: ONE_PENDING_TEAM_CHANGE_PER_USER_INDEX,
    unique: true,
    where: PENDING_TEAM_CHANGE_PREDICATE,
    ifNotExists: true,
  });
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
const down = (pgm) => {
  pgm.dropIndex('access_requests', ['existing_user_id'], {
    name: ONE_PENDING_TEAM_CHANGE_PER_USER_INDEX,
    ifExists: true,
  });
  pgm.dropIndex('access_requests', ['approval_team_id'], {
    name: APPROVAL_TEAM_PENDING_INDEX,
    ifExists: true,
  });

  pgm.dropColumn('access_requests', 'initiated_by', { ifExists: true });
  pgm.dropColumn('access_requests', 'approval_team_id', { ifExists: true });
};

module.exports = {
  shorthands,
  up,
  down,
};
