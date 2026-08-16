/**
 * Creates the `sync_worker_heartbeat` table (Requirement 14.6, task 34.4):
 * a single-row liveness marker updated by the Sync_Worker at the end of
 * every poll cycle, so an external health check (the lightweight
 * `http.createServer` endpoint added in `server/workers/syncWorker.js`,
 * listening on `SYNC_WORKER_HEALTH_PORT`) can determine whether the
 * Sync_Worker's poll loop is still alive without needing to instrument
 * the worker process directly.
 *
 * This follows the "single-row upsert table" pattern: the row's `id` is
 * always `1` (enforced by a CHECK constraint, mirroring the "fixed id"
 * idiom already documented for this table in `design.md`'s New Tables
 * section), and the Sync_Worker upserts `last_heartbeat_at = NOW()` via
 * `INSERT ... ON CONFLICT (id) DO UPDATE` every poll cycle rather than
 * inserting a new row per cycle. `worker_id` is an optional diagnostic
 * column (the Sync_Worker process's PID as a string) so an operator
 * inspecting the row directly can tell which OS process last reported a
 * heartbeat; it is not required for the health-check logic itself.
 *
 * No seed row is inserted here -- the first heartbeat upsert issued by
 * the Sync_Worker creates row id=1 on its first poll cycle. Until that
 * first upsert happens (e.g. immediately after a fresh migration, before
 * the Sync_Worker process has started), the health endpoint's query
 * against this table finds no row, which it treats the same as a stale
 * heartbeat (503) rather than throwing -- see `checkHeartbeatHealth` in
 * `server/workers/syncWorker.js`.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
const up = (pgm) => {
  pgm.createTable('sync_worker_heartbeat', {
    id: {
      type: 'integer',
      primaryKey: true,
      notNull: true,
    },
    last_heartbeat_at: {
      type: 'timestamp',
      notNull: true,
      default: pgm.func('NOW()'),
    },
    worker_id: {
      type: 'varchar(255)',
    },
  });

  // Requirement 14.6: enforce the single-row-upsert-table pattern at the
  // database level -- the only permitted primary key value is 1 -- so an
  // application bug can never accidentally insert a second row.
  pgm.addConstraint('sync_worker_heartbeat', 'sync_worker_heartbeat_single_row', {
    check: 'id = 1',
  });
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
const down = (pgm) => {
  pgm.dropTable('sync_worker_heartbeat');
};

module.exports = {
  shorthands,
  up,
  down,
};
