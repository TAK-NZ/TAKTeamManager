/**
 * Callsign character-class validation (Requirement 3: Organisation-Only TAK
 * Colour and Callsign Suffix Default Format; Requirement 11: Per-User
 * Callsign Suffix)
 *
 * Criterion 3.8 (foreign-partner-prefix extension): `callsign_prefix` is
 * accepted only if it is empty, or consists of one or more `-`-separated
 * alphanumeric SEGMENTS, each segment itself consisting exclusively of
 * letters (A-Z, case-insensitive) and digits (0-9) -- e.g. `FENZ`, or
 * `AUS-FIRE`. A leading, trailing, or doubled `-` is rejected (it would
 * create an empty segment). This intentionally widens the original
 * single-segment rule ("no `-` at all") to let a Foreign_Partner
 * Organisation's `callsign_prefix` itself carry an internal
 * `[COUNTRY]-[FUNCTION]` structure (e.g. `AUS-FIRE`) while a Sub_Team under
 * it still contributes its own segment via the existing no-separator Team
 * segment concatenation (Requirement 8 Criterion 3) and `-`-joined overall
 * assembly (Requirement 8 Criterion 5) -- unchanged, since `callsign_prefix`
 * is still just a string as far as `CallsignService.assembleCallsign` is
 * concerned; it does not care how many `-` its input already contains.
 *
 * A `-` is still the ONLY separator `callsign_prefix` may contain: this is
 * not a widening of the character class (Requirement 3.8 remains letters and
 * digits, plus this ONE punctuation character used strictly as an internal
 * segment separator), so a `callsign_prefix` value never gains `.` or any
 * other character `callsign_suffix` alone permits.
 *
 * Additionally (`managedIdentifier.js` boundary rule), no individual
 * `-`-separated segment may itself have the exact shape of a
 * Managed_Identifier's Identifier_Type_Marker + 7-character body (`D` or `U`
 * followed by exactly 7 characters from the Identifier_Alphabet, e.g.
 * `D7K3QMX`) -- see `MANAGED_IDENTIFIER_PREFIX_MARKER_CHARACTERS` below.
 * `managedIdentifier.js`'s `MANAGED_IDENTIFIER_PATTERN` locates the
 * marker+body suffix by anchoring from the RIGHT end of a Managed_Identifier
 * string (the last `-<marker><7-char-body>` run), so a `callsign_prefix`
 * segment that itself matches that exact shape would make that boundary
 * ambiguous. Rejecting it here, at the source of every `callsign_prefix`
 * value, means `managedIdentifier.js`'s right-anchored parse never needs to
 * consider that case.
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

const { AMBIGUITY_FREE_ALPHABET } = require('./identifierAlphabet');

const CALLSIGN_PREFIX_PATTERN = /^[A-Za-z0-9]+(-[A-Za-z0-9]+)*$/;
const CALLSIGN_SUFFIX_PATTERN = /^[A-Za-z0-9.-]*$/;

/**
 * The two Identifier_Type_Marker characters, duplicated here (rather than
 * imported) from `managedIdentifier.js`'s `IDENTIFIER_TYPE_MARKERS` to avoid
 * a circular require: `managedIdentifier.js` already imports
 * `isValidCallsignPrefix` from THIS module. Kept in agreement with that
 * module's `IDENTIFIER_TYPE_MARKERS` by a dedicated structural test
 * (`callsignValidation.test.js`) that imports both and asserts they match --
 * if the two ever drift, that test fails loudly rather than this rule
 * silently validating against a stale marker set.
 */
const MANAGED_IDENTIFIER_PREFIX_MARKER_CHARACTERS = 'DU';

/**
 * Matches a single `-`-separated `callsign_prefix` segment that has the
 * exact shape of a Managed_Identifier's marker+body suffix: one of
 * `MANAGED_IDENTIFIER_PREFIX_MARKER_CHARACTERS`, followed by exactly 7
 * characters from the Identifier_Alphabet. E.g. `D7K3QMX`, `U23456Z9`... any
 * `[DU]` immediately followed by exactly 7 alphabet characters, and nothing
 * else in the segment.
 */
const MANAGED_IDENTIFIER_MARKER_BODY_SEGMENT_PATTERN = new RegExp(
  `^[${MANAGED_IDENTIFIER_PREFIX_MARKER_CHARACTERS}][${AMBIGUITY_FREE_ALPHABET}]{7}$`
);

/**
 * Validates a `callsign_prefix` value per Requirement 3 Criteria 8-9
 * (extended for foreign-partner prefixes): empty, or one or more
 * `-`-separated alphanumeric segments, none of which has the exact shape of
 * a Managed_Identifier marker+body suffix.
 *
 * @param {string|null|undefined} value
 * @returns {boolean} true when `value` is empty/null/undefined, or consists
 *   of one or more non-empty alphanumeric segments separated by a single
 *   `-` each, none matching the marker+body shape.
 */
function isValidCallsignPrefix(value) {
  if (value === null || value === undefined || value === '') {
    return true;
  }
  if (!CALLSIGN_PREFIX_PATTERN.test(value)) {
    return false;
  }
  const segments = value.split('-');
  return segments.every(
    (segment) => !MANAGED_IDENTIFIER_MARKER_BODY_SEGMENT_PATTERN.test(segment)
  );
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

module.exports = {
  isValidCallsignPrefix,
  isValidCallsignSuffix,
  MANAGED_IDENTIFIER_PREFIX_MARKER_CHARACTERS
};
