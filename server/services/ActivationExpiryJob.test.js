/**
 * Unit tests for ActivationExpiryJob (server/services/ActivationExpiryJob.js): suspends accounts whose activation window
 * has passed with no sign-in, and nothing else.
 */
jest.mock('../config/database', () => ({ query: jest.fn(), connect: jest.fn() }));
jest.mock('./AccountLifecycleService', () => ({ suspendAccount: jest.fn() }));
const mockLogger = { info: jest.fn(), error: jest.fn(), debug: jest.fn(), warn: jest.fn() };
jest.mock('../config/logger', () => ({ createLogger: jest.fn(() => mockLogger) }));
const pool = require('../config/database');
const AccountLifecycleService = require('./AccountLifecycleService');
const ActivationExpiryJob = require('./ActivationExpiryJob');
function lockGrantingClient() {
  return {
    query: jest.fn(async (sql) => (String(sql).includes('pg_try_advisory_lock') ? { rows: [{ locked: true }] } : { rows: [] })),
    release: jest.fn()
  };
}
describe('ActivationExpiryJob.suspendExpired', () => {
  let job;
  beforeEach(() => {
    jest.clearAllMocks();
    job = new ActivationExpiryJob({ pool });
  });
  it('selects only active, non-device accounts with a passed window, a cache row and no sign-in', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    await job.suspendExpired();
    const sql = pool.query.mock.calls[0][0];
    expect(sql).toContain("u.account_status = 'active'");
    expect(sql).toContain('u.is_team_device = false');
    expect(sql).toContain('u.activation_expires_at IS NOT NULL');
    expect(sql).toContain('u.activation_expires_at < now()');
    expect(sql).toContain('uc.last_login IS NULL');
    expect(sql).toContain('uc.authentik_id IS NOT NULL');
  });
  it('suspends each account with no acting user and records why', async () => {
    const when = new Date('2026-11-01T00:00:00Z');
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 5, activation_expires_at: when }, { id: 6, activation_expires_at: when }] })
      .mockResolvedValue({ rows: [] });
    AccountLifecycleService.suspendAccount.mockResolvedValue({});
    const result = await job.suspendExpired();
    expect(result).toEqual({ found: 2, suspended: 2, failed: 0 });
    expect(AccountLifecycleService.suspendAccount).toHaveBeenNthCalledWith(1, 5, { userId: null });
    expect(AccountLifecycleService.suspendAccount).toHaveBeenNthCalledWith(2, 6, { userId: null });
    const audit = pool.query.mock.calls.filter(([sql]) => String(sql).includes("'user.activation_expired'"));
    expect(audit.map((c) => c[1][0])).toEqual([5, 6]);
  });
  it('carries on after one account cannot be suspended, and writes no reason row for it', async () => {
    const when = new Date('2026-11-01T00:00:00Z');
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 5, activation_expires_at: when }, { id: 6, activation_expires_at: when }] })
      .mockResolvedValue({ rows: [] });
    AccountLifecycleService.suspendAccount.mockRejectedValueOnce(new Error('already suspended')).mockResolvedValueOnce({});
    const result = await job.suspendExpired();
    expect(result).toEqual({ found: 2, suspended: 1, failed: 1 });
    const audit = pool.query.mock.calls.filter(([sql]) => String(sql).includes("'user.activation_expired'"));
    expect(audit.map((c) => c[1][0])).toEqual([6]);
  });
  it('never throws out of runOnce', async () => {
    pool.connect.mockResolvedValue(lockGrantingClient());
    pool.query.mockRejectedValue(new Error('db down'));
    await expect(job.runOnce()).resolves.toBeUndefined();
    expect(mockLogger.error).toHaveBeenCalled();
  });
});
describe('ActivationExpiryJob lifecycle', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
  });
  afterEach(() => jest.useRealTimers());
  it('runs at start, then on the interval, and stops cleanly', () => {
    const job = new ActivationExpiryJob({ pool });
    const spy = jest.spyOn(job, 'runOnce').mockResolvedValue();
    job.start();
    job.start();
    expect(spy).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(job.intervalMs);
    expect(spy).toHaveBeenCalledTimes(2);
    job.stop();
    jest.advanceTimersByTime(job.intervalMs * 3);
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
