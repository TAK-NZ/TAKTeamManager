/**
 * Google reCAPTCHA v3 verification middleware (Requirement 7.3/7.4:
 * bot-mitigation challenge on `POST /api/requests/team-access`).
 *
 * `verifyCaptcha` is mounted directly in front of
 * `POST /api/requests/team-access`'s handler chain in
 * `server/routes/requests.js`. Unlike v2 (a checkbox/invisible widget
 * that only reports pass/fail), reCAPTCHA v3 runs invisibly and returns a
 * risk `score` (0.0 = likely bot, 1.0 = likely human) alongside
 * `success`/`action` -- there is no user-facing challenge to fail, so
 * this middleware enforces a minimum score threshold itself.
 *
 * It:
 *
 *  - reads the reCAPTCHA v3 token from
 *    `req.body['g-recaptcha-response']` (the field name the client-side
 *    reCAPTCHA v3 `grecaptcha.execute()` call conventionally submits the
 *    generated token under); wiring up the actual client-side script is
 *    out of scope for this backend-only task;
 *  - IF the token is missing, rejects immediately with HTTP 400 WITHOUT
 *    calling reCAPTCHA's verify API at all (Requirement 7.4's "missing...
 *    challenge" case);
 *  - otherwise calls Google reCAPTCHA's `siteverify` endpoint
 *    (`https://www.google.com/recaptcha/api/siteverify`) with `secret`
 *    (from `process.env.RECAPTCHA_SECRET`) and `response` (the submitted
 *    token) as form-encoded params, using the same `axios` + 10000ms
 *    timeout convention already used for outbound HTTP calls elsewhere in
 *    this codebase (see `server/routes/auth.js`'s token-exchange/userinfo
 *    calls);
 *  - IF the verify call's `success` field is false, OR the returned
 *    `action` does not match `RECAPTCHA_EXPECTED_ACTION` (v3's anti-replay
 *    mechanism -- a token generated for a different action on the page
 *    must not be accepted here), OR the returned `score` is below
 *    `RECAPTCHA_MIN_SCORE` (env-configurable, default 0.5 -- Google's own
 *    documented default threshold), OR the call itself throws/times out,
 *    rejects with HTTP 400 (a slow/unreachable reCAPTCHA API is treated
 *    as a failed challenge, not an unhandled error, so the request never
 *    hangs indefinitely);
 *  - IF every check above passes, calls `next()`.
 *
 * Because this middleware runs before the route's express-validator chain
 * and before `emailWindowLimiter` (see the ordering comment in
 * `server/routes/requests.js`), a missing/invalid/low-score token is
 * rejected before any `access_requests` row is inserted or verification
 * email is sent, satisfying Requirement 7.4's "SHALL NOT create an
 * Access_Request row or send a verification email".
 */

const axios = require('axios');
const { getLogger } = require('./requestContext');

const RECAPTCHA_VERIFY_URL = 'https://www.google.com/recaptcha/api/siteverify';
const RECAPTCHA_VERIFY_TIMEOUT_MS = 10000;

// The `action` name the client-side `grecaptcha.execute(siteKey, {action})`
// call must have used when generating a token for this endpoint. reCAPTCHA
// v3 returns this back in the verify response so a token minted for an
// unrelated action elsewhere on the site can't be replayed here.
const RECAPTCHA_EXPECTED_ACTION = 'team_access_request';

// Google's own documented default score threshold (score >= 0.5 is
// treated as likely human) is used as the default here, overridable via
// RECAPTCHA_MIN_SCORE for environments that want a stricter/looser bar.
// An out-of-range or non-numeric override falls back to the default
// rather than silently disabling the check.
const DEFAULT_MIN_SCORE = 0.5;

function getMinScore() {
  const raw = parseFloat(process.env.RECAPTCHA_MIN_SCORE);
  if (Number.isNaN(raw) || raw < 0 || raw > 1) {
    return DEFAULT_MIN_SCORE;
  }
  return raw;
}

/**
 * Express middleware verifying the reCAPTCHA v3 response token submitted
 * on `req.body['g-recaptcha-response']` against Google's verify API,
 * enforcing both the expected `action` and a minimum risk `score`.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
async function verifyCaptcha(req, res, next) {
  const token = req.body && req.body['g-recaptcha-response'];

  // Requirement 7.4: a missing token is rejected immediately, without
  // calling the reCAPTCHA verify API at all.
  if (!token || typeof token !== 'string' || token.trim().length === 0) {
    return res.status(400).json({ error: 'CAPTCHA challenge is required' });
  }

  try {
    const verifyResponse = await axios.post(
      RECAPTCHA_VERIFY_URL,
      new URLSearchParams({
        secret: process.env.RECAPTCHA_SECRET,
        response: token
      }),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        timeout: RECAPTCHA_VERIFY_TIMEOUT_MS
      }
    );

    const result = verifyResponse.data;

    if (!result || result.success !== true) {
      return res.status(400).json({ error: 'CAPTCHA verification failed' });
    }

    if (result.action !== RECAPTCHA_EXPECTED_ACTION) {
      getLogger().warn(
        { expected: RECAPTCHA_EXPECTED_ACTION, actual: result.action },
        'reCAPTCHA action mismatch'
      );
      return res.status(400).json({ error: 'CAPTCHA verification failed' });
    }

    const minScore = getMinScore();
    if (typeof result.score !== 'number' || result.score < minScore) {
      getLogger().warn({ score: result.score, minScore }, 'reCAPTCHA score below threshold');
      return res.status(400).json({ error: 'CAPTCHA verification failed' });
    }

    return next();
  } catch (error) {
    // A failed, unreachable, or timed-out verify call is treated as a
    // failed challenge (Requirement 7.4), not as an unhandled error -- the
    // request never hangs indefinitely waiting on reCAPTCHA's API.
    getLogger().error({ err: error.response?.data || error.message }, 'reCAPTCHA verification error');
    return res.status(400).json({ error: 'CAPTCHA verification failed' });
  }
}

module.exports = { verifyCaptcha, RECAPTCHA_EXPECTED_ACTION, DEFAULT_MIN_SCORE, getMinScore };
