const {
  isValidCallsignPrefix,
  isValidCallsignSuffix,
  MANAGED_IDENTIFIER_PREFIX_MARKER_CHARACTERS
} = require('./callsignValidation');
const { IDENTIFIER_TYPE_MARKERS } = require('./managedIdentifier');
const { AMBIGUITY_FREE_ALPHABET } = require('./identifierAlphabet');

/**
 * Feature: org-team-hierarchy, task 6.5
 * Validates: Requirements 3.8, 3.9, 11.3
 */
describe('isValidCallsignPrefix', () => {
  it('accepts an empty string', () => {
    expect(isValidCallsignPrefix('')).toBe(true);
  });

  it('accepts null/undefined', () => {
    expect(isValidCallsignPrefix(null)).toBe(true);
    expect(isValidCallsignPrefix(undefined)).toBe(true);
  });

  it('accepts letters-only values', () => {
    expect(isValidCallsignPrefix('FENZ')).toBe(true);
  });

  it('accepts digits-only values', () => {
    expect(isValidCallsignPrefix('123')).toBe(true);
  });

  it('accepts mixed alphanumeric values', () => {
    expect(isValidCallsignPrefix('NZP40')).toBe(true);
  });

  // Foreign-partner-prefix extension: callsign_prefix now accepts one or
  // more `-`-separated alphanumeric segments, not just a single hyphen-free
  // run (e.g. a Foreign_Partner Organisation's "AUS-FIRE").
  it('accepts a value containing a single internal hyphen (a two-segment prefix)', () => {
    expect(isValidCallsignPrefix('AUS-FIRE')).toBe(true);
    expect(isValidCallsignPrefix('NZ-POL')).toBe(true);
  });

  it('accepts a value containing multiple internal hyphens (a three-segment prefix)', () => {
    expect(isValidCallsignPrefix('AUS-FIRE-NSW')).toBe(true);
  });

  it('rejects a value with a leading hyphen', () => {
    expect(isValidCallsignPrefix('-AUS')).toBe(false);
  });

  it('rejects a value with a trailing hyphen', () => {
    expect(isValidCallsignPrefix('AUS-')).toBe(false);
  });

  it('rejects a value with a doubled hyphen (an empty segment)', () => {
    expect(isValidCallsignPrefix('AUS--FIRE')).toBe(false);
  });

  it('rejects a value with a segment matching the Managed_Identifier marker+body shape', () => {
    // 'D' + 7 Identifier_Alphabet characters -- indistinguishable from a
    // real Managed_Identifier's own marker+body suffix if permitted.
    expect(isValidCallsignPrefix('AUS-D2345678')).toBe(false);
    expect(isValidCallsignPrefix('AUS-U2345678')).toBe(false);
    // Same shape, standing alone as the entire (single-segment) prefix.
    expect(isValidCallsignPrefix('D2345678')).toBe(false);
    expect(isValidCallsignPrefix('U2345678')).toBe(false);
  });

  it('accepts a segment that is ALMOST the marker+body shape but differs in length or leading character', () => {
    // One character short of a body -- not a marker+body match.
    expect(isValidCallsignPrefix('AUS-D234567')).toBe(true);
    // Correct length, but the leading character is not D or U.
    expect(isValidCallsignPrefix('AUS-F2345678')).toBe(true);
  });

  it('rejects a value containing a period', () => {
    expect(isValidCallsignPrefix('NZ.POL')).toBe(false);
  });

  it('rejects a value containing another disallowed character', () => {
    expect(isValidCallsignPrefix('NZ POL')).toBe(false);
    expect(isValidCallsignPrefix('NZ_POL')).toBe(false);
  });
});

describe('isValidCallsignSuffix', () => {
  it('accepts an empty string', () => {
    expect(isValidCallsignSuffix('')).toBe(true);
  });

  it('accepts null/undefined', () => {
    expect(isValidCallsignSuffix(null)).toBe(true);
    expect(isValidCallsignSuffix(undefined)).toBe(true);
  });

  it('accepts letters-only values', () => {
    expect(isValidCallsignSuffix('Doe')).toBe(true);
  });

  it('accepts digits-only values', () => {
    expect(isValidCallsignSuffix('4021')).toBe(true);
  });

  it('accepts mixed alphanumeric values', () => {
    expect(isValidCallsignSuffix('JDoe1')).toBe(true);
  });

  it('accepts a value containing a hyphen', () => {
    expect(isValidCallsignSuffix('J-Doe')).toBe(true);
  });

  it('accepts a value containing a period', () => {
    expect(isValidCallsignSuffix('J.Doe')).toBe(true);
  });

  it('rejects a value containing another disallowed character', () => {
    expect(isValidCallsignSuffix('J Doe')).toBe(false);
    expect(isValidCallsignSuffix('J_Doe')).toBe(false);
  });
});

/**
 * Property-based tests (design.md's Property 3: "`callsign_prefix` and
 * `callsign_suffix` accept disjoint-but-overlapping character classes"),
 * implemented with `fast-check` via `@fast-check/jest`'s `test.prop`
 * integration, matching the convention established in
 * `../config/htmlSafeSubset.test.js` and
 * `../config/permissions.registry.test.js`.
 *
 * Feature: org-team-hierarchy, task 6.6
 * Validates: Requirements 3.8, 3.9, 11.3
 */

const fc = require('fast-check');
const { test } = require('@fast-check/jest');

// Independent oracles, re-derived directly from Requirements 3.8/3.9/11.3
// (and the foreign-partner-prefix extension's segment/marker-shape rules)
// rather than importing/reusing the module's own regex constants
// (`CALLSIGN_PREFIX_PATTERN`, `MANAGED_IDENTIFIER_MARKER_BODY_SEGMENT_PATTERN`).
// `AMBIGUITY_FREE_ALPHABET` and `IDENTIFIER_TYPE_MARKERS` are imported
// because they are the canonical GROUND-TRUTH definitions the requirement
// itself references (the Identifier_Alphabet and the two
// Identifier_Type_Markers), not the subject's own re-implementation of the
// prefix rule -- re-typing either literal here would itself be the kind of
// "oracle agrees with a typo" risk `identifierAlphabet.js`'s own doc comment
// warns about.
const SUFFIX_ORACLE_PATTERN = /^[A-Za-z0-9.-]*$/;
const PREFIX_ORACLE_SEGMENT_PATTERN = /^[A-Za-z0-9]+$/;
const MARKER_BODY_ORACLE_PATTERN = new RegExp(
  `^[${IDENTIFIER_TYPE_MARKERS.DEVICE}${IDENTIFIER_TYPE_MARKERS.USER}][${AMBIGUITY_FREE_ALPHABET}]{7}$`
);

/**
 * Independent oracle for `isValidCallsignPrefix`: empty/null/undefined is
 * valid; otherwise every `-`-separated segment must be non-empty
 * alphanumeric AND must not match the marker+body shape.
 */
function prefixOracle(value) {
  if (value === null || value === undefined || value === '') {
    return true;
  }
  const segments = value.split('-');
  return segments.every(
    (segment) =>
      PREFIX_ORACLE_SEGMENT_PATTERN.test(segment) &&
      !MARKER_BODY_ORACLE_PATTERN.test(segment)
  );
}

describe('Property 3: callsign_prefix and callsign_suffix accept disjoint-but-overlapping character classes', () => {
  test.prop([fc.string()], { numRuns: 200 })(
    'isValidCallsignPrefix(str) agrees with the independent segment/marker-shape oracle',
    (str) => {
      expect(isValidCallsignPrefix(str)).toBe(prefixOracle(str));
    }
  );

  test.prop([fc.string()], { numRuns: 100 })(
    'isValidCallsignSuffix(str) === true iff every character is a letter, digit, "-", or "." (or str is empty)',
    (str) => {
      expect(isValidCallsignSuffix(str)).toBe(SUFFIX_ORACLE_PATTERN.test(str));
    }
  );

  // Strings built exclusively from the callsign_suffix-valid alphabet
  // ([A-Za-z0-9.-]), guaranteed to contain at least one '.', so the ONLY
  // reason callsign_prefix validation could reject them is that character
  // -- isolating the comparative claim from the two independent membership
  // predicates above. Unlike '-', '.' is NEVER permitted in a
  // callsign_prefix regardless of the foreign-partner-prefix extension, so
  // this comparative claim still holds unconditionally.
  const suffixAlphabetArb = fc
    .array(
      fc.constantFrom(
        ...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789.-'
      ),
      { minLength: 0, maxLength: 20 }
    )
    .map((chars) => chars.join(''));

  // Assemble str as: prefixPart + '.' + suffixPart, guaranteeing at least
  // one '.' is present while otherwise drawing from the
  // callsign_suffix-valid alphabet.
  const stringWithPeriodArb = fc
    .tuple(suffixAlphabetArb, suffixAlphabetArb)
    .map(([before, after]) => `${before}.${after}`);

  test.prop([stringWithPeriodArb], { numRuns: 100 })(
    'a string containing a "." (built from the callsign_suffix alphabet) is rejected by isValidCallsignPrefix but accepted by isValidCallsignSuffix',
    (str) => {
      expect(str).toMatch(/\./);
      expect(isValidCallsignPrefix(str)).toBe(false);
      expect(isValidCallsignSuffix(str)).toBe(true);
    }
  );

  // Foreign-partner-prefix extension: a well-formed multi-segment prefix
  // (1-4 segments, each 1-8 lowercase-alphanumeric characters -- lowercase
  // specifically so no segment can ever collide with the marker+body shape,
  // which is anchored on uppercase D/U and the uppercase-only
  // Identifier_Alphabet) is always accepted.
  const safeSegmentArb = fc
    .array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'), { minLength: 1, maxLength: 8 })
    .map((chars) => chars.join(''));
  const wellFormedMultiSegmentPrefixArb = fc
    .array(safeSegmentArb, { minLength: 1, maxLength: 4 })
    .map((segments) => segments.join('-'));

  test.prop([wellFormedMultiSegmentPrefixArb], { numRuns: 200 })(
    'a well-formed multi-segment alphanumeric prefix (e.g. "AUS-FIRE") is always accepted',
    (str) => {
      expect(isValidCallsignPrefix(str)).toBe(true);
    }
  );

  // Foreign-partner-prefix extension: embedding a marker+body-shaped
  // segment ANYWHERE among otherwise-safe segments is always rejected,
  // regardless of how many safe segments surround it or its position among
  // them.
  const markerCharArb = fc.constantFrom(
    IDENTIFIER_TYPE_MARKERS.DEVICE,
    IDENTIFIER_TYPE_MARKERS.USER
  );
  const alphabetCharArb = fc.constantFrom(...AMBIGUITY_FREE_ALPHABET);
  const markerBodySegmentArb = fc
    .tuple(markerCharArb, fc.array(alphabetCharArb, { minLength: 7, maxLength: 7 }))
    .map(([marker, bodyChars]) => `${marker}${bodyChars.join('')}`);

  const prefixWithEmbeddedMarkerSegmentArb = fc
    .tuple(
      fc.array(safeSegmentArb, { minLength: 0, maxLength: 3 }),
      markerBodySegmentArb,
      fc.array(safeSegmentArb, { minLength: 0, maxLength: 3 })
    )
    .map(([before, markerSegment, after]) =>
      [...before, markerSegment, ...after].join('-')
    );

  test.prop([prefixWithEmbeddedMarkerSegmentArb], { numRuns: 200 })(
    'a prefix with a marker+body-shaped segment embedded anywhere is always rejected',
    (str) => {
      expect(isValidCallsignPrefix(str)).toBe(false);
    }
  );

  // Foreign-partner-prefix extension: a leading, trailing, or doubled
  // hyphen (an empty segment) is always rejected, even though the
  // non-empty segments around it are individually well-formed.
  const malformedHyphenPlacementArb = fc.oneof(
    wellFormedMultiSegmentPrefixArb.map((str) => `-${str}`), // leading
    wellFormedMultiSegmentPrefixArb.map((str) => `${str}-`), // trailing
    fc
      .tuple(safeSegmentArb, safeSegmentArb)
      .map(([a, b]) => `${a}--${b}`) // doubled
  );

  test.prop([malformedHyphenPlacementArb], { numRuns: 200 })(
    'a prefix with a leading, trailing, or doubled hyphen is always rejected',
    (str) => {
      expect(isValidCallsignPrefix(str)).toBe(false);
    }
  );
});

/**
 * Structural guard: the marker characters this module hardcodes as
 * `MANAGED_IDENTIFIER_PREFIX_MARKER_CHARACTERS` (to avoid a circular
 * require with `managedIdentifier.js`, which already imports
 * `isValidCallsignPrefix` from this module) must stay in agreement with
 * `managedIdentifier.js`'s own `IDENTIFIER_TYPE_MARKERS`. If the two ever
 * drift, this fails loudly rather than `isValidCallsignPrefix` silently
 * validating against a stale marker set.
 */
describe('MANAGED_IDENTIFIER_PREFIX_MARKER_CHARACTERS stays in sync with managedIdentifier.js', () => {
  it('contains exactly the same characters as IDENTIFIER_TYPE_MARKERS\' values, in any order', () => {
    const fromManagedIdentifier = Object.values(IDENTIFIER_TYPE_MARKERS).sort();
    const fromCallsignValidation = MANAGED_IDENTIFIER_PREFIX_MARKER_CHARACTERS.split('').sort();
    expect(fromCallsignValidation).toEqual(fromManagedIdentifier);
  });
});
