const CallsignService = require('./CallsignService');

describe('CallsignService.assembleCallsign', () => {
  it('joins all three segments with a single dash when all are present', () => {
    const result = CallsignService.assembleCallsign({
      organisationPrefix: 'FENZ',
      teamSegmentPrefixes: ['CB', 'ST40'],
      nameSegment: 'J.Doe'
    });

    expect(result).toBe('FENZ-CBST40-J.Doe');
  });

  it('omits the Organisation segment and its adjacent dash when it is empty', () => {
    const result = CallsignService.assembleCallsign({
      organisationPrefix: '',
      teamSegmentPrefixes: ['CB', 'ST40'],
      nameSegment: 'J.Doe'
    });

    expect(result).toBe('CBST40-J.Doe');
  });

  it('treats a null Organisation segment the same as an empty one', () => {
    const result = CallsignService.assembleCallsign({
      organisationPrefix: null,
      teamSegmentPrefixes: ['CB'],
      nameSegment: 'J.Doe'
    });

    expect(result).toBe('CB-J.Doe');
  });

  it('omits the Team segment and its adjacent dash when teamSegmentPrefixes is empty', () => {
    const result = CallsignService.assembleCallsign({
      organisationPrefix: 'FENZ',
      teamSegmentPrefixes: [],
      nameSegment: 'J.Doe'
    });

    expect(result).toBe('FENZ-J.Doe');
  });

  it('omits the Team segment when every element is an empty string (joins to an empty string)', () => {
    const result = CallsignService.assembleCallsign({
      organisationPrefix: 'FENZ',
      teamSegmentPrefixes: ['', ''],
      nameSegment: 'J.Doe'
    });

    expect(result).toBe('FENZ-J.Doe');
  });

  it('treats an undefined teamSegmentPrefixes array the same as an empty one', () => {
    const result = CallsignService.assembleCallsign({
      organisationPrefix: 'FENZ',
      teamSegmentPrefixes: undefined,
      nameSegment: 'J.Doe'
    });

    expect(result).toBe('FENZ-J.Doe');
  });

  it('omits the Name segment and its adjacent dash when it is empty', () => {
    const result = CallsignService.assembleCallsign({
      organisationPrefix: 'FENZ',
      teamSegmentPrefixes: ['CB'],
      nameSegment: ''
    });

    expect(result).toBe('FENZ-CB');
  });

  it('joins multiple team-level prefixes with no separator', () => {
    const result = CallsignService.assembleCallsign({
      organisationPrefix: '',
      teamSegmentPrefixes: ['CB', 'ST40'],
      nameSegment: ''
    });

    expect(result).toBe('CBST40');
  });

  it('returns just the Organisation segment when it is the only one present', () => {
    const result = CallsignService.assembleCallsign({
      organisationPrefix: 'FENZ',
      teamSegmentPrefixes: [],
      nameSegment: ''
    });

    expect(result).toBe('FENZ');
  });

  it('returns just the Team segment when it is the only one present', () => {
    const result = CallsignService.assembleCallsign({
      organisationPrefix: '',
      teamSegmentPrefixes: ['CB', 'ST40'],
      nameSegment: ''
    });

    expect(result).toBe('CBST40');
  });

  it('returns just the Name segment when it is the only one present, with no leading dash', () => {
    const result = CallsignService.assembleCallsign({
      organisationPrefix: '',
      teamSegmentPrefixes: [],
      nameSegment: 'J.Doe'
    });

    expect(result).toBe('J.Doe');
  });

  it('returns an empty string when all three segments are empty', () => {
    const result = CallsignService.assembleCallsign({
      organisationPrefix: '',
      teamSegmentPrefixes: [],
      nameSegment: ''
    });

    expect(result).toBe('');
  });

  it('returns an empty string when all three segments are null/undefined', () => {
    const result = CallsignService.assembleCallsign({
      organisationPrefix: null,
      teamSegmentPrefixes: undefined,
      nameSegment: undefined
    });

    expect(result).toBe('');
  });
});

/**
 * Callsign Team-segment separator toggle: `teamSegmentSeparator` controls
 * how `teamSegmentPrefixes` entries are joined to form the Team segment.
 * Default (`''`, omitted) reproduces the original no-separator rule
 * exactly (pinned by the describe block above, which never passes this
 * param). `'-'` hyphenates each PRESENT level -- the caller
 * (`userAttributes.js`) never supplies an empty-string entry in
 * `teamSegmentPrefixes` (its own `!!team.callsign_prefix` filter runs
 * first), so this can never itself produce a leading/trailing/doubled
 * separator even when an intermediate Team-Depth level is unselected or
 * absent from the hierarchy -- that level is simply never present in the
 * array passed in.
 */
describe('CallsignService.assembleCallsign teamSegmentSeparator (Callsign Team-segment separator toggle)', () => {
  it("defaults to '' (no separator) when omitted, matching the pre-existing rule exactly", () => {
    const result = CallsignService.assembleCallsign({
      organisationPrefix: 'FENZ',
      teamSegmentPrefixes: ['NSW', 'SYD']
    });

    expect(result).toBe('FENZ-NSWSYD');
  });

  it("hyphenates every PRESENT level when teamSegmentSeparator is '-'", () => {
    const result = CallsignService.assembleCallsign({
      organisationPrefix: 'FENZ',
      teamSegmentPrefixes: ['NSW', 'SYD'],
      nameSegment: 'J.Bloggs',
      teamSegmentSeparator: '-'
    });

    expect(result).toBe('FENZ-NSW-SYD-J.Bloggs');
  });

  // The exact scenario named in the bug report: Level 1 and Level 3 set,
  // Level 2 NOT set -- teamSegmentPrefixes therefore contains only the
  // TWO present levels (['NSW', 'SYD']), never a placeholder for the
  // missing Level 2, so hyphenation joins them with exactly ONE '-',
  // never 'NSW--SYD'.
  it('never produces a doubled hyphen when an intermediate level is absent from teamSegmentPrefixes (Level 1 + Level 3 set, Level 2 not)', () => {
    const result = CallsignService.assembleCallsign({
      organisationPrefix: 'AUS-FIRE',
      teamSegmentPrefixes: ['NSW', 'SYD'],
      nameSegment: 'J.Bloggs',
      teamSegmentSeparator: '-'
    });

    expect(result).toBe('AUS-FIRE-NSW-SYD-J.Bloggs');
    expect(result).not.toContain('--');
  });

  it('hyphenates a single present level with no separator needed (nothing to join)', () => {
    const result = CallsignService.assembleCallsign({
      organisationPrefix: 'FENZ',
      teamSegmentPrefixes: ['NSW'],
      teamSegmentSeparator: '-'
    });

    expect(result).toBe('FENZ-NSW');
  });

  it('produces an empty Team segment (and no doubled/leading/trailing hyphen) when teamSegmentPrefixes is empty, regardless of teamSegmentSeparator', () => {
    const result = CallsignService.assembleCallsign({
      organisationPrefix: 'FENZ',
      teamSegmentPrefixes: [],
      nameSegment: 'J.Bloggs',
      teamSegmentSeparator: '-'
    });

    expect(result).toBe('FENZ-J.Bloggs');
  });

  it('treats an empty-string teamSegmentSeparator explicitly the same as omitting it', () => {
    const result = CallsignService.assembleCallsign({
      organisationPrefix: 'FENZ',
      teamSegmentPrefixes: ['NSW', 'SYD'],
      teamSegmentSeparator: ''
    });

    expect(result).toBe('FENZ-NSWSYD');
  });
});

describe('CallsignService.computeDefaultCallsignSuffix', () => {
  it('computes a full_name suffix as "First Last" sanitized', () => {
    const result = CallsignService.computeDefaultCallsignSuffix('John', 'Doe', 'full_name');
    expect(result).toBe('John-Doe');
  });

  it('computes a first_initial_last suffix as initial+space+last sanitized', () => {
    const result = CallsignService.computeDefaultCallsignSuffix('John', 'Doe', 'first_initial_last');
    expect(result).toBe('J-Doe');
  });

  it('falls back to just firstName for first_initial_last when lastName is empty', () => {
    const result = CallsignService.computeDefaultCallsignSuffix('John', '', 'first_initial_last');
    expect(result).toBe('John');
  });

  it('computes a first_last_initial suffix as first+space+initial sanitized', () => {
    const result = CallsignService.computeDefaultCallsignSuffix('John', 'Doe', 'first_last_initial');
    expect(result).toBe('John-D');
  });

  it('falls back to just firstName for first_last_initial when lastName is empty', () => {
    const result = CallsignService.computeDefaultCallsignSuffix('John', '', 'first_last_initial');
    expect(result).toBe('John');
  });

  it('computes a first_initial_dot_last suffix as "J.Doe" with the dot preserved', () => {
    const result = CallsignService.computeDefaultCallsignSuffix('John', 'Doe', 'first_initial_dot_last');
    expect(result).toBe('J.Doe');
  });

  it('falls back to just firstName for first_initial_dot_last when lastName is empty', () => {
    const result = CallsignService.computeDefaultCallsignSuffix('John', '', 'first_initial_dot_last');
    expect(result).toBe('John');
  });

  it('returns null unconditionally for user_defined', () => {
    const result = CallsignService.computeDefaultCallsignSuffix('John', 'Doe', 'user_defined');
    expect(result).toBeNull();
  });

  it('falls back to full_name-style formatting for an unrecognized format value', () => {
    const result = CallsignService.computeDefaultCallsignSuffix('John', 'Doe', 'some_unknown_format');
    expect(result).toBe('John-Doe');
  });

  it('trims firstName/lastName before formatting', () => {
    const result = CallsignService.computeDefaultCallsignSuffix('  John  ', '  Doe  ', 'full_name');
    expect(result).toBe('John-Doe');
  });

  it('replaces a disallowed character (apostrophe) with a single dash', () => {
    const result = CallsignService.computeDefaultCallsignSuffix("O'Brien", 'Doe', 'first_initial_last');
    // rawSuffix before sanitization: "O Doe" (first initial "O" + space + "Doe")
    expect(result).toBe('O-Doe');
  });

  it('replaces each disallowed character individually rather than collapsing runs', () => {
    // full_name for a name containing an apostrophe: "Mary Jane O'Brien-Smith"
    // first_name "Mary  Jane" (double space) -> trimmed still has internal double space
    const result = CallsignService.computeDefaultCallsignSuffix('Mary  Jane', "O'Brien", 'full_name');
    // rawSuffix: "Mary  Jane O'Brien" -> each disallowed char (2 spaces, 1 space, apostrophe)
    // replaced individually with '-': "Mary--Jane-O-Brien"
    expect(result).toBe('Mary--Jane-O-Brien');
  });

  it('preserves the synthesized dot in first_initial_dot_last through sanitization', () => {
    const result = CallsignService.computeDefaultCallsignSuffix("Jo'sh", "O'Brien", 'first_initial_dot_last');
    // rawSuffix: "J.O'Brien" -> apostrophe replaced with '-', dot preserved
    expect(result).toBe("J.O-Brien");
  });

  it('preserves an already-hyphenated last name in full_name formatting', () => {
    const result = CallsignService.computeDefaultCallsignSuffix('Anne', 'Smith-Jones', 'full_name');
    expect(result).toBe('Anne-Smith-Jones');
  });

  // Bugfix (callsign-handling): a macroned/accented letter must be
  // transliterated to its base ASCII letter, never mangled into a `-`
  // that is indistinguishable from an intended segment boundary.
  it('strips a macron (Kōkako -> Kokako) rather than replacing it with a dash', () => {
    const result = CallsignService.computeDefaultCallsignSuffix('Kingston', 'Kōkako', 'first_initial_dot_last');
    expect(result).toBe('K.Kokako');
  });

  it('strips diacritics across full_name formatting (José Muñoz -> Jose-Munoz)', () => {
    const result = CallsignService.computeDefaultCallsignSuffix('José', 'Muñoz', 'full_name');
    expect(result).toBe('Jose-Munoz');
  });

  it('strips a diaeresis (Zoë -> Zoe) while still replacing a genuinely disallowed character with a dash', () => {
    const result = CallsignService.computeDefaultCallsignSuffix('Zoë', "O'Brien", 'first_initial_last');
    // First initial "Z" (from de-accented "Zoe") + space + "O'Brien" ->
    // the apostrophe (a real disallowed character, not a diacritic) is
    // still replaced with '-'.
    expect(result).toBe('Z-O-Brien');
  });
});

/**
 * Property-based test (design.md's Property 12: "Callsign segment
 * assembly preserves segment identity and separator placement"),
 * implemented with `fast-check` via `@fast-check/jest`'s `test.prop`
 * integration, matching the convention established in
 * `../utils/callsignValidation.test.js` and
 * `../config/permissions.registry.test.js`.
 *
 * Feature: org-team-hierarchy, task 10.3
 * Validates: Requirements 8.1, 8.2, 8.3, 8.4, 8.5
 */

const fc = require('fast-check');
const { test } = require('@fast-check/jest');

describe('Property 12: Callsign segment assembly preserves segment identity and separator placement', () => {
  // Alphanumeric-only alphabet: deliberately excludes '-' so the separator
  // under test can never accidentally originate from inside a segment
  // itself, isolating the assembly rule's own separator-placement logic.
  const ALPHANUMERIC_CHARS =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

  const alphanumericArb = fc
    .array(fc.constantFrom(...ALPHANUMERIC_CHARS), { minLength: 0, maxLength: 10 })
    .map((chars) => chars.join(''));

  const orgPrefixArb = alphanumericArb;
  const nameSegmentArb = alphanumericArb;
  // Each individual team-level prefix is generated non-empty: an empty
  // string entry inside teamSegmentPrefixes would vanish harmlessly under
  // `.join('')` (Requirement 8.3), but would muddy the "split at known
  // boundaries" assertion below without adding any coverage of the
  // separator-placement rule under test.
  const nonEmptyAlphanumericArb = fc
    .array(fc.constantFrom(...ALPHANUMERIC_CHARS), { minLength: 1, maxLength: 10 })
    .map((chars) => chars.join(''));
  const teamPrefixListArb = fc.array(nonEmptyAlphanumericArb, {
    minLength: 0,
    maxLength: 5
  });

  // Feature: org-team-hierarchy, Property 12: Callsign segment assembly
  // preserves segment identity and separator placement
  test.prop([orgPrefixArb, teamPrefixListArb, nameSegmentArb], { numRuns: 100 })(
    'assembleCallsign never produces a leading/trailing/doubled separator, and yields back the original non-empty segments when split at the "-" boundaries',
    (organisationPrefix, teamSegmentPrefixes, nameSegment) => {
      const result = CallsignService.assembleCallsign({
        organisationPrefix,
        teamSegmentPrefixes,
        nameSegment
      });

      const teamSegment = teamSegmentPrefixes.join('');
      const nonEmptySegments = [organisationPrefix, teamSegment, nameSegment].filter(
        (segment) => segment !== ''
      );

      if (nonEmptySegments.length === 0) {
        expect(result).toBe('');
        return;
      }

      // No leading or trailing separator.
      expect(result.startsWith('-')).toBe(false);
      expect(result.endsWith('-')).toBe(false);

      // Exactly one '-' between each pair of adjacent non-empty segments --
      // i.e. never a doubled/adjacent separator.
      expect(result.includes('--')).toBe(false);

      // The Team segment is the no-separator concatenation of every
      // teamSegmentPrefixes entry (Requirement 8.3), appearing intact.
      if (teamSegment !== '') {
        expect(result).toContain(teamSegment);
      }

      // Splitting at the known "-" boundaries yields back exactly the
      // original non-empty segments, unchanged, in order.
      const splitPieces = result.split('-');
      expect(splitPieces.every((piece) => piece !== '')).toBe(true);
      expect(splitPieces).toEqual(nonEmptySegments);
    }
  );
});

/**
 * Callsign Team-segment separator toggle: the SAME Property 12 guarantee
 * (no leading/trailing/doubled separator; splitting at "-" boundaries
 * yields back exactly the original non-empty segments) must continue to
 * hold when `teamSegmentSeparator: '-'` is supplied -- the toggle must
 * never let an absent/unselected intermediate Team-Depth level (never
 * present as an empty-string entry in `teamSegmentPrefixes`, per the
 * caller's own `!!team.callsign_prefix` filter) produce a doubled
 * hyphen, regardless of how many levels are present or how the other two
 * segments are populated.
 */
describe('Property 12 (extended): teamSegmentSeparator hyphenation never produces a leading/trailing/doubled separator', () => {
  const ALPHANUMERIC_CHARS =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

  const alphanumericArb = fc
    .array(fc.constantFrom(...ALPHANUMERIC_CHARS), { minLength: 0, maxLength: 10 })
    .map((chars) => chars.join(''));

  const orgPrefixArb = alphanumericArb;
  const nameSegmentArb = alphanumericArb;
  const nonEmptyAlphanumericArb = fc
    .array(fc.constantFrom(...ALPHANUMERIC_CHARS), { minLength: 1, maxLength: 10 })
    .map((chars) => chars.join(''));
  const teamPrefixListArb = fc.array(nonEmptyAlphanumericArb, {
    minLength: 0,
    maxLength: 5
  });

  test.prop([orgPrefixArb, teamPrefixListArb, nameSegmentArb], { numRuns: 100 })(
    "assembleCallsign with teamSegmentSeparator: '-' never produces a leading/trailing/doubled separator, and yields back the original non-empty segments when split at the '-' boundaries",
    (organisationPrefix, teamSegmentPrefixes, nameSegment) => {
      const result = CallsignService.assembleCallsign({
        organisationPrefix,
        teamSegmentPrefixes,
        nameSegment,
        teamSegmentSeparator: '-'
      });

      // With hyphenation, the Team segment ITSELF is now `-`-joined, so
      // the reference expectation must split its own segments out too --
      // unlike the no-separator case, `teamSegmentPrefixes` entries are
      // each their own top-level "-"-delimited piece of the result.
      const nonEmptySegments = [
        organisationPrefix,
        ...teamSegmentPrefixes,
        nameSegment
      ].filter((segment) => segment !== '');

      if (nonEmptySegments.length === 0) {
        expect(result).toBe('');
        return;
      }

      expect(result.startsWith('-')).toBe(false);
      expect(result.endsWith('-')).toBe(false);
      expect(result.includes('--')).toBe(false);

      const splitPieces = result.split('-');
      expect(splitPieces.every((piece) => piece !== '')).toBe(true);
      expect(splitPieces).toEqual(nonEmptySegments);
    }
  );
});
