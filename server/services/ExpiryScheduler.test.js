const mockLoggerInstance = { info: jest.fn(), error: jest.fn(), debug: jest.fn(), warn: jest.fn() };
jest.mock('../config/logger', () => ({
  createLogger: jest.fn(() => mockLoggerInstance)
}));

const ExpiryScheduler = require('./ExpiryScheduler');

/**
 * Requirement 21.6/22.8 (task 43.1): `ExpiryScheduler` invokes
 * `VendorChannelService.expireGrants()` and
 * `DeploymentChannelService.deactivateExpired()` concurrently on each
 * sweep, via `Promise.allSettled` so a failure in one never prevents the
 * other from being called (in that same sweep, or on a future tick), and
 * logs any failure via the structured logger instead of throwing.
 */
describe('ExpiryScheduler.runSweep', () => {
  let vendorChannelService;
  let deploymentChannelService;
  let scheduler;

  beforeEach(() => {
    jest.clearAllMocks();
    vendorChannelService = { expireGrants: jest.fn().mockResolvedValue({ expiredCount: 0 }) };
    deploymentChannelService = { deactivateExpired: jest.fn().mockResolvedValue({ deactivatedCount: 0 }) };
    scheduler = new ExpiryScheduler({ vendorChannelService, deploymentChannelService });
  });

  it('calls both expireGrants() and deactivateExpired() on a sweep', async () => {
    await scheduler.runSweep();

    expect(vendorChannelService.expireGrants).toHaveBeenCalledTimes(1);
    expect(deploymentChannelService.deactivateExpired).toHaveBeenCalledTimes(1);
  });

  it('still calls deactivateExpired() when expireGrants() rejects, and logs the failure', async () => {
    const error = new Error('vendor expiry failed');
    vendorChannelService.expireGrants.mockRejectedValue(error);

    await expect(scheduler.runSweep()).resolves.toBeUndefined();

    expect(vendorChannelService.expireGrants).toHaveBeenCalledTimes(1);
    expect(deploymentChannelService.deactivateExpired).toHaveBeenCalledTimes(1);
    expect(mockLoggerInstance.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: error }),
      expect.stringContaining('expireGrants')
    );
  });

  it('still calls expireGrants() when deactivateExpired() rejects, and logs the failure', async () => {
    const error = new Error('deployment deactivation failed');
    deploymentChannelService.deactivateExpired.mockRejectedValue(error);

    await expect(scheduler.runSweep()).resolves.toBeUndefined();

    expect(vendorChannelService.expireGrants).toHaveBeenCalledTimes(1);
    expect(deploymentChannelService.deactivateExpired).toHaveBeenCalledTimes(1);
    expect(mockLoggerInstance.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: error }),
      expect.stringContaining('deactivateExpired')
    );
  });

  it('a rejection in one sweep does not prevent a subsequent sweep from calling both services again', async () => {
    vendorChannelService.expireGrants.mockRejectedValueOnce(new Error('transient failure'));

    await scheduler.runSweep();
    await scheduler.runSweep();

    expect(vendorChannelService.expireGrants).toHaveBeenCalledTimes(2);
    expect(deploymentChannelService.deactivateExpired).toHaveBeenCalledTimes(2);
  });
});

/**
 * `start()`/`stop()` start and clear the recurring interval, run one
 * sweep immediately on `start()` (so a freshly-started worker doesn't
 * wait a full interval for its first sweep), and are idempotent against
 * a double `start()`/`stop()`.
 */
describe('ExpiryScheduler start()/stop() lifecycle', () => {
  let vendorChannelService;
  let deploymentChannelService;
  let scheduler;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    vendorChannelService = { expireGrants: jest.fn().mockResolvedValue({ expiredCount: 0 }) };
    deploymentChannelService = { deactivateExpired: jest.fn().mockResolvedValue({ deactivatedCount: 0 }) };
    scheduler = new ExpiryScheduler({ vendorChannelService, deploymentChannelService });
  });

  afterEach(() => {
    scheduler.stop();
    jest.useRealTimers();
  });

  it('runs a sweep immediately on start(), before any interval elapses', () => {
    scheduler.start();

    expect(vendorChannelService.expireGrants).toHaveBeenCalledTimes(1);
    expect(deploymentChannelService.deactivateExpired).toHaveBeenCalledTimes(1);
  });

  it('runs another sweep after the configured interval elapses', async () => {
    scheduler.start();
    expect(vendorChannelService.expireGrants).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(scheduler.intervalMs);

    expect(vendorChannelService.expireGrants).toHaveBeenCalledTimes(2);
    expect(deploymentChannelService.deactivateExpired).toHaveBeenCalledTimes(2);
  });

  it('does not double-start: calling start() twice only sets up one interval/immediate sweep', () => {
    scheduler.start();
    scheduler.start();

    // Only the first start() call should have triggered an immediate sweep.
    expect(vendorChannelService.expireGrants).toHaveBeenCalledTimes(1);

    const timerAfterFirstStart = scheduler.timer;
    expect(scheduler.timer).toBe(timerAfterFirstStart);
  });

  it('stop() clears the interval so no further sweeps run', async () => {
    scheduler.start();
    expect(vendorChannelService.expireGrants).toHaveBeenCalledTimes(1);

    scheduler.stop();

    await jest.advanceTimersByTimeAsync(scheduler.intervalMs * 2);

    expect(vendorChannelService.expireGrants).toHaveBeenCalledTimes(1);
    expect(scheduler.timer).toBeNull();
  });

  it('stop() is a no-op when not running', () => {
    expect(() => scheduler.stop()).not.toThrow();
    expect(scheduler.timer).toBeNull();
  });
});

/**
 * Requirement 21.6/22.8: the configurable interval is clamped to the
 * 60000ms (1 minute) - 900000ms (15 minutes) range, following the same
 * `parseInt(...) || <default>` + `Math.min/Math.max` clamp pattern used
 * elsewhere (e.g. SYNC_WORKER_BATCH_SIZE/SYNC_WORKER_CONCURRENCY).
 */
describe('ExpiryScheduler interval configuration', () => {
  const originalEnv = process.env.EXPIRY_SCHEDULER_INTERVAL_SECONDS;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.EXPIRY_SCHEDULER_INTERVAL_SECONDS;
    } else {
      process.env.EXPIRY_SCHEDULER_INTERVAL_SECONDS = originalEnv;
    }
  });

  it('defaults to 900000ms (15 minutes) when unset', () => {
    delete process.env.EXPIRY_SCHEDULER_INTERVAL_SECONDS;
    const scheduler = new ExpiryScheduler();
    expect(scheduler.intervalMs).toBe(900000);
  });

  it('respects a valid configured value within the allowed range', () => {
    process.env.EXPIRY_SCHEDULER_INTERVAL_SECONDS = '300';
    const scheduler = new ExpiryScheduler();
    expect(scheduler.intervalMs).toBe(300000);
  });

  it('clamps a value above 900 seconds down to 900000ms', () => {
    process.env.EXPIRY_SCHEDULER_INTERVAL_SECONDS = '3600';
    const scheduler = new ExpiryScheduler();
    expect(scheduler.intervalMs).toBe(900000);
  });

  it('clamps a value below 60 seconds up to 60000ms', () => {
    process.env.EXPIRY_SCHEDULER_INTERVAL_SECONDS = '1';
    const scheduler = new ExpiryScheduler();
    expect(scheduler.intervalMs).toBe(60000);
  });

  it('falls back to the default for a non-numeric value', () => {
    process.env.EXPIRY_SCHEDULER_INTERVAL_SECONDS = 'not-a-number';
    const scheduler = new ExpiryScheduler();
    expect(scheduler.intervalMs).toBe(900000);
  });
});
