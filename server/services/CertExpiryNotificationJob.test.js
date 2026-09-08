jest.mock('./CertExpiryNotificationService', () => ({
  run: jest.fn(),
}));

// maybeRun() now routes CertExpiryNotificationService.run() through
// withJobLock (the desiredCount>1 single-runner guard), which takes a client
// and a session advisory lock. Mock the pool's connect() to hand back a client
// that GRANTS the lock, so these tests exercise the "this worker won the lock,
// so it sends" path. A separate suite (jobLock.test.js) covers the lock-lost
// (skip) path directly.
jest.mock('../config/database', () => ({
  query: jest.fn(),
  connect: jest.fn(async () => ({
    query: jest.fn(async (sql) =>
      typeof sql === 'string' && sql.includes('pg_try_advisory_lock')
        ? { rows: [{ locked: true }] }
        : { rows: [] }
    ),
    release: jest.fn(),
  })),
}));

const mockLoggerInstance = { info: jest.fn(), error: jest.fn(), debug: jest.fn(), warn: jest.fn() };
jest.mock('../config/logger', () => ({
  createLogger: jest.fn(() => mockLoggerInstance),
}));

const CertExpiryNotificationService = require('./CertExpiryNotificationService');
const CertExpiryNotificationJob = require('./CertExpiryNotificationJob');
const pool = require('../config/database');

// Flush enough microtask ticks for maybeRun()'s fire-and-forget
// withJobLock(...).catch() chain (connect -> try-lock -> run) to settle.
async function flushJobLock() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

const ORIGINAL_ENV = { ...process.env };

/**
 * cert-expiry-notifications task 6.3, Requirement 5.2, 5.3, 5.4:
 * `start()` is a no-op unless BOTH `CERT_EXPIRY_NOTIFICATIONS_ENABLED`
 * and `DEVICE_MGMT_ENABLED` are exactly `'true'`.
 */
describe('CertExpiryNotificationJob start() flag gating', () => {
  let job;

  beforeEach(() => {
    jest.clearAllMocks();
    job = new CertExpiryNotificationJob();
  });

  afterEach(() => {
    job.stop();
    process.env = { ...ORIGINAL_ENV };
  });

  it.each([
    ['both disabled', undefined, undefined],
    ['only CERT_EXPIRY_NOTIFICATIONS_ENABLED true', 'true', undefined],
    ['only DEVICE_MGMT_ENABLED true', undefined, 'true'],
    ['CERT_EXPIRY_NOTIFICATIONS_ENABLED true, DEVICE_MGMT_ENABLED explicitly false', 'true', 'false'],
  ])('does not start a timer when %s', (_label, certEnabled, deviceMgmtEnabled) => {
    if (certEnabled !== undefined) process.env.CERT_EXPIRY_NOTIFICATIONS_ENABLED = certEnabled;
    else delete process.env.CERT_EXPIRY_NOTIFICATIONS_ENABLED;
    if (deviceMgmtEnabled !== undefined) process.env.DEVICE_MGMT_ENABLED = deviceMgmtEnabled;
    else delete process.env.DEVICE_MGMT_ENABLED;

    job.start();

    expect(job.timer).toBeNull();
  });

  it('starts a timer when both flags are exactly "true"', () => {
    process.env.CERT_EXPIRY_NOTIFICATIONS_ENABLED = 'true';
    process.env.DEVICE_MGMT_ENABLED = 'true';

    job.start();

    expect(job.timer).not.toBeNull();
  });

  it('does not double-start: calling start() twice while enabled only sets up one interval', () => {
    process.env.CERT_EXPIRY_NOTIFICATIONS_ENABLED = 'true';
    process.env.DEVICE_MGMT_ENABLED = 'true';

    job.start();
    const timerAfterFirstStart = job.timer;
    job.start();

    expect(job.timer).toBe(timerAfterFirstStart);
  });
});

/**
 * cert-expiry-notifications task 6.3: `maybeRun()`'s digest-hour/minute/
 * timezone match, mirroring `EscalationService.startDailySchedule()`'s
 * own comparison, plus the `lastRunDateKey` guard against firing twice
 * within the same matching minute.
 */
describe('CertExpiryNotificationJob.maybeRun', () => {
  let job;

  beforeEach(() => {
    jest.clearAllMocks();
    job = new CertExpiryNotificationJob();
    CertExpiryNotificationService.run.mockResolvedValue(undefined);
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    jest.useRealTimers();
  });

  it('runs CertExpiryNotificationService.run() when now matches the configured digest hour/minute/timezone', async () => {
    process.env.DIGEST_HOUR = '9';
    process.env.DIGEST_MINUTE = '0';
    process.env.DIGEST_TIMEZONE = 'UTC';
    jest.useFakeTimers().setSystemTime(new Date('2026-08-31T09:00:00.000Z'));

    job.maybeRun();
    await flushJobLock();

    expect(CertExpiryNotificationService.run).toHaveBeenCalledTimes(1);
  });

  it('does NOT send when another worker holds the advisory lock (desiredCount>1 single-runner guard)', async () => {
    // Simulate a second worker: this process loses the lock, so even at the
    // matching minute it must not send (the other worker sends). This is the
    // guard against duplicate expiry emails at desiredCount>1.
    pool.connect.mockImplementationOnce(async () => ({
      query: jest.fn(async (sql) =>
        typeof sql === 'string' && sql.includes('pg_try_advisory_lock')
          ? { rows: [{ locked: false }] } // lock NOT acquired
          : { rows: [] }
      ),
      release: jest.fn()
    }));
    process.env.DIGEST_HOUR = '9';
    process.env.DIGEST_MINUTE = '0';
    process.env.DIGEST_TIMEZONE = 'UTC';
    jest.useFakeTimers().setSystemTime(new Date('2026-08-31T09:00:00.000Z'));

    job.maybeRun();
    await flushJobLock();

    expect(CertExpiryNotificationService.run).not.toHaveBeenCalled();
  });

  it('does not run when now does not match the configured digest hour/minute', () => {
    process.env.DIGEST_HOUR = '9';
    process.env.DIGEST_MINUTE = '0';
    process.env.DIGEST_TIMEZONE = 'UTC';
    jest.useFakeTimers().setSystemTime(new Date('2026-08-31T09:01:00.000Z'));

    job.maybeRun();

    expect(CertExpiryNotificationService.run).not.toHaveBeenCalled();
  });

  it('defaults to hour 9, minute 0, Pacific/Auckland when unset', async () => {
    delete process.env.DIGEST_HOUR;
    delete process.env.DIGEST_MINUTE;
    delete process.env.DIGEST_TIMEZONE;
    // 09:00 Pacific/Auckland (NZST, UTC+12) is 21:00 UTC the prior day.
    jest.useFakeTimers().setSystemTime(new Date('2026-08-30T21:00:00.000Z'));

    job.maybeRun();
    await flushJobLock();

    expect(CertExpiryNotificationService.run).toHaveBeenCalledTimes(1);
  });

  it('does not double-fire within the same matching minute (lastRunDateKey guard)', async () => {
    process.env.DIGEST_HOUR = '9';
    process.env.DIGEST_MINUTE = '0';
    process.env.DIGEST_TIMEZONE = 'UTC';
    jest.useFakeTimers().setSystemTime(new Date('2026-08-31T09:00:00.000Z'));

    job.maybeRun();
    job.maybeRun();
    job.maybeRun();
    await flushJobLock();

    expect(CertExpiryNotificationService.run).toHaveBeenCalledTimes(1);
  });

  it('runs again on the following day at the same matching minute', async () => {
    process.env.DIGEST_HOUR = '9';
    process.env.DIGEST_MINUTE = '0';
    process.env.DIGEST_TIMEZONE = 'UTC';

    jest.useFakeTimers().setSystemTime(new Date('2026-08-31T09:00:00.000Z'));
    job.maybeRun();
    await flushJobLock();

    jest.setSystemTime(new Date('2026-09-01T09:00:00.000Z'));
    job.maybeRun();
    await flushJobLock();

    expect(CertExpiryNotificationService.run).toHaveBeenCalledTimes(2);
  });

  it('logs an error and does not throw when the run rejects', async () => {
    process.env.DIGEST_HOUR = '9';
    process.env.DIGEST_MINUTE = '0';
    process.env.DIGEST_TIMEZONE = 'UTC';
    jest.useFakeTimers().setSystemTime(new Date('2026-08-31T09:00:00.000Z'));
    const error = new Error('run failed');
    CertExpiryNotificationService.run.mockRejectedValue(error);

    expect(() => job.maybeRun()).not.toThrow();
    await flushJobLock();

    expect(mockLoggerInstance.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: error }),
      expect.stringContaining('Cert expiry notification run failed')
    );
  });
});

/**
 * `start()`/`stop()` lifecycle: idempotency and interval-driven repeated
 * calls to `maybeRun()`, mirroring `RetentionCleanupJob`'s own lifecycle
 * test shape.
 */
describe('CertExpiryNotificationJob start()/stop() lifecycle', () => {
  let job;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.CERT_EXPIRY_NOTIFICATIONS_ENABLED = 'true';
    process.env.DEVICE_MGMT_ENABLED = 'true';
    CertExpiryNotificationService.run.mockResolvedValue(undefined);
    job = new CertExpiryNotificationJob();
  });

  afterEach(() => {
    job.stop();
    process.env = { ...ORIGINAL_ENV };
    jest.useRealTimers();
  });

  it('stop() clears the interval so no further maybeRun() calls happen', () => {
    jest.useFakeTimers();
    job.start();

    job.stop();
    jest.advanceTimersByTime(5 * 60 * 1000);

    expect(job.timer).toBeNull();
  });

  it('stop() is a no-op when not running', () => {
    expect(() => job.stop()).not.toThrow();
    expect(job.timer).toBeNull();
  });

  it('checks the schedule roughly once a minute while running', () => {
    jest.useFakeTimers();
    const maybeRunSpy = jest.spyOn(job, 'maybeRun');
    job.start();

    jest.advanceTimersByTime(3 * 60 * 1000);

    expect(maybeRunSpy).toHaveBeenCalledTimes(3);
  });
});
