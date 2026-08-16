/**
 * Real-Postgres integration test for Requirement 25.2 (task 47.4):
 *
 *   "THE Retention_Cleanup_Job SHALL NOT delete or archive a
 *   `sync_operations` row whose status is `pending` or `retrying`,
 *   regardless of that row's age."
 *
 * `RetentionCleanupJob.test.js` already asserts this structurally, by
 * inspecting the SQL string handed to a mocked `pool.query` (see its
 * "excludes pending/retrying (non-terminal) sync_operations rows from
 * deletion via the WHERE clause itself, regardless of age" test). That
 * mocked assertion proves the WHERE clause CONTAINS the right substrings,
 * but it cannot prove those clauses are actually joined with the correct
 * operator precedence once executed against a real query planner -- e.g.
 * a clause ordering/parenthesization bug that quietly turns the intended
 * `AND` into an effective `OR` for some rows would still pass a
 * substring-based mock assertion, yet would let an old `pending` row be
 * deleted for real. Requirement 25.2's own "regardless of age" phrasing
 * calls out exactly this age-independent guarantee as the thing worth
 * protecting, so this file adds a companion real-DB test that seeds an
 * old `pending` row and an old `completed` row of the same age, runs the
 * real `deleteExpiredRows()` against a real Postgres instance, and
 * asserts only the `completed` row was actually deleted.
 *
 * Following the existing separation convention in this codebase
 * (`syncWorker.test.js` / `syncWorker.integration.test.js`,
 * `Channel.test.js` / `Channel.integration.test.js`,
 * `TeamMembershipService.test.js` /
 * `TeamMembershipService.integration.test.js`), this real-DB test lives
 * in its own `*.integration.test.js` file rather than being added to the
 * existing mocked `RetentionCleanupJob.test.js`.
 *
 * Connection convention: mirrors `server/workers/syncWorker.integration
 * .test.js`/`server/models/Channel.integration.test.js` exactly --
 * `DB_HOST`/`DB_PORT`/`DB_NAME`/`DB_USER`/`DB_PASSWORD` are read from the
 * environment if already set, otherwise defaulted to the local
 * Docker-based test container (`tak_migration_test_501`, Postgres 15,
 * host port 15433, database `tak_team_manager`, user `postgres`,
 * password `postgres123`). These are set on `process.env` BEFORE
 * `../config/database` (required transitively by `RetentionCleanupJob`)
 * is first constructed anywhere in this file's module graph, and are
 * restored in `afterAll` so this file's env manipulation can never leak
 * into another test file running afterward in the same Jest worker
 * process.
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

const pool = require('../config/database');
const RetentionCleanupJob = require('./RetentionCleanupJob');

describe('RetentionCleanupJob.deleteExpiredRows against a real Postgres instance (Requirement 25.2, task 47.4)', () => {
  let seededIds = [];

  beforeAll(async () => {
    try {
      await pool.query('SELECT 1');
    } catch (error) {
      throw new Error(
        `Real Postgres test database is not reachable at ` +
          `${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_NAME} ` +
          `(user "${process.env.DB_USER}"). This integration test (task 47.4) requires ` +
          `a real, running, already-migrated Postgres instance -- it deliberately does not ` +
          `mock "pg"/"../config/database", since the whole point is to prove the real WHERE ` +
          `clause's operator precedence, not just the SQL string's substrings. ` +
          `Underlying error: ${error.message}`,
        { cause: error }
      );
    }
  });

  afterAll(async () => {
    await pool.end();

    process.env.DB_HOST = ORIGINAL_ENV.DB_HOST;
    process.env.DB_PORT = ORIGINAL_ENV.DB_PORT;
    process.env.DB_NAME = ORIGINAL_ENV.DB_NAME;
    process.env.DB_USER = ORIGINAL_ENV.DB_USER;
    process.env.DB_PASSWORD = ORIGINAL_ENV.DB_PASSWORD;
  });

  afterEach(async () => {
    if (seededIds.length > 0) {
      await pool.query('DELETE FROM sync_operations WHERE id = ANY($1)', [seededIds]);
      seededIds = [];
    }
  });

  it('deletes an old completed row but leaves an equally old pending row untouched', async () => {
    process.env.SYNC_OPERATIONS_RETENTION_DAYS = '90';

    const oldCreatedAt = "NOW() - INTERVAL '1 day' * 200"; // well past the 90-day threshold

    const pendingRow = await pool.query(
      `INSERT INTO sync_operations
         (operation_type, target_user_id, target_group_id, payload, status, retry_count, max_retries, created_at)
       VALUES ('add_user_to_group', 900101, 'grp-retention-pending', '{}'::jsonb, 'pending', 3, 48, ${oldCreatedAt})
       RETURNING id`
    );
    const completedRow = await pool.query(
      `INSERT INTO sync_operations
         (operation_type, target_user_id, target_group_id, payload, status, retry_count, max_retries, created_at)
       VALUES ('add_user_to_group', 900102, 'grp-retention-completed', '{}'::jsonb, 'completed', 0, 48, ${oldCreatedAt})
       RETURNING id`
    );

    const pendingId = pendingRow.rows[0].id;
    const completedId = completedRow.rows[0].id;
    seededIds = [pendingId, completedId];

    const job = new RetentionCleanupJob({ pool });
    await job.deleteExpiredRows();

    const remaining = await pool.query('SELECT id, status FROM sync_operations WHERE id = ANY($1)', [
      [pendingId, completedId]
    ]);

    // Only the pending row survives -- the completed row was deleted
    // despite both rows sharing the exact same (old) created_at.
    expect(remaining.rows).toHaveLength(1);
    expect(remaining.rows[0]).toMatchObject({ id: pendingId, status: 'pending' });

    // Reflect reality for the afterEach cleanup: the completed row is
    // already gone, so only the pending row still needs deleting.
    seededIds = [pendingId];
  });
});
