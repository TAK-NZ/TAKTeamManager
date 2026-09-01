/**
 * Real-Postgres integration test for Requirement 10.4 (task 30.4):
 *
 *   "WHERE multiple Sync_Worker instances run concurrently for
 *   horizontal scaling, THE Sync_Worker SHALL rely on the existing
 *   `FOR UPDATE SKIP LOCKED` row locking so that no two instances
 *   process the same `sync_operations` row (verified by an automated
 *   test running at least two concurrent worker instances against a
 *   shared queue and confirming each row's terminal status transition
 *   occurs exactly once)."
 *
 * Every other test file for this worker (`syncWorker.test.js`) mocks
 * `pg` entirely (`jest.mock('pg', () => ({ Pool: jest.fn(() => ({...
 * mocked methods ...})) }))`), which is correct for unit-testing
 * `handleOperationError`/`executeOperation`/etc. in isolation, but a
 * mocked `pool.query` has no actual row-locking behavior -- it can
 * never prove that two real `SyncWorker` instances won't double-process
 * the same row. This file deliberately does NOT mock `pg` or
 * `../config/database`; it is the one place in this codebase that
 * exercises `FOR UPDATE SKIP LOCKED`'s real Postgres semantics, against
 * a real, seeded `sync_operations` queue.
 *
 * Connection parameters: read from `DB_HOST`/`DB_PORT`/`DB_NAME`/
 * `DB_USER`/`DB_PASSWORD` if already present in the environment (e.g. a
 * CI job that provisions its own test database), otherwise defaulting
 * to the local Docker-based test container used during development of
 * this task (`tak_migration_test_501`, Postgres 15 on host port 15433,
 * database `tak_team_manager`, already migrated -- confirmed via
 * `docker exec tak_migration_test_501 psql -U postgres -d
 * tak_team_manager -c "\dt"`/`"\d sync_operations"`; the container's
 * actual `POSTGRES_PASSWORD` is `postgres123`, confirmed via `docker
 * inspect tak_migration_test_501`, NOT the more commonly-guessed
 * `postgres`).
 *
 * These env vars are read/defaulted and assigned onto `process.env`
 * BEFORE `../workers/syncWorker` is required -- and therefore before
 * `../config/database`'s module-level `pool` singleton (required
 * transitively via `RetentionCleanupJob`) is first
 * constructed anywhere in this file's module graph -- and are restored
 * to their original values in `afterAll`, so this file's env
 * manipulation can never leak into another test file that happens to
 * run afterward in the same Jest worker process (every other test file
 * continues to mock `pg`/`../config/database` and must keep working
 * unaffected by this file).
 *
 * If the real test database described above is not actually reachable,
 * `beforeAll` throws with a clear, descriptive error identifying the
 * connection target and underlying cause, rather than letting each test
 * in this file fail with an opaque connection-timeout error, and rather
 * than silently falling back to a mock (which would defeat the entire
 * point of this test).
 */

const ORIGINAL_ENV = {
  DB_HOST: process.env.DB_HOST,
  DB_PORT: process.env.DB_PORT,
  DB_NAME: process.env.DB_NAME,
  DB_USER: process.env.DB_USER,
  DB_PASSWORD: process.env.DB_PASSWORD
};

process.env.DB_HOST = process.env.DB_HOST || 'localhost';
process.env.DB_PORT = process.env.DB_PORT || '15433';
process.env.DB_NAME = process.env.DB_NAME || 'tak_team_manager';
process.env.DB_USER = process.env.DB_USER || 'postgres';
process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'postgres123';

const { Pool } = require('pg');
const SyncWorker = require('./syncWorker');

// 10-20 rows per the task's guidance: enough to make a genuine
// concurrent split between the two worker instances likely, while
// staying well under the default SYNC_WORKER_BATCH_SIZE (50), so either
// worker's single processNextOperation() call could in principle claim
// every row in one fetch -- the assertions below hold regardless of
// exactly how the race between the two instances resolves.
const SEED_ROW_COUNT = 15;

describe('SyncWorker concurrent batch processing against a real Postgres queue (Requirement 10.4, task 30.4)', () => {
  let seedPool;
  let seededIds = [];

  beforeAll(async () => {
    seedPool = new Pool({
      host: process.env.DB_HOST,
      port: process.env.DB_PORT,
      database: process.env.DB_NAME,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD
    });

    try {
      await seedPool.query('SELECT 1');
    } catch (error) {
      throw new Error(
        `Real Postgres test database is not reachable at ` +
          `${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_NAME} ` +
          `(user "${process.env.DB_USER}"). This integration test (task 30.4) requires ` +
          `a real, running, already-migrated Postgres instance -- it deliberately does not ` +
          `mock "pg", since the whole point is to exercise real FOR UPDATE SKIP LOCKED ` +
          `row-locking semantics. Underlying error: ${error.message}`,
        { cause: error }
      );
    }
  });

  afterAll(async () => {
    await seedPool.end();

    process.env.DB_HOST = ORIGINAL_ENV.DB_HOST;
    process.env.DB_PORT = ORIGINAL_ENV.DB_PORT;
    process.env.DB_NAME = ORIGINAL_ENV.DB_NAME;
    process.env.DB_USER = ORIGINAL_ENV.DB_USER;
    process.env.DB_PASSWORD = ORIGINAL_ENV.DB_PASSWORD;
  });

  beforeEach(async () => {
    seededIds = [];

    for (let i = 0; i < SEED_ROW_COUNT; i++) {
      // Arbitrary, unique-per-row values. No FK constraint ties
      // target_user_id to a real `users` row (confirmed via `\d
      // sync_operations`), and the stubbed handler (see the test below)
      // never actually queries `users`, so these need not reference
      // real user records -- only the payload SHAPE needs to satisfy
      // `add_user_to_group`'s schema in `operationSchemas.js`
      // (target_user_id: number, target_group_id: string).
      const targetUserId = 900000 + i;
      const targetGroupId = `group-concurrency-test-${i}`;
      const payload = { target_user_id: targetUserId, target_group_id: targetGroupId };

      const result = await seedPool.query(
        `INSERT INTO sync_operations
           (operation_type, target_user_id, target_group_id, payload, status, retry_count, max_retries)
         VALUES ('add_user_to_group', $1, $2, $3, 'pending', 0, 48)
         RETURNING id`,
        [targetUserId, targetGroupId, JSON.stringify(payload)]
      );

      seededIds.push(result.rows[0].id);
    }
  });

  afterEach(async () => {
    if (seededIds.length > 0) {
      await seedPool.query('DELETE FROM sync_operations WHERE id = ANY($1)', [seededIds]);
    }
  });

  it('processes every seeded row to a terminal status exactly once across two concurrent SyncWorker instances, with no row claimed by both', async () => {
    // Two independent SyncWorker instances, each with its OWN pg.Pool
    // (constructed from the same DB_* env vars, so both point at the
    // same real test database), simulating two independent worker
    // processes competing for the same queue.
    const worker1 = new SyncWorker();
    const worker2 = new SyncWorker();

    // Stub the Authentik-calling handler on EACH instance so this test
    // never makes a real network call to Authentik -- only the DATABASE
    // interactions (the real FOR UPDATE SKIP LOCKED fetch, the real
    // status UPDATEs) are real here.
    worker1.addUserToGroup = jest.fn().mockResolvedValue();
    worker2.addUserToGroup = jest.fn().mockResolvedValue();

    // Wrap (rather than replace) executeOperationSafely on each
    // instance, so the REAL batch-fetch -> dispatch -> terminal-status
    // path still runs end-to-end against the real database; this
    // wrapper only records which operation ids each worker instance was
    // actually handed, per-instance, per the task's tracking strategy.
    const worker1ProcessedIds = [];
    const originalExecuteOperationSafely1 = worker1.executeOperationSafely.bind(worker1);
    worker1.executeOperationSafely = jest.fn(async (operation) => {
      worker1ProcessedIds.push(operation.id);
      return originalExecuteOperationSafely1(operation);
    });

    const worker2ProcessedIds = [];
    const originalExecuteOperationSafely2 = worker2.executeOperationSafely.bind(worker2);
    worker2.executeOperationSafely = jest.fn(async (operation) => {
      worker2ProcessedIds.push(operation.id);
      return originalExecuteOperationSafely2(operation);
    });

    try {
      // Requirement 10.4: run both instances' batch-fetch-and-process
      // cycle CONCURRENTLY against the one shared, seeded queue,
      // relying on FOR UPDATE SKIP LOCKED's real Postgres row-locking
      // behavior to ensure they don't both grab the same rows.
      await Promise.all([worker1.processNextOperation(), worker2.processNextOperation()]);

      // No row was processed by BOTH workers: the two id-lists are
      // disjoint.
      const idsProcessedByBoth = worker1ProcessedIds.filter((id) => worker2ProcessedIds.includes(id));
      expect(idsProcessedByBoth).toEqual([]);

      // Their union covers every seeded row exactly once: no id appears
      // more than once across the combined list (which would indicate a
      // row being handed to executeOperationSafely twice, whether by the
      // same worker or the other one), and the combined set equals
      // exactly the set of seeded ids -- nothing missing, nothing extra.
      const combinedProcessedIds = [...worker1ProcessedIds, ...worker2ProcessedIds];
      expect(combinedProcessedIds.length).toBe(new Set(combinedProcessedIds).size);
      expect(new Set(combinedProcessedIds)).toEqual(new Set(seededIds));

      // Every seeded row ended up in a terminal status -- none remain
      // 'pending'/'processing'.
      const statusResult = await seedPool.query(
        'SELECT id, status FROM sync_operations WHERE id = ANY($1)',
        [seededIds]
      );
      expect(statusResult.rows).toHaveLength(SEED_ROW_COUNT);
      for (const row of statusResult.rows) {
        expect(['completed', 'failed']).toContain(row.status);
      }

      // The stubbed handler's total call count, summed across both
      // workers' own mock instances, equals the total seeded row count
      // -- confirming the handler was dispatched exactly once per row,
      // never zero times (skipped) and never twice (double-dispatched).
      const totalHandlerCalls =
        worker1.addUserToGroup.mock.calls.length + worker2.addUserToGroup.mock.calls.length;
      expect(totalHandlerCalls).toBe(SEED_ROW_COUNT);
    } finally {
      await worker1.pool.end();
      await worker2.pool.end();
    }
  });
});
