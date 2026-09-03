jest.mock('../config/database', () => ({
  query: jest.fn()
}));

const mockLoggerInstance = { info: jest.fn(), error: jest.fn(), debug: jest.fn(), warn: jest.fn() };
jest.mock('../config/logger', () => ({
  createLogger: jest.fn(() => mockLoggerInstance)
}));

const pool = require('../config/database');
const EmailRateLimitService = require('./EmailRateLimitService');

/**
 * Requirement 7.2: "no more than 5 requests associated with a given
 * email address within a 60-minute window", backed by the
 * `email_rate_tracking` table.
 */
describe('EmailRateLimitService.checkAndRecordEmailAttempt', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('allows and inserts a new window row when no active window exists for the email', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    pool.query.mockResolvedValueOnce({ rows: [] });

    const result = await EmailRateLimitService.checkAndRecordEmailAttempt('user@example.com');

    expect(result).toEqual({ allowed: true });
    const insertCall = pool.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO email_rate_tracking'));
    expect(insertCall).toBeDefined();
    expect(insertCall[1]).toEqual(['user@example.com']);
  });

  it('allows and increments the active window when count is below maxAttempts', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 42, count: 3 }] });
    pool.query.mockResolvedValueOnce({ rows: [] });

    const result = await EmailRateLimitService.checkAndRecordEmailAttempt('user@example.com');

    expect(result).toEqual({ allowed: true });
    const updateCall = pool.query.mock.calls.find(([sql]) => sql.includes('UPDATE email_rate_tracking'));
    expect(updateCall).toBeDefined();
    expect(updateCall[1]).toEqual([42]);
  });

  it('rejects without incrementing when the active window has already reached maxAttempts (default 5)', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 42, count: 5 }] });

    const result = await EmailRateLimitService.checkAndRecordEmailAttempt('user@example.com');

    expect(result).toEqual({ allowed: false });
    // Only the SELECT ran -- no UPDATE/INSERT for a rejected attempt.
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  it('respects a custom maxAttempts/windowMinutes override', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 1, count: 2 }] });

    const result = await EmailRateLimitService.checkAndRecordEmailAttempt('user@example.com', {
      maxAttempts: 2,
      windowMinutes: 30
    });

    expect(result).toEqual({ allowed: false });
    const selectCall = pool.query.mock.calls[0];
    expect(selectCall[1]).toEqual(['user@example.com', 30]);
  });

  it('fails OPEN (allows the attempt) when the database query rejects', async () => {
    pool.query.mockRejectedValueOnce(new Error('connection refused'));

    const result = await EmailRateLimitService.checkAndRecordEmailAttempt('user@example.com');

    expect(result).toEqual({ allowed: true });
    expect(mockLoggerInstance.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      expect.stringContaining('failing open')
    );
  });
});
