'use strict';

/**
 * Shared, cross-process token-bucket rate limiter for Authentik API calls.
 *
 * WHY THIS SHAPE: the main server process and every Sync_Worker replica
 * all call the same Authentik instance. The empirically-measured clean
 * ceilings are low (writes ~3-5/s, reads ~5-8/s -- see
 * `docs/authentik-ratelimit-profiling.md`), far too low to survive a
 * per-process in-memory limiter that would multiply the real aggregate
 * rate by the number of processes. So the bucket state lives in Postgres
 * (`rate_limit_buckets`), and refill-and-consume is a SINGLE atomic UPDATE
 * so two processes acquiring concurrently can never both consume the same
 * token. Postgres is the coordination point because this app has no Redis
 * and already coordinates the worker queue through the same database.
 *
 * Lanes (one bucket row each):
 *   - `read`           GET calls
 *   - `write`          normal POST/PATCH/DELETE
 *   - `write_priority` reserved budget for urgent mutations
 *
 * The pure token math lives in `server/utils/tokenBucket.js` (property
 * tested). This module is the DB shell: it does the atomic UPDATE, applies
 * the currently-configured capacity/refill rate (so a config change needs
 * no migration), and exposes `acquire(kind)` which waits (up to a cap) for
 * a token, returning whether one was granted.
 *
 * When the limiter is disabled (`AUTHENTIK_RATE_LIMIT_ENABLED` !== 'true')
 * `acquire` is a transparent, immediate pass-through -- no DB call at all.
 */

const pool = require('../config/database');
const logger = require('../config/logger').createLogger('AuthentikRateLimiter');
const { estimateWaitMs } = require('../utils/tokenBucket');
const {
  isAuthentikRateLimitEnabled,
  getReadRatePerSec,
  getWriteRatePerSec,
  getWritePriorityRatePerSec
} = require('../config/authentikRateLimit');

const BUCKET_KEYS = { read: 'read', write: 'write', write_priority: 'write_priority' };

// Poll granularity when waiting for a token, and the hard ceiling on how
// long a single acquire will wait before giving up. The ceiling exists so
// a caller (a Sync_Worker handler) never blocks a worker slot indefinitely
// on a saturated Authentik -- on timeout the operation is requeued via the
// normal retry/backoff path rather than held. Kept comfortably above the
// worst-case single-token wait at the lowest sane refill rate.
const MAX_ACQUIRE_WAIT_MS = 30000;
const MIN_SLEEP_MS = 50;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Resolve the configured capacity/refill for a lane from the current env,
 * so an operator changing a ceiling takes effect on the next acquire
 * without a redeploy or migration. capacity == refill rate (a 1-second
 * burst allowance), matching the seeded rows.
 *
 * @param {'read'|'write'|'write_priority'} kind
 * @returns {{ ratePerSec: number }}
 */
function laneRate(kind) {
  switch (kind) {
    case 'read':
      return { ratePerSec: getReadRatePerSec() };
    case 'write':
      return { ratePerSec: getWriteRatePerSec() };
    case 'write_priority':
      return { ratePerSec: getWritePriorityRatePerSec() };
    default:
      throw new Error(`Unknown rate-limit lane: ${kind}`);
  }
}

/**
 * Atomically refill and try to consume one token from a lane's bucket.
 *
 * The refill uses the DB clock (`now() - last_refill_at`) so all processes
 * measure elapsed time against the same authoritative clock rather than
 * their own. capacity/refill_per_sec are overwritten from the passed
 * `ratePerSec` each call. `GREATEST(0, ...)` on the elapsed seconds guards
 * against clock skew never draining the bucket.
 *
 * @param {object} executor - pool or client with `.query`.
 * @param {string} bucketKey
 * @param {number} ratePerSec - both the capacity and the refill rate.
 * @returns {Promise<{ allowed: boolean, tokens: number, ratePerSec: number }>}
 */
async function refillAndConsume(executor, bucketKey, ratePerSec) {
  // One statement: compute refilled = min(capacity, tokens + elapsed*rate),
  // then if refilled >= 1 consume a token, else leave it. last_refill_at is
  // advanced to now() unconditionally so the next call's elapsed is measured
  // from here. capacity/refill_per_sec are rewritten from $2 (current config).
  const result = await executor.query(
    `
    UPDATE rate_limit_buckets
    SET
      capacity = $2,
      refill_per_sec = $2,
      tokens = CASE WHEN refilled >= 1 THEN refilled - 1 ELSE refilled END,
      last_refill_at = now()
    FROM (
      SELECT LEAST(
        $2::double precision,
        tokens + GREATEST(0, EXTRACT(EPOCH FROM (now() - last_refill_at))) * $2::double precision
      ) AS refilled
      FROM rate_limit_buckets
      WHERE bucket_key = $1
    ) AS computed
    WHERE rate_limit_buckets.bucket_key = $1
    RETURNING rate_limit_buckets.tokens AS tokens, computed.refilled AS refilled
    `,
    [bucketKey, ratePerSec]
  );

  if (result.rows.length === 0) {
    // The lane row is missing (a fresh DB that has not run the seed, or a
    // manual delete). Fail OPEN rather than deadlock every Authentik call:
    // log once per occurrence and allow the request through. The row is
    // normally seeded by the migration.
    logger.error({ bucketKey }, 'Rate-limit bucket row missing; allowing request (fail-open)');
    return { allowed: true, tokens: 0, ratePerSec };
  }

  const { tokens, refilled } = result.rows[0];
  return { allowed: refilled >= 1, tokens, ratePerSec };
}

/**
 * Acquire one token from the given lane, waiting (up to
 * `MAX_ACQUIRE_WAIT_MS`) for one to refill if none is immediately
 * available. Returns whether a token was granted.
 *
 * When the limiter is disabled, returns `{ granted: true, waitedMs: 0 }`
 * immediately with no DB call.
 *
 * @param {'read'|'write'|'write_priority'} kind
 * @returns {Promise<{ granted: boolean, waitedMs: number }>} `granted:false`
 *   means the wait ceiling elapsed without a token -- the caller should
 *   treat this like a transient upstream failure (requeue/backoff), NOT
 *   proceed with the call.
 */
async function acquire(kind) {
  if (!isAuthentikRateLimitEnabled()) {
    return { granted: true, waitedMs: 0 };
  }

  const bucketKey = BUCKET_KEYS[kind];
  if (!bucketKey) {
    throw new Error(`Unknown rate-limit lane: ${kind}`);
  }

  const startedAt = Date.now();
  // First attempt, then poll until granted or the wait ceiling elapses.
  while (true) {
    const { ratePerSec } = laneRate(kind);
    const { allowed, tokens } = await refillAndConsume(pool, bucketKey, ratePerSec);
    if (allowed) {
      return { granted: true, waitedMs: Date.now() - startedAt };
    }

    const waitedSoFar = Date.now() - startedAt;
    if (waitedSoFar >= MAX_ACQUIRE_WAIT_MS) {
      logger.warn(
        { kind, waitedMs: waitedSoFar },
        'Rate-limit acquire timed out waiting for a token; signalling caller to requeue'
      );
      return { granted: false, waitedMs: waitedSoFar };
    }

    // Sleep until roughly one token should be available, bounded so we
    // never overshoot the overall wait ceiling and never busy-loop.
    const estimated = estimateWaitMs(tokens, ratePerSec);
    const remaining = MAX_ACQUIRE_WAIT_MS - waitedSoFar;
    const sleepMs = Math.max(MIN_SLEEP_MS, Math.min(Number.isFinite(estimated) ? estimated : MIN_SLEEP_MS, remaining));
    await sleep(sleepMs);
  }
}

module.exports = {
  acquire,
  refillAndConsume,
  BUCKET_KEYS,
  MAX_ACQUIRE_WAIT_MS
};
