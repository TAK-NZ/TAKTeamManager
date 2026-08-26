// Feature: takserver-enrollment, Property 6: The enrollment payloads are structurally exact and agree on the host, for every principal
//
// **Validates: Requirements 3.1, 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.8, 15.7**

/**
 * takserver-enrollment task 7.5: the single fast-check property test for
 * design.md's Property 6 (Requirements 3.1, 4.1, 4.2, 4.3, 4.4, 4.5, 4.6,
 * 4.8, 15.7).
 *
 * The subject is `DeviceEnrollmentService.buildItakRegistrationPayload` and
 * `DeviceEnrollmentService.buildAtakEnrollmentUri` -- two PUBLIC, pure,
 * static builders, called directly rather than through either public
 * service entry point (`generateSelfEnrollment` /
 * `generateEnrollmentQrCode`). Both builders take only
 * `(host, username, tokenKey[, registrationId])` and have no notion of
 * Enrollment_Principal at all: neither accepts a `principalKind` argument,
 * neither branches on one internally, and `#buildEnrollment` (the private
 * core that DOES know about principals) calls both with the exact same
 * three positional arguments regardless of whether it was reached from the
 * self-service path or the device path. "Crossed with both
 * Enrollment_Principals" is therefore satisfied by the fact that calling
 * the builders directly, with no principal-kind parameter anywhere in their
 * signature, IS the principal-agnostic case -- there is no second code path
 * per principal for this property to cross against. Likewise "the payload
 * is identical whichever public entry point produced it" (the last bullet
 * of design.md's Property 6) reduces to: the builder's output is a pure
 * function of its four parameters and nothing else, which is definitionally
 * true of a pure static function with no other inputs (no `this`, no
 * closed-over mutable state, no I/O) -- exercising the two full service
 * entry points and diffing their output is deliberately left to task 7.6's
 * example tests, which exercise `#buildEnrollment` end to end.
 *
 * Every expected value below is constructed LITERALLY in this file from the
 * generated host/username/tokenKey/registrationId, never by calling either
 * builder and comparing it to itself: `connectionString` is re-typed as
 * `` `${host}:8089:ssl` `` (not `ENROLLMENT_PORT`), and the ATAK URI is
 * re-typed with `encodeURIComponent` applied directly to each of the three
 * inputs, matching Criterion 4.7's construction. Independent re-derivation
 * is the point of this test; a test that builds its expectation with the
 * function under test would assert only determinism.
 *
 * The host/username/tokenKey generator concentrates on the hostile shapes
 * Property 6 names: colons, double and single quotes, backslashes,
 * non-ASCII characters (emoji, accented Latin, CJK), the empty string, and
 * strings longer than 1000 characters -- crossed with a broad arbitrary
 * string arm so the property is not boundary-only.
 *
 * An anti-vacuity module-level counter confirms at least one generated host
 * across the whole run actually contained a colon: a colon in the host is
 * exactly what would break a naive `split(':')` reading of
 * `connectionString`, so a generator that never produced one would leave
 * the interesting case untested.
 */

const fc = require('fast-check');
const { test } = require('@fast-check/jest');

const DeviceEnrollmentService = require('../DeviceEnrollmentService');

const { buildItakRegistrationPayload, buildAtakEnrollmentUri } = DeviceEnrollmentService;

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/** Uuid-shape regex, written out literally rather than imported. */
const UUID_SHAPE_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Emoji, accented Latin, CJK -- the non-ASCII shapes Property 6 names. */
const NON_ASCII_SNIPPETS = ['🚀', '🔥', 'é', 'ü', 'ñ', '漢字', 'こんにちは', '中文测试'];

/** Colons, quotes, backslashes -- the hostile-punctuation shapes Property 6 names. */
const HOSTILE_PUNCTUATION_SNIPPETS = [':', '::', '"', "'", '\\', ':"\'\\', 'a:b:c', '\\"\'\\:'];

const longStringArb = fc
  .array(fc.constantFrom('x', 'y', 'z', '0', '-', '.'), { minLength: 1001, maxLength: 1200 })
  .map((chars) => chars.join(''));

const hostileSnippetArb = fc.oneof(
  fc.constantFrom(...NON_ASCII_SNIPPETS),
  fc.constantFrom(...HOSTILE_PUNCTUATION_SNIPPETS)
);

/** A hostile string: some plain text, salted with a colon/quote/backslash/non-ASCII snippet. */
const hostileStringArb = fc
  .tuple(fc.string({ maxLength: 20 }), hostileSnippetArb, fc.string({ maxLength: 20 }))
  .map(([before, snippet, after]) => `${before}${snippet}${after}`);

/**
 * One string value, drawn from the full space Property 6 names: the empty
 * string, a hostile-punctuation/non-ASCII salted string, a string longer
 * than 1000 characters, and a broad arbitrary arm so the property is not
 * boundary-only.
 */
const valueArb = fc.oneof(
  { weight: 2, arbitrary: fc.constant('') },
  { weight: 4, arbitrary: hostileStringArb },
  { weight: 2, arbitrary: longStringArb },
  { weight: 3, arbitrary: fc.string() }
);

/** A triple of (host, username, tokenKey), each independently hostile-or-plain. */
const tripleArb = fc.record({
  host: valueArb,
  username: valueArb,
  tokenKey: valueArb
});

// ---------------------------------------------------------------------------
// Anti-vacuity tracking
// ---------------------------------------------------------------------------

let sawColonInHost = false;

function recordHost(host) {
  if (host.includes(':')) {
    sawColonInHost = true;
  }
}

// ---------------------------------------------------------------------------
// Independent re-derivation helpers -- literal construction, never a call to
// the subject compared to itself.
// ---------------------------------------------------------------------------

/** Re-derives the expected connectionString, written out literally (not via ENROLLMENT_PORT). */
function expectedConnectionString(host) {
  return `${host}:8089:ssl`;
}

/** Re-derives the expected ATAK_Enrollment_Uri, matching Criterion 4.7's construction exactly. */
function expectedAtakUri(host, username, tokenKey) {
  return `tak://com.atakmap.app/enroll?host=${encodeURIComponent(host)}` +
    `&username=${encodeURIComponent(username)}` +
    `&token=${encodeURIComponent(tokenKey)}`;
}

// Feature: takserver-enrollment, Property 6: The enrollment payloads are structurally exact and agree on the host, for every principal
describe('Property 6: The enrollment payloads are structurally exact and agree on the host, for every principal', () => {
  test.prop([tripleArb], { numRuns: 300 })(
    'produces the exact iTAK_Registration_Payload key set and values, for every generated triple',
    ({ host, username, tokenKey }) => {
      recordHost(host);

      const payload = buildItakRegistrationPayload(host, username, tokenKey);

      // 1. Exact top-level key set -- no extra key, no missing key.
      expect(Object.keys(payload).sort()).toEqual(
        ['passphrase', 'serverCredentials', 'type', 'userCredentials'].sort()
      );

      // 2. Exact serverCredentials key set.
      expect(Object.keys(payload.serverCredentials).sort()).toEqual(['connectionString'].sort());

      // 3. Exact userCredentials key set -- confirms NO `token` key anywhere.
      expect(Object.keys(payload.userCredentials).sort()).toEqual(
        ['password', 'registrationId', 'username'].sort()
      );
      expect(payload.token).toBeUndefined();
      expect(payload.serverCredentials.token).toBeUndefined();
      expect(payload.userCredentials.token).toBeUndefined();

      // 4. passphrase is the exact STRING "false", never the boolean.
      expect(typeof payload.passphrase).toBe('string');
      expect(payload.passphrase).toBe('false');
      expect(payload.passphrase).not.toBe(false);

      // 5. connectionString, re-derived literally -- never via ENROLLMENT_PORT.
      expect(payload.serverCredentials.connectionString).toBe(expectedConnectionString(host));

      // 6. password equals the input tokenKey exactly.
      expect(payload.userCredentials.password).toBe(tokenKey);
      expect(payload.userCredentials.username).toBe(username);

      // 7. Round-trip safety: no value vanishes or changes across JSON serialization.
      expect(JSON.parse(JSON.stringify(payload))).toEqual(payload);

      // 8. Cross-check: the host embedded in connectionString (stripping the
      // known ':8089:ssl' suffix) equals the host passed to
      // buildAtakEnrollmentUri for the SAME triple -- the two builders never
      // disagree about which host they were given.
      const atakUri = buildAtakEnrollmentUri(host, username, tokenKey);
      const embeddedHost = payload.serverCredentials.connectionString.slice(
        0,
        payload.serverCredentials.connectionString.length - ':8089:ssl'.length
      );
      const uriHostParam = new URL(atakUri.replace('tak://', 'https://')).searchParams.get('host');
      expect(embeddedHost).toBe(host);
      expect(uriHostParam).toBe(host);
    }
  );

  test.prop([tripleArb], { numRuns: 300 })(
    'two invocations with identical inputs and a defaulted registrationId differ ONLY in registrationId, both uuid-shaped',
    ({ host, username, tokenKey }) => {
      recordHost(host);

      // 9. Neither call passes a fourth argument, so crypto.randomUUID()'s
      // default fires fresh on each call.
      const first = buildItakRegistrationPayload(host, username, tokenKey);
      const second = buildItakRegistrationPayload(host, username, tokenKey);

      expect(first.userCredentials.registrationId).not.toBe(second.userCredentials.registrationId);
      expect(UUID_SHAPE_REGEX.test(first.userCredentials.registrationId)).toBe(true);
      expect(UUID_SHAPE_REGEX.test(second.userCredentials.registrationId)).toBe(true);

      // Every other field matches between the two calls.
      expect(first.passphrase).toBe(second.passphrase);
      expect(first.type).toBe(second.type);
      expect(first.serverCredentials).toEqual(second.serverCredentials);
      expect(first.userCredentials.username).toBe(second.userCredentials.username);
      expect(first.userCredentials.password).toBe(second.userCredentials.password);
    }
  );

  // 10. "The payload is identical whichever public entry point produced it"
  // (design.md Property 6's final bullet): since this test exercises the
  // pure builder directly rather than the two full service entry points,
  // this is satisfied by construction -- buildItakRegistrationPayload is a
  // static function with no `this`, no closed-over mutable state, and no
  // I/O, taking only (host, username, tokenKey, registrationId). Its output
  // is therefore, definitionally, a pure function of those four parameters
  // alone: two calls made with the same four arguments -- regardless of
  // which "entry point" a caller imagines reached them -- return the same
  // value. Asserted directly here rather than by invoking
  // generateSelfEnrollment/generateEnrollmentQrCode, which task 7.6's
  // example tests exercise end to end.
  test.prop([tripleArb, fc.uuid()], { numRuns: 200 })(
    'is a pure function of its four parameters alone: an identical registrationId argument yields byte-identical output',
    ({ host, username, tokenKey }, registrationId) => {
      recordHost(host);

      const first = buildItakRegistrationPayload(host, username, tokenKey, registrationId);
      const second = buildItakRegistrationPayload(host, username, tokenKey, registrationId);

      expect(first).toEqual(second);
      expect(first.userCredentials.registrationId).toBe(registrationId);
    }
  );

  test.prop([tripleArb], { numRuns: 300 })(
    'produces the exact ATAK_Enrollment_Uri construction, for the same generated triples',
    ({ host, username, tokenKey }) => {
      recordHost(host);

      const uri = buildAtakEnrollmentUri(host, username, tokenKey);

      expect(uri).toBe(expectedAtakUri(host, username, tokenKey));
    }
  );

  it('exercised at least one generated host containing a colon (anti-vacuity)', () => {
    expect(sawColonInHost).toBe(true);
  });
});
