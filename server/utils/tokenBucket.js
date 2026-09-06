'use strict';

/**
 * Pure token-bucket math, framework- and DB-free, so it can be reached
 * directly by a property test (per the repo's "pure decision logic with
 * interesting boundaries lives in utils" convention). The DB-backed,
 * cross-process bucket in `server/services/authentikRateLimiter.js` is a
 * thin shell around these functions -- it supplies the persisted
 * `{tokens, lastRefillAt}` and the wall-clock `now`, calls `refill` then
 * `tryConsume`, and writes the result back atomically.
 *
 * Classic token bucket: tokens accrue at `refillPerSec` up to `capacity`,
 * and a request consumes one token if one is available. Fractional tokens
 * are preserved (double precision) so a bucket refilling slower than one
 * token per call still accumulates whole tokens over several calls rather
 * than losing the fraction each time.
 */

/**
 * Compute the token count after refilling for the elapsed wall-clock time.
 *
 * @param {number} tokens - current token count (may be fractional).
 * @param {number} capacity - maximum tokens the bucket can hold.
 * @param {number} refillPerSec - tokens added per second.
 * @param {number} elapsedMs - milliseconds since the last refill. Negative
 *   values (clock skew between processes writing the same row) are treated
 *   as zero so time can never run backwards and DRAIN the bucket.
 * @returns {number} the refilled token count, clamped to `capacity`.
 */
function refill(tokens, capacity, refillPerSec, elapsedMs) {
  const safeElapsedMs = elapsedMs > 0 ? elapsedMs : 0;
  const added = (safeElapsedMs / 1000) * refillPerSec;
  const refilled = tokens + added;
  return refilled > capacity ? capacity : refilled;
}

/**
 * Attempt to consume one token from an already-refilled bucket.
 *
 * @param {number} tokens - refilled token count.
 * @returns {{ allowed: boolean, tokens: number, waitMs: number }}
 *   - allowed: true iff a whole token was available and consumed.
 *   - tokens: the token count AFTER the attempt (decremented iff allowed).
 *   - waitMs: when not allowed, an estimate of how long until one token is
 *     available at `refillPerSec` -- 0 when allowed. The caller uses this
 *     to decide how long to sleep before retrying. Computed by the caller
 *     via `estimateWaitMs` (which knows `refillPerSec`); here it is 0
 *     because this function is intentionally rate-agnostic.
 */
function tryConsume(tokens) {
  if (tokens >= 1) {
    return { allowed: true, tokens: tokens - 1, waitMs: 0 };
  }
  return { allowed: false, tokens, waitMs: 0 };
}

/**
 * Estimate milliseconds until at least one whole token is available.
 *
 * @param {number} tokens - current (fractional) token count, < 1.
 * @param {number} refillPerSec - tokens added per second (> 0).
 * @returns {number} milliseconds to wait; 0 if a token is already
 *   available, and a positive value otherwise. A non-positive
 *   `refillPerSec` yields `Infinity` (a misconfigured bucket that never
 *   refills), which the caller must guard against rather than sleep on.
 */
function estimateWaitMs(tokens, refillPerSec) {
  if (tokens >= 1) return 0;
  if (refillPerSec <= 0) return Infinity;
  const deficit = 1 - tokens;
  return Math.ceil((deficit / refillPerSec) * 1000);
}

module.exports = { refill, tryConsume, estimateWaitMs };
