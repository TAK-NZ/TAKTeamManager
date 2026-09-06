/**
 * Authentik API rate-limiter configuration (server-side only).
 *
 * TAK Team Manager throttles every call it makes to the Authentik
 * management API through a shared, cross-process token bucket (see
 * `server/services/authentikRateLimiter.js`). The ceilings below were
 * derived empirically from load-profiling a prod-shaped Authentik: it
 * emits NO 429 and NO Retry-After -- it simply degrades into latency and
 * timeouts once reads exceed ~5-8 rps or writes exceed ~3-5 rps (see
 * `docs/authentik-ratelimit-profiling.md` and
 * `.kiro/steering/authentik-scaling.md`). The defaults are therefore
 * deliberately conservative and sit below the measured collapse point.
 *
 * All of these are read on the SERVER (and Sync_Worker) ONLY. None are
 * ever surfaced through the Public_Config_Endpoint (`GET /api/config/public`);
 * they govern how the backend talks to Authentik, not how the client
 * renders anything.
 *
 * Every helper takes an injectable `env` for testing and follows the
 * codebase's established env conventions: the flag is true ONLY for the
 * exact string `'true'` (matching `isDeviceMgmtEnabled` in
 * `server/config/deviceMgmt.js`), and each numeric ceiling is clamped to
 * a positive integer with `Math.max(1, parseInt(...) || DEFAULT)`
 * (matching `getRevokeMaxCerts` / `SubscriptionPoller`).
 */

// Empirical defaults (requests per second), from the prod-shaped profile.
// Kept below the observed clean ceilings (reads ~5-8/s, writes ~3-5/s) so
// sustained background reconciliation never runs at the edge of capacity.
const DEFAULT_READ_PER_SEC = 5;
const DEFAULT_WRITE_PER_SEC = 3;
// A small reserved budget for urgent mutations (delete/suspend/revoke/
// cleanup) so they still get a token even while a bulk background job has
// drained the normal write budget. WRITE + WRITE_PRIORITY together
// (3 + 2 = 5) stay at/under the ~5/s clean write ceiling.
const DEFAULT_WRITE_PRIORITY_PER_SEC = 2;

/**
 * Rate-limiter enablement flag.
 *
 * True ONLY when `AUTHENTIK_RATE_LIMIT_ENABLED` is exactly `'true'`;
 * unset, empty, or any other value (including `'TRUE'`, `' true '`,
 * `'1'`) yields false. When false, `authentikRateLimiter` is a
 * transparent pass-through -- every call proceeds immediately, acquiring
 * no token -- so the limiter can be shipped dark and enabled per
 * environment.
 *
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {boolean}
 */
function isAuthentikRateLimitEnabled(env = process.env) {
  return env.AUTHENTIK_RATE_LIMIT_ENABLED === 'true';
}

/**
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {number} positive-integer read requests/sec ceiling; 5 default.
 */
function getReadRatePerSec(env = process.env) {
  return Math.max(1, parseInt(env.AUTHENTIK_RATE_LIMIT_READ_PER_SEC, 10) || DEFAULT_READ_PER_SEC);
}

/**
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {number} positive-integer normal-write requests/sec ceiling; 3 default.
 */
function getWriteRatePerSec(env = process.env) {
  return Math.max(1, parseInt(env.AUTHENTIK_RATE_LIMIT_WRITE_PER_SEC, 10) || DEFAULT_WRITE_PER_SEC);
}

/**
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {number} positive-integer priority-write requests/sec ceiling; 2 default.
 */
function getWritePriorityRatePerSec(env = process.env) {
  return Math.max(1, parseInt(env.AUTHENTIK_RATE_LIMIT_WRITE_PRIORITY_PER_SEC, 10) || DEFAULT_WRITE_PRIORITY_PER_SEC);
}

module.exports = {
  isAuthentikRateLimitEnabled,
  getReadRatePerSec,
  getWriteRatePerSec,
  getWritePriorityRatePerSec,
  DEFAULT_READ_PER_SEC,
  DEFAULT_WRITE_PER_SEC,
  DEFAULT_WRITE_PRIORITY_PER_SEC
};
