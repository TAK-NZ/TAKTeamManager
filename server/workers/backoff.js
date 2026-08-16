/**
 * Bounded exponential backoff for Sync_Operation retries (Requirement 9.1).
 *
 * `handleOperationError` (see `server/workers/syncWorker.js`) previously
 * computed the delay before the next retry attempt as an unbounded
 * `Math.pow(2, retryCount) * 60000` ("2^n minutes"). For a large enough
 * `retryCount` this expression overflows/produces an astronomically large
 * millisecond value, which in turn produces an invalid `next_retry_at`
 * `Date` (e.g. an out-of-range date once `Date.now() + delay` exceeds the
 * `Date` type's representable range). Requirement 9.1 requires the
 * computed per-retry delay to be capped at a fixed maximum of 1 hour
 * (3,600,000 ms), so that the cap by itself is enough to guarantee a
 * valid, non-overflowing `next_retry_at` for any `retry_count` value up
 * to `max_retries`, regardless of how large `retryCount` grows.
 *
 * This module intentionally does nothing else: it does not enforce
 * `max_retries` (that is task 26.3, a separate concern -- whether a retry
 * should be scheduled at all), it only bounds the delay used *when* a
 * retry is scheduled.
 *
 * @param {number} retryCount - the (1-indexed) retry attempt number this
 *   delay is being computed for. Any non-negative integer is accepted;
 *   the cap ensures the function never overflows or misbehaves even for
 *   values far larger than any realistic `max_retries` configuration.
 * @returns {number} the delay, in milliseconds, before the next retry
 *   should be attempted -- always `<= 3_600_000` and `>= 0`.
 */
function computeBackoffDelay(retryCount) {
  return Math.min(Math.pow(2, retryCount) * 60000, 3_600_000);
}

module.exports = { computeBackoffDelay };
