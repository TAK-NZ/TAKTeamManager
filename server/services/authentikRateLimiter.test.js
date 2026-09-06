'use strict';

/**
 * Authentik scaling (Phase 1): the DB-backed shared rate limiter shell.
 *
 * These tests mock the pool and the config helpers so they assert the
 * limiter's control flow -- pass-through when disabled, a single atomic
 * refill-and-consume UPDATE when enabled and granted, and fail-open when
 * the bucket row is missing -- without a real database. The token math
 * itself is covered by tokenBucket.property.test.js.
 */

const mockQuery = jest.fn();
jest.mock('../config/database', () => ({ query: mockQuery }));

const mockIsEnabled = jest.fn();
const mockReadRate = jest.fn();
const mockWriteRate = jest.fn();
const mockWritePriorityRate = jest.fn();
jest.mock('../config/authentikRateLimit', () => ({
  isAuthentikRateLimitEnabled: () => mockIsEnabled(),
  getReadRatePerSec: () => mockReadRate(),
  getWriteRatePerSec: () => mockWriteRate(),
  getWritePriorityRatePerSec: () => mockWritePriorityRate()
}));

const rateLimiter = require('./authentikRateLimiter');

describe('authentikRateLimiter.acquire', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockReadRate.mockReturnValue(5);
    mockWriteRate.mockReturnValue(3);
    mockWritePriorityRate.mockReturnValue(2);
  });

  it('is a transparent pass-through with NO DB call when disabled', async () => {
    mockIsEnabled.mockReturnValue(false);

    const result = await rateLimiter.acquire('write');

    expect(result).toEqual({ granted: true, waitedMs: 0 });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('consumes one token via a single UPDATE and grants immediately when a token is available', async () => {
    mockIsEnabled.mockReturnValue(true);
    // refilled >= 1 => allowed.
    mockQuery.mockResolvedValue({ rows: [{ tokens: 2, refilled: 3 }] });

    const result = await rateLimiter.acquire('write');

    expect(result.granted).toBe(true);
    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('UPDATE rate_limit_buckets');
    // lane key + configured rate (write => 3).
    expect(params).toEqual(['write', 3]);
  });

  it('uses the correct configured rate per lane', async () => {
    mockIsEnabled.mockReturnValue(true);
    mockQuery.mockResolvedValue({ rows: [{ tokens: 4, refilled: 5 }] });

    await rateLimiter.acquire('read');

    const [, params] = mockQuery.mock.calls[0];
    expect(params).toEqual(['read', 5]); // read rate
  });

  it('fails OPEN (grants) when the bucket row is missing, rather than deadlocking', async () => {
    mockIsEnabled.mockReturnValue(true);
    mockQuery.mockResolvedValue({ rows: [] }); // no such bucket row

    const result = await rateLimiter.acquire('write');

    expect(result.granted).toBe(true);
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('rejects an unknown lane', async () => {
    mockIsEnabled.mockReturnValue(true);
    await expect(rateLimiter.acquire('nonsense')).rejects.toThrow(/Unknown rate-limit lane/);
  });
});

describe('authentikRateLimiter.refillAndConsume', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('reports allowed=false when the refilled amount is below one whole token', async () => {
    const executor = { query: jest.fn().mockResolvedValue({ rows: [{ tokens: 0.4, refilled: 0.4 }] }) };

    const result = await rateLimiter.refillAndConsume(executor, 'write', 3);

    expect(result.allowed).toBe(false);
    expect(result.tokens).toBeCloseTo(0.4, 9);
  });

  it('reports allowed=true when the refilled amount is at least one token', async () => {
    const executor = { query: jest.fn().mockResolvedValue({ rows: [{ tokens: 0.5, refilled: 1.5 }] }) };

    const result = await rateLimiter.refillAndConsume(executor, 'read', 5);

    expect(result.allowed).toBe(true);
  });
});
