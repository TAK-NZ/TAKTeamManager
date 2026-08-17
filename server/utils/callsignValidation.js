/**
 * Callsign character-class validation (Requirement 3: Organisation-Only TAK
 * Colour and Callsign Suffix Default Format; Requirement 11: Per-User
 * Callsign Suffix)
 *
 * Criterion 3.8: `callsign_prefix` is accepted only if it is empty, or
 * consists exclusively of letters (A-Z, case-insensitive) and digits (0-9).
 * The `-` character is deliberately NOT permitted in a `callsign_prefix`
 * value, since it participates in the Team segment's no-separator
 * concatenation (Requirement 8 Criterion 3) and, at Team_Depth 0, in the
 * `-`-joined segment assembly (Requirement 8 Criterion 5) -- a `-` embedded
 * inside a `callsign_prefix` value would be visually indistinguishable from
 * an intended segment boundary.
 *
 * Criterion 11.3: `callsign_suffix` is accepted only if it is empty, or
 * consists exclusively of letters, digits, the `-` character, and the `.`
 * character. This is deliberately broader than `callsign_prefix`: a
 * `callsign_suffix` value occupies the Name segment, the LAST segment in
 * callsign assembly, with nothing after it to be confused with.
 *
 * Both functions are pure (no I/O) and treat an empty, `null`, or
 * `undefined` value as valid, matching the existing convention elsewhere in
 * this codebase of allowing an optional field to be genuinely absent while
 * still restricting whatever non-empty value IS supplied.
 */

const CALLSIGN_PREFIX_PATTERN = /^[A-Za-z0-9]*$/;
const CALLSIGN_SUFFIX_PATTERN = /^[A-Za-z0-9.-]*$/;

/**
 * Validates a `callsign_prefix` value per Requirement 3 Criteria 8-9:
 * letters and digits only, no `-`.
 *
 * @param {string|null|undefined} value
 * @returns {boolean} true when `value` is empty/null/undefined, or consists
 *   exclusively of letters and digits.
 */
function isValidCallsignPrefix(value) {
  if (value === null || value === undefined || value === '') {
    return true;
  }
  return CALLSIGN_PREFIX_PATTERN.test(value);
}

/**
 * Validates a `callsign_suffix` value per Requirement 11 Criterion 3:
 * letters, digits, `-`, and `.` only.
 *
 * @param {string|null|undefined} value
 * @returns {boolean} true when `value` is empty/null/undefined, or consists
 *   exclusively of letters, digits, `-`, and `.`.
 */
function isValidCallsignSuffix(value) {
  if (value === null || value === undefined || value === '') {
    return true;
  }
  return CALLSIGN_SUFFIX_PATTERN.test(value);
}

module.exports = { isValidCallsignPrefix, isValidCallsignSuffix };
