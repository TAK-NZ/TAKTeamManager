/**
 * Pure helper: which user primary keys does an Authentik (Django REST
 * framework) validation error say do not exist?
 *
 * A group PATCH `{ users: [...] }` that names a user Authentik no longer has
 * is answered with HTTP 400 and a body like
 *
 *   { "users": ["Invalid pk \"474\" - object does not exist."] }
 *
 * The whole PATCH is rejected and nothing is written, so a caller can safely
 * drop exactly those pks and try again. This function only EXTRACTS the pks;
 * it is deliberately strict so that anything it does not recognise yields an
 * empty list (and the caller then fails exactly as it did before):
 *   - the message must be DRF's own "Invalid pk "<digits>" - object does not
 *     exist." wording, and sit under the `users` key;
 *   - any other error under `users` (wrong type, "Invalid pk" with some other
 *     reason, a permission message) or under another key is ignored;
 *   - the pk must be a non-negative integer written as digits only.
 *
 * Kept free of framework and database imports so it can be tested directly.
 *
 * @param {unknown} body  the parsed JSON response body (any shape).
 * @returns {number[]} the distinct pks reported as non-existent, in order.
 */
const MISSING_PK_MESSAGE = /^Invalid pk "(\d{1,15})" - object does not exist\.$/;

function flattenStrings(value, out, depth = 0) {
  if (depth > 3) return;
  if (typeof value === 'string') {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const v of value) flattenStrings(v, out, depth + 1);
  } else if (value && typeof value === 'object') {
    for (const v of Object.values(value)) flattenStrings(v, out, depth + 1);
  }
}

function extractMissingUserPks(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return [];
  if (!Object.prototype.hasOwnProperty.call(body, 'users')) return [];
  const messages = [];
  flattenStrings(body.users, messages);
  const pks = [];
  for (const message of messages) {
    const match = MISSING_PK_MESSAGE.exec(message);
    if (!match) continue;
    const pk = Number(match[1]);
    if (Number.isSafeInteger(pk) && !pks.includes(pk)) pks.push(pk);
  }
  return pks;
}

module.exports = { extractMissingUserPks };
