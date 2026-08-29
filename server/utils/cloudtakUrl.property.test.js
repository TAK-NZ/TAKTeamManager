// Feature: downloads-page-os-sections, Property 1: CLOUDTAK_URL resolution is a total function partitioned exactly into "exact passthrough" and "null"
//
// **Validates: Requirements 5.1, 5.2, 5.3**

/**
 * downloads-page-os-sections task 1.2: the single fast-check property test
 * for design.md's Property 1 (Requirements 5.1, 5.2, 5.3).
 *
 * design.md's exact Property 1 statement: "For any string value -- including
 * the empty string, strings of only whitespace characters, syntactically
 * malformed URLs, absolute URLs with a scheme other than `http`/`https` (any
 * case), absolute `http`/`https` URLs with an empty host, and syntactically
 * valid absolute `http`/`https` URLs with a non-empty host in any
 * combination of path/query/port/case-of-scheme/userinfo -- `resolveCloudTakUrl`
 * SHALL never throw, and SHALL return either `null` or the exact, unmodified
 * input string; it SHALL return `null` for every case in the first group
 * above and the exact input string, character-for-character, for every case
 * in the second group."
 *
 * Structure mirrors `authentikEmail.property.test.js`:
 *
 *   1. TOTALITY AND SHAPE -- the widest input space, including non-string
 *      values even though the declared parameter type is a string: never
 *      throws, and the return is either `null` or the exact input reference
 *      back (never a re-serialized/trimmed copy).
 *   2. INDEPENDENT RE-DERIVATION -- every input compared against
 *      `expectedResolve` below, an oracle written directly against Node's
 *      own `URL` constructor and `.protocol`/`.hostname`, never by calling
 *      `resolveCloudTakUrl` and comparing it to itself.
 *   3. BOUNDARY CONCENTRATION -- an `fc.oneof` mixing whitespace-only
 *      strings, malformed strings, non-http(s) absolute URLs (with scheme
 *      case variants), empty-host `http(s)` URLs, valid `http`/`https` URLs
 *      varied across scheme case/port/userinfo/path/query/fragment/
 *      IPv4/IPv6/hostname forms, and a broad `fc.string()` arm.
 *
 * A pair of module-scoped flags (`sawNullResult` / `sawNonNullResult`) is set
 * from inside the totality block and asserted in a trailing `it()`, so the
 * whole property cannot pass vacuously by only ever exercising one side of
 * the null / non-null split.
 */

const fc = require('fast-check');
const { test } = require('@fast-check/jest');

const { resolveCloudTakUrl } = require('./cloudtakUrl');

// ---------------------------------------------------------------------------
// Oracle -- Criteria 5.1-5.3's text restated directly against Node's own
// `URL` constructor, independent of the module under test.
// ---------------------------------------------------------------------------

/**
 * Re-derives the expected result directly from Criteria 5.1-5.3: `null` for
 * any non-string, for a whitespace-only string (including `''`), for a
 * string that fails to parse as a `URL`, for a parsed URL whose protocol is
 * not exactly `http:`/`https:`, or for a parsed URL with an empty hostname;
 * otherwise the exact, unmodified input string. Uses `new URL(...)` and its
 * own `.protocol`/`.hostname` getters directly, rather than the subject's
 * internal logic, so agreement is evidence rather than a restatement of the
 * implementation.
 *
 * @param {*} value
 * @returns {string|null}
 */
function expectedResolve(value) {
  if (typeof value !== 'string') return null;
  if (value.trim() === '') return null;

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (parsed.hostname === '') return null;

  return value;
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/** Whitespace characters JavaScript's `.trim()` strips (same set as authentikEmail's). */
const WHITESPACE_CHARS = [
  ' ',
  '\t',
  '\n',
  '\r',
  '\v',
  '\f',
  '\u00A0',
  '\u2028',
  '\u2029',
  '\u3000',
  '\u2003',
  '\u2009',
  '\uFEFF'
];

const whitespaceCharArb = fc.constantFrom(...WHITESPACE_CHARS);

/** (a) A whitespace-only string of arbitrary length and composition, including `''`. */
const whitespaceOnlyStringArb = fc
  .array(whitespaceCharArb, { minLength: 0, maxLength: 40 })
  .map((chars) => chars.join(''));

/** (b) Syntactically malformed strings -- no scheme, no colon, or otherwise unparseable as a URL. */
const malformedStringArb = fc.oneof(
  fc.constant('not a url'),
  fc.constant('example.com'),
  fc.constant('/relative/path'),
  fc.constant('://missing-scheme'),
  fc.constant('http//missing-colon'),
  fc.constant('https:// '), // whitespace-only authority - fails to parse
  fc.constant('https://:8080/path'), // empty host with explicit port - fails to parse
  fc.string().filter((s) => !s.includes(':'))
);

/** (c) Non-http(s) absolute URLs, including case variants of the scheme. */
const nonHttpSchemeArb = fc.constantFrom(
  'ftp',
  'FTP',
  'Ftp',
  'javascript',
  'JAVASCRIPT',
  'JavaScript',
  'mailto',
  'MAILTO',
  'data',
  'DATA',
  'file',
  'ws'
);
const nonHttpSchemeUrlArb = fc.oneof(
  fc
    .tuple(nonHttpSchemeArb, fc.constantFrom('example.com', 'host.internal:8080/path'))
    .map(([scheme, rest]) => `${scheme}://${rest}`),
  fc.constant('javascript:alert(1)'),
  fc.constant('mailto:a@b.example.com'),
  fc.constant('data:text/plain,hello')
);

/** (d) Empty-host `http(s)` URLs -- syntactically valid but an empty authority. */
const emptyHostUrlArb = fc
  .tuple(fc.constantFrom('http', 'https', 'HTTP', 'HTTPS'), fc.constantFrom('path', 'a/b', 'no-host', ''))
  .map(([scheme, path]) => `${scheme}:///${path}`);

/**
 * (e) Syntactically valid `http`/`https` URLs varied across scheme case,
 * port, userinfo, path, query, fragment, and IPv4/IPv6/hostname forms.
 * Built on fast-check's own `webUrl` generator (with every optional
 * authority/query/fragment feature turned on) plus a scheme-case remap,
 * since `webUrl` always lowercases its scheme.
 */
const validHttpUrlArb = fc
  .tuple(
    fc.webUrl({
      validSchemes: ['http', 'https'],
      withQueryParameters: true,
      withFragments: true,
      authoritySettings: {
        withIPv4: true,
        withIPv6: true,
        withUserInfo: true,
        withPort: true
      }
    }),
    fc.constantFrom('lower', 'upper', 'mixed')
  )
  .map(([url, caseVariant]) => {
    if (caseVariant === 'lower') return url;
    const sepIndex = url.indexOf('://');
    const scheme = url.slice(0, sepIndex);
    const rest = url.slice(sepIndex);
    const casedScheme = caseVariant === 'upper' ? scheme.toUpperCase() : scheme[0].toUpperCase() + scheme.slice(1);
    return `${casedScheme}${rest}`;
  });

/** The full boundary-concentrated input space (f) plus arms (a)-(e) above. */
const boundaryConcentratedArb = fc.oneof(
  { weight: 3, arbitrary: whitespaceOnlyStringArb },
  { weight: 3, arbitrary: malformedStringArb },
  { weight: 3, arbitrary: nonHttpSchemeUrlArb },
  { weight: 3, arbitrary: emptyHostUrlArb },
  { weight: 4, arbitrary: validHttpUrlArb },
  { weight: 3, arbitrary: fc.string() }
);

/** Non-string primitives and exotic values, for the totality check. */
const nonStringPrimitiveArb = fc.oneof(
  fc.constant(null),
  fc.constant(undefined),
  fc.constant(NaN),
  fc.constant(Infinity),
  fc.constant(-Infinity),
  fc.constant(0),
  fc.constant(-0),
  fc.double(),
  fc.integer(),
  fc.boolean(),
  fc.constant(Symbol('probe')),
  fc.bigInt()
);

/** Non-string object/array shapes. */
const nonStringObjectArb = fc.oneof(fc.array(fc.anything()), fc.object(), fc.constant(Object.create(null)));

/** Full totality input space: every string-shaped arm above, plus non-strings. */
const totalityArb = fc.oneof(
  { weight: 6, arbitrary: boundaryConcentratedArb },
  { weight: 2, arbitrary: nonStringPrimitiveArb },
  { weight: 2, arbitrary: nonStringObjectArb }
);

// ---------------------------------------------------------------------------
// Anti-vacuity flags, asserted in the trailing `it()` below.
// ---------------------------------------------------------------------------

let sawNullResult = false;
let sawNonNullResult = false;

// Feature: downloads-page-os-sections, Property 1: CLOUDTAK_URL resolution is a total function partitioned exactly into "exact passthrough" and "null"
describe('Property 1: CLOUDTAK_URL resolution is a total function partitioned exactly into "exact passthrough" and "null"', () => {
  test.prop([totalityArb], { numRuns: 300 })(
    'never throws, and returns either null or the exact, unmodified input string, for any input including non-strings',
    (value) => {
      let result;
      expect(() => {
        result = resolveCloudTakUrl(value);
      }).not.toThrow();

      if (result === null) {
        sawNullResult = true;
      } else {
        // Exact passthrough only: the identical string, never a
        // re-serialized or trimmed copy, and (since the input is
        // necessarily a string on this branch) never anything but a string.
        expect(typeof value).toBe('string');
        expect(result).toBe(value);
        sawNonNullResult = true;
      }
    }
  );

  test.prop([boundaryConcentratedArb], { numRuns: 300 })(
    'agrees with the independently re-derived URL-based rule from Criteria 5.1-5.3, for boundary-concentrated string inputs',
    (value) => {
      expect(resolveCloudTakUrl(value)).toBe(expectedResolve(value));
    }
  );

  test.prop([totalityArb], { numRuns: 300 })(
    'agrees with the independently re-derived rule across the full totality input space',
    (value) => {
      expect(resolveCloudTakUrl(value)).toBe(expectedResolve(value));
    }
  );

  it('exercised at least one input landing on each side of the null / non-null split (anti-vacuity)', () => {
    expect(sawNullResult).toBe(true);
    expect(sawNonNullResult).toBe(true);
  });
});
