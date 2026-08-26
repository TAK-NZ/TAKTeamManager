jest.mock('../config/database', () => ({
  query: jest.fn()
}));

const mockLoggerInstance = { info: jest.fn(), error: jest.fn(), debug: jest.fn(), warn: jest.fn() };
jest.mock('../config/logger', () => ({
  createLogger: jest.fn(() => mockLoggerInstance)
}));

const pool = require('../config/database');
const RetentionCleanupJob = require('./RetentionCleanupJob');

/**
 * Requirement 25 (task 47.1): `RetentionCleanupJob.deleteExpiredRows()`
 * executes the two DELETE statements from design.md's Section 20 against
 * `sync_operations` and `audit_logs`, reading the retention thresholds
 * from `SYNC_OPERATIONS_RETENTION_DAYS` (default 90) and
 * `AUDIT_LOGS_RETENTION_DAYS` (default 365) on every run.
 */
describe('RetentionCleanupJob.deleteExpiredRows', () => {
  let job;
  const originalSyncDays = process.env.SYNC_OPERATIONS_RETENTION_DAYS;
  const originalAuditDays = process.env.AUDIT_LOGS_RETENTION_DAYS;

  beforeEach(() => {
    jest.clearAllMocks();
    pool.query.mockResolvedValue({ rowCount: 0 });
    job = new RetentionCleanupJob({ pool });
  });

  afterEach(() => {
    if (originalSyncDays === undefined) delete process.env.SYNC_OPERATIONS_RETENTION_DAYS;
    else process.env.SYNC_OPERATIONS_RETENTION_DAYS = originalSyncDays;

    if (originalAuditDays === undefined) delete process.env.AUDIT_LOGS_RETENTION_DAYS;
    else process.env.AUDIT_LOGS_RETENTION_DAYS = originalAuditDays;
  });

  it('deletes sync_operations rows in a terminal state older than the configured threshold, defaulting to 90 days', async () => {
    delete process.env.SYNC_OPERATIONS_RETENTION_DAYS;

    await job.deleteExpiredRows();

    const syncCall = pool.query.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('DELETE FROM sync_operations')
    );
    expect(syncCall).toBeDefined();
    expect(syncCall[0]).toContain("status IN ('completed', 'failed')");
    expect(syncCall[0]).toContain("failure_category IN ('permanent', 'validation')");
    expect(syncCall[1]).toEqual([90]);
  });

  it('deletes audit_logs rows older than the configured threshold, defaulting to 365 days', async () => {
    delete process.env.AUDIT_LOGS_RETENTION_DAYS;

    await job.deleteExpiredRows();

    const auditCall = pool.query.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('DELETE FROM audit_logs')
    );
    expect(auditCall).toBeDefined();
    expect(auditCall[1]).toEqual([365]);
  });

  it('reads configured retention thresholds from the environment on every run', async () => {
    process.env.SYNC_OPERATIONS_RETENTION_DAYS = '30';
    process.env.AUDIT_LOGS_RETENTION_DAYS = '180';

    await job.deleteExpiredRows();

    const syncCall = pool.query.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('DELETE FROM sync_operations')
    );
    const auditCall = pool.query.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('DELETE FROM audit_logs')
    );
    expect(syncCall[1]).toEqual([30]);
    expect(auditCall[1]).toEqual([180]);
  });

  it('returns the number of rows deleted from each table', async () => {
    pool.query
      .mockResolvedValueOnce({ rowCount: 12 })
      .mockResolvedValueOnce({ rowCount: 34 });

    const result = await job.deleteExpiredRows();

    expect(result).toEqual({ syncOperationsDeleted: 12, auditLogsDeleted: 34 });
  });

  /**
   * Requirement 25.2 (task 47.4): "THE Retention_Cleanup_Job SHALL NOT
   * delete or archive a `sync_operations` row whose status is `pending`
   * or `retrying`, regardless of that row's age."
   *
   * This codebase has no literal `'retrying'` status value -- per
   * `SyncWorker.handleOperationError`, a retryable failure awaiting its
   * next retry attempt is represented as `status = 'pending'` with an
   * incremented `retry_count` and a future `next_retry_at`, not a
   * separate status string (confirmed against the `sync_operations`
   * schema: `status` is a plain `varchar(20)` with no CHECK constraint,
   * and `operationSchemas.js`/the migrations never introduce a
   * `'retrying'`/`'processing'` literal). So "pending/retrying rows" in
   * the requirement's wording is the CONCEPT of "not yet in a terminal
   * state" -- covered here by asserting the DELETE's WHERE clause itself
   * structurally excludes anything other than `'completed'`/`'failed'`.
   *
   * Mirrors the established pattern for this kind of age-independent
   * structural guarantee (see `DeploymentChannelService.test.js`'s
   * "Never applied when deployment_end_date is null" assertion on
   * `deactivateExpired()`'s UPDATE): assert directly on the SQL string
   * handed to `pool.query`, since the guarantee lives in the WHERE
   * clause's own logic (an `AND`, not an `OR`, joining the status
   * condition to the age condition) rather than in anything a mocked
   * `pool.query` return value could distinguish.
   */
  it('excludes pending/retrying (non-terminal) sync_operations rows from deletion via the WHERE clause itself, regardless of age', async () => {
    await job.deleteExpiredRows();

    const syncCall = pool.query.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('DELETE FROM sync_operations')
    );
    expect(syncCall).toBeDefined();

    const sql = syncCall[0];

    // Structurally excludes any non-terminal status: only 'completed' or
    // 'failed' rows are eligible at all.
    expect(sql).toContain("status IN ('completed', 'failed')");

    // Never matches a 'pending' row directly, and never filters by age
    // alone (i.e. the status condition isn't OR'd away/short-circuited).
    expect(sql).not.toMatch(/status\s*=\s*'pending'/);
    expect(sql).not.toContain("'retrying'");

    // The status condition and the age condition are joined by AND, not
    // OR -- an OR here would let an old 'pending' row through on age
    // alone, which is exactly the "regardless of age" failure mode
    // Requirement 25.2 guards against.
    const statusIndex = sql.indexOf("status IN ('completed', 'failed')");
    const ageIndex = sql.indexOf('created_at <');
    const betweenStatusAndAge = sql.slice(statusIndex, ageIndex);
    expect(betweenStatusAndAge).toMatch(/AND/);
    expect(betweenStatusAndAge).not.toMatch(/\bOR\b\s*status/i);
  });
});

/**
 * Requirement 25.6: a thrown error while deleting rows is caught, logged
 * via the structured logger, and never propagates -- so a retention
 * cleanup failure can never crash or exit the Sync_Worker process, and
 * the next scheduled run simply retries.
 */
describe('RetentionCleanupJob.runCleanup', () => {
  let job;

  beforeEach(() => {
    jest.clearAllMocks();
    pool.query.mockResolvedValue({ rowCount: 0 });
    job = new RetentionCleanupJob({ pool });
  });

  it('logs and does not throw when deleteExpiredRows() rejects', async () => {
    const error = new Error('database unavailable');
    pool.query.mockRejectedValueOnce(error);

    await expect(job.runCleanup()).resolves.toBeUndefined();

    expect(mockLoggerInstance.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: error }),
      expect.stringContaining('Retention cleanup run failed')
    );
  });

  it('logs a completion summary when deleteExpiredRows() succeeds', async () => {
    pool.query
      .mockResolvedValueOnce({ rowCount: 5 })
      .mockResolvedValueOnce({ rowCount: 2 });

    await job.runCleanup();

    expect(mockLoggerInstance.info).toHaveBeenCalledWith(
      { syncOperationsDeleted: 5, auditLogsDeleted: 2 },
      expect.stringContaining('Retention cleanup run completed')
    );
  });

  it('a failure in one run does not prevent a subsequent run from executing again', async () => {
    pool.query.mockRejectedValueOnce(new Error('transient failure'));

    await job.runCleanup();
    await job.runCleanup();

    // 1 failed call (sync_operations DELETE only, since it rejected) +
    // 2 successful calls (sync_operations + audit_logs DELETEs) = 3 total.
    expect(pool.query).toHaveBeenCalledTimes(3);
  });
});

/**
 * `start()`/`stop()` start and clear the recurring interval, run one
 * cleanup pass immediately on `start()`, and are idempotent against a
 * double `start()`/`stop()` -- mirroring `ExpiryScheduler`'s established
 * lifecycle shape.
 */
describe('RetentionCleanupJob start()/stop() lifecycle', () => {
  let job;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    pool.query.mockResolvedValue({ rowCount: 0 });
    job = new RetentionCleanupJob({ pool });
  });

  afterEach(() => {
    job.stop();
    jest.useRealTimers();
  });

  it('runs a cleanup pass immediately on start(), before any interval elapses', async () => {
    job.start();
    await Promise.resolve();

    const syncCall = pool.query.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('DELETE FROM sync_operations')
    );
    expect(syncCall).toBeDefined();
  });

  it('runs another cleanup pass after the configured interval elapses', async () => {
    job.start();
    await Promise.resolve();
    pool.query.mockClear();

    await jest.advanceTimersByTimeAsync(job.intervalMs);

    const syncCall = pool.query.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('DELETE FROM sync_operations')
    );
    expect(syncCall).toBeDefined();
  });

  it('does not double-start: calling start() twice only sets up one interval/immediate pass', () => {
    job.start();
    const timerAfterFirstStart = job.timer;
    job.start();

    expect(job.timer).toBe(timerAfterFirstStart);
  });

  it('stop() clears the interval so no further cleanup passes run', async () => {
    job.start();
    await Promise.resolve();
    pool.query.mockClear();

    job.stop();

    await jest.advanceTimersByTimeAsync(job.intervalMs * 2);

    expect(pool.query).not.toHaveBeenCalled();
    expect(job.timer).toBeNull();
  });

  it('stop() is a no-op when not running', () => {
    expect(() => job.stop()).not.toThrow();
    expect(job.timer).toBeNull();
  });
});

/**
 * The configurable interval defaults to 24 hours and is clamped to a
 * minimum of 60000ms (1 minute), following the same
 * `parseInt(...) || <default>` + `Math.max` clamp pattern used by
 * `ExpiryScheduler`.
 */
describe('RetentionCleanupJob interval configuration', () => {
  const originalEnv = process.env.RETENTION_CLEANUP_INTERVAL_SECONDS;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.RETENTION_CLEANUP_INTERVAL_SECONDS;
    } else {
      process.env.RETENTION_CLEANUP_INTERVAL_SECONDS = originalEnv;
    }
  });

  it('defaults to 86400000ms (24 hours) when unset', () => {
    delete process.env.RETENTION_CLEANUP_INTERVAL_SECONDS;
    const job = new RetentionCleanupJob({ pool });
    expect(job.intervalMs).toBe(24 * 60 * 60 * 1000);
  });

  it('respects a valid configured value above the minimum', () => {
    process.env.RETENTION_CLEANUP_INTERVAL_SECONDS = '3600';
    const job = new RetentionCleanupJob({ pool });
    expect(job.intervalMs).toBe(3600000);
  });

  it('clamps a value below 60 seconds up to 60000ms', () => {
    process.env.RETENTION_CLEANUP_INTERVAL_SECONDS = '1';
    const job = new RetentionCleanupJob({ pool });
    expect(job.intervalMs).toBe(60000);
  });

  it('falls back to the default for a non-numeric value', () => {
    process.env.RETENTION_CLEANUP_INTERVAL_SECONDS = 'not-a-number';
    const job = new RetentionCleanupJob({ pool });
    expect(job.intervalMs).toBe(24 * 60 * 60 * 1000);
  });
});
