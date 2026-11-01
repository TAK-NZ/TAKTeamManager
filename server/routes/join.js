const express = require('express');
const SignupCodeService = require('../services/SignupCodeService');

const router = express.Router();

/**
 * Short, human-typeable sign-up link: GET /join/:code redirects to the
 * canonical `/request-access?code=<code>` page.
 *
 * The canonical URL is already in circulation (printed QR codes, shared
 * links) and keeps working unchanged; this is purely a shorter alias for
 * anything a person has to read out or type.
 *
 * Public by design (listed in `server/config/publicRoutes.js`): the sign-up
 * page is for anonymous visitors. The handler does no database lookup, so it
 * cannot be used to probe which codes exist -- the code is checked for format
 * only, and the real validation happens when the visitor submits the form.
 *
 * The redirect target is a fixed relative path plus a code that has passed the
 * format check (so it can only contain Identifier_Alphabet characters). Nothing
 * from the request, including the Host header, is reflected into `Location`,
 * which rules out an open redirect. A malformed code still lands on the
 * sign-up page, just without a pre-filled code.
 *
 * The code is accepted case-insensitively with an optional dash after the
 * fourth character (`4kp7-nxrm`), matching what a person would type from the
 * formatted display.
 *
 * 302 rather than 301 so browsers do not cache the redirect permanently.
 */
router.get('/:code', (req, res) => {
  const code = String(req.params.code).toUpperCase();

  if (!SignupCodeService.isValidCodeFormat(code)) {
    return res.redirect(302, '/request-access');
  }

  const normalized = code.replace(/-/g, '');
  return res.redirect(302, `/request-access?code=${encodeURIComponent(normalized)}`);
});

module.exports = router;
