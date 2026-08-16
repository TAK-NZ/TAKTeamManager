/**
 * Adds two new columns to `sync_operations` and lowers the `max_retries`
 * default, as part of Phase 3 (Sync Worker Reliability & Throughput).
 *
 * 1. `correlation_id` (uuid, nullable) — populated by
 *    `EventPublisher.publishOperation` (task 33.2, not implemented here)
 *    with the HTTP request's correlation ID (Requirement 13.4) so that a
 *    Sync_Worker log line for this operation can be traced back to the
 *    originating request. Nullable because operations enqueued before
 *    this column existed, and any enqueue path not yet wired to pass a
 *    correlation ID, will have no value.
 *
 * 2. `failure_category` (text, nullable) — set by the Sync_Worker's
 *    failure-classification logic (tasks 27.2/28.2, not implemented
 *    here) to one of `'validation'`, `'permanent'`, or `'retryable'`,
 *    or left `NULL` for operations that haven't failed (or failed
 *    before this column existed). This mirrors the existing
 *    `sync_operations.status`/`operation_type` columns and every other
 *    enum-like text column in the baseline schema (`teams.visibility`,
 *    `access_requests.status`, `channel_memberships.permission`, etc.),
 *    none of which use a `CHECK` constraint — the valid value set is
 *    documented in a comment and enforced in application code instead.
 *    A plain nullable `text` column (no `CHECK`) is used here to stay
 *    consistent with that existing convention, rather than introducing
 *    a new constraint style for just this one column.
 *
 * 3. `max_retries`'s column default changes from 100 to 48
 *    (Requirement 9.2): 48 retries at the (separately implemented)
 *    1-hour backoff cap is a 48-hour maximum retry window, matching
 *    `ARCHITECTURE.md`. This only affects the default applied to
 *    *future* inserts that don't specify `max_retries` explicitly.
 *
 * 4. A backfill statement lowers `max_retries` to 48 on existing rows
 *    that are still sitting at the old default (100) and are still in
 *    a non-terminal status (`'pending'` or `'processing'`, per the
 *    baseline schema's `sync_operations.status` comment: `'pending',
 *    'processing', 'completed', 'failed'`), but only if their
 *    `retry_count` hasn't already reached the new cap. Rows already at
 *    or past 48 retries are deliberately left untouched — retroactively
 *    lowering their cap below their current `retry_count` would cause
 *    them to be treated as exhausted immediately, which is not this
 *    migration's intent (the new cap is a going-forward policy change,
 *    not a retroactive failure of in-flight operations). Terminal rows
 *    (`'completed'`/`'failed'`) are left untouched since `max_retries`
 *    no longer has any effect on them.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
const up = (pgm) => {
  pgm.addColumn('sync_operations', {
    correlation_id: {
      type: 'uuid',
      notNull: false,
    },
    failure_category: {
      type: 'text',
      notNull: false,
    },
  });

  pgm.alterColumn('sync_operations', 'max_retries', {
    default: 48,
  });

  // Data backfill (not a schema change): lower max_retries to the new
  // cap only for still-in-flight rows that haven't already retried past
  // it. See the file-level comment (point 4) for the reasoning.
  pgm.sql(`
    UPDATE sync_operations
    SET max_retries = 48
    WHERE max_retries = 100
      AND retry_count < 48
      AND status IN ('pending', 'processing');
  `);
};

/**
 * Reverses the schema changes. The backfill performed in `up()` is a
 * data migration and is intentionally NOT reversed here: there is no
 * reliable way to distinguish rows that were backfilled from 100 to 48
 * by this migration from rows that legitimately had `max_retries = 48`
 * for an unrelated reason, so restoring them to 100 on rollback would
 * risk incorrectly raising the retry cap on rows that were never
 * touched by `up()`. This is the normal/expected limitation of
 * reversing a data backfill and matches this repo's existing migration
 * conventions (see the baseline migration's teardown, which is likewise
 * a structural-only reversal).
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
const down = (pgm) => {
  pgm.alterColumn('sync_operations', 'max_retries', {
    default: 100,
  });

  pgm.dropColumn('sync_operations', ['correlation_id', 'failure_category']);
};

module.exports = {
  shorthands,
  up,
  down,
};
