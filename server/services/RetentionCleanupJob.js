const pool = require('../config/database');
const logger = require('../config/logger').createLogger('RetentionCleanupJob');
const { withJobLock, JOB_LOCK_KEYS } = require('../utils/jobLock');

/**
 * Requirement 25 (Data Retention) / task 47.1: implements the
 * Retention_Cleanup_Job described in design.md's Section 20 ("Data
 * Retention"). Runs inside the Sync_Worker process on its OWN
 * `setInterval`, independent of the main poll loop (`SyncWorker`'s own
 * `processNextOperation` cycle) -- mirroring `ExpiryScheduler`'s
 * already-established "separate interval started/stopped alongside the
 * poll loop" shape (see `server/services/ExpiryScheduler.js`), so that a
 * future change to pause polling without pausing retention cleanup (or
 * vice versa) is trivial, per design.md's Section 20 opening note.
 *
 * Per Requirement 25 Criteria 3/5, the schedule default is once every 24
 * hours; per Criterion 6, any error raised while deleting rows is caught,
 * logged via the structured logger, and never allowed to crash or exit
 * the Sync_Worker process -- the next scheduled run simply retries.
 *
 * Retention thresholds (task 47.1/47.2 note): task 47.2 wires
 * `SYNC_OPERATIONS_RETENTION_DAYS` (default 90) and
 * `AUDIT_LOGS_RETENTION_DAYS` (default 365) into Config_Validator for
 * startup-time validation (positive integers, with the audit threshold
 * required to exceed the sync-operations threshold, per Requirement
 * 25.4's "distinct from and longer than"; see
 * `collectRetentionConfigIssues` in `server/config/configValidator.js`).
 * This class still reads those same two environment variables directly,
 * with the same stated defaults, so the job is fully functional
 * standalone -- Config_Validator's startup check simply guarantees these
 * values are always well-formed by the time this job ever runs.
 *
 * Security-hardening addition: also deletes expired `token_revocations`
 * rows (`WHERE expires_at < NOW()`). This table is written once per
 * logout with a valid `jti` (`server/routes/auth.js`) and read once per
 * authenticated request (`server/middleware/auth.js`'s revocation
 * check), but nothing purged it before this change -- despite
 * `auth.js`'s own comment on the INSERT already describing "the
 * retention job's `WHERE expires_at < NOW()` purge pattern" as if it
 * existed. Deletion is keyed on `expires_at` alone (not a configurable
 * days-based threshold like the other two tables): a revocation row is
 * useless the moment its token would have expired naturally regardless
 * of when that happens to fall, so there is no equivalent "how many days
 * to keep it" question to make configurable here. The existing
 * `token_revocations_expires_at_index` (baseline migration) makes this
 * DELETE's WHERE clause an index range scan rather than a full table
 * scan.
 *
 * Lifecycle mirrors `ExpiryScheduler`'s `start()`/`stop()` shape (a plain
 * `setInterval`/`clearInterval` wrapper, idempotent against a double
 * `start()`/`stop()`), and, like `ExpiryScheduler`, `start()` runs one
 * cleanup pass immediately (in addition to scheduling the recurring
 * interval) so a freshly-deployed/restarted worker doesn't wait a full
 * 24 hours for its first cleanup pass after a restart or deploy; every
 * subsequent pass is then driven purely by the `setInterval` timer.
 */
class RetentionCleanupJob {
  constructor({ pool: dbPool = pool } = {}) {
    this.pool = dbPool;

    // Requirement 25.3/25.5: "once every 24 hours" is the stated default
    // schedule; unlike `ExpiryScheduler`'s vendor-grant 15-minute figure,
    // requirements.md/design.md do not impose a hard upper bound on this
    // interval, so only a lower bound is enforced here -- guarding
    // against a misconfigured near-zero interval turning this into a
    // tight busy-loop against the database, mirroring the reasoning
    // behind `ExpiryScheduler`'s MIN_INTERVAL_SECONDS guard. Clamped in
    // seconds and converted to milliseconds once at the end -- the field
    // stays `intervalMs` because `setInterval` takes milliseconds.
    const MIN_INTERVAL_SECONDS = 60; // 1 minute
    const DEFAULT_INTERVAL_SECONDS = 24 * 60 * 60; // 24 hours

    const intervalSeconds = Math.max(
      MIN_INTERVAL_SECONDS,
      parseInt(process.env.RETENTION_CLEANUP_INTERVAL_SECONDS, 10) || DEFAULT_INTERVAL_SECONDS
    );
    this.intervalMs = intervalSeconds * 1000;

    this.timer = null;
  }

  /**
   * Starts the job: runs one cleanup pass immediately, then schedules a
   * recurring pass every `this.intervalMs`. A no-op if already running
   * (mirrors `ExpiryScheduler.start()`'s idempotency against a double
   * start).
   */
  start() {
    if (this.timer) return;

    logger.info({ intervalMs: this.intervalMs }, 'Retention cleanup job started');

    // Run once immediately so a freshly-deployed/restarted worker doesn't
    // wait a full 24 hours for its first cleanup pass.
    this.runCleanup();

    this.timer = setInterval(() => {
      this.runCleanup();
    }, this.intervalMs);
  }

  /**
   * Stops the job, clearing the recurring interval. A no-op if not
   * currently running.
   */
  stop() {
    if (!this.timer) return;

    clearInterval(this.timer);
    this.timer = null;
    logger.info('Retention cleanup job stopped');
  }

  /**
   * Runs one cleanup pass, via `deleteExpiredRows()`. Requirement 25.6:
   * any thrown error is caught and logged via the structured logger
   * rather than propagated, so a failure here can never crash or exit
   * the Sync_Worker process; the next scheduled `setInterval` tick
   * simply retries.
   *
   * @returns {Promise<void>}
   */
  async runCleanup() {
    try {
      // Single-runner guard: at desiredCount > 1, only the worker that wins
      // the advisory lock runs the DELETE pass. The cleanup is idempotent
      // (a second run's WHERE clause simply matches nothing), so running it
      // twice would be harmless-but-wasteful; the lock avoids the wasted
      // scans and keeps the "runs once per tick" contract these periodic
      // jobs are designed around. A worker that does not win the lock skips
      // this tick and retries next interval.
      await withJobLock(this.pool, JOB_LOCK_KEYS.RETENTION_CLEANUP, async () => {
        const result = await this.deleteExpiredRows();
        logger.info(result, 'Retention cleanup run completed');
      });
    } catch (error) {
      logger.error({ err: error }, 'Retention cleanup run failed');
    }
  }

  /**
   * Executes the DELETE statements from design.md's Section 20, against
   * `sync_operations` and `audit_logs`, plus a third against
   * `token_revocations` (see the class-level comment above).
   *
   * `sync_operations`: deletes rows that are both in a terminal state
   * (`completed`, or `failed` with a `failure_category` of `permanent`
   * or `validation`) AND older than `SYNC_OPERATIONS_RETENTION_DAYS`.
   * Requirement 25.2: a `pending` (including a retryable failure
   * awaiting its next retry -- which this codebase represents as
   * `status = 'pending'` with an incremented `retry_count`, per
   * `SyncWorker.handleOperationError`) or `processing` row is
   * structurally excluded by the `status IN ('completed', 'failed')`
   * clause alone, regardless of that row's age.
   *
   * `audit_logs`: deletes every row older than
   * `AUDIT_LOGS_RETENTION_DAYS`, with no status-based condition (that
   * table has no analogous in-flight state to protect).
   *
   * `token_revocations`: deletes every row whose `expires_at` has
   * already passed. Unlike the other two tables, this has no
   * configurable days-based threshold -- see the class-level comment.
   *
   * Retention day thresholds for the first two tables are read directly
   * from `SYNC_OPERATIONS_RETENTION_DAYS` (default 90) and
   * `AUDIT_LOGS_RETENTION_DAYS` (default 365) on every run (rather than
   * cached at construction time), so a changed environment variable
   * takes effect on the very next scheduled pass without requiring a
   * process restart.
   *
   * @returns {Promise<{syncOperationsDeleted: number, auditLogsDeleted: number, tokenRevocationsDeleted: number}>}
   */
  async deleteExpiredRows() {
    const syncOperationsRetentionDays =
      parseInt(process.env.SYNC_OPERATIONS_RETENTION_DAYS, 10) || 90;
    const auditLogsRetentionDays = parseInt(process.env.AUDIT_LOGS_RETENTION_DAYS, 10) || 365;

    const syncOperationsResult = await this.pool.query(
      `DELETE FROM sync_operations
       WHERE status IN ('completed', 'failed')
         AND (status != 'failed' OR failure_category IN ('permanent', 'validation'))
         AND created_at < NOW() - INTERVAL '1 day' * $1::integer`,
      [syncOperationsRetentionDays]
    );

    const auditLogsResult = await this.pool.query(
      `DELETE FROM audit_logs
       WHERE created_at < NOW() - INTERVAL '1 day' * $1::integer`,
      [auditLogsRetentionDays]
    );

    const tokenRevocationsResult = await this.pool.query(
      `DELETE FROM token_revocations WHERE expires_at < NOW()`
    );

    return {
      syncOperationsDeleted: syncOperationsResult.rowCount,
      auditLogsDeleted: auditLogsResult.rowCount,
      tokenRevocationsDeleted: tokenRevocationsResult.rowCount
    };
  }
}

module.exports = RetentionCleanupJob;
