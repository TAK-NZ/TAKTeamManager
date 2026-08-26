/**
 * Empty_String_Email normalisation (takserver-enrollment Requirement 5.5).
 *
 * Authentik was verified to store a user created with the `email` key
 * ABSENT from the request body as the EMPTY STRING `""`, not as `null`.
 * `server/services/authentikSync.js` binds this normaliser's result to both
 * the `users` and the `user_cache` upserts so that "no email" is the same
 * value -- `NULL` -- on both tables, rather than `NULL` on one and `''` on
 * the other for the same principal.
 *
 * TOTAL and PURE: never throws, reads no global, and returns the same
 * result for the same argument every time. Never returns `''`: a
 * whitespace-only string carries exactly as much "absent" information as
 * `''` does, so it is trimmed to `null` too -- a deliberate SUPERSET of the
 * literal requirement (Criterion 5.5 only names `''` and whitespace-only
 * strings explicitly, but no predicate in this codebase treats a
 * whitespace-only value as a real address, so admitting it as non-null
 * would be admitting a value nothing treats as present).
 *
 * Lives in `server/utils/` with no framework import, beside
 * `callsignValidation.js` and `connectionAlias.js`, so a property test can
 * call it directly with no database and no server bootstrap.
 */

/**
 * Normalises a value read from Authentik's `email` field to either `null`
 * (absent) or a non-empty, trimmed string (present).
 *
 * @param {*} value the raw value, as read from an Authentik API response.
 *   May legitimately be `''`, and may be anything else a hostile or
 *   malformed upstream response could carry.
 * @returns {string|null} `null` for `null`, `undefined`, a non-string, `''`
 *   and any whitespace-only string; otherwise the trimmed string.
 */
function normaliseAuthentikEmail(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

module.exports = { normaliseAuthentikEmail };
