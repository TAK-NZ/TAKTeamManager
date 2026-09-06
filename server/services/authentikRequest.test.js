'use strict';

/**
 * Authentik scaling (Phase 1): the `authentikRequest.run` chokepoint.
 *
 * Composition contract:
 *   - a token is acquired for the given lane BEFORE `fn` is called;
 *   - if the token is GRANTED, `fn` runs and its result/rejection passes
 *     through unchanged;
 *   - if the token is NOT granted (wait cap elapsed), `fn` is NEVER called
 *     and a `RateLimitAcquireError` (an `Error`, so classified retryable)
 *     is thrown instead.
 *
 * The rate limiter is mocked so these tests assert the composition, not the
 * bucket math (covered by tokenBucket.property.test.js).
 */

const mockAcquire = jest.fn();
jest.mock('./authentikRateLimiter', () => ({
  acquire: mockAcquire
}));

const authentikRequest = require('./authentikRequest');
const { RateLimitAcquireError } = authentikRequest;

describe('authentikRequest.run', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('acquires a token for the given lane before calling fn, then returns fn result', async () => {
    mockAcquire.mockResolvedValue({ granted: true, waitedMs: 0 });
    const order = [];
    mockAcquire.mockImplementation(async () => {
      order.push('acquire');
      return { granted: true, waitedMs: 0 };
    });
    const fn = jest.fn(async () => {
      order.push('fn');
      return 'result';
    });

    const result = await authentikRequest.run({ kind: 'write' }, fn);

    expect(result).toBe('result');
    expect(mockAcquire).toHaveBeenCalledWith('write');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['acquire', 'fn']); // token first, then the call
  });

  it('propagates fn rejection unchanged when a token was granted', async () => {
    mockAcquire.mockResolvedValue({ granted: true, waitedMs: 0 });
    const boom = new Error('authentik 500');
    const fn = jest.fn().mockRejectedValue(boom);

    await expect(authentikRequest.run({ kind: 'read' }, fn)).rejects.toBe(boom);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('throws RateLimitAcquireError and NEVER calls fn when no token is granted', async () => {
    mockAcquire.mockResolvedValue({ granted: false, waitedMs: 30000 });
    const fn = jest.fn();

    await expect(authentikRequest.run({ kind: 'write_priority' }, fn)).rejects.toBeInstanceOf(RateLimitAcquireError);
    expect(fn).not.toHaveBeenCalled();
  });

  it('RateLimitAcquireError is an Error (so failureClassification treats it as retryable) and records the lane', async () => {
    mockAcquire.mockResolvedValue({ granted: false, waitedMs: 12345 });

    let caught;
    try {
      await authentikRequest.run({ kind: 'write' }, jest.fn());
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(Error);
    expect(caught.name).toBe('RateLimitAcquireError');
    expect(caught.rateLimitLane).toBe('write');
    expect(caught.waitedMs).toBe(12345);
  });
});
