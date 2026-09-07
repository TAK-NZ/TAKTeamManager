// Post-login return path.
//
// When an unauthenticated visitor lands on a deep link -- e.g. the Downloads
// QR encodes `${APP_URL}/downloads` and a phone scans it -- the app fires the
// OAuth2 login (`authAPI.login()`), Authentik authenticates, and the server
// callback redirects to a FIXED `${FRONTEND_URL}/dashboard` (it has no idea
// where the user was headed). So the visitor asked for /downloads and lands on
// /dashboard.
//
// Fixing this on the server would mean threading the intended path through the
// OAuth2 `state`/`redirect_uri`, both of which Authentik validates strictly --
// fragile and unnecessary. Instead this is a purely client-side round-trip:
// capture the intended path in `sessionStorage` at the moment we redirect to
// login, then, once a session is established, read it back and navigate there.
//
// sessionStorage (not localStorage) is deliberate -- the intent belongs to
// THIS tab's login round-trip and should evaporate when the tab closes, never
// resurface on an unrelated future visit. Every access is wrapped so a
// storage-blocked context ("Access to storage is not allowed from this
// context") degrades to "no stored path" rather than throwing on the login
// path.

export const RETURN_PATH_KEY = 'tak_post_login_return_path'

// Paths we must never send a freshly-authenticated user back to. `/login` and
// the OAuth API routes would loop or dead-end; `/dashboard` is the default
// landing anyway, so storing it buys nothing. `/request-access` is the public,
// anonymous-only page -- a signed-in user has no reason to be returned there.
const NON_RETURNABLE_PREFIXES = ['/login', '/api/', '/dashboard', '/request-access']

/**
 * Whether `path` is a safe in-app destination to return a user to after login.
 * Requires a same-origin ABSOLUTE path (leading `/`, but not `//` which is a
 * protocol-relative URL to another host) that is not one of the
 * non-returnable routes above. This is the guard against an open-redirect: a
 * captured value is only ever a location the app itself set, but validating on
 * the way out too means a tampered sessionStorage value can never send the
 * browser off-origin.
 *
 * @param {*} path
 * @returns {boolean}
 */
export function isReturnablePath(path) {
  if (typeof path !== 'string' || path.length === 0) return false
  // Must be an app-absolute path, and NOT protocol-relative (`//evil.com`).
  if (path[0] !== '/' || path[1] === '/') return false
  // No control over a backslash-based host trick either.
  if (path.includes('\\')) return false
  return !NON_RETURNABLE_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`) || path.startsWith(`${prefix}?`)
  )
}

/**
 * Records where the user currently is, so we can return them here after login.
 * A no-op (rather than storing) when the current location is not a returnable
 * destination, so we never stash `/dashboard`, `/login`, etc. Silent on any
 * storage error.
 *
 * @param {string} path the current in-app path (e.g. `location.pathname + location.search`)
 * @param {Storage} [storage=window.sessionStorage] injectable for testing
 */
export function captureReturnPath(
  path,
  storage = typeof window !== 'undefined' ? window.sessionStorage : undefined
) {
  if (!storage || !isReturnablePath(path)) return
  try {
    storage.setItem(RETURN_PATH_KEY, path)
  } catch {
    // Storage blocked -- the user simply lands on the default page after login.
  }
}

/**
 * Reads and CLEARS the stored return path, returning it only if it is still a
 * safe, returnable destination (re-validated on the way out, so a tampered
 * value can't cause an off-origin or loop redirect). Returns `null` when there
 * is nothing to return to. Always clears the key (even on a rejected value) so
 * a stale intent never re-fires on a later navigation.
 *
 * @param {Storage} [storage=window.sessionStorage] injectable for testing
 * @returns {string|null} the path to navigate to, or null
 */
export function consumeReturnPath(
  storage = typeof window !== 'undefined' ? window.sessionStorage : undefined
) {
  if (!storage) return null
  let stored = null
  try {
    stored = storage.getItem(RETURN_PATH_KEY)
    storage.removeItem(RETURN_PATH_KEY)
  } catch {
    return null
  }
  return isReturnablePath(stored) ? stored : null
}
