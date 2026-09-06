// Feature: authentik-scaling, Property: token-bucket refill/consume invariants
//
// **Validates: the shared rate limiter's core math (docs/authentik-ratelimit-profiling.md,
// .kiro/steering/authentik-scaling.md) -- refill never exceeds capacity,
// never runs backwards on clock skew, consume takes exactly one whole token,
// and the wait estimate is a non-negative finite value whenever refill is positive.**

const fc = require('fast-check');
const { refill, tryConsume, estimateWaitMs } = require('./tokenBucket');

// Generators including hostile totality inputs per the testing conventions.
const finiteNonNeg = () =>
  fc.oneof(
    fc.constant(0),
    fc.double({ min: 0, max: 1000, noNaN: true }),
    fc.double({ min: 0, max: 0.999, noNaN: true }) // sub-one fractional boundary
  );

const rate = () =>
  fc.oneof(
    fc.constant(1),
    fc.constant(3),
    fc.constant(5),
    fc.double({ min: 0.1, max: 100, noNaN: true })
  );

describe('tokenBucket.refill', () => {
  it('never exceeds capacity and never drops below the starting tokens for non-negative elapsed', () => {
    fc.assert(
      fc.property(finiteNonNeg(), rate(), rate(), fc.double({ min: 0, max: 60000, noNaN: true }), (startTokens, capacity, refillPerSec, elapsedMs) => {
        // Independent expectation transcribed from the bucket definition:
        // refilled = min(capacity, tokens + elapsed_sec * rate), floored at
        // the starting tokens because elapsed >= 0 only ever adds.
        const clampedStart = Math.min(startTokens, capacity);
        const result = refill(clampedStart, capacity, refillPerSec, elapsedMs);

        expect(result).toBeLessThanOrEqual(capacity + 1e-9);
        expect(result).toBeGreaterThanOrEqual(clampedStart - 1e-9);
      }),
      { numRuns: 500 }
    );
  });

  it('treats negative elapsed (clock skew) as zero -- never drains the bucket backwards', () => {
    fc.assert(
      fc.property(finiteNonNeg(), rate(), rate(), fc.double({ min: -60000, max: -0.001, noNaN: true }), (startTokens, capacity, refillPerSec, negElapsed) => {
        const clampedStart = Math.min(startTokens, capacity);
        const result = refill(clampedStart, capacity, refillPerSec, negElapsed);
        // Negative elapsed => zero refill => tokens unchanged.
        expect(result).toBeCloseTo(clampedStart, 9);
      }),
      { numRuns: 300 }
    );
  });
});

describe('tokenBucket.tryConsume', () => {
  it('consumes exactly one whole token iff at least one is available', () => {
    fc.assert(
      fc.property(finiteNonNeg(), (tokens) => {
        const { allowed, tokens: after } = tryConsume(tokens);
        if (tokens >= 1) {
          expect(allowed).toBe(true);
          expect(after).toBeCloseTo(tokens - 1, 9);
        } else {
          expect(allowed).toBe(false);
          expect(after).toBeCloseTo(tokens, 9);
        }
      }),
      { numRuns: 300 }
    );
  });
});

describe('tokenBucket.estimateWaitMs', () => {
  it('is 0 when a token is available, positive-finite when short with a positive rate', () => {
    fc.assert(
      fc.property(finiteNonNeg(), rate(), (tokens, refillPerSec) => {
        const waitMs = estimateWaitMs(tokens, refillPerSec);
        if (tokens >= 1) {
          expect(waitMs).toBe(0);
        } else {
          expect(waitMs).toBeGreaterThan(0);
          expect(Number.isFinite(waitMs)).toBe(true);
        }
      }),
      { numRuns: 300 }
    );
  });

  it('is Infinity for a sub-one bucket that never refills (rate <= 0), so the caller must guard', () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 0.999, noNaN: true }), fc.oneof(fc.constant(0), fc.double({ min: -100, max: -0.001, noNaN: true })), (tokens, nonPositiveRate) => {
        expect(estimateWaitMs(tokens, nonPositiveRate)).toBe(Infinity);
      }),
      { numRuns: 200 }
    );
  });
});
