// Feature: takserver-enrollment, Property 1: Managed_Identifier generation is total, shape-exact, alphabet-exact, and type-partitioned
//
// **Validates: Requirements 1.1, 1.2, 1.3, 1.6, 1.11**

/**
 * takserver-enrollment task 1.3: the single fast-check property test for
 * design.md's Property 1 (Requirements 1.1, 1.2, 1.3, 1.6, 1.11).
 *
 * Property 1's statement, restated from the requirements text: for any valid
 * Organisation_Prefix and any Identifier_Type_Marker, `generateManagedIdentifier`
 * SHALL return a string of the exact shape `<PREFIX>-<TYPE><BODY>` -- the
 * supplied prefix, the literal separator `-`, the supplied marker, then
 * exactly seven further characters, every one of them a member of the
 * Identifier_Alphabet and none of them one of the five excluded ambiguous
 * characters -- and for one prefix, the `D` identifier and the `U`
 * identifier SHALL never be equal.
 *
 * Generators are crossed over four boundary Organisation_Prefix shapes --
 * a one-character prefix, an all-digit prefix, an all-letter prefix, and a
 * 255-character prefix -- each crossed with BOTH Identifier_Type_Markers, plus
 * a broad uniform arm so the property is not boundary-only.
 *
 * **This property carries the design's ONE named exception to independent
 * re-derivation.** The alphabet-membership clause is asserted against
 * `AMBIGUITY_FREE_ALPHABET` -- the subject's own table -- because the
 * alternative is a test that re-types 31 characters and therefore agrees with
 * itself about a typo. The EXCLUSION clause carries the real assertion and is
 * asserted against the separately declared `EXCLUDED_AMBIGUOUS_CHARACTERS`,
 * never re-typed either. Every other value this file checks -- the seven-char
 * body length, the separator, the marker literals `D`/`U` -- is written out
 * literally from the requirements text rather than imported from the
 * subject or from `IDENTIFIER_TYPE_MARKERS`/`IDENTIFIER_BODY_LENGTH`. Do NOT
 * extend the one named exception to any other property in this spec.
 *
 * Anti-vacuity flags confirm each of the four boundary prefix shapes and both
 * Identifier_Type_Markers were actually exercised at least once, asserted in
 * the trailing `it()` below.
 */

const fc = require('fast-check');
const { test } = require('@fast-check/jest');

const { generateManagedIdentifier } = require('./managedIdentifier');
const { AMBIGUITY_FREE_ALPHABET, EXCLUDED_AMBIGUOUS_CHARACTERS } = require('./identifierAlphabet');

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const UPPER_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const LOWER_LETTERS = 'abcdefghijklmnopqrstuvwxyz';
const DIGITS = '0123456789';
const ALPHANUMERIC = UPPER_LETTERS + LOWER_LETTERS + DIGITS;

const alphanumericCharArb = fc.constantFrom(...ALPHANUMERIC.split(''));
const letterCharArb = fc.constantFrom(...(UPPER_LETTERS + LOWER_LETTERS).split(''));
const digitCharArb = fc.constantFrom(...DIGITS.split(''));

/** A single-character Organisation_Prefix, drawn from letters and digits. */
const oneCharPrefixArb = alphanumericCharArb.map((prefix) => ({ prefix, category: 'oneChar' }));

/** An all-digit Organisation_Prefix of varying length. */
const allDigitPrefixArb = fc
  .array(digitCharArb, { minLength: 2, maxLength: 30 })
  .map((chars) => ({ prefix: chars.join(''), category: 'allDigit' }));

/** An all-letter Organisation_Prefix of varying length, mixed case. */
const allLetterPrefixArb = fc
  .array(letterCharArb, { minLength: 2, maxLength: 30 })
  .map((chars) => ({ prefix: chars.join(''), category: 'allLetter' }));

/** A fixed-length 255-character Organisation_Prefix, content drawn at random. */
const the255PrefixArb = fc
  .array(alphanumericCharArb, { minLength: 255, maxLength: 255 })
  .map((chars) => ({ prefix: chars.join(''), category: 'the255' }));

/** A broad uniform arm so the property is not boundary-only. */
const broadPrefixArb = fc
  .array(alphanumericCharArb, { minLength: 1, maxLength: 64 })
  .map((chars) => ({ prefix: chars.join(''), category: 'broad' }));

const prefixCaseArb = fc.oneof(
  { weight: 3, arbitrary: oneCharPrefixArb },
  { weight: 3, arbitrary: allDigitPrefixArb },
  { weight: 3, arbitrary: allLetterPrefixArb },
  { weight: 3, arbitrary: the255PrefixArb },
  { weight: 4, arbitrary: broadPrefixArb }
);

/** Both Identifier_Type_Markers, written out literally rather than imported. */
const markerArb = fc.constantFrom('D', 'U');

// ---------------------------------------------------------------------------
// Anti-vacuity tracking
// ---------------------------------------------------------------------------

const seenCategories = new Set();
const seenMarkers = new Set();

function recordCategory(category) {
  seenCategories.add(category);
}

function recordMarker(marker) {
  seenMarkers.add(marker);
}

// Feature: takserver-enrollment, Property 1: Managed_Identifier generation is total, shape-exact, alphabet-exact, and type-partitioned
describe('Property 1: Managed_Identifier generation is total, shape-exact, alphabet-exact, and type-partitioned', () => {
  test.prop([prefixCaseArb, markerArb], { numRuns: 300 })(
    'produces <prefix>-<marker><7-char-body>, every body character in the alphabet and none excluded, for every boundary prefix shape crossed with both markers',
    ({ prefix, category }, marker) => {
      recordCategory(category);
      recordMarker(marker);

      const identifier = generateManagedIdentifier(prefix, marker);

      // Exact composition: prefix, then '-', then the marker, then exactly
      // seven further characters -- checked positionally, not by regex, so
      // this assertion re-derives the shape from the requirements text
      // rather than from the subject's own pattern.
      expect(identifier[prefix.length]).toBe('-');
      expect(identifier[prefix.length + 1]).toBe(marker);
      expect(identifier.slice(0, prefix.length)).toBe(prefix);

      const body = identifier.slice(prefix.length + 2);
      expect(body.length).toBe(7);
      expect(identifier.length).toBe(prefix.length + 2 + 7);

      // Alphabet membership: the ONE named exception to independent
      // re-derivation, asserted against the subject's own table.
      for (const ch of body) {
        expect(AMBIGUITY_FREE_ALPHABET.includes(ch)).toBe(true);
      }

      // Exclusion: the real assertion, against the separately declared
      // constant -- never re-typed.
      for (const ch of body) {
        expect(EXCLUDED_AMBIGUOUS_CHARACTERS.includes(ch)).toBe(false);
      }
    }
  );

  test.prop([prefixCaseArb], { numRuns: 300 })(
    'a D identifier and a U identifier minted for the same prefix are never equal',
    ({ prefix, category }) => {
      recordCategory(category);
      recordMarker('D');
      recordMarker('U');

      const deviceIdentifier = generateManagedIdentifier(prefix, 'D');
      const userIdentifier = generateManagedIdentifier(prefix, 'U');

      expect(deviceIdentifier).not.toBe(userIdentifier);
    }
  );

  it('exercised every boundary prefix shape and both Identifier_Type_Markers at least once (anti-vacuity)', () => {
    expect(seenCategories.has('oneChar')).toBe(true);
    expect(seenCategories.has('allDigit')).toBe(true);
    expect(seenCategories.has('allLetter')).toBe(true);
    expect(seenCategories.has('the255')).toBe(true);
    expect(seenMarkers.has('D')).toBe(true);
    expect(seenMarkers.has('U')).toBe(true);
  });
});
