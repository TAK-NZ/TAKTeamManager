'use strict';

/**
 * Authentik scaling, Phase 1: adds the two pieces of durable state the
 * shared rate limiter and priority-aware queue draining need.
 *
 * 1. `sync_operations.priority` (integer, default 100).
 *
 *    LOWER number = HIGHER priority, so the Sync_Worker's claim query can
 *    simply `ORDER BY priority ASC, created_at ASC` and keep its existing
 *    FIFO-within-a-priority behaviour. 100 is the "normal" default that
 *    every existing and most new operations use; urgent, user-perceptible
 *    mutations (delete/suspend/revoke/cleanup) are enqueued at a lower
 *    number so they pre-empt a large backlog of bulk background work (e.g.
 *    a 15K-user import) rather than waiting behind it. The wide gap to 100
 *    leaves room to slot intermediate priorities later without a backfill.
 *
 *    Backfilling existing rows is unnecessary: the column default applies
 *    to every already-enqueued row as 100 (normal), which is exactly the
 *    pre-change behaviour (pure `created_at` ordering), so this is a
 *    behaviour-preserving addition for anything already in the queue.
 *
 *    The partial index mirrors the predicate the claim query already uses
 *    (`status = 'pending' AND next_retry_at <= NOW()`) but orders by
 *    `(priority, created_at)` so the priority-aware claim stays index-
 *    supported rather than degrading into a sort of the whole pending set.
 *    `next_retry_at` is intentionally NOT in the ORDER BY (it is a
 *    predicate, not a sort key) so the index key matches the claim's
 *    `ORDER BY` exactly.
 *
 * 2. `rate_limit_buckets` -- the shared, cross-process token-bucket state.
 *
 *    The main server process AND every Sync_Worker replica route their
 *    Authentik calls through one logical token bucket per lane (`read`,
 *    `write`, `write_priority`), so the AGGREGATE request rate stays under
 *    the configured ceiling regardless of how many processes are running.
 *    A per-process in-memory bucket would multiply the real rate by the
 *    process count; the profiled ceilings (writes ~3-5/s) are far too low
 *    to tolerate that. Postgres is the coordination point (this app has no
 *    Redis) -- consistent with how the worker already coordinates via
 *    `FOR UPDATE SKIP LOCKED`.
 *
 *    `bucket_key` is the lane name (PK). `tokens` is the current available
 *    token count (double precision so a sub-1 fractional refill can
 *    accumulate between calls rather than being lost to integer
 *    truncation). `capacity` and `refill_per_sec` are written from the
 *    configured ceilings on each acquire (so a config change takes effect
 *    without a migration), and `last_refill_at` is the timestamp the
 *    refill math measures elapsed time from. The three lane rows are
 *    seeded here so the acquire path is a pure UPDATE and never has to
 *    branch on "row missing".
 *
 * down() reverses both additions. Dropping `rate_limit_buckets` discards
 * only transient throttle bookkeeping (it is rebuilt on next use); dropping
 * `priority` returns the queue to pure `created_at` ordering.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
const shorthands = undefined;

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE sync_operations ADD COLUMN priority integer NOT NULL DEFAULT 100;
    COMMENT ON COLUMN sync_operations.priority IS 'Claim priority for the Sync_Worker: LOWER number = HIGHER priority, drained via ORDER BY priority ASC, created_at ASC. 100 = normal (default, every existing row); urgent mutations (delete/suspend/revoke/cleanup) are enqueued lower so they pre-empt bulk background work. See server/services/EventPublisher.js for the op-type -> priority mapping and .kiro/steering/authentik-scaling.md.';

    CREATE INDEX idx_sync_operations_priority_claim
      ON sync_operations (priority, created_at)
      WHERE status = 'pending';

    CREATE TABLE rate_limit_buckets (
      bucket_key      character varying(50) PRIMARY KEY,
      tokens          double precision NOT NULL,
      capacity        double precision NOT NULL,
      refill_per_sec  double precision NOT NULL,
      last_refill_at  timestamp without time zone NOT NULL DEFAULT now()
    );
    COMMENT ON TABLE rate_limit_buckets IS 'Shared cross-process token buckets throttling Authentik API calls. One row per lane (read/write/write_priority). Refill-and-consume is a single atomic UPDATE (see server/services/authentikRateLimiter.js). capacity/refill_per_sec are rewritten from the configured ceilings on each acquire so a config change needs no migration.';

    INSERT INTO rate_limit_buckets (bucket_key, tokens, capacity, refill_per_sec) VALUES
      ('read', 5, 5, 5),
      ('write', 3, 3, 3),
      ('write_priority', 2, 2, 2);
  `);
};

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
const down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS rate_limit_buckets;
    DROP INDEX IF EXISTS idx_sync_operations_priority_claim;
    ALTER TABLE sync_operations DROP COLUMN IF EXISTS priority;
  `);
};

module.exports = { shorthands, up, down };
