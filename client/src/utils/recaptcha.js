/**
 * Google reCAPTCHA v3 client-side helper.
 *
 * reCAPTCHA v3 has no visible widget to render -- the site key is only
 * known at runtime (fetched from GET /api/config/public's
 * `recaptcha_site_key` field, see server/models/SiteConfig.js), so
 * Google's script cannot be statically included in index.html the way a
 * fixed-site-key integration normally would be. This module loads the
 * script dynamically, once, given a site key, then exposes a helper to
 * generate a token for a specific action via `grecaptcha.execute()`.
 *
 * The `action` string passed to `getRecaptchaToken` MUST exactly match
 * `RECAPTCHA_EXPECTED_ACTION` in server/middleware/captcha.js -- reCAPTCHA
 * v3 tokens are scoped to the action they were generated for, and the
 * server verifies the returned action matches before accepting a token.
 */

let loadPromise = null

/**
 * Loads Google's reCAPTCHA v3 script for the given site key, if it has
 * not already been loaded. Safe to call multiple times -- subsequent
 * calls return the same in-flight/resolved promise rather than injecting
 * the script tag again.
 *
 * @param {string} siteKey
 * @returns {Promise<void>}
 */
export function loadRecaptchaScript(siteKey) {
  if (!siteKey) {
    return Promise.reject(new Error('loadRecaptchaScript requires a site key'))
  }

  if (loadPromise) {
    return loadPromise
  }

  loadPromise = new Promise((resolve, reject) => {
    if (window.grecaptcha) {
      resolve()
      return
    }

    const script = document.createElement('script')
    script.src = `https://www.google.com/recaptcha/api.js?render=${encodeURIComponent(siteKey)}`
    script.async = true
    script.defer = true
    script.onload = () => resolve()
    script.onerror = () => reject(new Error('Failed to load reCAPTCHA script'))
    document.head.appendChild(script)
  })

  return loadPromise
}

/**
 * Generates a reCAPTCHA v3 token for the given site key and action,
 * loading the script first if it has not been loaded yet.
 *
 * @param {string} siteKey
 * @param {string} action - must match RECAPTCHA_EXPECTED_ACTION on the
 *   server for the endpoint this token will be submitted to.
 * @returns {Promise<string>} the generated token, to be submitted as
 *   `g-recaptcha-response` in the request body.
 */
export async function getRecaptchaToken(siteKey, action) {
  await loadRecaptchaScript(siteKey)

  return new Promise((resolve, reject) => {
    window.grecaptcha.ready(() => {
      window.grecaptcha
        .execute(siteKey, { action })
        .then(resolve)
        .catch(reject)
    })
  })
}
