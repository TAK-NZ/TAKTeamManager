const pool = require('../config/database');
const logger = require('../config/logger').createLogger('EmailRateLimitService');

/**
 * Email-keyed rate limiting for the public request-access/sign-up flow
 * (Requirement 7.2's "5 requests associated with a given email address
 * within a 60-minute window"), backed by the `email_rate_tracking` table
 * that has existed in the schema since the baseline migration but, until
 * this service, was never read or written by any application code.
 *
 * This exists alongside the IP-keyed limiters in `rateLimiters.js`
 * because IP-keyed throttling alone does not protect a single victim
 * email address from being flooded with verification emails by an
 * attacker who simply rotates source IPs -- the per-IP budget resets for
 * every new IP, but the per-EMAIL budget here does not.
 *
 * Implementation is a simple fixed-window counter (not a sliding
 * window): the first attempt for an email opens a window starting now;
 * every subsequent attempt within `windowMinutes` of that window's start
 * increments the same row's `count`; once `count` reaches `maxAttempts`
 * the window is exhausted and further attempts are rejected until the
 * window elapses, at which point the NEXT attempt opens a fresh window.
 *
 * Concurrency note: the read-then-write here (SELECT the active window,
 * then either UPDATE or INSERT) is not atomic against a concurrent
 * request for the same email arriving in the same instant -- two
 * simultaneous attempts could each observe the same pre-increment count
 * and both be allowed through, undercounting by at most the number of
 * truly concurrent requests. This is an accepted tradeoff for an abuse
 * mitigation rather than a hard security boundary (the same class of
 * imprecision already exists in `rateLimiters.js`'s in-memory
 * `express-rate-limit` stores under multi-instance deployment) -- a
 * `SELECT ... FOR UPDATE` would close this gap at the cost of a table
 * lock on every signup attempt, which is not justified here.
 *
 * Fails OPEN (logs a warning and allows the attempt) on any database
 * error, deliberately: a DB blip must not block every legitimate signup
 * attempt just because this best-effort abuse counter couldn't be read.
 * This differs from `DirectoryScopeService`'s fail-closed convention
 * elsewhere in this codebase, because this is a rate limiter (an
 * availability/abuse concern), not an authorization boundary protecting
 * data visibility.
 */

const DEFAULT_WINDOW_MINUTES = 60;
const DEFAULT_MAX_ATTEMPTS = 5;

/**
 * Checks whether `email` is still within its rate-limit budget and, if
 * so, records this attempt (opening a new window or incrementing the
 * active one). Returns `{ allowed: true }` or `{ allowed: false }`
 * without throwing on a database error -- see the file-level fail-open
 * note above.
 *
 * @param {string} email - normalized email address (caller's
 *   responsibility to lowercase/trim before calling, matching whatever
 *   normalization the rest of the signup flow already applies).
 * @param {{windowMinutes?: number, maxAttempts?: number}} [options]
 * @returns {Promise<{allowed: boolean}>}
 */
async function checkAndRecordEmailAttempt(email, options = {}) {
  const windowMinutes = options.windowMinutes ?? DEFAULT_WINDOW_MINUTES;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

  try {
    const activeWindowResult = await pool.query(
      `SELECT id, count FROM email_rate_tracking
       WHERE email = $1 AND window_start > NOW() - INTERVAL '1 minute' * $2::integer
       ORDER BY window_start DESC LIMIT 1`,
      [email, windowMinutes]
    );

    const activeWindow = activeWindowResult?.rows?.[0];

    if (activeWindow) {
      if (activeWindow.count >= maxAttempts) {
        return { allowed: false };
      }
      await pool.query('UPDATE email_rate_tracking SET count = count + 1 WHERE id = $1', [activeWindow.id]);
      return { allowed: true };
    }

    await pool.query(
      'INSERT INTO email_rate_tracking (email, window_start, count) VALUES ($1, NOW(), 1)',
      [email]
    );
    return { allowed: true };
  } catch (error) {
    logger.warn({ err: error }, 'Email rate-limit check failed; failing open and allowing the attempt');
    return { allowed: true };
  }
}

module.exports = {
  checkAndRecordEmailAttempt,
  DEFAULT_WINDOW_MINUTES,
  DEFAULT_MAX_ATTEMPTS
};
