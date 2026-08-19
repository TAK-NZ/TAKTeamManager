/**
 * Creates the `org_interest_requests` table for the Sign-Up Flow Rework
 * feature (Requirement 7.3).
 *
 * This table stores requests from verified users who have no available
 * teams to join and wish to express interest in having their organisation
 * onboarded. These are informational leads for global admins.
 *
 * Column shape, per Requirement 7.3 and `design.md`:
 *   - `email`       the verified email of the requester
 *   - `first_name`  optional first name
 *   - `last_name`   optional last name
 *   - `org_name`    the organisation the user is requesting be onboarded
 *   - `status`      lifecycle state: 'pending' | 'actioned' | 'dismissed'
 *   - `created_at`  timestamp of submission
 *
 * No foreign key to `users` since these are unauthenticated submissions
 * from users who do not yet have accounts.
 *
 * Supporting index on (email, status) enables the "at most one pending
 * per email" check (Requirement 5.7) and efficient lookups by email.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
const shorthands = undefined;

const INDEX_NAME = 'idx_org_interest_requests_email_status';

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
const up = (pgm) => {
  pgm.createTable('org_interest_requests', {
    id: 'id',
    email: {
      type: 'varchar(255)',
      notNull: true,
    },
    first_name: {
      type: 'varchar(255)',
    },
    last_name: {
      type: 'varchar(255)',
    },
    org_name: {
      type: 'varchar(255)',
      notNull: true,
    },
    status: {
      type: 'varchar(20)',
      notNull: true,
      default: "'pending'",
    },
    created_at: {
      type: 'timestamp',
      notNull: true,
      default: pgm.func('CURRENT_TIMESTAMP'),
    },
  });

  pgm.createIndex('org_interest_requests', ['email', 'status'], {
    name: INDEX_NAME,
  });
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
const down = (pgm) => {
  pgm.dropIndex('org_interest_requests', ['email', 'status'], { name: INDEX_NAME });
  pgm.dropTable('org_interest_requests');
};

module.exports = {
  shorthands,
  up,
  down,
};
