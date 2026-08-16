/**
 * Creates the `email_rate_tracking` table used by the future
 * `requestAccessLimiter` rate-limiter middleware (task 22.2) to enforce
 * the per-email-address rate limit on `POST /api/requests/team-access`
 * and `GET /api/requests/verify/:token` (Requirement 7.2: no more than
 * 5 requests associated with a given email address within a 60-minute
 * window).
 *
 * Each row represents one tracking window for one email address: `email`
 * identifies the submitted address, `window_start` marks when that
 * window began, and `count` is the number of requests seen so far within
 * that window. The rate-limiter middleware itself (reading and writing
 * this table) is implemented separately in task 22.2 — this migration
 * only creates the storage.
 *
 * An index on `email` supports the middleware's "does this email have an
 * existing window" lookup, and a composite index on `(email, window_start)`
 * additionally supports the "how many submissions for this email in the
 * current window" lookup the middleware will need on every request.
 *
 * Per the baseline migration's own guidance, this migration (like
 * `1786597988855_create-token-revocations.cjs`) uses node-pg-migrate's
 * schema-builder API rather than raw SQL.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
const up = (pgm) => {
  pgm.createTable('email_rate_tracking', {
    id: 'id',
    email: {
      type: 'varchar(254)',
      notNull: true,
    },
    window_start: {
      type: 'timestamp',
      notNull: true,
    },
    count: {
      type: 'integer',
      notNull: true,
      default: 1,
    },
  });

  pgm.createIndex('email_rate_tracking', 'email');
  pgm.createIndex('email_rate_tracking', ['email', 'window_start']);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
const down = (pgm) => {
  pgm.dropTable('email_rate_tracking');
};

module.exports = {
  shorthands,
  up,
  down,
};
