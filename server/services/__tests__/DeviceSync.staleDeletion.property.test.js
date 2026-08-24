/**
 * device-management task 25.4: the single fast-check property test for
 * design.md's Correctness Property 14 (Requirements 17.1, 17.2, 17.3, 17.4).
 *
 * Property 14's exact statement: "For all fetch outcomes (a rejected
 * certificate-view fetch, a malformed non-list payload, a failed local-user
 * load, and a fully successful fetch) and for all pairs of a derived
 * Live_Device_Set and a Device_Table content (arbitrary overlap, including
 * disjoint, identical, and one-empty pairs), a Device_Table row SHALL be
 * deleted if and only if the run's fetch fully succeeded AND that row's
 * `client_uid` is absent from the derived Live_Device_Set."
 *
 * It is stated as a BICONDITIONAL on purpose, so an implementation cannot
 * satisfy "deletes stale rows" while missing "deletes nothing on failure".
 * Both directions are therefore asserted for EVERY generated case:
 *
 *   - forward: after a successful run, every row whose `client_uid` is absent
 *     from the Live_Device_Set is gone (Requirement 17.1);
 *   - reverse: no row whose `client_uid` is present in the Live_Device_Set is
 *     gone (Requirement 17.4), and after a FAILED run no row is gone at all
 *     and no row is even rewritten (Requirement 17.2).
 *
 * The case that carries the most weight is the one this file generates
 * explicitly via fast-check `examples` rather than leaving to sampling: a
 * SUCCESSFUL run whose Live_Device_Set is empty must delete every row, while
 * each of the three FAILED runs against that same table must delete none.
 * Those four runs ask for the same table-level outcome from the data alone --
 * the derived live set is empty in all of them -- and are distinguished only by
 * the run's outcome. An implementation that keyed the delete off "is the live
 * set non-empty?" would pass a weaker property and fail this one; an
 * implementation that placed the delete ahead of one of the early returns would
 * empty the table on the first bad tick, which is the catastrophic behaviour
 * Requirement 17.2 names as this requirement's load-bearing constraint.
 *
 * Scoping (Requirement 17.3) is asserted STRUCTURALLY as well as
 * behaviourally: the DELETE's parameter array is captured off the mocked pool
 * and compared as a SET against the expected live uids, and the statement text
 * is required to restrict on `client_uid`. An unscoped `DELETE FROM tak_devices`
 * -- no `WHERE`, no params -- fails here even though its table-level effect is
 * identical to the correct statement whenever the live set happens to be empty.
 *
 * Modelled the same way as the sibling `DeviceSync.property.test.js` and
 * `DeviceSync.deviceIdentity.property.test.js`: the mocked pool is backed by an
 * in-memory `client_uid -> row` map that faithfully applies BOTH the real
 * `ON CONFLICT (client_uid) DO UPDATE SET ...` upsert and the real scoped
 * DELETE. The expected surviving set is computed from the GENERATED live set,
 * never by calling `groupByClientUid`, so the property cannot degenerate into
 * asserting the implementation agrees with itself.
 *
 * Sibling `DeviceSync.test.js` (task 25.3) covers the concrete deletion
 * examples, the exact SQL text, the reported `deleted` count and the
 * swallowed-delete-failure path.
 */

jest.mock('../../config/database', () => ({
  query: jest.fn()
}));

jest.mock('../../config/logger', () => ({
  createLogger: jest.fn(() => ({ info: jest.fn(), error: jest.fn(), debug: jest.fn(), warn: jest.fn() }))
}));

const fc = require('fast-check');

const DeviceSync = require('../DeviceSync');

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
 * The `client_uid` alphabet the Live_Device_Set is drawn from, in the shapes
 * observed live (an Android uid, an ETL uid, a CloudTAK uid, a Windows SID).
 */
const LIVE_UID_POOL = [
  'ANDROID-63040a40563b5fab',
  'ckadmin (ETL)',
  'cloudtak-uid-1',
  'S-1-5-21-1407069837-2091007605-538272213-25045379',
  'ANDROID-842f08e120efdbe3'
];

/**
 * A DISJOINT uid alphabet for pre-existing rows that carry no
 * Live_Certificate -- the stale rows measured live (nine of 22 rows, every one
 * of them still `revoked = false`).
 */
const STALE_UID_POOL = [
  '95623A24-71A4-4FCC-98ED-FCA7C2DEFA27',
  'ANDROID-25852d3229de5f89',
  'chris@chriselsen.net (ETL)',
  'twoodill@amazon.com (ETL)'
];

/** The local `users` rows every scenario runs against. */
const USERS = [{ id: 1, username: 'ckadmin' }];

/**
 * The four documented fetch outcomes Property 14 quantifies over. The first
 * three each end `run()` at one of its early returns with
 * `outcome: 'failed'`; only the fourth may delete anything.
 */
const OUTCOMES = ['fetch-rejection', 'non-list-payload', 'user-load-failure', 'success'];

/** Payload shapes that are not a certificate list (Requirement 14.5's malformed case). */
const MALFORMED_PAYLOADS = [null, undefined, 'not-a-list', 42, { data: [] }];

/** How the pre-existing table content relates to the Live_Device_Set. */
const TABLE_RELATIONSHIPS = ['disjoint', 'identical', 'subset', 'superset', 'overlap', 'empty-table'];

/**
 * An axios-shaped rejection for the `fetch-rejection` outcome: a server that
 * answered with a status, and a request that never got an answer at all.
 *
 * @param {number|null} status
 * @returns {Error}
 */
function fetchError(status) {
  const error = new Error(status === null ? 'socket hang up' : `Request failed with status code ${status}`);
  if (status !== null) {
    error.response = { status };
    error.config = { url: '/Marti/api/certadmin/cert/revoked' };
  }
  return error;
}

/**
 * A pre-existing Device_Table row for `uid`, deterministic in the uid's
 * position so the generated scenario stays small and the explicit `examples`
 * below stay readable. `last_seen_at` is non-null and `revoked` alternates, so
 * a failed run that rewrote a row -- rather than merely not deleting it --
 * is caught by the whole-table comparison.
 *
 * @param {string} uid
 * @param {number} index
 * @returns {object}
 */
function seededRow(uid, index) {
  return {
    client_uid: uid,
    user_id: index % 3 === 0 ? USERS[0].id : null,
    cert_id: -(index + 1),
    issued_at: '2024-03-01T00:00:00.000Z',
    expires_at: '2027-03-01T00:00:00.000Z',
    last_seen_at: `2025-01-0${(index % 9) + 1}T00:00:00.000Z`,
    last_polled_at: '2025-01-01T00:00:00.000Z',
    revoked: index % 2 === 0
  };
}

/**
 * An in-memory `tak_devices` table plus the local `users` read, behind the
 * `{ query }` shape `DeviceSync` takes as its pool.
 *
 * The upsert is driven by the statement the implementation actually issues (its
 * insert column list and its `DO UPDATE SET col = EXCLUDED.col` assignments are
 * read out of the SQL text), and the DELETE is applied with its scoping intact:
 * the uids it was parameterised with are RETAINED and every other row is
 * removed. Every delete is also recorded verbatim, so the test can assert what
 * the statement asked for and not merely what the table ended up as -- an
 * unscoped `DELETE FROM tak_devices` arrives here with no params and is
 * distinguishable.
 *
 * @param {{rows: object[], failUserLoad: boolean}} args
 */
function createDeviceTable({ rows, failUserLoad }) {
  const devices = new Map(rows.map((row) => [row.client_uid, { ...row }]));
  const deletes = [];
  const upserts = [];

  const query = jest.fn(async (sql, params = []) => {
    if (sql.includes('FROM users')) {
      if (failUserLoad) throw new Error('local users read failed');
      return { rows: USERS.map((user) => ({ ...user })) };
    }

    if (sql.includes('INSERT INTO tak_devices')) {
      upserts.push({ sql, params });

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

    if (sql.includes('DELETE FROM tak_devices')) {
      deletes.push({ sql, params });

      // Requirement 17.3: the statement is scoped to the uids ABSENT from the
      // parameterised Live_Device_Set. An implementation that issued an
      // unscoped statement would arrive with `params[0]` undefined, which this
      // model turns into "no uid is live" -- the whole table goes -- so the
      // table-level assertions catch it too, not just the scoping assertion.
      const liveUids = new Set(Array.isArray(params[0]) ? params[0] : []);
      let rowCount = 0;

      for (const uid of [...devices.keys()]) {
        if (!liveUids.has(uid)) {
          devices.delete(uid);
          rowCount += 1;
        }
      }

      return { rowCount };
    }

    throw new Error(`Unexpected SQL in DeviceSync stale-deletion property test: ${sql}`);
  });

  return {
    query,
    deletes,
    upserts,
    /** Snapshot of the table keyed by `client_uid`. */
    snapshot() {
      return Object.fromEntries([...devices.entries()].map(([uid, row]) => [uid, { ...row }]));
    }
  };
}

/**
 * A whole scenario. Deliberately flat and small so the load-bearing cases can
 * be written out as explicit fast-check `examples` below rather than left to
 * sampling.
 *
 * `liveUids` IS the expected Live_Device_Set: the certificates handed to the
 * run are built from it, so the expectation never has to be derived by the
 * code under test.
 */
const scenarioArb = fc.record({
  outcome: fc.constantFrom(...OUTCOMES),
  // Includes the empty live set -- the case where correct and catastrophic
  // behaviour produce the same table.
  liveUids: fc.uniqueArray(fc.constantFrom(...LIVE_UID_POOL), { minLength: 0, maxLength: LIVE_UID_POOL.length }),
  staleUids: fc.uniqueArray(fc.constantFrom(...STALE_UID_POOL), { minLength: 0, maxLength: STALE_UID_POOL.length }),
  relationship: fc.constantFrom(...TABLE_RELATIONSHIPS),
  // Requirement 11.1: several Live_Certificates commonly share one uid, so the
  // Live_Device_Set is smaller than the certificate list.
  extraCertsPerUid: fc.integer({ min: 0, max: 2 }),
  // Certificates with no usable `clientUid`: skipped, forming no group, and so
  // contributing nothing to the Live_Device_Set.
  uidlessCerts: fc.integer({ min: 0, max: 2 }),
  malformedPayloadIndex: fc.integer({ min: 0, max: MALFORMED_PAYLOADS.length - 1 }),
  rejectionStatus: fc.constantFrom(404, 401, 500, 503, null)
});

/**
 * Expands a generated scenario into the pre-existing table content, the
 * certificate list, and the expectations -- all computed from the GENERATED
 * `liveUids` rather than from the implementation's derivation.
 *
 * @param {object} scenario
 */
function buildScenario(scenario) {
  const { outcome, liveUids, staleUids, relationship, extraCertsPerUid, uidlessCerts } = scenario;

  // The (Live_Device_Set, table content) pair, across the required spectrum.
  let tableUids;
  switch (relationship) {
    case 'disjoint':
      tableUids = [...staleUids];
      break;
    case 'identical':
      tableUids = [...liveUids];
      break;
    case 'subset':
      tableUids = liveUids.slice(0, Math.ceil(liveUids.length / 2));
      break;
    case 'superset':
      tableUids = [...liveUids, ...staleUids];
      break;
    case 'overlap':
      tableUids = [...liveUids.filter((_uid, index) => index % 2 === 0), ...staleUids];
      break;
    default:
      tableUids = [];
      break;
  }

  const rows = tableUids.map((uid, index) => seededRow(uid, index));

  // One certificate per live uid, plus duplicates on the same uid, plus
  // certificates with no usable uid at all. Ids are positional only in this
  // builder; which certificate of a group wins is Property 8's concern.
  const certificates = [];
  liveUids.forEach((uid, index) => {
    for (let copy = 0; copy <= extraCertsPerUid; copy += 1) {
      certificates.push({
        id: (index + 1) * 100 + copy,
        clientUid: uid,
        creatorDn: index % 2 === 0 ? `CN=${USERS[0].username},OU=TAK,O=NZ` : 'CN=nobody-local,OU=TAK,O=NZ',
        issuanceDate: `2025-0${(copy % 9) + 1}-01T00:00:00.000Z`,
        expirationDate: '2027-01-01T00:00:00.000Z'
      });
    }
  });
  for (let index = 0; index < uidlessCerts; index += 1) {
    certificates.push({
      id: 9000 + index,
      clientUid: index % 2 === 0 ? undefined : '',
      creatorDn: 'CN=nobody-local,OU=TAK,O=NZ',
      issuanceDate: '2025-06-01T00:00:00.000Z',
      expirationDate: '2027-06-01T00:00:00.000Z'
    });
  }

  const liveSet = new Set(liveUids);
  const succeeded = outcome === 'success';

  // The biconditional, restated as sets and computed independently:
  //   deleted  <=> succeeded AND uid absent from the Live_Device_Set
  const expectedDeleted = succeeded ? tableUids.filter((uid) => !liveSet.has(uid)) : [];
  const expectedRetained = succeeded ? tableUids.filter((uid) => liveSet.has(uid)) : [...tableUids];
  // On success every live uid is upserted and every other row is deleted, so
  // the table converges on exactly the Live_Device_Set. On failure nothing is
  // written and nothing is deleted, so it is exactly what it was.
  const expectedSurviving = succeeded ? [...liveSet] : [...tableUids];

  return { tableUids, rows, certificates, liveSet, succeeded, expectedDeleted, expectedRetained, expectedSurviving };
}

/**
 * Builds the TAK Server double for a scenario's fetch outcome.
 *
 * @param {object} scenario
 * @param {Array<object>} certificates
 */
function createTakServerService(scenario, certificates) {
  if (scenario.outcome === 'fetch-rejection') {
    return { listLiveCertificates: jest.fn().mockRejectedValue(fetchError(scenario.rejectionStatus)) };
  }
  if (scenario.outcome === 'non-list-payload') {
    return {
      listLiveCertificates: jest.fn().mockResolvedValue(MALFORMED_PAYLOADS[scenario.malformedPayloadIndex])
    };
  }
  // `user-load-failure` still fetches successfully; the failure is the local
  // `users` read, injected by the pool double.
  return { listLiveCertificates: jest.fn().mockResolvedValue(certificates.map((cert) => ({ ...cert }))) };
}

/**
 * Non-vacuity guard: a property that never generated a deletion would pass
 * while proving nothing, and the four outcomes are required coverage rather
 * than a nice-to-have. Asserted after the run.
 */
const observed = {
  fetchRejection: false,
  nonListPayload: false,
  userLoadFailure: false,
  success: false,
  successfulDeletion: false,
  failedRunAgainstNonEmptyTable: false,
  emptyLiveSetOnSuccess: false,
  liveUidRetained: false,
  emptyTable: false,
  identicalPair: false,
  disjointPair: false
};

/**
 * The load-bearing cases, written out rather than left to sampling: one
 * SUCCESSFUL run whose Live_Device_Set is empty against a populated table
 * (every row must go), and the SAME table under each of the three failure
 * outcomes (no row may go). All four derive an empty live set; only the run's
 * outcome tells them apart.
 */
const emptyLiveSetBase = {
  liveUids: [],
  staleUids: [...STALE_UID_POOL],
  relationship: 'disjoint',
  extraCertsPerUid: 0,
  uidlessCerts: 0,
  malformedPayloadIndex: 0,
  rejectionStatus: 404
};

const REQUIRED_EXAMPLES = [
  [{ ...emptyLiveSetBase, outcome: 'success' }],
  [{ ...emptyLiveSetBase, outcome: 'fetch-rejection' }],
  [{ ...emptyLiveSetBase, outcome: 'non-list-payload' }],
  // A malformed payload that reads as "empty" rather than as garbage: `{ data: [] }`.
  [{ ...emptyLiveSetBase, outcome: 'non-list-payload', malformedPayloadIndex: MALFORMED_PAYLOADS.length - 1 }],
  [{ ...emptyLiveSetBase, outcome: 'user-load-failure' }],
  // A successful run whose live set covers the whole table: nothing may go.
  [{ ...emptyLiveSetBase, outcome: 'success', liveUids: [...LIVE_UID_POOL], relationship: 'identical' }],
  // A successful run against an empty table: nothing to delete, still scoped.
  [{ ...emptyLiveSetBase, outcome: 'success', liveUids: [...LIVE_UID_POOL], relationship: 'empty-table' }]
];

// Feature: device-management, Property 14: A row is deleted if and only if the fetch succeeded and its client UID is not live
describe('Property 14: A row is deleted if and only if the fetch succeeded and its client UID is not live', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('holds for all fetch outcomes crossed with all (Live_Device_Set, table content) pairs', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async (scenario) => {
        const {
          tableUids,
          rows,
          certificates,
          liveSet,
          succeeded,
          expectedDeleted,
          expectedRetained,
          expectedSurviving
        } = buildScenario(scenario);

        // ---- generator coverage bookkeeping (asserted after the run) ----
        observed[
          {
            'fetch-rejection': 'fetchRejection',
            'non-list-payload': 'nonListPayload',
            'user-load-failure': 'userLoadFailure',
            success: 'success'
          }[scenario.outcome]
        ] = true;
        if (succeeded && expectedDeleted.length > 0) observed.successfulDeletion = true;
        if (!succeeded && tableUids.length > 0) observed.failedRunAgainstNonEmptyTable = true;
        if (succeeded && liveSet.size === 0 && tableUids.length > 0) observed.emptyLiveSetOnSuccess = true;
        if (succeeded && expectedRetained.length > 0) observed.liveUidRetained = true;
        if (tableUids.length === 0) observed.emptyTable = true;
        if (tableUids.length > 0 && tableUids.every((uid) => liveSet.has(uid)) && liveSet.size === tableUids.length) {
          observed.identicalPair = true;
        }
        if (tableUids.length > 0 && tableUids.every((uid) => !liveSet.has(uid))) observed.disjointPair = true;

        const db = createDeviceTable({ rows, failUserLoad: scenario.outcome === 'user-load-failure' });
        const before = db.snapshot();

        const counts = await new DeviceSync({
          takServerService: createTakServerService(scenario, certificates),
          pool: db
        }).run();

        const after = db.snapshot();

        if (!succeeded) {
          // Requirement 17.2, the load-bearing safety constraint. A failed run
          // reports `undefined`, deletes NOTHING -- it never even issues the
          // statement -- and writes nothing, so the table is bit-for-bit what
          // it was, whatever it contained and however the fetch failed. This is
          // the reverse direction of the biconditional at its strongest: the
          // derived live set is empty on every one of these paths, so a table
          // full of rows absent from it survives purely because the run failed.
          expect(counts).toBeUndefined();
          expect(db.deletes).toHaveLength(0);
          expect(db.upserts).toHaveLength(0);
          expect(after).toEqual(before);
          expect(Object.keys(after).sort()).toEqual([...tableUids].sort());
          return;
        }

        // ---- Requirement 17.3: every deletion is restricted by `client_uid` ----
        // Exactly one statement, and it is scoped: its parameter array, compared
        // as a SET, is the Live_Device_Set. An unscoped `DELETE FROM tak_devices`
        // carries no `WHERE` and no params and fails all three of these.
        expect(db.deletes).toHaveLength(1);
        const [{ sql, params }] = db.deletes;
        expect(sql).toMatch(/WHERE/i);
        expect(sql).toMatch(/client_uid/);
        expect(Array.isArray(params?.[0])).toBe(true);
        expect(new Set(params[0])).toEqual(liveSet);
        expect(params[0]).toHaveLength(liveSet.size);

        // ---- the biconditional, at the table level ----
        // Forward (Requirement 17.1): every row whose uid is absent from the
        // Live_Device_Set is gone.
        for (const uid of expectedDeleted) {
          expect(Object.prototype.hasOwnProperty.call(after, uid)).toBe(false);
        }

        // Reverse (Requirement 17.4): no row whose uid is present in the
        // Live_Device_Set is gone -- Requirement 11.5's failure mode from the
        // other direction, hiding a live Device. Its Last_Seen and revoked flag
        // are untouched too, so "retained" means retained rather than
        // re-inserted at the column defaults.
        for (const uid of expectedRetained) {
          expect(Object.prototype.hasOwnProperty.call(after, uid)).toBe(true);
          expect(after[uid].last_seen_at).toBe(before[uid].last_seen_at);
          expect(after[uid].revoked).toBe(before[uid].revoked);
        }

        // The two directions together: the surviving set is EXACTLY the
        // Live_Device_Set -- no stale row left standing, no live row missing.
        expect(Object.keys(after).sort()).toEqual([...expectedSurviving].sort());

        // Requirement 17.9: the deleted count is reported on the completed run.
        expect(counts.deleted).toBe(expectedDeleted.length);
        expect(counts.devices).toBe(liveSet.size);
      }),
      { numRuns: 300, examples: REQUIRED_EXAMPLES }
    );

    // The generated runs really did reach every shape Property 14 is about --
    // all four fetch outcomes, an actual deletion, a failed run against a
    // populated table, the empty-live-set success, and a retained live uid -- so
    // none of the assertions above passed vacuously.
    expect(observed).toEqual({
      fetchRejection: true,
      nonListPayload: true,
      userLoadFailure: true,
      success: true,
      successfulDeletion: true,
      failedRunAgainstNonEmptyTable: true,
      emptyLiveSetOnSuccess: true,
      liveUidRetained: true,
      emptyTable: true,
      identicalPair: true,
      disjointPair: true
    });
  });
});
