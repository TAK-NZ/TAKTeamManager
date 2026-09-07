// Auto-login loop breaker.
//
// With FORCE_SSO_LOGIN (server/config/forceSso.js) enabled -- or when the
// visitor arrives with an Authentik-origin referrer -- App.jsx auto-fires
// `authAPI.login()` on any unauthenticated mount, without waiting for a
// manual "Sign in" click. That is normally one redirect to Authentik and
// back. But if the round-trip never establishes a usable `tak_session`
// cookie (a failed token exchange, an unsynced user, a cookie the browser
// declines to store/return, an Authentik session that bounces straight
// back), the app lands unauthenticated again and auto-fires ANOTHER
// redirect -- an endless loop. Every hop is a request against the per-IP
// `/api/auth/*` limiter (20/15min, server/middleware/rateLimiters.js), so
// the loop silently burns the whole budget and the visitor ends on a bare
// 429 with no way forward.
//
// The `?error=` guard in App.jsx catches the loop variant where the
// callback redirects to `${FRONTEND_URL}?error=...`, but NOT the variant
// where each callback "succeeds" (or Authentik bounces back) yet no session
// cookie is ever presented on the next request -- that loop carries no
// `?error=` to key off. This module closes that gap by counting the
// auto-login attempts themselves, in `sessionStorage`, within a short
// window: once too many fire in too little time, we stop auto-firing and
// let App.jsx render the manual Login page instead, so the visitor sees a
// "Sign in" button they control rather than an infinite redirect.
//
// sessionStorage (not localStorage) is deliberate: the counter should live
// for the duration of the tab/loop and evaporate when the tab closes, not
// persist across unrelated future visits. All access is wrapped in
// try/catch -- some embedded/privacy contexts throw on storage access
// ("Access to storage is not allowed from this context"), and a storage
// failure must fail OPEN (behave as "not looping") so it can never itself
// block a legitimate first login.

export const AUTO_LOGIN_ATTEMPTS_KEY = 'tak_auto_login_attempts'

// Break the loop once this many auto-login attempts occur within
// AUTO_LOGIN_WINDOW_MS. Set above a legitimate single redirect (1) with
// headroom for a stray double-mount (React StrictMode mounts effects twice
// in development) or one genuine retry, but well below the 20-request
// per-IP auth limiter so the breaker trips long before the 429 does.
export const AUTO_LOGIN_MAX_ATTEMPTS = 3

// Attempts older than this are discarded before counting, so a slow,
// legitimate re-login hours apart never accumulates toward the threshold --
// only a tight redirect loop does.
export const AUTO_LOGIN_WINDOW_MS = 30 * 1000

function readAttempts(storage, now) {
  try {
    const raw = storage.getItem(AUTO_LOGIN_ATTEMPTS_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    // Keep only numeric timestamps still inside the active window.
    return parsed.filter(
      (t) => typeof t === 'number' && Number.isFinite(t) && now - t < AUTO_LOGIN_WINDOW_MS
    )
  } catch {
    // Unreadable/unparseable/blocked storage -> treat as no history.
    return []
  }
}

/**
 * Records one auto-login attempt at `now` and returns whether the recent
 * attempt count (this one included) has reached AUTO_LOGIN_MAX_ATTEMPTS
 * within AUTO_LOGIN_WINDOW_MS -- i.e. whether the caller should STOP
 * auto-firing `authAPI.login()` and show the manual Login page instead.
 *
 * Fails OPEN on any storage error: if attempts cannot be persisted, returns
 * false so a legitimate first login is never blocked by a broken/blocked
 * storage context. The trade-off is that a loop in a storage-less context
 * is still bounded by the server-side per-IP limiter rather than by this
 * breaker -- acceptable, since the breaker is an early, friendlier stop, not
 * the only one.
 *
 * @param {Storage} [storage=window.sessionStorage] injectable for testing
 * @param {number}  [now=Date.now()]                injectable for testing
 * @returns {boolean} true iff the caller should suppress auto-login
 */
export function recordAutoLoginAttemptAndCheckLoop(
  storage = typeof window !== 'undefined' ? window.sessionStorage : undefined,
  now = Date.now()
) {
  if (!storage) return false

  const recent = readAttempts(storage, now)
  recent.push(now)

  try {
    storage.setItem(AUTO_LOGIN_ATTEMPTS_KEY, JSON.stringify(recent))
  } catch {
    // Could not persist -> fail open. We cannot reliably detect a loop
    // without a place to count, so do not block this attempt.
    return false
  }

  return recent.length >= AUTO_LOGIN_MAX_ATTEMPTS
}

/**
 * Clears the auto-login attempt counter. Called once a session is
 * successfully established (App.jsx's getProfile() success branch), so a
 * later, unrelated logout->login does not start already part-way to the
 * threshold. Silent no-op on any storage error.
 *
 * @param {Storage} [storage=window.sessionStorage] injectable for testing
 */
export function clearAutoLoginAttempts(
  storage = typeof window !== 'undefined' ? window.sessionStorage : undefined
) {
  if (!storage) return
  try {
    storage.removeItem(AUTO_LOGIN_ATTEMPTS_KEY)
  } catch {
    // Nothing to do -- a counter we cannot clear will age out of its window
    // on its own.
  }
}
