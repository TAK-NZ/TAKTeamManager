/**
 * The pure Managed_Identifier generator (takserver-enrollment Requirement 1).
 *
 * A Managed_Identifier has the shape `<organisationPrefix>-<typeMarker><body>`:
 * an Organisation_Prefix, the Managed_Identifier separator `-`, a single
 * Identifier_Type_Marker character, and a seven-character body drawn from the
 * Identifier_Alphabet. Example: `AUK-D7K3QMX`.
 *
 * Foreign-partner-prefix extension: `organisationPrefix` may itself contain
 * internal `-` separators (e.g. `AUS-FIRE`, validated by
 * `callsignValidation.js`'s `isValidCallsignPrefix`), producing an identifier
 * like `AUS-FIRE-D7K3QMX`. This stays unambiguous because
 * `isValidCallsignPrefix` independently rejects any `-`-separated
 * `organisationPrefix` segment that itself has the exact marker+body shape
 * (`[DU]` followed by exactly 7 Identifier_Alphabet characters) -- so the
 * FINAL `-<marker><7-char-body>` run in a Managed_Identifier string is always
 * the real one, never a coincidental prefix segment. `MANAGED_IDENTIFIER_PATTERN`
 * below matches the prefix as one-or-more `-`-joined alphanumeric segments
 * for this reason.
 *
 * This module imports `crypto`, `./identifierAlphabet` and
 * `./callsignValidation` ONLY -- no framework, no database -- so a property
 * test can load it bare (takserver-enrollment Criterion 1.5). All three are
 * themselves free of framework/database imports:
 * `server/utils/callsignValidation.js` has no requires of its own, so pulling
 * it in does not add anything to the require graph that Criterion 1.5
 * forbids; it is imported specifically so this module does NOT write a
 * second Organisation_Prefix regex (takserver-enrollment Criterion 2.5).
 */

const crypto = require('crypto');
const {
  AMBIGUITY_FREE_ALPHABET,
  AMBIGUITY_FREE_ALPHABET_LENGTH
} = require('./identifierAlphabet');
const { isValidCallsignPrefix } = require('./callsignValidation');

/** Length of a Managed_Identifier's body, in characters (Criterion 1.1). */
const IDENTIFIER_BODY_LENGTH = 7;

/** The separator between the Organisation_Prefix and the Identifier_Type_Marker. */
const IDENTIFIER_SEPARATOR = '-';

/**
 * The two Identifier_Type_Markers (Criterion 1.3). `D` for a
 * Team_Owned_Device, `U` for a Human_Principal (a Pseudonymous_Username).
 * Frozen so a caller cannot mutate the set of valid markers.
 */
const IDENTIFIER_TYPE_MARKERS = Object.freeze({ DEVICE: 'D', USER: 'U' });

const VALID_TYPE_MARKERS = Object.freeze(Object.values(IDENTIFIER_TYPE_MARKERS));

// Built from the imported alphabet and marker set rather than re-typed, so
// the alphabet literal continues to appear in exactly one non-test module
// (identifierAlphabet.js) per the structural guard (Criterion 1.4).
//
// The prefix group, `[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*`, matches one or more
// `-`-joined alphanumeric segments (the foreign-partner-prefix extension --
// see this file's header comment), rather than a single hyphen-free run.
// Regex alternation is greedy left-to-right but backtracks, so this pattern
// still anchors correctly on the FINAL `-<marker><7-char-body>` run even
// when the prefix itself contains `-`: `isValidCallsignPrefix` guarantees no
// earlier segment can match `[DU][alphabet]{7}` exactly, so there is only
// ever one place in the string this suffix can match.
const MANAGED_IDENTIFIER_PATTERN = new RegExp(
  `^[A-Za-z0-9]+(?:${escapeForCharClass(IDENTIFIER_SEPARATOR)}[A-Za-z0-9]+)*${escapeForCharClass(IDENTIFIER_SEPARATOR)}[${VALID_TYPE_MARKERS.join('')}][${AMBIGUITY_FREE_ALPHABET}]{${IDENTIFIER_BODY_LENGTH}}$`
);

/**
 * Escapes a single character for safe use inside a `[...]` regex character
 * class. `IDENTIFIER_SEPARATOR` is `-`, which is a range operator inside a
 * character class, so it must be escaped there even though it is used
 * literally (not inside a class) everywhere else in this module.
 *
 * @param {string} char
 * @returns {string}
 */
function escapeForCharClass(char) {
  return char.replace(/[-[\]\\^]/g, '\\$&');
}

/**
 * Generates a Managed_Identifier body: exactly `IDENTIFIER_BODY_LENGTH`
 * characters, each drawn by calling `randomInt(AMBIGUITY_FREE_ALPHABET_LENGTH)`
 * -- i.e. `randomInt(31)`, with no second argument -- and using the result as
 * a DIRECT INDEX into the Identifier_Alphabet. No modulo, no `randomBytes`, no
 * `Math.random` (Criterion 1.10).
 *
 * `randomInt` is injected with a default of `crypto.randomInt` rather than
 * reached through this module's own `crypto` import internally, so a
 * property test can drive the generator over a chosen index sequence
 * (Property 2).
 *
 * @param {(max: number) => number} [randomInt] defaults to `crypto.randomInt`
 * @returns {string} exactly `IDENTIFIER_BODY_LENGTH` characters
 */
function generateIdentifierBody(randomInt = crypto.randomInt) {
  let body = '';
  for (let i = 0; i < IDENTIFIER_BODY_LENGTH; i += 1) {
    const index = randomInt(AMBIGUITY_FREE_ALPHABET_LENGTH);
    body += AMBIGUITY_FREE_ALPHABET[index];
  }
  return body;
}

/**
 * Generates a Managed_Identifier: `<organisationPrefix>-<typeMarker><body>`.
 *
 * One generator serves BOTH Identifier_Type_Markers via the `typeMarker`
 * parameter (Criterion 1.4) -- there is deliberately no second generator.
 *
 * Total on the random source; deliberately NOT total on its configuration
 * arguments (Criterion 2.9): an `organisationPrefix` that is absent, empty,
 * or fails `isValidCallsignPrefix` (which, per the foreign-partner-prefix
 * extension, now also rejects a `-`-separated segment shaped like a
 * marker+body suffix) is a caller defect and throws a `TypeError` naming the
 * offending value, and the same is true for a `typeMarker` that is not one
 * of `IDENTIFIER_TYPE_MARKERS`' values. `organisationPrefix` is validated
 * with the existing `isValidCallsignPrefix` (Criterion 2.5) rather than a
 * second regex -- that function alone treats an empty/null/undefined value
 * as VALID (it exists to validate an optional field), so emptiness is
 * checked separately here, since a Managed_Identifier always needs a real
 * prefix.
 *
 * No runtime cross-type collision check is performed, deliberately
 * (Criterion 1.6): the Identifier_Type_Marker occupies the fixed index
 * `organisationPrefix.length + 1`, so a `D` identifier and a `U` identifier
 * for one prefix differ at that index for every possible pair of bodies, and
 * a check that can never fire is a check nobody maintains.
 *
 * @param {string} organisationPrefix
 * @param {string} typeMarker one of `IDENTIFIER_TYPE_MARKERS`'s values
 * @param {(max: number) => number} [randomInt] defaults to `crypto.randomInt`
 * @returns {string}
 * @throws {TypeError} for an invalid `organisationPrefix` or `typeMarker`
 */
function generateManagedIdentifier(organisationPrefix, typeMarker, randomInt = crypto.randomInt) {
  if (
    typeof organisationPrefix !== 'string' ||
    organisationPrefix.length === 0 ||
    !isValidCallsignPrefix(organisationPrefix)
  ) {
    throw new TypeError(
      `generateManagedIdentifier: organisationPrefix must be a non-empty string of [A-Za-z0-9], received ${JSON.stringify(organisationPrefix)}`
    );
  }

  if (!VALID_TYPE_MARKERS.includes(typeMarker)) {
    throw new TypeError(
      `generateManagedIdentifier: typeMarker must be one of ${JSON.stringify(VALID_TYPE_MARKERS)}, received ${JSON.stringify(typeMarker)}`
    );
  }

  const body = generateIdentifierBody(randomInt);
  return `${organisationPrefix}${IDENTIFIER_SEPARATOR}${typeMarker}${body}`;
}

/**
 * Total, pure shape predicate: does `value` match the exact Managed_Identifier
 * shape `<prefix>-<marker><7-char-body>`, where `prefix` is `[A-Za-z0-9]+`,
 * `marker` is one of `IDENTIFIER_TYPE_MARKERS`'s values, and every body
 * character is a member of the Identifier_Alphabet? Never throws, for any
 * input type.
 *
 * @param {*} value
 * @returns {boolean}
 */
function isManagedIdentifier(value) {
  if (typeof value !== 'string') {
    return false;
  }
  return MANAGED_IDENTIFIER_PATTERN.test(value);
}

module.exports = {
  IDENTIFIER_BODY_LENGTH,
  IDENTIFIER_SEPARATOR,
  IDENTIFIER_TYPE_MARKERS,
  generateIdentifierBody,
  generateManagedIdentifier,
  isManagedIdentifier
};
