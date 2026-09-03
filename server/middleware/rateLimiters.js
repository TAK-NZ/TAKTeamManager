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
 *  - the request-access-specific limiter called for by Requirement 7.1
 *    (`requestAccessLimiter`), mounted on `POST /api/requests/initiate`
 *    (see `server/routes/signup.js`).
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
const EmailRateLimitService = require('../services/EmailRateLimitService');
const { getLogger } = require('./requestContext');

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
// Requirement 7.1: requestAccessLimiter (per-IP) for
// `POST /api/requests/initiate`.
// ---------------------------------------------------------------------------

// Requirement 7.1: no more than 20 requests per IP per 15-minute window on
// `POST /api/requests/initiate`.
// This is a *separate* `express-rate-limit` instance (own store) from
// `authLimiter` above, even though both currently use the same 20/15min
// thresholds, so that a burst against one route group never counts
// against the other's budget.
const REQUEST_ACCESS_LIMITER_WINDOW_MS = 15 * 60 * 1000;
const REQUEST_ACCESS_LIMITER_MAX = 20;

const requestAccessLimiterStore = new MemoryStore();

/**
 * Requirement 7.1: standard `express-rate-limit` instance capped at 20
 * requests per IP per 15-minute window, mounted on
 * `POST /api/requests/initiate`.
 * Because this middleware runs before the route's handler, an IP that
 * exceeds the limit receives HTTP 429 and the handler -- which would
 * otherwise create an `access_requests` row or send a verification email
 * -- never runs.
 */
const requestAccessLimiter = rateLimit({
  windowMs: REQUEST_ACCESS_LIMITER_WINDOW_MS,
  max: REQUEST_ACCESS_LIMITER_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  store: requestAccessLimiterStore
});

// ---------------------------------------------------------------------------
// Requirement 7.2: emailRequestAccessLimiter -- per-EMAIL throttling for the
// request-access/sign-up flow, backed by `EmailRateLimitService`
// (`email_rate_tracking` table). Complements the per-IP limiter above:
// `requestAccessLimiter` resets its budget for every new source IP, so an
// attacker who rotates IPs is otherwise unconstrained from flooding a
// single victim email address with verification/notification emails. This
// limiter closes that gap by tracking attempts against the SUBMITTED email
// address itself, independent of which IP submitted it.
// ---------------------------------------------------------------------------

/**
 * Requirement 7.2: factory for a per-EMAIL rate-limiting middleware. Takes
 * an async `extractEmail(req)` function so different routes can supply
 * different ways of identifying "the email this request is about" --
 * `POST /requests/initiate` carries the email directly in the body,
 * while `POST /requests/team-access` only carries a verification token
 * and must resolve it to an email first (see
 * `SignupFlowService.resolveEmailByToken`). Kept generic here rather than
 * importing `SignupFlowService` directly, so this middleware module has
 * no dependency on any one route's service layer.
 *
 * Fails OPEN on a database error (via `EmailRateLimitService`) and also
 * treats "no email could be determined for this request" as pass-through
 * -- e.g. an already-invalid/expired token resolves to no email, in which
 * case this middleware has nothing to rate-limit and the route handler's
 * own token validation produces the actual error response.
 *
 * @param {(req: import('express').Request) => Promise<string|null>} extractEmail
 * @returns {import('express').RequestHandler}
 */
function createEmailKeyedLimiter(extractEmail) {
  return async function emailKeyedLimiter(req, res, next) {
    let email;
    try {
      email = await extractEmail(req);
    } catch (error) {
      // Resolving the email itself failed (e.g. a DB error looking up a
      // token) -- fail open, consistent with EmailRateLimitService's own
      // fail-open stance; the route handler's own logic will still run
      // and surface any real problem.
      getLogger().warn({ err: error }, 'Failed to resolve email for email-keyed rate limiting; failing open');
      return next();
    }

    if (typeof email !== 'string' || email.trim().length === 0) {
      return next();
    }

    const normalizedEmail = email.trim().toLowerCase();
    const { allowed } = await EmailRateLimitService.checkAndRecordEmailAttempt(normalizedEmail);

    if (!allowed) {
      getLogger().warn({ email: normalizedEmail }, 'Email-keyed request-access rate limit exceeded');
      return res.status(429).json({
        error: 'Too many requests for this email address. Please try again later.'
      });
    }

    next();
  };
}

/**
 * Requirement 7.2: no more than 5 requests associated with a given email
 * address within a 60-minute window on `POST /api/requests/initiate`,
 * keyed off `req.body.email` directly.
 */
const emailRequestAccessLimiter = createEmailKeyedLimiter(async (req) => {
  return req.body && typeof req.body.email === 'string' ? req.body.email : null;
});

// ---------------------------------------------------------------------------
// Requirement 7.1/7.2: availableTeamsLimiter -- `GET /api/requests/
// available-teams` is the closest analog in this codebase to the
// documented "GET /api/requests/verify/:token" route (that exact path was
// never implemented; this is the actual public, token-in-query-string
// route that plays the equivalent role). Unauthenticated and reachable
// with only a token guess, so it gets the same 20/15min per-IP budget as
// the other public request-access routes.
// ---------------------------------------------------------------------------

const AVAILABLE_TEAMS_LIMITER_WINDOW_MS = 15 * 60 * 1000;
const AVAILABLE_TEAMS_LIMITER_MAX = 20;

const availableTeamsLimiterStore = new MemoryStore();

const availableTeamsLimiter = rateLimit({
  windowMs: AVAILABLE_TEAMS_LIMITER_WINDOW_MS,
  max: AVAILABLE_TEAMS_LIMITER_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  store: availableTeamsLimiterStore
});

module.exports = {
  authLimiter,
  authCallbackFailureLimiter,
  recordAuthCallbackFailure,
  requestAccessLimiter,
  createEmailKeyedLimiter,
  emailRequestAccessLimiter,
  availableTeamsLimiter,
  // Exposed for tests only, to reset in-memory counters between cases.
  authLimiterStore,
  authCallbackFailureStore,
  requestAccessLimiterStore,
  availableTeamsLimiterStore,
  AUTH_LIMITER_WINDOW_MS,
  AUTH_LIMITER_MAX,
  AUTH_CALLBACK_FAILURE_WINDOW_MS,
  AUTH_CALLBACK_FAILURE_MAX,
  REQUEST_ACCESS_LIMITER_WINDOW_MS,
  REQUEST_ACCESS_LIMITER_MAX,
  AVAILABLE_TEAMS_LIMITER_WINDOW_MS,
  AVAILABLE_TEAMS_LIMITER_MAX
};
