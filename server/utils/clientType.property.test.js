/**
 * device-management task 22.5: the single fast-check property test for
 * design.md's Correctness Property 11 (Requirements 15.1, 15.3, 15.4, 15.5,
 * 15.8).
 *
 * Runs directly against the real `classifyClientType` — no mocks, nothing to
 * mock: Criterion 15.1 makes it a pure function of Client_Uid alone.
 *
 * design.md's exact Property 11 statement: "For all strings,
 * `classifyClientType` SHALL return exactly one of the five Client_Types;
 * SHALL return the same value for the string and for any change of its case;
 * SHALL return `cloudtak` for every string containing `(ETL)`, `(Web)`, or
 * `CloudTAK` (including strings that ALSO start with `ANDROID-`); SHALL
 * return `android` for every other string starting with `ANDROID-`; SHALL
 * return `ios` for every UUID-shaped and `windows` for every SID-shaped
 * string not already matched; and SHALL return `unknown` for everything else,
 * never throwing and never returning a non-Client_Type value."
 *
 * The property is split into the four halves of that sentence, each with its
 * own generator, because a single arbitrary would have to be so wide that no
 * half would be exercised often enough to matter:
 *
 *   1. Totality/determinism — the widest possible input space, including
 *      `fc.anything()` (so `null`, numbers, objects and arrays are covered)
 *      and arbitrary unicode strings.
 *   2. Case-invariance (Criterion 15.8) — every generated shape with its case
 *      randomised character by character.
 *   3. Precedence (Criterion 15.4) — a CloudTAK marker spliced into a base
 *      that would otherwise classify as `android`, `ios` or `windows`. The
 *      base is asserted on its own in the SAME run, so the test cannot pass
 *      by accident against an implementation that tests `ANDROID-` first:
 *      such an implementation returns `android` for the spliced string.
 *   4. Rule agreement — every input compared against `expectedClientType`
 *      below, an oracle written from the requirement text using string
 *      operations rather than the source's regexes, so agreement is evidence
 *      rather than a restatement of the implementation.
 *
 * Every real Client_Uid observed on the live server is pinned through
 * fast-check `examples`, so they run on every invocation rather than waiting
 * on sampling.
 *
 * ON THE CASE-INVARIANCE ALPHABET: the case-randomising generators draw from
 * ASCII, not from arbitrary unicode, and that is a statement about JavaScript
 * rather than a weakening of Criterion 15.8. All four rules in
 * `clientType.js` carry the `i` flag, so no rule is case-sensitive. But
 * `String.prototype.toUpperCase` is not case FOLDING: it maps U+017F (ſ) to
 * `S` and `'\u212A'.toLowerCase()` (K, the Kelvin sign) to `k`, i.e. it can
 * turn a non-ASCII character into a different, ASCII one. `'\u017F-1-5-21-1-1-1-1'`
 * is `unknown` and its uppercase is a genuine Windows SID — a different
 * identifier, not the same one in another case. Quantifying case-invariance
 * over such strings would assert something the property never claimed. Those
 * strings are still generated in halves 1 and 4, where they belong.
 *
 * Sibling `./clientType.test.js` (task 22.6) covers the concrete per-rule
 * examples and the boundary cases.
 *
 * **Validates: Requirements 15.1, 15.3, 15.4, 15.5, 15.8**
 */

const fc = require('fast-check');
const { test } = require('@fast-check/jest');

const { CLIENT_TYPES, classifyClientType } = require('./clientType');

/** The five and only acceptable return values (Criterion 15.3). */
const CLIENT_TYPE_VALUES = Object.values(CLIENT_TYPES);

// ---------------------------------------------------------------------------
// Oracle — the requirement text restated with string operations
// ---------------------------------------------------------------------------

const HEX_DIGITS = '0123456789abcdefABCDEF';
const DECIMAL_DIGITS = '0123456789';

/** True when every character of `text` is an ASCII hex digit, and it is `length` long. */
function isHexGroup(text, length) {
  return text.length === length && [...text].every((ch) => HEX_DIGITS.includes(ch));
}

/** True when `text` is one or more ASCII decimal digits. */
function isDigitGroup(text) {
  return text.length > 0 && [...text].every((ch) => DECIMAL_DIGITS.includes(ch));
}

/** Rule 3 restated: `8-4-4-4-12` hex groups, whole string. */
function isUuidShaped(value) {
  const groups = value.split('-');
  const lengths = [8, 4, 4, 4, 12];
  return groups.length === lengths.length
    && groups.every((group, index) => isHexGroup(group, lengths[index]));
}

/** Rule 4 restated: `S-1-5-21-` plus four decimal groups, whole string. */
function isSidShaped(value) {
  const groups = value.split('-');
  if (groups.length !== 8) return false;
  const [s, one, five, twentyOne, ...rest] = groups;
  return s.toLowerCase() === 's'
    && one === '1'
    && five === '5'
    && twentyOne === '21'
    && rest.every(isDigitGroup);
}

/**
 * Independent oracle for Criteria 15.3/15.4/15.5, written from the
 * requirement text with `includes`/`startsWith`/`split` rather than the
 * source's regexes, and in the source's precedence order.
 *
 * Sound for ASCII inputs, which is what the generators feeding it produce;
 * `toLowerCase` and a case-insensitive regex can disagree on non-ASCII
 * characters (see the Kelvin sign, above).
 */
function expectedClientType(value) {
  if (typeof value !== 'string' || value === '') return CLIENT_TYPES.UNKNOWN;
  const lower = value.toLowerCase();
  // Rule 1 — CloudTAK, ahead of Android by Criterion 15.4.
  if (lower.includes('(etl)') || lower.includes('(web)') || lower.includes('cloudtak')) {
    return CLIENT_TYPES.CLOUDTAK;
  }
  if (lower.startsWith('android-')) return CLIENT_TYPES.ANDROID;
  if (isUuidShaped(value)) return CLIENT_TYPES.IOS;
  if (isSidShaped(value)) return CLIENT_TYPES.WINDOWS;
  return CLIENT_TYPES.UNKNOWN;
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/** Joins a fixed-length draw of `chars` into a string. */
const blockOf = (chars, minLength, maxLength = minLength) =>
  fc.array(fc.constantFrom(...chars), { minLength, maxLength }).map((cs) => cs.join(''));

/** `8-4-4-4-12` hex, mixed case, e.g. `CE17C84D-9700-4080-BA5A-44AF51809453`. */
const uuidArb = fc
  .tuple(
    blockOf(HEX_DIGITS, 8),
    blockOf(HEX_DIGITS, 4),
    blockOf(HEX_DIGITS, 4),
    blockOf(HEX_DIGITS, 4),
    blockOf(HEX_DIGITS, 12)
  )
  .map((groups) => groups.join('-'));

/** `S-1-5-21-<digits>-<digits>-<digits>-<digits>`, e.g. a real WinTAK SID. */
const sidArb = fc
  .tuple(
    fc.constantFrom('S', 's'),
    blockOf(DECIMAL_DIGITS, 1, 10),
    blockOf(DECIMAL_DIGITS, 1, 10),
    blockOf(DECIMAL_DIGITS, 1, 10),
    blockOf(DECIMAL_DIGITS, 1, 4)
  )
  .map(([s, a, b, c, d]) => `${s}-1-5-21-${a}-${b}-${c}-${d}`);

/**
 * `ANDROID-` plus a hex body. The body is hex-and-hyphen ONLY, which is what
 * makes this generator safe as an `android` oracle: `(ETL)` and `(Web)` need
 * parentheses and `CloudTAK` needs `l`, `o`, `u` and `k`, none of which are
 * hex digits, so no body can smuggle in a CloudTAK marker and steal the
 * classification.
 */
const androidArb = fc
  .tuple(fc.constantFrom('ANDROID-', 'android-', 'Android-', 'aNdRoId-'), blockOf(HEX_DIGITS, 1, 20))
  .map(([prefix, body]) => prefix + body);

/** The CloudTAK markers of Rule 1, in assorted cases (Criterion 15.8). */
const markerArb = fc.constantFrom(
  '(ETL)',
  '(etl)',
  '(Etl)',
  '(Web)',
  '(web)',
  '(WEB)',
  'CloudTAK',
  'cloudtak',
  'CLOUDTAK',
  'ClOuDtAk'
);

/** ASCII alphabet for free-form Client_Uids: every character is its own case pair. */
const UID_CHARS = [
  ...'abcdefghijklmnopqrstuvwxyz',
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  ...'0123456789',
  ...'-()@._ ',
];

/** A free-form ASCII Client_Uid. Overwhelmingly `unknown`, occasionally not. */
const plainAsciiArb = fc.string({ unit: fc.constantFrom(...UID_CHARS), maxLength: 40 });

/**
 * Shapes that come CLOSE to a rule and must still be `unknown` (Criterion
 * 15.5: no nudging an unrecognised Client_Uid into a neighbouring category).
 * Includes whitespace-padded UUIDs and SIDs, which `clientType.js`
 * deliberately does not trim.
 */
const nearMissArb = fc.oneof(
  uuidArb.map((uuid) => `${uuid}a`), // one hex digit too many
  uuidArb.map((uuid) => uuid.slice(1)), // one hex digit too few
  uuidArb.map((uuid) => uuid.replace(/-/g, '')), // no group separators
  uuidArb.map((uuid) => ` ${uuid}`), // padded, hence a different identifier
  uuidArb.map((uuid) => `${uuid} `),
  sidArb.map((sid) => sid.replace('S-1-5-21-', 'S-1-5-20-').replace('s-1-5-21-', 's-1-5-20-')),
  sidArb.map((sid) => sid.split('-').slice(0, 7).join('-')), // three digit groups
  sidArb.map((sid) => `${sid}-9`), // five digit groups
  sidArb.map((sid) => ` ${sid}`),
  blockOf(HEX_DIGITS, 1, 20).map((body) => `ANDROID${body}`), // no hyphen after ANDROID
  fc.constantFrom('', ' ', 'ANDROID', 'ANDROID_63040a40563b5fab', 'ETL', 'Web', 'S-1-5-21')
);

/** Everything ASCII, in one arbitrary: the input space of halves 2 and 4. */
const asciiInputArb = fc.oneof(
  { weight: 3, arbitrary: plainAsciiArb },
  { weight: 2, arbitrary: uuidArb },
  { weight: 2, arbitrary: sidArb },
  { weight: 2, arbitrary: androidArb },
  { weight: 2, arbitrary: nearMissArb },
  {
    weight: 3,
    arbitrary: fc
      .tuple(fc.oneof(plainAsciiArb, androidArb, uuidArb, sidArb), markerArb, fc.nat())
      .map(([base, marker, at]) => {
        const cut = base.length === 0 ? 0 : at % (base.length + 1);
        return base.slice(0, cut) + marker + base.slice(cut);
      }),
  }
);

/** Non-string inputs, all of which are `unknown` and none of which may throw. */
const nonStringArb = fc.oneof(
  fc.constant(null),
  fc.constant(undefined),
  fc.integer(),
  fc.double(),
  fc.boolean(),
  fc.object(),
  fc.array(fc.string()),
  fc.constant(Object.create(null)),
  fc.constant(new Date())
);

/** The widest space of half 1: anything at all, plus every targeted shape. */
const anyInputArb = fc.oneof(
  { weight: 3, arbitrary: fc.anything() },
  { weight: 3, arbitrary: fc.string() }, // arbitrary unicode, unrestricted
  { weight: 2, arbitrary: nonStringArb },
  { weight: 6, arbitrary: asciiInputArb }
);

/** Real Client_Uids observed on the live server, per rule. */
const LIVE_CLOUDTAK = [
  'ckadmin (ETL)',
  'etl-fenz-test (ETL)',
  'chris@chriselsen.net (Web)',
  'ANDROID-CloudTAK-chris@chriselsen.net',
];
const LIVE_ANDROID = ['ANDROID-63040a40563b5fab', 'ANDROID-842f08e120efdbe3'];
const LIVE_IOS = [
  'CE17C84D-9700-4080-BA5A-44AF51809453',
  '49902537-1326-443B-9244-8E39B60EC7E6',
  '21E91375-E57E-4BD4-8631-1AA123EB6410',
];
const LIVE_WINDOWS = [
  'S-1-5-21-2281966494-490247268-205662872-1002',
  'S-1-5-21-3905910803-2204963604-4021719043-1001',
  'S-1-5-21-259247192-2041132692-1012567362-500',
];
const LIVE_UIDS = [...LIVE_CLOUDTAK, ...LIVE_ANDROID, ...LIVE_IOS, ...LIVE_WINDOWS];

/** Pinned single-argument examples: every live Client_Uid, plus the odd ones. */
const LIVE_EXAMPLES = [...LIVE_UIDS, '', ' ', 'no-idea-what-this-is'].map((uid) => [uid]);

// Feature: device-management, Property 11: Client_Type classification is total, deterministic, and precedence-correct
describe('Property 11: Client_Type classification is total, deterministic, and precedence-correct', () => {
  test.prop([anyInputArb], { numRuns: 1000, examples: LIVE_EXAMPLES })(
    'returns one of the five Client_Types for absolutely any input, never throws, and returns the same value on a second call',
    (value) => {
      let first;
      expect(() => {
        first = classifyClientType(value);
      }).not.toThrow();

      expect(CLIENT_TYPE_VALUES).toContain(first);
      expect(classifyClientType(value)).toBe(first);
    }
  );

  test.prop([nonStringArb], { numRuns: 200 })(
    'classifies every non-string input as unknown rather than failing (Criterion 15.5)',
    (value) => {
      expect(classifyClientType(value)).toBe(CLIENT_TYPES.UNKNOWN);
    }
  );

  test.prop([asciiInputArb, fc.array(fc.boolean(), { minLength: 1, maxLength: 8 })], {
    numRuns: 500,
    examples: LIVE_UIDS.map((uid) => [uid, [true, false, true, false]]),
  })(
    'classifies a Client_Uid and any re-casing of it identically (Criterion 15.8)',
    (value, upperFlags) => {
      const recased = [...value]
        .map((ch, index) => (upperFlags[index % upperFlags.length] ? ch.toUpperCase() : ch.toLowerCase()))
        .join('');

      // The alphabet is ASCII, so re-casing changes case and nothing else.
      expect(recased).toHaveLength(value.length);
      expect(classifyClientType(recased)).toBe(classifyClientType(value));
    }
  );

  test.prop(
    [
      fc.oneof(
        androidArb.map((base) => ({ base, withoutMarker: CLIENT_TYPES.ANDROID })),
        uuidArb.map((base) => ({ base, withoutMarker: CLIENT_TYPES.IOS })),
        sidArb.map((base) => ({ base, withoutMarker: CLIENT_TYPES.WINDOWS }))
      ),
      markerArb,
      fc.nat(),
    ],
    {
      numRuns: 500,
      examples: [
        [{ base: 'ANDROID-63040a40563b5fab', withoutMarker: CLIENT_TYPES.ANDROID }, 'CloudTAK', 8],
        [{ base: 'ANDROID-842f08e120efdbe3', withoutMarker: CLIENT_TYPES.ANDROID }, '(ETL)', 0],
        [
          { base: 'CE17C84D-9700-4080-BA5A-44AF51809453', withoutMarker: CLIENT_TYPES.IOS },
          '(Web)',
          36,
        ],
        [
          {
            base: 'S-1-5-21-2281966494-490247268-205662872-1002',
            withoutMarker: CLIENT_TYPES.WINDOWS,
          },
          'cloudtak',
          4,
        ],
      ],
    }
  )(
    'lets a CloudTAK marker outrank the Android, iOS and Windows rules wherever it appears (Criterion 15.4)',
    ({ base, withoutMarker }, marker, at) => {
      const cut = at % (base.length + 1);
      const marked = base.slice(0, cut) + marker + base.slice(cut);

      // Same run, so the base is known to classify by its own rule: an
      // implementation testing `ANDROID-` before the CloudTAK markers passes
      // this line and fails the next.
      expect(classifyClientType(base)).toBe(withoutMarker);
      expect(classifyClientType(marked)).toBe(CLIENT_TYPES.CLOUDTAK);
    }
  );

  test.prop(
    [
      fc.oneof(
        markerArb.map((value) => ({ value, expected: CLIENT_TYPES.CLOUDTAK })),
        androidArb.map((value) => ({ value, expected: CLIENT_TYPES.ANDROID })),
        uuidArb.map((value) => ({ value, expected: CLIENT_TYPES.IOS })),
        sidArb.map((value) => ({ value, expected: CLIENT_TYPES.WINDOWS })),
        nearMissArb.map((value) => ({ value, expected: CLIENT_TYPES.UNKNOWN }))
      ),
    ],
    {
      numRuns: 500,
      examples: [
        ...LIVE_CLOUDTAK.map((value) => [{ value, expected: CLIENT_TYPES.CLOUDTAK }]),
        ...LIVE_ANDROID.map((value) => [{ value, expected: CLIENT_TYPES.ANDROID }]),
        ...LIVE_IOS.map((value) => [{ value, expected: CLIENT_TYPES.IOS }]),
        ...LIVE_WINDOWS.map((value) => [{ value, expected: CLIENT_TYPES.WINDOWS }]),
      ],
    }
  )('classifies each rule\'s own shape by that rule (Criteria 15.3, 15.5)', ({ value, expected }) => {
    expect(classifyClientType(value)).toBe(expected);
  });

  test.prop([asciiInputArb], { numRuns: 1000, examples: LIVE_EXAMPLES })(
    'agrees with the requirement text read independently of the implementation (Criterion 15.3)',
    (value) => {
      expect(classifyClientType(value)).toBe(expectedClientType(value));
    }
  );
});
