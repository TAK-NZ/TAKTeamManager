/**
 * device-management task 20.3: the single fast-check property test for
 * design.md's Correctness Property 8 (Requirements 4.3, 4.4, 4.6, 5.4, 11.1,
 * 11.2, 11.3, 11.5, 11.6).
 *
 * Property 8's exact statement: "For all pairs of an Active_Certificate list
 * and a Revoked_Certificate_View list (with arbitrary overlap, arbitrary
 * `clientUid` reuse, and arbitrary `issuanceDate` order), the derived Device
 * set SHALL contain exactly one entry per `clientUid` that has at least one
 * certificate in `/active` and not in `/revoked`; each entry's `certId`,
 * `issuedAt` and `expiresAt` SHALL equal those of the greatest-`issuanceDate`
 * Live_Certificate for that `clientUid`; and no `clientUid` whose every
 * certificate is revoked SHALL appear at all."
 *
 * The property is checked at BOTH levels, because they can fail
 * independently:
 *
 *   1. against the exported pure `groupByClientUid()` -- where the derivation
 *      actually lives, and
 *   2. through the real `DeviceSync.run()` against a mocked pool backed by an
 *      in-memory `tak_devices` table -- which is what proves the rows
 *      actually WRITTEN match the derivation (one row per live `clientUid`,
 *      carrying that group's newest certificate's id/dates and the user
 *      resolved from ITS `creatorDn`).
 *
 * The expected Newest_Live_Certificate is computed here, independently, by a
 * comparator written in this file. `DeviceSync.isNewerCertificate` is
 * deliberately NOT called to build the expectation -- doing so would make the
 * property circular (it would assert only that the implementation agrees with
 * itself).
 *
 * The generator reproduces the shape of the verified live server rather than a
 * convenient synthetic one, because every one of the defects this property
 * guards only appears at that shape:
 *
 *   - A SMALL `clientUid` alphabet against a MUCH larger certificate count,
 *     with one uid deliberately dominant -- live, 95 certificates carried only
 *     10 distinct `clientUid`s and 60 of them sat on `ckadmin (ETL)`
 *     (Requirement 11.1). One certificate per uid would not exercise grouping
 *     at all.
 *   - `/revoked` as a random SUBSET of `/active`, across the whole spectrum
 *     from empty to everything -- live, 90 of the 95 `/active` certificates
 *     also appeared in `/revoked` (Requirement 11.2). This is what makes
 *     fully-revoked `clientUid`s occur, which is the specific live defect
 *     (Requirement 11.5): the earlier implementation synced `/active`
 *     directly and listed 10 Devices where only 1 was live.
 *   - A non-null `revocationDate` on certificates INDEPENDENTLY of `/revoked`
 *     membership, including runs where every certificate carries one -- live,
 *     all 95 did, including the 5 absent from `/revoked`. An implementation
 *     that read `revocationDate` as the revocation signal therefore cannot
 *     pass.
 *   - `issuanceDate`s drawn from a small pool of instants (so ties happen and
 *     the id tiebreak is exercised) and the certificate list fed in a
 *     generated shuffle, so the newest is never accidentally the last (or
 *     first) element. The same list is additionally re-run in a different
 *     order and the written rows compared, so a "last one wins" derivation
 *     fails outright.
 *
 * `/Marti/api/certadmin/cert/replaced` is deliberately not modelled:
 * Requirement 11.4 forbids using it, since live it returned the same 95 ids
 * as `/active`.
 *
 * Sibling `DeviceSync.property.test.js` covers Property 4 (upsert idempotence
 * and Last_Seen preservation); `DeviceSync.test.js` covers the concrete
 * examples, the SQL text, scheduling and the never-throwing error paths.
 */

jest.mock('../../config/database', () => ({
  query: jest.fn()
}));

jest.mock('../../config/logger', () => ({
  createLogger: jest.fn(() => ({ info: jest.fn(), error: jest.fn(), debug: jest.fn(), warn: jest.fn() }))
}));

const fc = require('fast-check');

const DeviceSync = require('../DeviceSync');
const { groupByClientUid } = DeviceSync;

/**
 * The live `clientUid` alphabet, kept small on purpose (Requirement 11.1).
 * The first entry is weighted heavily by `clientUidArb` below, mirroring the
 * 60-of-95 concentration observed on `ckadmin (ETL)`.
 */
const CLIENT_UIDS = [
  'ckadmin (ETL)',
  'etl-fenz-test (ETL)',
  'ANDROID-63040a40563b5fab',
  'ANDROID-842f08e120efdbe3',
  'cloudtak-uid-1'
];

/**
 * Local usernames. Chosen so no username is a substring of another: the
 * shared `matchesCreatorDn` predicate falls back to a substring match, and
 * overlapping usernames would make the EXPECTED attribution ambiguous rather
 * than testing anything about the sync.
 */
const USERNAMES = ['ckadmin', 'etl-fenz-test', 'android-63040a40563b5fab', 'operator'];

/** The local `users` rows every scenario runs against. */
const USERS = USERNAMES.map((username, index) => ({ id: index + 1, username }));

/** A `creatorDn` naming nobody local, so the Device resolves to a NULL user. */
const NOBODY_DN = 'CN=nobody-local,OU=TAK,O=NZ';

/**
 * A small pool of `issuanceDate` instants. Small on purpose: repeated values
 * across a group's certificates are what exercise Requirement 11.3's tie
 * handling (broken by the greater certificate id) instead of leaving every
 * comparison decided by the date alone.
 */
const ISSUANCE_INSTANTS = [
  '2024-01-15T02:30:00.000Z',
  '2024-07-04T09:00:00.000Z',
  '2025-02-20T23:59:59.000Z',
  '2025-09-01T12:00:00.000Z',
  '2026-01-17T01:15:22.160Z'
];

const EXPIRATION_INSTANTS = [
  '2026-01-15T02:30:00.000Z',
  '2027-07-04T09:00:00.000Z',
  '2028-02-20T23:59:59.000Z'
];

/** `tak_devices` column defaults, applied to columns an INSERT omits. */
const COLUMN_DEFAULTS = {
  client_uid: null,
  user_id: null,
  cert_id: null,
  issued_at: null,
  expires_at: null,
  last_seen_at: null, // NULL = "never seen"
  last_polled_at: null,
  revoked: false
};

/**
 * Independent `issuanceDate` -> comparable time. Returns null for an absent or
 * unparseable date, which is also what the Device_Table's `issued_at` must
 * hold for such a certificate.
 *
 * @param {unknown} issuanceDate
 * @returns {number|null}
 */
function expectedIssuanceTime(issuanceDate) {
  if (issuanceDate === null || issuanceDate === undefined) return null;
  const time = Date.parse(issuanceDate);
  return Number.isFinite(time) ? time : null;
}

/**
 * Independent restatement of "is `candidate` the newer certificate?" --
 * Requirement 11.3's greatest `issuanceDate`, with a certificate that has no
 * usable date ranked last (never dropped, since dropping it could hide a live
 * Device) and ties broken by the greater id.
 *
 * Written out here rather than imported from `DeviceSync` so the expectation
 * is genuinely independent of the code under test.
 *
 * @param {object} candidate
 * @param {object} incumbent
 * @returns {boolean}
 */
function expectedIsNewer(candidate, incumbent) {
  const candidateTime = expectedIssuanceTime(candidate.issuanceDate);
  const incumbentTime = expectedIssuanceTime(incumbent.issuanceDate);

  if (candidateTime === null && incumbentTime === null) return candidate.id > incumbent.id;
  if (candidateTime === null) return false;
  if (incumbentTime === null) return true;
  if (candidateTime !== incumbentTime) return candidateTime > incumbentTime;
  return candidate.id > incumbent.id;
}

/**
 * The expected Device set: one entry per `clientUid` with at least one
 * Live_Certificate, holding that group's greatest-`issuanceDate` certificate.
 *
 * Certificate ids are generated unique, so the ordering above is a strict
 * total order and this maximum is well defined regardless of input order.
 *
 * @param {Array<object>} liveCertificates
 * @returns {Map<string, object>} clientUid -> expected Newest_Live_Certificate
 */
function expectedDevices(liveCertificates) {
  const newest = new Map();

  for (const cert of liveCertificates) {
    const incumbent = newest.get(cert.clientUid);
    if (incumbent === undefined || expectedIsNewer(cert, incumbent)) {
      newest.set(cert.clientUid, cert);
    }
  }

  return newest;
}

/**
 * An in-memory `tak_devices` table plus the local `users` read, behind the
 * `{ query }` shape `DeviceSync` takes as its pool.
 *
 * Both the insert column list and the `DO UPDATE SET col = EXCLUDED.col`
 * assignments are read out of the SQL the implementation actually issues
 * (rather than hardcoded here), so the model cannot silently write a column
 * the statement omits -- which is what keeps the "`last_seen_at`/`revoked` are
 * never written" half of the check honest.
 *
 * @param {Array<{id: number, username: string}>} users
 */
function createDeviceTable(users) {
  const devices = new Map();
  const insertStatements = [];

  const query = jest.fn(async (sql, params = []) => {
    if (sql.includes('FROM users')) {
      return { rows: users.map((user) => ({ ...user })) };
    }

    if (sql.includes('INSERT INTO tak_devices')) {
      insertStatements.push(sql);

      const insertColumns = sql
        .slice(sql.indexOf('(') + 1, sql.indexOf(')'))
        .split(',')
        .map((column) => column.trim());
      const excluded = Object.fromEntries(insertColumns.map((column, index) => [column, params[index]]));

      const updateClause = sql.slice(sql.indexOf('DO UPDATE SET'));
      const updatedColumns = [...updateClause.matchAll(/(\w+)\s*=\s*EXCLUDED\.(\w+)/g)].map(([, target, source]) => [
        target,
        source
      ]);

      const existing = devices.get(excluded.client_uid);

      if (existing) {
        for (const [target, source] of updatedColumns) {
          existing[target] = excluded[source];
        }
      } else {
        devices.set(excluded.client_uid, { ...COLUMN_DEFAULTS, ...excluded });
      }

      return { rowCount: 1 };
    }

    // Task 25.1 / Requirement 17.1: the reconciliation statement a completed
    // run ends with, modelled with its scoping intact -- the uids it is
    // parameterised with are retained, every other row is removed. This table
    // starts empty, so it removes nothing here; it is honoured rather than
    // rejected so the run does not silently log a failed delete.
    if (sql.includes('DELETE FROM tak_devices')) {
      const liveUids = new Set(params[0]);
      let rowCount = 0;

      for (const uid of [...devices.keys()]) {
        if (!liveUids.has(uid)) {
          devices.delete(uid);
          rowCount += 1;
        }
      }

      return { rowCount };
    }

    throw new Error(`Unexpected SQL in DeviceSync device-identity property test: ${sql}`);
  });

  return {
    query,
    insertStatements,
    /** Snapshot of the table keyed by `client_uid`. */
    snapshot() {
      return Object.fromEntries([...devices.entries()].map(([uid, row]) => [uid, { ...row }]));
    }
  };
}

/** Strips the per-run `last_polled_at` before comparing two runs' rows. */
function withoutPolledAt(snapshot) {
  return Object.fromEntries(
    Object.entries(snapshot).map(([uid, row]) => {
      const rest = { ...row };
      delete rest.last_polled_at;
      return [uid, rest];
    })
  );
}

/**
 * A generated Marti `TakCert` body, minus its id (assigned from the generated
 * unique-id pool so ids are not positional) and minus `/revoked` membership.
 */
const certificateBodyArb = fc.record({
  // Requirement 11.1: heavy clientUid reuse, with one dominant uid.
  clientUid: fc.oneof(
    { weight: 6, arbitrary: fc.constant(CLIENT_UIDS[0]) },
    { weight: 4, arbitrary: fc.constantFrom(...CLIENT_UIDS) }
  ),
  // Mostly usable dates from a small pool (so ties occur), plus the two
  // unusable shapes: absent, and present-but-unparseable.
  issuanceDate: fc.oneof(
    { weight: 18, arbitrary: fc.constantFrom(...ISSUANCE_INSTANTS) },
    { weight: 1, arbitrary: fc.constant(undefined) },
    { weight: 1, arbitrary: fc.constant('not-a-date') }
  ),
  expirationDate: fc.constantFrom(...EXPIRATION_INSTANTS),
  // Which local user this certificate's creatorDn names, or nobody.
  creatorDnUserIndex: fc.option(fc.integer({ min: 0, max: USERNAMES.length - 1 }), { nil: null }),
  // Generator-only: compared against the scenario's threshold to decide
  // /revoked membership, so revocation is a random SUBSET of /active.
  revokedDraw: fc.integer({ min: 0, max: 99 }),
  // Generator-only: sort key used to feed the same live set in a second,
  // different order.
  shuffleKey: fc.integer({ min: -1000, max: 1000 })
});

/**
 * A whole scenario: a unique certificate-id pool, one body per id, how much of
 * `/active` is revoked (0 = nothing, 100 = everything), and whether EVERY
 * certificate carries a non-null `revocationDate` (the verified live case).
 */
const catalogueArb = fc.uniqueArray(fc.integer({ min: 1, max: 5000 }), { minLength: 12, maxLength: 45 }).chain((ids) =>
  fc.record({
    certIds: fc.constant(ids),
    bodies: fc.array(certificateBodyArb, { minLength: ids.length, maxLength: ids.length }),
    revokedThreshold: fc.integer({ min: 0, max: 100 }),
    revocationDateMode: fc.constantFrom('all-present', 'mixed')
  })
);

/**
 * Turns a generated catalogue into the two documented views plus the
 * independently-derived expectations.
 *
 * @param {{certIds: number[], bodies: object[], revokedThreshold: number,
 *   revocationDateMode: string}} catalogue
 */
function buildScenario({ certIds, bodies, revokedThreshold, revocationDateMode }) {
  const expectedUserIdByCertId = new Map();
  const shuffleKeyByCertId = new Map();

  const active = bodies.map((body, index) => {
    const id = certIds[index];
    const creatorDn =
      body.creatorDnUserIndex === null ? NOBODY_DN : `CN=${USERNAMES[body.creatorDnUserIndex]},OU=TAK,O=NZ`;

    expectedUserIdByCertId.set(id, body.creatorDnUserIndex === null ? null : USERS[body.creatorDnUserIndex].id);
    shuffleKeyByCertId.set(id, body.shuffleKey);

    return {
      id,
      clientUid: body.clientUid,
      creatorDn,
      issuanceDate: body.issuanceDate,
      expirationDate: body.expirationDate,
      // Requirement 12.5 / live fact: `revocationDate` is NOT the revocation
      // signal, and is set independently of /revoked membership -- including
      // the observed case where every certificate carries one.
      revocationDate:
        revocationDateMode === 'all-present' || body.revokedDraw % 10 !== 0 ? '2026-01-17T01:15:22.160Z' : null
    };
  });

  // Requirement 11.2: /revoked is a random SUBSET of /active, by id.
  const revoked = active.filter((_cert, index) => bodies[index].revokedDraw < revokedThreshold);
  const revokedIds = new Set(revoked.map((cert) => cert.id));

  // Requirement 4.3: the Live_Certificates are the set difference.
  const live = active.filter((cert) => !revokedIds.has(cert.id));
  // The same live set in a different order, so "newest" can never be "last".
  const shuffledLive = [...live].sort((a, b) => shuffleKeyByCertId.get(a.id) - shuffleKeyByCertId.get(b.id));

  const activeUids = new Set(active.map((cert) => cert.clientUid));
  const liveUids = new Set(live.map((cert) => cert.clientUid));
  // Requirement 11.5: uids present in /active whose every certificate is
  // revoked. These must not appear as Devices at all.
  const fullyRevokedUids = [...activeUids].filter((uid) => !liveUids.has(uid));

  return { active, live, shuffledLive, expectedUserIdByCertId, fullyRevokedUids };
}

/**
 * Non-vacuity guard: the property is only meaningful if the generated runs
 * actually reached the live shapes it is about. Asserted after the run.
 */
const observed = {
  liveDevices: false,
  groupWithMultipleLiveCerts: false,
  fullyRevokedUid: false,
  allRevocationDatesPresent: false,
  unusableIssuanceDate: false,
  reorderedInput: false
};

// Feature: device-management, Property 8: Devices are live client UIDs carrying their newest live certificate
describe('Property 8: Devices are live client UIDs carrying their newest live certificate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('holds for all (active, revoked) pairs', async () => {
    await fc.assert(
      fc.asyncProperty(catalogueArb, async (catalogue) => {
        const { active, live, shuffledLive, expectedUserIdByCertId, fullyRevokedUids } = buildScenario(catalogue);

        const expected = expectedDevices(live);

        // ---- generator coverage bookkeeping (asserted after the run) ----
        if (expected.size > 0) observed.liveDevices = true;
        if (fullyRevokedUids.length > 0) observed.fullyRevokedUid = true;
        if (active.every((cert) => cert.revocationDate !== null)) observed.allRevocationDatesPresent = true;
        if (live.some((cert) => expectedIssuanceTime(cert.issuanceDate) === null)) {
          observed.unusableIssuanceDate = true;
        }
        if (live.some((cert, index) => shuffledLive[index] !== cert)) observed.reorderedInput = true;
        const liveCountsByUid = new Map();
        for (const cert of live) {
          liveCountsByUid.set(cert.clientUid, (liveCountsByUid.get(cert.clientUid) ?? 0) + 1);
        }
        if ([...liveCountsByUid.values()].some((count) => count > 1)) {
          observed.groupWithMultipleLiveCerts = true;
        }

        // ---- level 1: the pure derivation ----
        const { devices, skipped } = groupByClientUid(shuffledLive);

        // Every generated certificate carries a usable clientUid, so none is
        // skipped and the grouping below is over the whole live set.
        expect(skipped).toBe(0);

        // Assertion 1: exactly one entry per clientUid with at least one live
        // certificate -- no duplicates (a Map cannot hold them), none missing.
        expect([...devices.keys()].sort()).toEqual([...expected.keys()].sort());
        expect(devices.size).toBe(expected.size);

        // Assertion 3, at the derivation level: each group's certificate is
        // the independently-computed greatest-issuanceDate one.
        for (const [uid, expectedCert] of expected) {
          expect(devices.get(uid).id).toBe(expectedCert.id);
        }

        // ---- level 2: the rows actually written by run() ----
        const db = createDeviceTable(USERS);
        const takServerService = {
          listLiveCertificates: jest.fn().mockResolvedValue(shuffledLive.map((cert) => ({ ...cert })))
        };

        const counts = await new DeviceSync({ takServerService, pool: db }).run();
        const rows = db.snapshot();

        expect(counts.devices).toBe(expected.size);
        expect(counts.upserted).toBe(expected.size);

        // Assertion 1, at the table level: Requirement 11.6 -- exactly one
        // row per live clientUid.
        expect(Object.keys(rows).sort()).toEqual([...expected.keys()].sort());

        // Assertion 2: Requirements 5.4/11.5 -- a clientUid whose every
        // certificate is revoked does not appear AT ALL. Not with
        // `revoked = false`; not at all.
        for (const uid of fullyRevokedUids) {
          expect(devices.has(uid)).toBe(false);
          expect(Object.prototype.hasOwnProperty.call(rows, uid)).toBe(false);
        }

        for (const [uid, expectedCert] of expected) {
          const row = rows[uid];

          // Assertions 3 and 4: Requirements 4.6/11.3 -- the carried
          // certificate id and dates, and the resolved user, all come from
          // that group's newest live certificate.
          expect(row.cert_id).toBe(expectedCert.id);
          expect(row.issued_at).toBe(
            expectedIssuanceTime(expectedCert.issuanceDate) === null ? null : expectedCert.issuanceDate
          );
          expect(row.expires_at).toBe(expectedCert.expirationDate);
          expect(row.user_id).toBe(expectedUserIdByCertId.get(expectedCert.id));

          // Assertion 6: neither column is ever written, so a fresh row shows
          // the table defaults.
          expect(row.last_seen_at).toBeNull();
          expect(row.revoked).toBe(false);
        }

        // Assertion 6, at the statement level: `last_seen_at` and `revoked`
        // appear in NEITHER the insert column list nor the update list.
        for (const sql of db.insertStatements) {
          expect(sql).not.toMatch(/last_seen_at/);
          expect(sql).not.toMatch(/revoked/);
        }

        // Assertion 5: order invariance -- the same live set fed in the
        // generated (different) order yields identical rows.
        const reorderedDb = createDeviceTable(USERS);
        await new DeviceSync({
          takServerService: {
            listLiveCertificates: jest.fn().mockResolvedValue(live.map((cert) => ({ ...cert })))
          },
          pool: reorderedDb
        }).run();

        expect(withoutPolledAt(reorderedDb.snapshot())).toEqual(withoutPolledAt(rows));
      }),
      { numRuns: 200 }
    );

    // The generated runs really did reach the live shapes Property 8 is
    // about, so none of the assertions above passed vacuously.
    expect(observed).toEqual({
      liveDevices: true,
      groupWithMultipleLiveCerts: true,
      fullyRevokedUid: true,
      allRevocationDatesPresent: true,
      unusableIssuanceDate: true,
      reorderedInput: true
    });
  });
});
