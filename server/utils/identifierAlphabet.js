/**
 * The ambiguity-free Identifier_Alphabet (takserver-enrollment Requirement 1,
 * Criteria 1.2 and 1.4).
 *
 * This is the single definition of the 31-character alphabet a Managed_Identifier
 * body is drawn from, and it is also the alphabet `SignupCodeService`'s sign-up
 * codes already used before this module existed. Named for the PROPERTY the
 * alphabet has -- ambiguity-freedom -- rather than for either consumer, because
 * neither consumer owns the other:
 *
 * - `server/utils/managedIdentifier.js` requires Criterion 1.5's bare require
 *   graph (no framework, no database), so it cannot import from
 *   `server/services/SignupCodeService.js`, which requires `../config/database`,
 *   `pdfkit` and `qrcode`.
 * - Filing the constant inside `managedIdentifier.js` instead would file the
 *   sign-up code's alphabet under a concept sign-up codes have nothing to do
 *   with, so a developer changing sign-up codes would not find it.
 *
 * NO IMPORTS. This file must load with nothing else in its require graph.
 */

/**
 * 23 letters (A-Z, less I, L, O) plus 8 digits (2-9): 31 characters, chosen
 * because a Managed_Identifier and a sign-up code are both read aloud and
 * typed by hand, and O/0 and I/1/L are the pairs a person mistypes and a
 * support call mistransmits.
 */
const AMBIGUITY_FREE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** The length of AMBIGUITY_FREE_ALPHABET, spelled out so a caller need not
 * call `.length` on the string to get a named constant. */
const AMBIGUITY_FREE_ALPHABET_LENGTH = 31;

/**
 * The five characters deliberately excluded from AMBIGUITY_FREE_ALPHABET.
 * Exported even though nothing in production reads it yet: a future property
 * test asserts that no generated body character is ever one of these, and it
 * asserts that against this declared set rather than a set the test
 * re-types -- a test that re-types the exclusions is a test that agrees with
 * itself about a typo.
 */
const EXCLUDED_AMBIGUOUS_CHARACTERS = 'O0I1L';

module.exports = {
  AMBIGUITY_FREE_ALPHABET,
  AMBIGUITY_FREE_ALPHABET_LENGTH,
  EXCLUDED_AMBIGUOUS_CHARACTERS
};
