/**
 * Health check routes (Requirement 14: Provide Meaningful Health and
 * Readiness Checks)
 *
 * `GET /health` replaces the previous unconditional `{status: 'OK'}`
 * response in `server/index.js` with a real Database connectivity check
 * (Criteria 14.1-14.2): a `SELECT 1` query is issued against the shared
 * connection pool with a 2-second maximum timeout, enforced via
 * `Promise.race` against a timer (the `pg` Pool's `query()` method has no
 * built-in per-call timeout option, so the race is the mechanism used
 * elsewhere in this design for time-bounded dependency checks).
 *
 * - On success: HTTP 200, `{status: 'healthy'}`.
 * - On failure or timeout: HTTP 503, `{status: 'unhealthy', reason}`,
 *   where `reason` is a short, non-leaky description of what went wrong
 *   (the underlying error is logged via the structured logger, not
 *   exposed in the response body, to avoid leaking internal details).
 *
 * `GET /ready` (mounted as `GET /health/ready`) implements the separate
 * readiness check required by Criteria 14.3-14.4: it verifies BOTH
 * Database connectivity and Authentik API reachability, each bounded to
 * its own 3-second timeout via the same `Promise.race`-against-a-timer
 * mechanism, run concurrently via `Promise.allSettled` so the worst-case
 * total latency is ~3s rather than ~6s. HTTP 200 `{status: 'ready'}` is
 * returned only if both checks succeed; otherwise HTTP 503
 * `{status: 'not_ready', reason}` is returned, where `reason` identifies
 * which dependency check(s) failed without leaking the underlying error.
 *
 * `GET /live` (mounted as `GET /health/live`) implements the liveness
 * check required by Criterion 14.5: it performs no Database or Authentik
 * checks at all and always returns HTTP 200 `{status: 'alive'}` whenever
 * the process is able to respond to the request.
 *
 * These routes are listed in `server/config/publicRoutes.js` (Requirement
 * 33.1) and must remain reachable without authentication, since load
 * balancers and container orchestrators probing them have no JWT_Token.
 */

const express = require('express');
const axios = require('axios');
const pool = require('../config/database');
const logger = require('../config/logger').createLogger('health');

const router = express.Router();

const DB_CHECK_TIMEOUT_MS = 2000;

// Requirement 14.3/14.4: the readiness endpoint's Database and Authentik
// checks each get their own 3-second timeout, distinct from `GET /health`'s
// 2-second Database timeout.
const READY_DB_CHECK_TIMEOUT_MS = 3000;
const AUTHENTIK_CHECK_TIMEOUT_MS = 3000;

/**
 * Races `promise` against a fixed timeout so a hung/slow dependency can't
 * block a health/readiness check indefinitely.
 *
 * @param {Promise<any>} promise - the dependency check to bound.
 * @param {number} timeoutMs - maximum time to wait, in milliseconds.
 * @param {string} timeoutMessage - error message used if the timeout wins.
 * @returns {Promise<any>} resolves/rejects with `promise`'s outcome if it
 *   settles first; rejects with an Error(timeoutMessage) otherwise.
 */
function withTimeout(promise, timeoutMs, timeoutMessage) {
  let timeoutHandle;

  const timeoutPromise = new Promise((_resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error(timeoutMessage));
    }, timeoutMs);
  });

  // Whichever side of the race settles first, clear the timer so it never
  // lingers past the request. Without this, a fast-resolving `promise`
  // still leaves the `setTimeout` running for the remainder of `timeoutMs`
  // (up to 2-3s per check here), which shows up as a dangling active timer
  // keeping the Jest worker process alive after the test run completes.
  return Promise.race([promise, timeoutPromise]).finally(() => {
    clearTimeout(timeoutHandle);
  });
}

/**
 * Runs `SELECT 1` against the shared pool, racing it against a fixed
 * timeout so a hung/slow database connection can't block the health
 * check indefinitely (Criterion 14.1, reused with a longer timeout for
 * Criterion 14.3).
 *
 * @param {number} [timeoutMs] - maximum time to wait, in milliseconds.
 *   Defaults to the `GET /health` 2-second timeout.
 * @returns {Promise<void>} resolves if the query completes within the
 *   timeout; rejects with an Error otherwise (including on timeout).
 */
function checkDatabaseConnectivity(timeoutMs = DB_CHECK_TIMEOUT_MS) {
  return withTimeout(
    pool.query('SELECT 1'),
    timeoutMs,
    `Database connectivity check timed out after ${timeoutMs}ms`
  );
}

/**
 * Makes a lightweight authenticated call to the Authentik API, racing it
 * against a fixed timeout so a hung/slow Authentik instance can't block
 * the readiness check indefinitely (Criterion 14.3).
 *
 * @param {number} [timeoutMs] - maximum time to wait, in milliseconds.
 * @returns {Promise<void>} resolves if the call completes within the
 *   timeout; rejects with an Error otherwise (including on timeout).
 */
function checkAuthentikReachability(timeoutMs = AUTHENTIK_CHECK_TIMEOUT_MS) {
  const requestPromise = axios.get(`${process.env.AUTHENTIK_URL}/api/v3/core/users/?page_size=1`, {
    headers: { Authorization: `Bearer ${process.env.AUTHENTIK_ADMIN_TOKEN}` }
  });

  return withTimeout(
    requestPromise,
    timeoutMs,
    `Authentik reachability check timed out after ${timeoutMs}ms`
  );
}

// Requirement 14.1/14.2: GET /health verifies Database connectivity via a
// timeout-bounded `SELECT 1` and reports the result as a liveness+DB
// health signal for load balancers / ECS Fargate health checks.
router.get('/', async (req, res) => {
  try {
    await checkDatabaseConnectivity();
    res.status(200).json({ status: 'healthy' });
  } catch (err) {
    logger.error({ err }, 'Health check failed: database connectivity check failed or timed out');
    res.status(503).json({
      status: 'unhealthy',
      reason: 'Database connectivity check failed or timed out'
    });
  }
});

// Requirement 14.3/14.4: GET /ready (mounted at GET /health/ready) verifies
// both Database connectivity and Authentik reachability concurrently, each
// bounded to its own 3-second timeout, returning 200 only if both succeed.
router.get('/ready', async (req, res) => {
  const [dbResult, authentikResult] = await Promise.allSettled([
    checkDatabaseConnectivity(READY_DB_CHECK_TIMEOUT_MS),
    checkAuthentikReachability()
  ]);

  const reasons = [];

  if (dbResult.status === 'rejected') {
    logger.error(
      { err: dbResult.reason },
      'Readiness check failed: database connectivity check failed or timed out'
    );
    reasons.push('Database connectivity check failed or timed out');
  }

  if (authentikResult.status === 'rejected') {
    logger.error(
      { err: authentikResult.reason },
      'Readiness check failed: Authentik reachability check failed or timed out'
    );
    reasons.push('Authentik reachability check failed or timed out');
  }

  if (reasons.length === 0) {
    return res.status(200).json({ status: 'ready' });
  }

  return res.status(503).json({
    status: 'not_ready',
    reason: reasons.join('; ')
  });
});

// Requirement 14.5: GET /live (mounted at GET /health/live) verifies only
// that the App process is running and able to respond to HTTP requests --
// no Database or Authentik connectivity check -- and always returns 200
// whenever the process can handle the request.
router.get('/live', (req, res) => {
  res.status(200).json({ status: 'alive' });
});

module.exports = router;
module.exports.checkDatabaseConnectivity = checkDatabaseConnectivity;
module.exports.checkAuthentikReachability = checkAuthentikReachability;
module.exports.DB_CHECK_TIMEOUT_MS = DB_CHECK_TIMEOUT_MS;
module.exports.READY_DB_CHECK_TIMEOUT_MS = READY_DB_CHECK_TIMEOUT_MS;
module.exports.AUTHENTIK_CHECK_TIMEOUT_MS = AUTHENTIK_CHECK_TIMEOUT_MS;
