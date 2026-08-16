/**
 * Shared field-sanitization validator chain factory (Requirement 5.7).
 *
 * `textField(maxLen = 1000)` returns an express-validator chain factory
 * for a given field name: `body(field).trim().escape().isLength({ max: maxLen })`.
 * This gives every user-supplied/publicly-submitted text field (including
 * the unauthenticated `POST /api/requests/team-access` endpoint) the same
 * baseline sanitization — trimmed whitespace, HTML-escaped output (safe if
 * later rendered as HTML), and a maximum length, defaulting to 1000
 * characters per Requirement 5.7, overridable per-field when a stricter
 * limit applies (e.g. `textField(100)('name')`).
 *
 * Usage (curried factory, matching design.md's
 * `textField(maxLen = 1000)` = `body(field).trim().escape().isLength({ max: maxLen })`
 * shape, where `maxLen` is bound first and `field` is supplied at the call
 * site):
 *
 *   const { textField } = require('../middleware/validators');
 *
 *   router.post('/team-access', [
 *     textField()('firstName'),        // default max length of 1000
 *     textField(100)('lastName'),      // stricter 100-char limit
 *   ], async (req, res) => { ... });
 *
 * Validation failures are surfaced via express-validator's existing
 * `validationResult(req)` mechanism at the route level (already used
 * throughout `server/routes/`); nothing about that flow changes here —
 * this module only centralizes the chain construction itself so every
 * call site applies the same trim/escape/max-length rules instead of
 * hand-rolling its own `body(field).trim()...` chain (Requirement 5.7's
 * "consistent" sanitization).
 *
 * This module intentionally creates ONLY the shared chain factory; it does
 * not itself apply `textField` to any route (that is a separate task).
 */

const { body } = require('express-validator');

/**
 * Returns a function that, given a field name, produces an
 * express-validator chain for a plain user-supplied/publicly-submitted
 * text field: trims whitespace, HTML-escapes the value, and enforces a
 * maximum length.
 *
 * @param {number} [maxLen=1000] - Maximum allowed length for the field,
 *   per Requirement 5.7 (default 1000 characters unless a stricter limit
 *   is defined for that field).
 * @returns {(field: string) => import('express-validator').ValidationChain}
 *   A function taking a field name and returning the configured
 *   express-validator chain for that field.
 */
function textField(maxLen = 1000) {
  return (field) => body(field).trim().escape().isLength({ max: maxLen });
}

module.exports = { textField };
