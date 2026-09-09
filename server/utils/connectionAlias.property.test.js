/**
 * device-management task 30.6: the single fast-check property test for
 * design.md's Property 18 (Requirements 22.1, 22.2, 22.3, 22.6, 22.7, 22.9,
 * 22.12).
 *
 * design.md's exact Property 18 statement: "For all reported
 * `ClientEndpoint.uid` values -- including the empty string, the
 * CloudTAK_Connection_Prefix with nothing after it, prefixed uids whose base
 * already ends in ` (Web)` or ` (ETL)`, the prefix in arbitrary mixed case, and
 * arbitrary strings carrying no prefix -- the Connection_Alias derivation SHALL
 * return a value rather than raising, and SHALL be a pure function of its input
 * alone; the reported uid SHALL be a member of the returned
 * Candidate_Client_Uids for every input; a uid that does not begin with the
 * CloudTAK_Connection_Prefix compared case-insensitively SHALL yield EXACTLY one
 * candidate, that uid alone, so no native ATAK, iTAK or WinTAK Device's match is
 * altered; a uid that does begin with that prefix SHALL yield EXACTLY three
 * candidates -- the reported uid itself, `<base> (Web)`, and `<base> (ETL)`,
 * where `<base>` is the remainder of the uid after the prefix; every candidate
 * SHALL be an exact complete `client_uid` string used for equality matching, so
 * no candidate stands in a proper-prefix or substring relationship to a row key
 * in place of equality and no candidate is a pattern; and for all
 * Client_Endpoints_API payloads, the reported set handed to the Criterion 20.6
 * unreported sweep SHALL contain every candidate of every reported entry, so no
 * row a reported entry just marked connected can be swept back to not connected
 * within the same poll."
 *
 * The property is split into the arms of that sentence, each with its own
 * generator, because one arbitrary wide enough for all of them would exercise
 * none of them often enough to matter:
 *
 *   1. TOTALITY and PURITY -- the widest input space, `fc.anything()` included,
 *      so `null`, numbers, objects and arrays are covered. Purity is asserted as
 *      "equal result on a repeat call, and a FRESH array each time", so a
 *      caller mutating what it got back cannot poison the next caller, and no
 *      hidden state accumulates across the interleaved calls this arm makes.
 *   2. ADDITIVITY -- the reported uid is a member of the candidates for every
 *      string input, and is FIRST, which is what makes the alias additive rather
 *      than a replacement (Requirements 22.2, 22.9).
 *   3. EXACTLY ONE for an unprefixed uid, drawn often enough that this arm is
 *      genuinely exercised: it is the arm that protects every native Device.
 *   4. EXACTLY THREE for a prefixed uid, with the base and the prefix's casing
 *      generated separately so the case-insensitive prefix test and the
 *      case-PRESERVING base slice are pinned apart.
 *   5. EXACTNESS -- no candidate carries a `LIKE` metacharacter, and two
 *      DIFFERENT accounts' candidate sets are disjoint, so no candidate of one
 *      account can reach the other's row (Requirement 22.7).
 *   6. THE SWEEP UNION -- payloads mixing native and prefixed uids driven
 *      through the REAL `SubscriptionPoller.run()` against a mocked pool,
 *      asserting the sweep's exclusion array contains every candidate of every
 *      reported entry. This is the interaction where a regression actually lands
 *      (Requirement 22.6): a per-entry write that is right and a sweep that is
 *      stale produce a correct row that is overwritten inside the same poll, so
 *      the fix would be invisible on the UI while arms 1-5 all passed.
 *
 * EVERY EXPECTATION IS RE-DERIVED FROM THE GENERATED INPUT -- the prefix test,
 * the base slice and the two suffixed strings are rebuilt here from the
 * requirement text, never by calling back into the code under test. A test that
 * computes its expectation with the function it is checking asserts only that
 * the function is deterministic. The generated parts are kept separate for the
 * same reason: the prefix casing and the base are generated as independent
 * values and CONCATENATED to make the input, so the expectation is built from
 * the pieces rather than recovered from the result.
 *
 * The three live examples (Requirement 22.12) are pinned through fast-check
 * `examples` so they run on every invocation rather than waiting on sampling.
 *
 * Sibling `./connectionAlias.test.js` (task 30.5) covers the concrete examples
 * and boundaries; `../services/__tests__/SubscriptionPoller.test.js` covers the
 * two statements the poller builds from these candidates.
 *
 * **Validates: Requirements 22.1, 22.2, 22.3, 22.6, 22.7, 22.9, 22.12**
 */

jest.mock('../config/database', () => ({
  query: jest.fn()
}));

jest.mock('../config/logger', () => ({
  createLogger: jest.fn(() => ({
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn()
  }))
}));

const fc = require('fast-check');
const { test } = require('@fast-check/jest');

const {
  CLOUDTAK_CONNECTION_PREFIX,
  candidateClientUids,
  unionCandidateClientUids
} = require('./connectionAlias');
const SubscriptionPoller = require('../services/SubscriptionPoller');

/** The reported uids observed on the live TAK Server (Requirement 22.12). */
const LIVE_NATIVE_UID = 'ANDROID-63040a40563b5fab';
const LIVE_CLOUDTAK_WEB_REPORTED = 'ANDROID-CloudTAK-chris@chriselsen.net';
const LIVE_CLOUDTAK_ETL_REPORTED = 'ANDROID-CloudTAK-ckadmin';

// ---------------------------------------------------------------------------
// Oracle -- the requirement text restated, independent of the implementation
// ---------------------------------------------------------------------------

/**
 * Whether `uid` carries the CloudTAK_Connection_Prefix, compared
 * case-insensitively (Requirement 22.2). Written with `slice` + `toLowerCase`
 * rather than by reusing the module's own predicate, so agreement is evidence.
 *
 * @param {string} uid
 */
function carriesPrefix(uid) {
  return uid.slice(0, CLOUDTAK_CONNECTION_PREFIX.length).toLowerCase() === CLOUDTAK_CONNECTION_PREFIX.toLowerCase();
}

/**
 * The candidates Requirements 22.2 and 22.3 require, rebuilt from the rule: the
 * uid alone unless it carries the prefix, in which case the ORIGINAL-cased
 * remainder is suffixed with both Certificate_Uid_Suffix forms.
 *
 * @param {string} uid
 * @returns {Array<string>}
 */
function expectedCandidates(uid) {
  if (!carriesPrefix(uid)) return [uid];

  const base = uid.slice(CLOUDTAK_CONNECTION_PREFIX.length);
  return [uid, `${base} (Web)`, `${base} (ETL)`];
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/**
 * The CloudTAK_Connection_Prefix in an arbitrary mixture of cases --
 * `android-cloudtak-`, `ANDROID-cloudTAK-` and everything between. The prefix
 * is ASCII, so case randomisation here cannot turn one character into a
 * different one.
 */
const prefixCaseArb = fc
  .array(fc.boolean(), {
    minLength: CLOUDTAK_CONNECTION_PREFIX.length,
    maxLength: CLOUDTAK_CONNECTION_PREFIX.length
  })
  .map((upper) =>
    [...CLOUDTAK_CONNECTION_PREFIX]
      .map((character, index) => (upper[index] ? character.toUpperCase() : character.toLowerCase()))
      .join('')
  );

/**
 * The base a prefixed uid carries. The EMPTY base and the two bases that already
 * end in a Certificate_Uid_Suffix are drawn deliberately rather than left to
 * chance: the first is where a naive implementation throws or emits ` (Web)`
 * with no base at all, and the second is where one that strips or rewrites an
 * existing suffix produces the wrong candidate.
 */
const baseArb = fc.oneof(
  { weight: 4, arbitrary: fc.string() },
  { weight: 2, arbitrary: fc.constant('') },
  { weight: 2, arbitrary: fc.constantFrom('chris@chriselsen.net', 'ckadmin', 'MixedCase@Example.NET') },
  {
    weight: 2,
    arbitrary: fc.constantFrom('ckadmin (ETL)', 'chris@chriselsen.net (Web)', 'x (Web)', 'y (ETL)')
  },
  { weight: 1, arbitrary: fc.string({ unit: 'binary' }) }
);

/** A uid that carries the prefix, assembled from the two generated pieces. */
const prefixedUidArb = fc.tuple(prefixCaseArb, baseArb).map(([prefix, base]) => prefix + base);

/**
 * A uid that does NOT carry the prefix. Arbitrary strings dominate so the
 * exactly-one arm is genuinely exercised, with the live native shapes and the
 * empty string pinned in.
 */
const unprefixedUidArb = fc
  .oneof(
    { weight: 6, arbitrary: fc.string() },
    { weight: 2, arbitrary: fc.string({ unit: 'binary' }) },
    {
      weight: 2,
      arbitrary: fc.constantFrom(
        LIVE_NATIVE_UID,
        'ANDROID-842f08e120efdbe3',
        'CE17C84D-9700-4080-BA5A-44AF51809453',
        'S-1-5-21-2281966494-490247268-205662872-1002',
        'chris@chriselsen.net (Web)',
        'ckadmin (ETL)',
        '',
        'ANDROID-CloudTAK',
        'ANDROID-Cloud',
        ' ANDROID-CloudTAK-x'
      )
    }
  )
  .filter((uid) => !carriesPrefix(uid));

/** Every reported-uid shape, prefixed and not, for the arms that take both. */
const reportedUidArb = fc.oneof(
  { weight: 5, arbitrary: unprefixedUidArb },
  { weight: 5, arbitrary: prefixedUidArb },
  {
    weight: 1,
    arbitrary: fc.constantFrom(
      LIVE_NATIVE_UID,
      LIVE_CLOUDTAK_WEB_REPORTED,
      LIVE_CLOUDTAK_ETL_REPORTED,
      CLOUDTAK_CONNECTION_PREFIX
    )
  }
);

/** The totality arm's input space: anything at all, strings included. */
const anyInputArb = fc.oneof(
  { weight: 5, arbitrary: reportedUidArb },
  { weight: 5, arbitrary: fc.anything() }
);

// Feature: device-management, Property 18: The Connection_Alias is total, additive, exact, and reaches the unreported sweep
describe('Property 18: The Connection_Alias is total, additive, exact, and reaches the unreported sweep', () => {
  test.prop([anyInputArb], { numRuns: 300 })(
    'returns a value rather than raising, for every input, and is a pure function of its input alone',
    (input) => {
      // TOTAL: never throws, always an array of strings (Requirement 22.1 --
      // this runs inside a poll loop that must never throw).
      let candidates;
      expect(() => {
        candidates = candidateClientUids(input);
      }).not.toThrow();
      expect(Array.isArray(candidates)).toBe(true);
      for (const candidate of candidates) expect(typeof candidate).toBe('string');

      // A non-string has no reported uid to try, so there is nothing to return.
      if (typeof input !== 'string') expect(candidates).toEqual([]);

      // PURE: the same input yields an equal result, in a FRESH array, and the
      // result is unaffected by the unrelated calls made in between.
      candidates.push('mutated-by-a-caller');
      candidateClientUids('ANDROID-CloudTAK-someone-else');
      const again = candidateClientUids(input);

      expect(again).not.toContain('mutated-by-a-caller');
      expect(again).toEqual(candidateClientUids(input));
    }
  );

  test.prop([reportedUidArb], {
    numRuns: 300,
    examples: [[LIVE_NATIVE_UID], [LIVE_CLOUDTAK_WEB_REPORTED], [LIVE_CLOUDTAK_ETL_REPORTED], ['']]
  })('always includes the reported uid itself, first, so the alias is additive rather than a replacement', (uid) => {
    const candidates = candidateClientUids(uid);

    // Requirements 22.2 / 22.9: the reported uid is ALWAYS tried, so an upstream
    // construction change can cost a CloudTAK Device its Last_Seen and can never
    // cost a native Device the match it has today.
    expect(candidates).toContain(uid);
    expect(candidates[0]).toBe(uid);
  });

  test.prop([unprefixedUidArb], {
    numRuns: 300,
    examples: [[LIVE_NATIVE_UID], ['ANDROID-CloudTAK'], [''], ['chris@chriselsen.net (Web)']]
  })('yields EXACTLY ONE candidate -- the uid alone -- for a uid carrying no prefix', (uid) => {
    // The arm that protects every native Device: one candidate, the reported
    // uid, which is the match the poller made before the alias existed.
    expect(candidateClientUids(uid)).toEqual([uid]);
  });

  test.prop([prefixCaseArb, baseArb], {
    numRuns: 300,
    examples: [
      ['ANDROID-CloudTAK-', 'chris@chriselsen.net'],
      ['ANDROID-CloudTAK-', 'ckadmin'],
      ['ANDROID-CloudTAK-', ''],
      ['android-cloudtak-', 'MixedCase@Example.NET'],
      ['ANDROID-cloudTAK-', 'ckadmin (ETL)']
    ]
  })(
    'yields EXACTLY THREE candidates -- the uid, `<base> (Web)`, `<base> (ETL)` -- for a prefixed uid in any casing',
    (prefix, base) => {
      const reportedUid = prefix + base;
      const candidates = candidateClientUids(reportedUid);

      // Built from the GENERATED pieces, not recovered from the result: the
      // prefix test is case-insensitive while the base keeps the casing it was
      // generated with (`client_uid` matching in Postgres is case-sensitive, so
      // a lowercased base would match no row).
      expect(candidates).toEqual([reportedUid, `${base} (Web)`, `${base} (ETL)`]);
      expect(candidates).toHaveLength(3);

      // Not deduplicated and not special-cased: exactly three is structural,
      // including for the EMPTY base, whose suffixed forms are the literal
      // strings ` (Web)` and ` (ETL)`.
      expect(expectedCandidates(reportedUid)).toEqual(candidates);
    }
  );

  test.prop([reportedUidArb, baseArb, baseArb], {
    numRuns: 300,
    examples: [
      [LIVE_CLOUDTAK_WEB_REPORTED, 'chris@chriselsen.net', 'ckadmin'],
      [LIVE_CLOUDTAK_ETL_REPORTED, 'ckadmin', 'chris@chriselsen.net']
    ]
  })(
    'emits complete strings built by plain concatenation, and no row key belonging to another account',
    (uid, base, otherBase) => {
      const candidates = candidateClientUids(uid);

      // Every candidate is a COMPLETE `client_uid` built by plain
      // concatenation: the reported uid itself, or its base followed by one of
      // the two literal Certificate_Uid_Suffix strings. So the derivation
      // introduces no metacharacter of its own -- a `%` or `_` present in a
      // candidate came from the reported uid, where it is a literal character
      // of a `client_uid` rather than a wildcard, because matching is by
      // equality (Requirement 22.7). That the STATEMENTS match by equality is
      // asserted in the sweep arm below and in the poller's unit tests.
      if (carriesPrefix(uid)) {
        const uidBase = uid.slice(CLOUDTAK_CONNECTION_PREFIX.length);

        for (const candidate of candidates.slice(1)) {
          expect(candidate.startsWith(uidBase)).toBe(true);
          expect([' (Web)', ' (ETL)']).toContain(candidate.slice(uidBase.length));
        }
      } else {
        expect(candidates).toEqual([uid]);
      }

      // Two DIFFERENT accounts' derived row keys never coincide, so a
      // connection can only reach a row whose `client_uid` names its OWN
      // account identifier (Requirement 22.7). Asserted on the DERIVED keys --
      // the candidates the alias adds -- because they are what the alias makes
      // newly reachable; the reported uid itself was always tried and names
      // whatever row it names.
      fc.pre(base !== otherBase);

      const derivedKeys = (accountBase) =>
        candidateClientUids(CLOUDTAK_CONNECTION_PREFIX + accountBase).slice(1);

      for (const key of derivedKeys(base)) {
        expect(derivedKeys(otherBase)).not.toContain(key);
      }
    }
  );

  test.prop([payloadArb()], { numRuns: 200 })(
    'hands the unreported sweep a set containing every candidate of every reported entry',
    async (uids) => {
      const { statements } = await runPoll(uids);

      // The per-entry write binds `$3` inside the revoked-guarded form
      // `connected = ($3 AND revoked = false)` (a revoked row is never marked
      // connected); the sweep writes a literal false. Keying on the `$3` bind
      // still tells the two apart.
      const perEntryWrites = statements.filter(([sql]) =>
        /connected\s*=\s*\(\s*\$3\s+AND\s+revoked\s*=\s*false\s*\)/i.test(sql)
      );
      const sweeps = statements.filter(([sql]) => /connected\s*=\s*false/i.test(sql));

      // Exactly one sweep, scoped by equality against a complete-string array.
      expect(sweeps).toHaveLength(1);
      const [[sweepSql, sweepParams]] = sweeps;
      expect(sweepSql).toMatch(/WHERE\s+client_uid <> ALL\(\$1::text\[\]\)/);

      const excluded = sweepParams[0];
      const reportedUids = [...new Set(uids)];

      // THE LOAD-BEARING ASSERTION (Requirement 22.6). A CloudTAK row the
      // per-entry write just marked connected is, by construction, absent from
      // the RAW reported uids -- that absence is the defect -- so a sweep keyed
      // on those raw values would set it straight back to `connected = false`
      // inside the same poll and the fix would be invisible on the UI.
      for (const uid of reportedUids) {
        for (const candidate of expectedCandidates(uid)) {
          expect(excluded).toContain(candidate);
        }
      }

      // The excluded set carries NOTHING BEYOND those candidates, and no
      // duplicates -- so the sweep stays exactly as scoped as Requirement 20.6
      // requires and does not grow with the duplicate entries TAK Server reports
      // per uid.
      const expectedUnion = [];
      for (const uid of reportedUids) {
        for (const candidate of expectedCandidates(uid)) {
          if (!expectedUnion.includes(candidate)) expectedUnion.push(candidate);
        }
      }
      expect(excluded).toEqual(expectedUnion);
      expect(unionCandidateClientUids(reportedUids)).toEqual(expectedUnion);

      // And each per-entry write is targeted at that entry's own candidates, in
      // order (Requirement 22.4) -- so the row the sweep now spares is the same
      // row the write reached.
      expect(perEntryWrites.map(([, params]) => params[0])).toEqual(
        reportedUids.map((uid) => expectedCandidates(uid))
      );

      // Equality only, in EVERY statement this poll issued (Requirement 22.7).
      for (const [sql] of statements) {
        expect(sql).not.toMatch(/LIKE/i);
        expect(sql).not.toContain('%');
      }
    }
  );
});

/**
 * Payloads mixing native and prefixed uids, with duplicates reachable (TAK
 * Server reports a client more than once). Every uid is a non-empty string,
 * since the poller skips an entry with an unusable `uid` before the alias is
 * ever consulted -- that skip is covered in `./connectionAlias.test.js` and in
 * the poller's own unit tests.
 */
function payloadArb() {
  const uidArb = fc.oneof(
    { weight: 4, arbitrary: unprefixedUidArb.filter((uid) => uid.length > 0) },
    { weight: 4, arbitrary: prefixedUidArb },
    {
      weight: 2,
      arbitrary: fc.constantFrom(
        LIVE_NATIVE_UID,
        LIVE_CLOUDTAK_WEB_REPORTED,
        LIVE_CLOUDTAK_ETL_REPORTED,
        CLOUDTAK_CONNECTION_PREFIX
      )
    }
  );

  // A short list against a small alphabet of shapes, so duplicate uids within
  // one payload are common rather than an edge case.
  return fc.array(uidArb, { maxLength: 8 });
}

/**
 * Drives ONE real `SubscriptionPoller.run()` over a payload of `uids` against a
 * pool that records every statement it is handed. Nothing about the resulting
 * rows is modelled here -- that is Property 17's job; this arm is about the
 * PARAMETERS the sweep and the per-entry writes carry.
 *
 * @param {Array<string>} uids
 * @returns {Promise<{statements: Array<[string, Array<unknown>]>}>}
 */
async function runPoll(uids) {
  const statements = [];
  const pool = {
    query: jest.fn(async (sql, params) => {
      statements.push([sql, params]);
      return { rowCount: 1 };
    })
  };
  const takServerService = {
    getClientEndpoints: jest.fn().mockResolvedValue(
      uids.map((uid, index) => ({
        callsign: `CALLSIGN-${index}`,
        uid,
        username: 'alice',
        team: 'Cyan',
        role: 'Team Member',
        lastEventTime: new Date(Date.UTC(2026, 7, 24, 6, 40, 16, 361) + index * 1000).toISOString(),
        lastStatus: index % 2 === 0 ? 'Connected' : 'Disconnected'
      }))
    )
  };

  await new SubscriptionPoller({ takServerService, pool }).run();

  return { statements };
}
