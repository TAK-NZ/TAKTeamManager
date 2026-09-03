/**
 * Resiliency-hardening: a thin wrapper around the native `fetch` that
 * always attaches a bounded `signal` (via `AbortSignal.timeout`), so a
 * hung/slow Authentik connection can never leave a caller waiting
 * indefinitely.
 *
 * Before this module existed, every direct Authentik call in this
 * codebase that used raw `fetch` (as opposed to the `axios` instances in
 * `server/services/authentik.js`/`TakServerService.js`) had NO timeout
 * at all -- unlike native `axios`, native `fetch` never times out on its
 * own. Several of these call sites run inside a SYNCHRONOUS
 * request-handler flow (e.g. `POST /api/users`'s user-creation path in
 * `server/routes/users.js`), so a hung connection there hangs the
 * client's actual HTTP request, not just a background job.
 *
 * `DEFAULT_FETCH_TIMEOUT_MS` (10000ms) matches the timeout already used
 * for the axios-based Authentik/Authentik-OAuth2 calls elsewhere in this
 * codebase (`server/routes/auth.js`, `server/middleware/captcha.js`), so
 * this is a consistency fix, not a new, arbitrary threshold.
 *
 * `AbortSignal.timeout(ms)` (available natively since Node 17.3/18.0,
 * and this repo's Dockerfile targets `node:24-alpine`) creates a signal
 * that fires automatically after `ms` milliseconds, with no manual
 * `setTimeout`/`clearTimeout` bookkeeping needed -- `fetch` itself
 * rejects with an `AbortError`-shaped `DOMException` once the signal
 * fires.
 *
 * Usage: replace `fetch(url, options)` with
 * `fetchWithTimeout(url, options)`. `options.signal`, if the caller
 * already supplied one (no current call site in this codebase does),
 * is preserved by combining both signals via `AbortSignal.any` so a
 * caller-supplied abort reason and this timeout can coexist; otherwise
 * the timeout signal is used directly.
 */

const DEFAULT_FETCH_TIMEOUT_MS = 10000;

/**
 * @param {string} url
 * @param {RequestInit} [options]
 * @param {number} [timeoutMs] defaults to `DEFAULT_FETCH_TIMEOUT_MS`.
 * @returns {Promise<Response>}
 */
function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_FETCH_TIMEOUT_MS) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeoutSignal])
    : timeoutSignal;

  return fetch(url, { ...options, signal });
}

module.exports = { fetchWithTimeout, DEFAULT_FETCH_TIMEOUT_MS };
