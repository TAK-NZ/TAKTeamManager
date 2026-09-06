'use strict';

/**
 * The single consolidated chokepoint for every call TAK Team Manager makes
 * to the Authentik API. Composition order, outermost first:
 *
 *   1. RATE LIMIT   -- acquire a token from the right lane (read / write /
 *                      write_priority), waiting up to a cap. If no token is
 *                      granted before the cap, throw `RateLimitAcquireError`
 *                      WITHOUT attempting the call. This is deliberately
 *                      OUTSIDE the circuit breaker so a token-starvation
 *                      wait never counts as an Authentik failure and never
 *                      trips the breaker.
 *   2. CIRCUIT BREAKER -- the caller passes a `breaker.execute`-bound `fn`
 *                      (or any function); this module does not own the
 *                      breaker. `authentik.js` already routes its axios
 *                      client through a breaker; the worker passes its
 *                      fetch call. Either way the breaker sits between the
 *                      token and the HTTP call.
 *   3. HTTP         -- the caller's actual request function.
 *
 * WHY a single module both the server and the worker import: before this,
 * `authentik.js` (axios + breaker) and `syncWorker.js` (raw
 * `fetchWithTimeout`) hit Authentik through two independent code paths, so
 * the worker's load was invisible to the server's throttle. Routing both
 * through `run()` makes the token bucket a true aggregate limit.
 *
 * FAILURE SIGNAL: `RateLimitAcquireError` extends `Error`, so
 * `server/workers/failureClassification.js` classifies it as 'retryable'
 * (the call never reached Authentik) and the operation is requeued via the
 * normal backoff path rather than proceeding unthrottled. A request-path
 * caller (the main server) sees a thrown error it can surface as a
 * transient 503-style failure.
 */

const rateLimiter = require('./authentikRateLimiter');

/**
 * Thrown when a token could not be acquired within the limiter's wait cap.
 * Extends `Error` so it classifies as retryable and is treated like a
 * transient upstream failure (requeue/backoff), never as a permanent one.
 */
class RateLimitAcquireError extends Error {
  /**
   * @param {'read'|'write'|'write_priority'} kind
   * @param {number} waitedMs
   */
  constructor(kind, waitedMs) {
    super(`Authentik rate limit: no ${kind} token available after waiting ${waitedMs}ms`);
    this.name = 'RateLimitAcquireError';
    this.rateLimitLane = kind;
    this.waitedMs = waitedMs;
  }
}

/**
 * Run an Authentik call under the shared rate limiter.
 *
 * @param {object} opts
 * @param {'read'|'write'|'write_priority'} opts.kind - which lane's token
 *   to consume. GETs use `read`; normal mutations use `write`; urgent
 *   mutations (delete/suspend/revoke/cleanup) use `write_priority`.
 * @param {() => Promise<*>} fn - the actual call (already breaker-wrapped by
 *   the caller if it wants breaker behaviour). Its resolution/rejection is
 *   returned/propagated unchanged.
 * @returns {Promise<*>} `fn()`'s result.
 * @throws {RateLimitAcquireError} if no token was granted before the cap,
 *   without ever calling `fn`.
 * @throws {*} `fn()`'s own rejection, unchanged.
 */
async function run({ kind }, fn) {
  const { granted, waitedMs } = await rateLimiter.acquire(kind);
  if (!granted) {
    throw new RateLimitAcquireError(kind, waitedMs);
  }
  return fn();
}

module.exports = { run, RateLimitAcquireError };
