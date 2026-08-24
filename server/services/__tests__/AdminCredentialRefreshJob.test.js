const mockLoggerInstance = { info: jest.fn(), error: jest.fn(), debug: jest.fn(), warn: jest.fn() };
jest.mock('../../config/logger', () => ({
  createLogger: jest.fn(() => mockLoggerInstance)
}));

const AdminCredentialRefreshJob = require('../AdminCredentialRefreshJob');

/**
 * device-management task 7.4: unit tests for `AdminCredentialRefreshJob`
 * (Requirements 2.6, 2.10).
 *
 * Same shape as `server/services/ExpiryScheduler.test.js` and
 * `server/services/RetentionCleanupJob.test.js` -- the two jobs this one
 * deliberately mirrors -- with jest fake timers for the lifecycle and a
 * mocked Admin_Credential_Loader as the sole collaborator.
 */

/** Minimal Admin_Credential_Loader stand-in: `run()` only calls `refresh()`. */
function createLoader() {
  return { refresh: jest.fn().mockResolvedValue(undefined) };
}

describe('AdminCredentialRefreshJob constructor', () => {
  it('requires a loader (there is no safe default: a second loader would refresh a credential nothing reads)', () => {
    expect(() => new AdminCredentialRefreshJob()).toThrow(TypeError);
    expect(() => new AdminCredentialRefreshJob({})).toThrow(/requires a loader/);
  });
});

/**
 * Requirement 2.6: the cached Admin_Credential is refreshed "every 24
 * hours", so 24 hours is the default. Clamped with the same
 * `parseInt(...) || <default>` + `Math.max` pattern as
 * `ExpiryScheduler`/`RetentionCleanupJob`; as with `RetentionCleanupJob`,
 * no upper bound is imposed because none is stated.
 */
describe('AdminCredentialRefreshJob interval configuration', () => {
  const originalEnv = process.env.TAK_ADMIN_CERT_REFRESH_INTERVAL_MS;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.TAK_ADMIN_CERT_REFRESH_INTERVAL_MS;
    } else {
      process.env.TAK_ADMIN_CERT_REFRESH_INTERVAL_MS = originalEnv;
    }
  });

  it('defaults to 86400000ms (24 hours) when unset', () => {
    delete process.env.TAK_ADMIN_CERT_REFRESH_INTERVAL_MS;
    const job = new AdminCredentialRefreshJob({ loader: createLoader() });
    expect(job.intervalMs).toBe(24 * 60 * 60 * 1000);
  });

  it('respects a valid configured value above the minimum', () => {
    process.env.TAK_ADMIN_CERT_REFRESH_INTERVAL_MS = '3600000';
    const job = new AdminCredentialRefreshJob({ loader: createLoader() });
    expect(job.intervalMs).toBe(3600000);
  });

  it('clamps a value below 60000ms up to 60000ms', () => {
    process.env.TAK_ADMIN_CERT_REFRESH_INTERVAL_MS = '1000';
    const job = new AdminCredentialRefreshJob({ loader: createLoader() });
    expect(job.intervalMs).toBe(60000);
  });

  it('falls back to the default for a non-numeric value', () => {
    process.env.TAK_ADMIN_CERT_REFRESH_INTERVAL_MS = 'not-a-number';
    const job = new AdminCredentialRefreshJob({ loader: createLoader() });
    expect(job.intervalMs).toBe(24 * 60 * 60 * 1000);
  });
});

/**
 * `start()`/`stop()` lifecycle. The immediate first pass is load-bearing
 * here (design.md): it is what loads the Admin_Credential before the first
 * `SubscriptionPoller`/`DeviceSync` tick.
 */
describe('AdminCredentialRefreshJob start()/stop() lifecycle', () => {
  let loader;
  let job;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    loader = createLoader();
    job = new AdminCredentialRefreshJob({ loader });
  });

  afterEach(() => {
    job.stop();
    jest.useRealTimers();
  });

  it('refreshes immediately on start(), before any interval elapses', () => {
    job.start();

    expect(loader.refresh).toHaveBeenCalledTimes(1);
  });

  it('refreshes again after the configured interval elapses', async () => {
    job.start();
    expect(loader.refresh).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(job.intervalMs);

    expect(loader.refresh).toHaveBeenCalledTimes(2);
  });

  it('does not double-start: calling start() twice only sets up one interval/immediate pass', () => {
    job.start();
    const timerAfterFirstStart = job.timer;
    job.start();

    expect(loader.refresh).toHaveBeenCalledTimes(1);
    expect(job.timer).toBe(timerAfterFirstStart);
  });

  it('stop() clears the interval so no further refreshes run', async () => {
    job.start();
    expect(loader.refresh).toHaveBeenCalledTimes(1);

    job.stop();

    await jest.advanceTimersByTimeAsync(job.intervalMs * 2);

    expect(loader.refresh).toHaveBeenCalledTimes(1);
    expect(job.timer).toBeNull();
  });

  it('stop() is a no-op when not running', () => {
    expect(() => job.stop()).not.toThrow();
    expect(job.timer).toBeNull();
  });

  it('stop() is idempotent against a double stop()', () => {
    job.start();
    job.stop();

    expect(() => job.stop()).not.toThrow();
    expect(job.timer).toBeNull();
  });
});

/**
 * Requirement 2.10: a failed refresh is logged via the Structured_Logger
 * and NEVER propagated -- the Loader keeps its previously cached
 * credential and the next tick simply retries, so the Sync_Worker process
 * is never crashed or exited.
 */
describe('AdminCredentialRefreshJob.run', () => {
  let loader;
  let job;

  beforeEach(() => {
    jest.clearAllMocks();
    loader = createLoader();
    job = new AdminCredentialRefreshJob({ loader });
  });

  it('calls loader.refresh() once per run', async () => {
    await job.run();

    expect(loader.refresh).toHaveBeenCalledTimes(1);
  });

  it('logs and does not throw when loader.refresh() rejects', async () => {
    const error = new Error('secrets manager unavailable');
    loader.refresh.mockRejectedValueOnce(error);

    await expect(job.run()).resolves.toBeUndefined();

    expect(mockLoggerInstance.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: error }),
      expect.stringContaining('Admin credential refresh run failed')
    );
  });

  it('logs and does not throw when loader.refresh() throws synchronously', async () => {
    loader.refresh.mockImplementation(() => {
      throw new Error('boom');
    });

    await expect(job.run()).resolves.toBeUndefined();

    expect(mockLoggerInstance.error).toHaveBeenCalledTimes(1);
  });

  it('a failed run does not prevent the next run from refreshing again', async () => {
    loader.refresh.mockRejectedValueOnce(new Error('transient failure'));

    await job.run();
    await job.run();

    expect(loader.refresh).toHaveBeenCalledTimes(2);
  });

  it('never logs credential material or the passphrase (Requirement 2.11 hygiene)', async () => {
    loader.refresh.mockRejectedValueOnce(new Error('load failed'));

    await job.run();
    job.start();
    job.stop();

    const logged = JSON.stringify([
      ...mockLoggerInstance.info.mock.calls,
      ...mockLoggerInstance.error.mock.calls,
      ...mockLoggerInstance.debug.mock.calls,
      ...mockLoggerInstance.warn.mock.calls
    ]);
    expect(logged).not.toMatch(/atakatak/i);
    expect(logged).not.toMatch(/passphrase/i);
    expect(logged).not.toMatch(/PRIVATE KEY/i);
  });
});
