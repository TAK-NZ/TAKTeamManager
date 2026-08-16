/**
 * Auth-scoped and request-access-scoped rate limiters (Requirement 7:
 * Apply Endpoint-Appropriate Rate Limiting).
 *
 * `server/index.js` already applies a single global `express-rate-limit`
 * instance (1000 requests / 15 minutes) as a coarse backstop. This module
 * adds:
 *
 *  - the two auth-specific limiters called for by Requirements 7.1, 7.5,
 *    and 7.6 (`authLimiter`, `authCallbackFailureLimiter`); and
 *  - the two request-access-specific limiters called for by Requirements
 *    7.1 and 7.2 (`requestAccessLimiter`, `emailWindowLimiter`), mounted
 *    on `POST /api/requests/team-access` and `GET /api/requests/verify/:token`
 *    (see `server/routes/requests.js`).
 *
 * `authLimiter` and `requestAccessLimiter` are both keyed by `req.ip` (via
 * `express-rate-limit`'s default `keyGenerator`):
 *
 *  - `authLimiter`: a standard `express-rate-limit` instance capped at 20
 *    requests per IP per 15-minute window, mounted broadly across every
 *    route in `/api/auth/*` (Requirement 7.1). Because this middleware runs
 *    before any route handler, an IP that exceeds the limit receives an
 *    HTTP 429 response and the request never reaches the handler -- no
 *    token exchange or Authentik API call happens for the offending
 *    request (Requirement 7.6).
 *
 *  - `authCallbackFailureLimiter`: a *separate*, stricter counter limited
 *    to 10 FAILED attempts per IP per 15-minute window, applied only to
 *    `GET /api/auth/callback` (Requirement 7.5). This is deliberately NOT
 *    implemented as a second standard `express-rate-limit` instance with
 *    `skipSuccessfulRequests: true`, because that option's built-in
 *    `requestWasSuccessful` check (`response.statusCode < 400`) cannot
 *    distinguish a failed OAuth2 callback from a successful one here: both
 *    outcomes respond with an HTTP 302 redirect (a successful callback
 *    redirects to `${FRONTEND_URL}/dashboard`; a failed one redirects to
 *    `${FRONTEND_URL}?error=...`) -- 302 is never >= 400, so
 *    `skipSuccessfulRequests` would never count anything as a failure.
 *
 *    Instead, this module exposes:
 *      - `authCallbackFailureLimiter` middleware: a *read-only* gate that
 *        rejects with 429 (before the route handler, and therefore before
 *        any token exchange or Authentik API call) once the requesting
 *        IP's failure count for the current window has already reached
 *        the limit. It does NOT itself increment anything on a
 *        request-in / request-out basis.
 *      - `recordAuthCallbackFailure(req)`: an explicit increment function,
 *        called only from within `GET /api/auth/callback`'s existing
 *        `catch` block (i.e. only on an actual token-exchange/userinfo
 *        failure), which is what "incremented in the callback's catch"
 *        means concretely.
 *
 *    This mirrors the `email_rate_tracking` window-tracking pattern used
 *    elsewhere in this codebase, implemented as a small in-memory,
 *    IP-keyed counter with its own 15-minute window rather than relying on
 *    `express-rate-limit`'s automatic per-request counting.
 */

const rateLimit = require('express-rate-limit');
const { MemoryStore } = rateLimit;
const { validationResult } = require('express-validator');
const pool = require('../config/database');

// Requirement 7.1: no more than 20 requests per IP per 15-minute window on
// the OAuth2 `/api/auth/*` routes.
const AUTH_LIMITER_WINDOW_MS = 15 * 60 * 1000;
const AUTH_LIMITER_MAX = 20;

// Requirement 7.5: no more than 10 FAILED attempts per IP per 15-minute
// window on `GET /api/auth/callback`.
const AUTH_CALLBACK_FAILURE_WINDOW_MS = 15 * 60 * 1000;
const AUTH_CALLBACK_FAILURE_MAX = 10;

// The store is created and passed explicitly (rather than left as
// `express-rate-limit`'s implicit default) so tests can reset it between
// cases via `authLimiterStore.resetAll()` without needing to know the
// exact key `express-rate-limit`'s default `keyGenerator` derives from
// `req.ip`.
const authLimiterStore = new MemoryStore();

/**
 * Requirement 7.1/7.6: standard `express-rate-limit` instance capped at 20
 * requests per IP per 15-minute window, intended to be mounted broadly
 * (`router.use(authLimiter)`) across every route in `/api/auth/*`.
 */
const authLimiter = rateLimit({
  windowMs: AUTH_LIMITER_WINDOW_MS,
  max: AUTH_LIMITER_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  store: authLimiterStore
});

/**
 * A small, IP-keyed, fixed-window failure counter, deliberately separate
 * from `express-rate-limit`'s request-counting `MemoryStore` since this
 * store is only ever mutated by an explicit `recordFailure` call (from the
 * callback's `catch` block), never by the gate middleware itself.
 */
class FailureWindowCounter {
  constructor(windowMs) {
    this.windowMs = windowMs;
    this.hits = new Map(); // key -> { count, resetTime }
  }

  /**
   * Returns the current failure count for `key` within the active window,
   * or 0 if `key` has no entry or its window has already elapsed.
   */
  getCount(key) {
    const entry = this.hits.get(key);
    if (!entry || entry.resetTime <= Date.now()) {
      return 0;
    }
    return entry.count;
  }

  /**
   * Increments `key`'s failure count, starting a fresh window if none is
   * active. Returns the updated count.
   */
  recordFailure(key) {
    const now = Date.now();
    let entry = this.hits.get(key);
    if (!entry || entry.resetTime <= now) {
      entry = { count: 0, resetTime: now + this.windowMs };
      this.hits.set(key, entry);
    }
    entry.count += 1;
    return entry.count;
  }

  /** Test helper: clears every tracked key. */
  resetAll() {
    this.hits.clear();
  }
}

const authCallbackFailureStore = new FailureWindowCounter(AUTH_CALLBACK_FAILURE_WINDOW_MS);

/**
 * Requirement 7.5/7.6: gate middleware for `GET /api/auth/callback`.
 *
 * Rejects with HTTP 429 -- before the route handler runs, and therefore
 * before any token exchange or Authentik API call -- once the requesting
 * IP has already recorded `AUTH_CALLBACK_FAILURE_MAX` (10) failed attempts
 * within the current 15-minute window. Does not itself increment the
 * counter; only `recordAuthCallbackFailure` (called from the route
 * handler's `catch` block) does that.
 */
function authCallbackFailureLimiter(req, res, next) {
  const key = req.ip;
  const count = authCallbackFailureStore.getCount(key);

  if (count >= AUTH_CALLBACK_FAILURE_MAX) {
    return res.status(429).json({
      error: 'Too many failed authentication attempts. Please try again later.'
    });
  }

  next();
}

/**
 * Requirement 7.5: records a failed `GET /api/auth/callback` attempt for
 * the requesting IP. This is the ONLY place the failure counter is
 * incremented -- called from `server/routes/auth.js`'s existing `catch`
 * block for the primary OAuth2 callback, i.e. only on an actual
 * token-exchange/userinfo failure, never on a successful callback.
 *
 * @param {import('express').Request} req
 */
function recordAuthCallbackFailure(req) {
  authCallbackFailureStore.recordFailure(req.ip);
}

// ---------------------------------------------------------------------------
// Requirement 7.1/7.2: requestAccessLimiter (per-IP) and emailWindowLimiter
// (per-email, via `email_rate_tracking`) for `POST /api/requests/team-access`
// and `GET /api/requests/verify/:token`.
// ---------------------------------------------------------------------------

// Requirement 7.1: no more than 20 requests per IP per 15-minute window on
// `POST /api/requests/team-access` and `GET /api/requests/verify/:token`.
// This is a *separate* `express-rate-limit` instance (own store) from
// `authLimiter` above, even though both currently use the same 20/15min
// thresholds, so that a burst against one route group never counts
// against the other's budget.
const REQUEST_ACCESS_LIMITER_WINDOW_MS = 15 * 60 * 1000;
const REQUEST_ACCESS_LIMITER_MAX = 20;

const requestAccessLimiterStore = new MemoryStore();

/**
 * Requirement 7.1: standard `express-rate-limit` instance capped at 20
 * requests per IP per 15-minute window, mounted on both
 * `POST /api/requests/team-access` and `GET /api/requests/verify/:token`.
 * Because this middleware runs before either route's handler, an IP that
 * exceeds the limit receives HTTP 429 and the handler -- which would
 * otherwise create an `access_requests` row or send a verification email
 * -- never runs (Requirement 7.2).
 */
const requestAccessLimiter = rateLimit({
  windowMs: REQUEST_ACCESS_LIMITER_WINDOW_MS,
  max: REQUEST_ACCESS_LIMITER_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  store: requestAccessLimiterStore
});

// Requirement 7.2: no more than 5 requests associated with a given email
// address within a 60-minute window, tracked via the `email_rate_tracking`
// table (see `database/migrations/*_create-email-rate-tracking.cjs`)
// rather than an in-memory store, since `express-rate-limit`'s built-in
// keying only has synchronous access to request properties (typically
// `req.ip`) and cannot key off a value read from the request body without
// a custom store/middleware like this one.
const EMAIL_WINDOW_LIMITER_WINDOW_MS = 60 * 60 * 1000;
const EMAIL_WINDOW_LIMITER_MAX = 5;

/**
 * Requirement 7.2: per-email rate-limiting middleware for
 * `POST /api/requests/team-access`, where `req.body.email` is directly
 * submitted by the caller.
 *
 * This is intentionally mounted AFTER the route's `express-validator`
 * chain (which includes `body('email').isEmail().normalizeEmail()`) so
 * that:
 *   - an invalid `email` never reaches this DB-backed check at all (the
 *     chain's sanitizers still run and mutate `req.body.email` in place,
 *     but this middleware defers to the route handler's own
 *     `validationResult(req)` check for reporting the 400, rather than
 *     duplicating that logic here); and
 *   - the value read from `req.body.email` is already normalized
 *     (lower-cased, etc.) by `.normalizeEmail()`, consistent with how
 *     `requester_email` is later persisted by `RequestApprovalService`/
 *     `AccessRequest`, so the same address is always tracked under the
 *     same key regardless of the casing/formatting a caller submits.
 *
 * Uses a single window row per email: if an active (< 60 minutes old)
 * window row exists and its count is already at or over the limit, the
 * request is rejected with 429 *without* incrementing the count further
 * and without calling `next()` (so the route handler -- which creates the
 * `access_requests` row and sends the verification email -- never runs,
 * per Requirement 7.2). Otherwise the existing window's count is
 * incremented, or a fresh window row is inserted if none is active, and
 * the request proceeds.
 */
async function emailWindowLimiter(req, res, next) {
  // If the express-validator chain mounted ahead of this middleware
  // already found `email` invalid (or missing), let the route handler's
  // own `validationResult(req)` check report the 400 rather than this
  // middleware attempting to rate-limit an invalid/absent value.
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return next();
  }

  const email = req.body.email;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const windowResult = await client.query(
      `SELECT id, count FROM email_rate_tracking
       WHERE email = $1 AND window_start > NOW() - INTERVAL '60 minutes'
       ORDER BY window_start DESC
       LIMIT 1
       FOR UPDATE`,
      [email]
    );

    if (windowResult.rows.length > 0) {
      const { id, count } = windowResult.rows[0];

      if (count >= EMAIL_WINDOW_LIMITER_MAX) {
        await client.query('ROLLBACK');
        return res.status(429).json({
          error: 'Too many requests for this email address. Please try again later.'
        });
      }

      await client.query(
        'UPDATE email_rate_tracking SET count = count + 1 WHERE id = $1',
        [id]
      );
    } else {
      await client.query(
        'INSERT INTO email_rate_tracking (email, window_start, count) VALUES ($1, NOW(), 1)',
        [email]
      );
    }

    await client.query('COMMIT');
    return next();
  } catch (error) {
    await client.query('ROLLBACK');
    return next(error);
  } finally {
    client.release();
  }
}

module.exports = {
  authLimiter,
  authCallbackFailureLimiter,
  recordAuthCallbackFailure,
  requestAccessLimiter,
  emailWindowLimiter,
  // Exposed for tests only, to reset in-memory counters between cases.
  authLimiterStore,
  authCallbackFailureStore,
  requestAccessLimiterStore,
  AUTH_LIMITER_WINDOW_MS,
  AUTH_LIMITER_MAX,
  AUTH_CALLBACK_FAILURE_WINDOW_MS,
  AUTH_CALLBACK_FAILURE_MAX,
  REQUEST_ACCESS_LIMITER_WINDOW_MS,
  REQUEST_ACCESS_LIMITER_MAX,
  EMAIL_WINDOW_LIMITER_WINDOW_MS,
  EMAIL_WINDOW_LIMITER_MAX
};
