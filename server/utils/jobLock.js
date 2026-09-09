const logger = require('../config/logger').createLogger('jobLock');

/**
 * Single-runner guard for the Sync_Worker's PERIODIC jobs, using a Postgres
 * session-level advisory lock.
 *
 * WHY THIS EXISTS
 *
 * The Sync_Worker runs at desiredCount > 1 in production (two tasks, for
 * resiliency of the `sync_operations` queue drain). The queue drain itself is
 * safe to run in every worker -- it claims rows with `FOR UPDATE SKIP LOCKED`,
 * the canonical competing-consumers pattern. But the worker ALSO runs several
 * PERIODIC jobs on their own `setInterval` timers (retention cleanup, the
 * owned-group anti-drift sweep, the subscription poller, the device sync, and
 * -- the one with a real correctness stake -- the daily certificate-expiry
 * email digest). Those are "run once per tick" jobs, not queue consumers, and
 * their in-process guards (e.g. CertExpiryNotificationJob's `lastRunDateKey`,
 * OwnedGroupSweepJob's `isSweeping`) are PER-PROCESS: with two workers they do
 * not coordinate, so both would fire the same tick. For the cert-expiry job
 * that means duplicate emails to the same recipient (its dedup row is written
 * AFTER the send, so it prevents duplicate rows, not duplicate sends).
 *
 * `withJobLock` makes a periodic tick run in AT MOST ONE worker: the worker
 * that acquires the advisory lock runs the tick; any other worker whose tick
 * fires while the lock is held simply skips this tick and tries again next
 * interval. The queue drain is deliberately NOT wrapped -- it must stay
 * parallel.
 *
 * WHY A SESSION LOCK ON A DEDICATED CLIENT
 *
 * `pg_try_advisory_lock(key)` is non-blocking (returns immediately with
 * true/false) and session-scoped: the lock is held by the CONNECTION until
 * `pg_advisory_unlock(key)` is called on that same connection (or the
 * connection closes). So the lock and unlock MUST run on the same client --
 * hence a single `pool.connect()` client held for the duration of `fn`, with
 * the unlock in a `finally`. Using `pool.query` (which may hand out different
 * pooled connections for the lock and the unlock) would be a bug: the unlock
 * could land on a connection that never held the lock, leaving the real lock
 * held until its connection is recycled.
 *
 * FAIL-SAFE POSTURE
 *
 * - Could not acquire the lock (another worker holds it): skip -- return
 *   `{ ran: false }`, do NOT run `fn`. This is the normal N>1 case.
 * - Could not even connect / the try-lock query threw: skip and log, do NOT
 *   run `fn`. Failing CLOSED (not running) is correct for a singleton job: at
 *   worst a tick is missed and the next interval retries; running it without a
 *   confirmed lock is what we are trying to prevent.
 * - `fn` itself throws: the error propagates to the caller AFTER the lock is
 *   released in `finally`, so each job keeps its own existing catch-and-log
 *   behaviour unchanged.
 */

// Stable advisory-lock keys, one per periodic job. Postgres advisory-lock keys
// are arbitrary bigints; these are fixed, distinct constants so two workers
// contend on the SAME key per job (and never collide across different jobs).
// Chosen in a small, human-readable, deliberately-unique block. NEVER reuse a
// value for two jobs, and NEVER change a value in a way that would let an old
// and a new worker use different keys for the same job during a rolling
// deploy (they would then both run the tick). AdminCredentialRefreshJob is
// intentionally ABSENT: it must run in every worker (each needs its own
// in-memory credential), so it is never lock-guarded.
const JOB_LOCK_KEYS = Object.freeze({
  RETENTION_CLEANUP: 4310001,
  OWNED_GROUP_SWEEP: 4310002,
  SUBSCRIPTION_POLLER: 4310003,
  DEVICE_SYNC: 4310004,
  CERT_EXPIRY_NOTIFICATION: 4310005,
  CALLSIGN_POLLER: 4310006
});

/**
 * Runs `fn` only if this process can acquire the Postgres advisory lock for
 * `jobKey`; otherwise skips (another worker is running this tick, or the lock
 * could not be acquired for any reason).
 *
 * @param {import('pg').Pool} pool a pg Pool
 * @param {number} jobKey a stable advisory-lock key (see JOB_LOCK_KEYS)
 * @param {() => Promise<void>} fn the tick body to run under the lock
 * @returns {Promise<{ran: boolean}>} whether `fn` was executed
 * @throws re-throws whatever `fn` throws (after releasing the lock)
 */
async function withJobLock(pool, jobKey, fn) {
  let client;
  try {
    client = await pool.connect();
  } catch (error) {
    // Cannot even get a connection to try the lock -- fail closed (skip the
    // tick). The next interval retries; a transient pool exhaustion must not
    // cause an unguarded run.
    logger.warn({ err: error, jobKey }, 'Could not acquire a client to take the job lock; skipping this tick');
    return { ran: false };
  }

  let acquired = false;
  try {
    let result;
    try {
      result = await client.query('SELECT pg_try_advisory_lock($1) AS locked', [jobKey]);
    } catch (error) {
      // The try-lock query itself failed -- fail closed.
      logger.warn({ err: error, jobKey }, 'pg_try_advisory_lock failed; skipping this tick');
      return { ran: false };
    }

    acquired = result.rows[0] && result.rows[0].locked === true;
    if (!acquired) {
      // Another worker holds the lock -- the expected N>1 skip. Debug, not
      // warn: this is normal, once-per-tick-per-extra-worker.
      logger.debug({ jobKey }, 'Job lock held by another worker; skipping this tick');
      return { ran: false };
    }

    await fn();
    return { ran: true };
  } finally {
    if (acquired) {
      try {
        await client.query('SELECT pg_advisory_unlock($1)', [jobKey]);
      } catch (error) {
        // A failed unlock is not fatal: the lock is released automatically when
        // this client's connection is closed/recycled below. Log so a
        // persistent unlock failure is visible.
        logger.warn({ err: error, jobKey }, 'pg_advisory_unlock failed; the lock will release when the connection closes');
      }
    }
    client.release();
  }
}

module.exports = { withJobLock, JOB_LOCK_KEYS };
