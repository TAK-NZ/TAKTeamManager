const { isValidCallsignPrefix, isValidCallsignSuffix } = require('./callsignValidation');

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

  it('rejects a value containing a hyphen', () => {
    expect(isValidCallsignPrefix('NZ-POL')).toBe(false);
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
// rather than importing/reusing the module's own regex constants.
const PREFIX_ORACLE_PATTERN = /^[A-Za-z0-9]*$/;
const SUFFIX_ORACLE_PATTERN = /^[A-Za-z0-9.-]*$/;

describe('Property 3: callsign_prefix and callsign_suffix accept disjoint-but-overlapping character classes', () => {
  test.prop([fc.string()], { numRuns: 100 })(
    'isValidCallsignPrefix(str) === true iff every character is a letter or digit (or str is empty)',
    (str) => {
      expect(isValidCallsignPrefix(str)).toBe(PREFIX_ORACLE_PATTERN.test(str));
    }
  );

  test.prop([fc.string()], { numRuns: 100 })(
    'isValidCallsignSuffix(str) === true iff every character is a letter, digit, "-", or "." (or str is empty)',
    (str) => {
      expect(isValidCallsignSuffix(str)).toBe(SUFFIX_ORACLE_PATTERN.test(str));
    }
  );

  // Strings built exclusively from the callsign_suffix-valid alphabet
  // ([A-Za-z0-9.-]), guaranteed to contain at least one '-' or '.', so the
  // ONLY reason callsign_prefix validation could reject them is that
  // separator character -- isolating the comparative claim from the two
  // independent membership predicates above.
  const suffixAlphabetArb = fc
    .array(
      fc.constantFrom(
        ...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789.-'
      ),
      { minLength: 0, maxLength: 20 }
    )
    .map((chars) => chars.join(''));
  const separatorArb = fc.constantFrom('-', '.');

  // Assemble str as: prefixPart + separator + suffixPart, guaranteeing at
  // least one '-'/'.' is present while otherwise drawing from the
  // callsign_suffix-valid alphabet.
  const stringWithSeparatorArb = fc
    .tuple(suffixAlphabetArb, separatorArb, suffixAlphabetArb)
    .map(([before, sep, after]) => `${before}${sep}${after}`);

  test.prop([stringWithSeparatorArb], { numRuns: 100 })(
    'a string containing a "-" or "." (built from the callsign_suffix alphabet) is rejected by isValidCallsignPrefix but accepted by isValidCallsignSuffix',
    (str) => {
      expect(str).toMatch(/[-.]/);
      expect(isValidCallsignPrefix(str)).toBe(false);
      expect(isValidCallsignSuffix(str)).toBe(true);
    }
  );
});
