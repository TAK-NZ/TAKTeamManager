const {
  CLOUDTAK_CONNECTION_PREFIX,
  candidateClientUids,
  unionCandidateClientUids
} = require('./connectionAlias');

/**
 * device-management task 30.5: the concrete, readable example tests for the
 * Connection_Alias derivation (Requirements 22.1, 22.2, 22.3, 22.7, 22.12).
 *
 * Division of labour with the sibling files, following the pattern
 * `clientType.test.js` / `clientType.property.test.js` set:
 *
 *   - `./connectionAlias.property.test.js` (task 30.6, Property 18) quantifies
 *     totality, purity, additivity, the exactly-one/exactly-three counts and the
 *     sweep union over generated inputs.
 *   - THIS file is what a reader reaches for to answer "what does
 *     `ANDROID-CloudTAK-chris@chriselsen.net` derive, and why" without decoding
 *     a generator: the three live examples named in Requirement 22.12, plus the
 *     boundaries a naive implementation gets wrong.
 *   - `../services/__tests__/SubscriptionPoller.test.js` asserts the two
 *     statements the poller builds from these candidates.
 *
 * Nothing is mocked, because there is nothing to mock -- Criterion 22.1 makes
 * this a pure function of the reported uid alone.
 */

// The Client_Uids and reported uids observed on the live TAK Server. These are
// the examples the requirement text names, so a change that breaks one breaks a
// documented case rather than a synthetic one.
const LIVE = Object.freeze({
  NATIVE_ANDROID_UID: 'ANDROID-63040a40563b5fab',
  CLOUDTAK_WEB_REPORTED: 'ANDROID-CloudTAK-chris@chriselsen.net',
  CLOUDTAK_WEB_CLIENT_UID: 'chris@chriselsen.net (Web)',
  CLOUDTAK_ETL_REPORTED: 'ANDROID-CloudTAK-ckadmin',
  CLOUDTAK_ETL_CLIENT_UID: 'ckadmin (ETL)'
});

describe('CLOUDTAK_CONNECTION_PREFIX', () => {
  it('is the literal upstream CloudTAK puts in front of the account identifier', () => {
    // `api/common/connection-config.ts:170`, `ANDROID-CloudTAK-${email}`.
    expect(CLOUDTAK_CONNECTION_PREFIX).toBe('ANDROID-CloudTAK-');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Requirement 22.12: the three live examples.
// ══════════════════════════════════════════════════════════════════════════
describe('candidateClientUids over the live examples (Requirement 22.12)', () => {
  /**
   * The arm that protects every native Device: one candidate, the reported uid,
   * which is the same match the poller made before the alias existed
   * (Requirements 22.2, 22.9).
   */
  it('derives EXACTLY ONE candidate -- the uid alone -- for a native ATAK uid', () => {
    expect(candidateClientUids(LIVE.NATIVE_ANDROID_UID)).toEqual([LIVE.NATIVE_ANDROID_UID]);
  });

  it('derives EXACTLY THREE candidates including `chris@chriselsen.net (Web)` for the measured defect', () => {
    const candidates = candidateClientUids(LIVE.CLOUDTAK_WEB_REPORTED);

    // The exact array, in order: reported uid, `(Web)`, `(ETL)` (Requirement
    // 22.3 -- both suffixes, since the reported uid carries no evidence of
    // which enrollment path minted the certificate).
    expect(candidates).toEqual([
      LIVE.CLOUDTAK_WEB_REPORTED,
      LIVE.CLOUDTAK_WEB_CLIENT_UID,
      'chris@chriselsen.net (ETL)'
    ]);
    // Named separately because this membership IS the defect being closed.
    expect(candidates).toContain(LIVE.CLOUDTAK_WEB_CLIENT_UID);
  });

  it('derives EXACTLY THREE candidates including `ckadmin (ETL)` for the ETL-enrolled account', () => {
    const candidates = candidateClientUids(LIVE.CLOUDTAK_ETL_REPORTED);

    expect(candidates).toEqual([
      LIVE.CLOUDTAK_ETL_REPORTED,
      'ckadmin (Web)',
      LIVE.CLOUDTAK_ETL_CLIENT_UID
    ]);
    expect(candidates).toContain(LIVE.CLOUDTAK_ETL_CLIENT_UID);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Requirement 22.2: the prefix test is case-insensitive, the base is not.
// ══════════════════════════════════════════════════════════════════════════
describe('candidateClientUids compares the prefix case-insensitively but preserves the base (Requirement 22.2)', () => {
  it.each([
    ['all lower case', 'android-cloudtak-'],
    ['mixed case', 'ANDROID-cloudTAK-'],
    ['all upper case', 'ANDROID-CLOUDTAK-'],
    ['inverted case', 'android-CLOUDtak-']
  ])('recognises a %s prefix', (_label, prefix) => {
    const reportedUid = `${prefix}Chris.Elsen@Example.NET`;

    expect(candidateClientUids(reportedUid)).toEqual([
      reportedUid,
      'Chris.Elsen@Example.NET (Web)',
      'Chris.Elsen@Example.NET (ETL)'
    ]);
  });

  /**
   * The assertion a count-only test would miss. `client_uid` matching in
   * Postgres is case-SENSITIVE, so an implementation that lowercases the whole
   * uid to test the prefix and then suffixes the lowercased remainder builds a
   * base that matches no row -- it would pass "exactly three candidates" while
   * fixing nothing.
   */
  it('does not lowercase the base it suffixes', () => {
    const candidates = candidateClientUids('android-cloudtak-MixedCase@Example.NET');

    expect(candidates).toContain('MixedCase@Example.NET (Web)');
    expect(candidates).toContain('MixedCase@Example.NET (ETL)');
    expect(candidates).not.toContain('mixedcase@example.net (Web)');
    expect(candidates).not.toContain('mixedcase@example.net (ETL)');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Requirements 22.1, 22.2: the two boundaries that look like invitations to be
// clever. Both must be left exactly as they are.
// ══════════════════════════════════════════════════════════════════════════
describe('candidateClientUids at the awkward boundaries (Requirements 22.1, 22.2)', () => {
  /**
   * TRAP 1. The uid that IS the prefix has an empty base. It stays total and
   * still yields exactly three candidates -- NOT special-cased down to one,
   * which would make the code and Property 18 disagree. What keeps it safe is
   * exact equality: ` (Web)` can only ever reach a row whose `client_uid` is
   * that exact string.
   */
  it('returns three candidates, without throwing, for a uid that is exactly the prefix', () => {
    expect(() => candidateClientUids(CLOUDTAK_CONNECTION_PREFIX)).not.toThrow();
    expect(candidateClientUids(CLOUDTAK_CONNECTION_PREFIX)).toEqual([
      CLOUDTAK_CONNECTION_PREFIX,
      ' (Web)',
      ' (ETL)'
    ]);
  });

  /**
   * TRAP 2. A base that ALREADY ends in a Certificate_Uid_Suffix is neither
   * stripped, nor deduplicated, nor single-suffixed: the rule is a plain
   * concatenation. The doubled strings match no row, which is the correct
   * outcome for a uid shape upstream does not produce -- any cleverness here is
   * a way for a candidate to land on a row it does not name (Requirement 22.7).
   */
  it.each([
    ['(ETL)', 'ANDROID-CloudTAK-ckadmin (ETL)', 'ckadmin (ETL)'],
    ['(Web)', 'ANDROID-CloudTAK-chris@chriselsen.net (Web)', 'chris@chriselsen.net (Web)']
  ])('neither strips nor collapses a base already ending in %s', (_label, reportedUid, base) => {
    const candidates = candidateClientUids(reportedUid);

    expect(candidates).toEqual([reportedUid, `${base} (Web)`, `${base} (ETL)`]);
    // Not single-suffixed, and the existing suffix was not consumed: the bare
    // base is NOT a candidate on its own.
    expect(candidates).toHaveLength(3);
    expect(candidates).not.toContain(base);
  });

  /**
   * Requirement 22.1 / 3.8: this runs inside a poll loop that must never
   * throw, so every input yields a defined value. A non-string has no reported
   * uid string to try, so it yields the empty array.
   */
  it.each([
    ['the empty string', '', ['']],
    ['null', null, []],
    ['undefined', undefined, []],
    ['a number', 42, []],
    ['NaN', NaN, []],
    ['an object', { uid: 'ANDROID-CloudTAK-x' }, []],
    ['an array', ['ANDROID-CloudTAK-x'], []],
    ['a boolean', true, []]
  ])('is total for %s', (_label, input, expected) => {
    expect(() => candidateClientUids(input)).not.toThrow();
    expect(candidateClientUids(input)).toEqual(expected);
  });

  it('is pure: the same input yields an equal array and no input is mutated', () => {
    const reportedUid = LIVE.CLOUDTAK_WEB_REPORTED;
    const first = candidateClientUids(reportedUid);
    const second = candidateClientUids(reportedUid);

    expect(second).toEqual(first);
    // A fresh array each call, so a caller mutating one cannot poison the next.
    expect(second).not.toBe(first);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Requirement 22.7: every candidate is a complete `client_uid` for equality
// matching -- never a pattern.
// ══════════════════════════════════════════════════════════════════════════
describe('candidateClientUids emits exact strings, never patterns (Requirement 22.7)', () => {
  it.each([
    LIVE.NATIVE_ANDROID_UID,
    LIVE.CLOUDTAK_WEB_REPORTED,
    LIVE.CLOUDTAK_ETL_REPORTED,
    CLOUDTAK_CONNECTION_PREFIX
  ])('emits no wildcard or LIKE metacharacter for %s', (reportedUid) => {
    for (const candidate of candidateClientUids(reportedUid)) {
      expect(typeof candidate).toBe('string');
      expect(candidate).not.toContain('%');
      expect(candidate).not.toContain('_%');
      expect(candidate).not.toMatch(/LIKE/i);
    }
  });

  /**
   * One user's connection must never reach another user's Device row. A
   * candidate's base IS the account identifier the connection belongs to, so a
   * different account's `client_uid` is not among them -- which only holds
   * because matching is by equality and never by prefix or substring.
   */
  it('does not derive another account\'s client_uid', () => {
    const candidates = candidateClientUids(LIVE.CLOUDTAK_WEB_REPORTED);

    expect(candidates).not.toContain(LIVE.CLOUDTAK_ETL_CLIENT_UID);
    expect(candidates).not.toContain('ckadmin (Web)');
    // And no candidate is a proper prefix of another account's row key, which is
    // what a `LIKE`-based implementation would have made reachable.
    for (const candidate of candidates) {
      expect(LIVE.CLOUDTAK_ETL_CLIENT_UID.startsWith(candidate)).toBe(false);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Requirement 22.6: the union handed to the unreported sweep.
// ══════════════════════════════════════════════════════════════════════════
describe('unionCandidateClientUids (Requirement 22.6)', () => {
  it('is exactly the reported set, in the order given, for a native-only payload', () => {
    const reported = ['ANDROID-63040a40563b5fab', 'ANDROID-842f08e120efdbe3'];

    // The no-op that makes this change invisible to native Devices.
    expect(unionCandidateClientUids(reported)).toEqual(reported);
  });

  it('collapses the duplicate entries TAK Server reports per uid', () => {
    // The live shape: one client reported four times under different callsigns.
    expect(unionCandidateClientUids(['uid-a', 'uid-a', 'uid-b', 'uid-a'])).toEqual(['uid-a', 'uid-b']);
  });

  it('contains every candidate of every entry, first-seen ordered, for a mixed payload', () => {
    expect(
      unionCandidateClientUids([
        LIVE.NATIVE_ANDROID_UID,
        LIVE.CLOUDTAK_WEB_REPORTED,
        LIVE.CLOUDTAK_ETL_REPORTED
      ])
    ).toEqual([
      LIVE.NATIVE_ANDROID_UID,
      LIVE.CLOUDTAK_WEB_REPORTED,
      LIVE.CLOUDTAK_WEB_CLIENT_UID,
      'chris@chriselsen.net (ETL)',
      LIVE.CLOUDTAK_ETL_REPORTED,
      'ckadmin (Web)',
      LIVE.CLOUDTAK_ETL_CLIENT_UID
    ]);
  });

  it.each([
    ['a non-array', 'ANDROID-CloudTAK-x'],
    ['null', null],
    ['undefined', undefined]
  ])('is total for %s', (_label, input) => {
    expect(() => unionCandidateClientUids(input)).not.toThrow();
    expect(unionCandidateClientUids(input)).toEqual([]);
  });

  it('lets unusable members contribute nothing rather than raising', () => {
    expect(unionCandidateClientUids([null, 'uid-a', undefined, 42, {}])).toEqual(['uid-a']);
  });

  it('treats a uid such as `__proto__` as an ordinary key', () => {
    expect(unionCandidateClientUids(['__proto__', 'constructor'])).toEqual(['__proto__', 'constructor']);
  });
});
