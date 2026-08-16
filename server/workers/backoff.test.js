const { computeBackoffDelay } = require('./backoff');

describe('computeBackoffDelay', () => {
  describe('matches the exact uncapped exponential formula for small retryCount values', () => {
    it('retryCount=1 -> 120000ms (2^1 minutes)', () => {
      expect(computeBackoffDelay(1)).toBe(120000);
    });

    it('retryCount=5 -> 1920000ms (2^5 minutes)', () => {
      expect(computeBackoffDelay(5)).toBe(1920000);
    });

    it('retryCount=0 -> 60000ms (2^0 minutes)', () => {
      expect(computeBackoffDelay(0)).toBe(60000);
    });
  });

  describe('caps at exactly 3,600,000ms once the uncapped formula would exceed it', () => {
    it('retryCount=6 -> uncapped 2^6 * 60000 = 3,840,000ms, capped to 3,600,000ms', () => {
      // Sanity-check the uncapped value actually exceeds the cap for this input.
      expect(Math.pow(2, 6) * 60000).toBeGreaterThan(3_600_000);
      expect(computeBackoffDelay(6)).toBe(3_600_000);
    });

    it('retryCount=10 caps at 3,600,000ms', () => {
      expect(computeBackoffDelay(10)).toBe(3_600_000);
    });
  });

  describe('never exceeds the 1-hour cap, even for very large retryCount (no overflow/invalid-Date issue)', () => {
    it('retryCount=48 caps at 3,600,000ms', () => {
      expect(computeBackoffDelay(48)).toBe(3_600_000);
    });

    it('retryCount=100 caps at 3,600,000ms', () => {
      expect(computeBackoffDelay(100)).toBe(3_600_000);
    });

    it('retryCount=1000 (far beyond any realistic max_retries) caps at 3,600,000ms and stays finite', () => {
      const delay = computeBackoffDelay(1000);
      expect(delay).toBe(3_600_000);
      expect(Number.isFinite(delay)).toBe(true);
    });

    it('the resulting next_retry_at Date is always valid for any retryCount up to 100', () => {
      for (let retryCount = 0; retryCount <= 100; retryCount++) {
        const nextRetry = new Date(Date.now() + computeBackoffDelay(retryCount));
        expect(Number.isNaN(nextRetry.getTime())).toBe(false);
      }
    });
  });
});
