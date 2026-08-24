/**
 * device-management tasks 16.4, 20.4, 28.7: the single fast-check property test
 * for design.md's Correctness Property 4 (Requirements 4.4, 4.7, 20.10).
 *
 * **Validates: Requirements 4.4, 4.7, 20.10**
 *
 * This is a MODEL-BASED test rather than a call-shape assertion: the mocked
 * pool is backed by an in-memory `tak_devices` map that faithfully applies
 * the real `ON CONFLICT (client_uid) DO UPDATE SET ...` semantics of
 * `DeviceSync.upsertDevice` (including the crucial part -- `last_seen_at`,
 * `revoked` and `connected` appear in neither the insert column list nor the
 * update list, so an existing row keeps whatever it already held). The real
 * `DeviceSync.run()` then runs TWICE over the same generated
 * Live_Certificate set and the resulting row set is compared against the
 * first run's.
 *
 * The generated set is the LIVE set (`/active` MINUS `/revoked`), fed through
 * `listLiveCertificates()` -- the only certificate view `DeviceSync` consumes
 * (Requirements 4.3, 11.2). `clientUid`s are drawn from a small alphabet
 * against a larger certificate count, so reuse -- the normal case, verified
 * live -- is what the "one row per distinct `client_uid`" half of the property
 * runs against. Which certificate of a group wins is NOT asserted here: that
 * is Property 8's Newest_Live_Certificate derivation. This file asserts only
 * that a group yields exactly one row, that a replay changes nothing, and that
 * `last_seen_at`/`revoked`/`connected` survive.
 *
 * Some rows are seeded before the first run with a non-null `last_seen_at`,
 * `revoked: true` and `connected: true` (and deliberately stale
 * `cert_id`/`user_id`/date values), which is what gives the preservation half
 * of the property teeth: a sync that carried
 * `last_seen_at`/`revoked`/`connected` through its upsert -- or that
 * inserted defaults over an existing row -- would clobber them. That half is
 * carried by the seeded rows whose uid DOES hold a Live_Certificate: they are
 * refreshed in place, and their `last_seen_at`/`revoked`/`connected` have to
 * come through the refresh untouched.
 *
 * Task 28.7 / Requirement 20.10: `connected` joins that preservation list
 * rather than earning a property of its own, which is design.md's "Two
 * existing properties are strengthened rather than duplicated" decision. The
 * Subscription_Poller is the column's ONE writer, so a sync run must leave a
 * stored `connected` exactly as it found it and an inserted row must take the
 * column default of false. Both halves are asserted here, and the column is
 * additionally asserted absent from the insert column list AND from the
 * `DO UPDATE SET` list -- read out of the SQL the implementation issued, not
 * assumed -- so a `connected = EXCLUDED.connected` added to either list fails
 * this property twice over.
 *
 * Seeds are drawn from the same `clientUid` alphabet, so some seeded rows
 * belong to a uid with no Live_Certificate at all. Since task 25.1 those rows
 * are DELETED by the reconciliation step a completed run ends with
 * (Requirement 17.1), so the table converges on exactly the Live_Device_Set
 * rather than accumulating every uid it has ever seen. The pool double below
 * models that DELETE -- including its `client_uid` scoping, so the retained
 * uids are exactly the parameterised ones -- and the assertions expect a
 * non-live seeded uid to be GONE rather than left standing. An earlier version
 * of this paragraph claimed such a row "must be left entirely alone -- not
 * refreshed, not rewritten, not deleted"; that was the pre-25.1 design error
 * (Requirement 17 exists precisely because nothing removed those rows) and it
 * contradicted this file's own body. Requirement 17's behaviour is covered by
 * tasks 25.3/25.4; what matters here is only that this double does not model
 * the sync as if the deletion did not happen.
 *
 * `last_polled_at` is deliberately NOT part of the compared column set:
 * Requirement 4.7 defines it as each run's own time, so it is EXPECTED to
 * differ between run one and run two.
 *
 * Sibling `DeviceSync.test.js` covers the concrete examples, the exact SQL
 * text, scheduling, and the never-throwing error paths.
 */

jest.mock('../../config/database', () => ({
  query: jest.fn()
}));

jest.mock('../../config/logger', () => ({
  createLogger: jest.fn(() => ({ info: jest.fn(), error: jest.fn(), debug: jest.fn(), warn: jest.fn() }))
}));

const fc = require('fast-check');

const DeviceSync = require('../DeviceSync');

/**
 * The five columns Property 4 quantifies over: "upserting twice yields the
 * same rows as once (same `client_uid`, `cert_id`, `issued_at`,
 * `expires_at`, `user_id`)".
 */
const CARRIED_COLUMNS = ['client_uid', 'user_id', 'cert_id', 'issued_at', 'expires_at'];

/** `tak_devices` column defaults, applied to columns an INSERT omits. */
const COLUMN_DEFAULTS = {
  client_uid: null,
  user_id: null,
  cert_id: null,
  issued_at: null,
  expires_at: null,
  last_seen_at: null, // NULL = "never seen"
  last_polled_at: null,
  revoked: false,
  // Requirement 20.2: `boolean NOT NULL DEFAULT false`. An inserted row takes
  // this default because the sync does not list the column (Requirement 20.10).
  connected: false
};

/**
 * The columns `DeviceSync` must never write, on insert or on conflict:
 * `last_seen_at` belongs to the Subscription_Poller (Requirement 3.3),
 * `revoked` to the Revoke_Operation handler (Requirements 7.6, 8.7), and
 * `connected` to the Subscription_Poller as its ONE writer (Requirement 20.10).
 */
const FOREIGN_COLUMNS = ['last_seen_at', 'revoked', 'connected'];

/**
 * The `cert_id` every seeded row starts with -- outside the generated id range
 * so "this row was refreshed off its stale seed" and "this row was never
 * touched" are distinguishable.
 */
const STALE_CERT_ID = -1;

/**
 * An in-memory `tak_devices` table plus the local `users` read, exposed
 * through the `{ query }` shape `DeviceSync` injects as its pool.
 *
 * The INSERT branch is driven by the statement the implementation actually
 * issues rather than by a hardcoded column order: the insert column list and
 * the `DO UPDATE SET col = EXCLUDED.col` assignments are read out of the SQL
 * text and applied against the map. That is what makes the preservation half
 * of Property 4 a real check -- if `DeviceSync` ever started listing
 * `last_seen_at`/`revoked`/`connected` in either list, this model would
 * dutifully write them and the property would fail, instead of silently
 * passing because the model hardcoded the good behavior.
 *
 * The same parse is also exposed through `writtenColumns()`, so the property
 * can name the forbidden columns directly rather than only observing their
 * effect: the model reports every column the statements listed, and the
 * assertion is that `connected` is in neither list (Requirement 20.10).
 *
 * @param {{users: Array<{id: number, username: string}>, rows?: object[]}} args
 */
function createInMemoryDb({ users, rows = [] }) {
  const devices = new Map(rows.map((row) => [row.client_uid, { ...row }]));
  /** Columns the issued upserts named, as parsed out of the SQL text. */
  const written = { inserted: new Set(), updated: new Set() };

  const query = jest.fn(async (sql, params = []) => {
    if (sql.includes('FROM users')) {
      return { rows: users.map((user) => ({ ...user })) };
    }

    if (sql.includes('INSERT INTO tak_devices')) {
      const insertColumns = sql
        .slice(sql.indexOf('(') + 1, sql.indexOf(')'))
        .split(',')
        .map((column) => column.trim());
      // The row the statement proposes -- Postgres' EXCLUDED.
      const excluded = Object.fromEntries(insertColumns.map((column, index) => [column, params[index]]));

      const updateClause = sql.slice(sql.indexOf('DO UPDATE SET'));
      const updatedColumns = [...updateClause.matchAll(/(\w+)\s*=\s*EXCLUDED\.(\w+)/g)].map(([, target, source]) => [
        target,
        source
      ]);

      insertColumns.forEach((column) => written.inserted.add(column));
      updatedColumns.forEach(([target]) => written.updated.add(target));

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
    // run ends with. Modelled faithfully -- including its scoping -- so this
    // double cannot hide it: the uids it is parameterised with are RETAINED and
    // every other row is removed.
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

    throw new Error(`Unexpected SQL in DeviceSync property test: ${sql}`);
  });

  return {
    query,
    /** How many `tak_devices` upserts have been issued so far. */
    upsertCount() {
      return query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO tak_devices')).length;
    },
    /**
     * The columns the issued upserts named, split by list: `inserted` is the
     * `INSERT INTO tak_devices (...)` column list, `updated` the targets of the
     * `ON CONFLICT ... DO UPDATE SET` assignments.
     */
    writtenColumns() {
      return { inserted: [...written.inserted], updated: [...written.updated] };
    },
    /** Snapshot of the table keyed by `client_uid`, for run-to-run comparison. */
    snapshot() {
      return Object.fromEntries([...devices.entries()].map(([uid, row]) => [uid, { ...row }]));
    }
  };
}

/** Reduces a snapshot to only the columns Property 4 compares. */
function carriedColumns(snapshot) {
  return Object.fromEntries(
    Object.entries(snapshot).map(([uid, row]) => [
      uid,
      Object.fromEntries(CARRIED_COLUMNS.map((column) => [column, row[column]]))
    ])
  );
}

const usernameArb = fc.integer({ min: 0, max: 5 }).map((n) => `user${n}`);
/**
 * A small `clientUid` alphabet against a larger certificate count, so several
 * Live_Certificates commonly share one uid -- the live shape (95 certificates,
 * 10 distinct uids), not an edge case.
 */
const clientUidArb = fc.integer({ min: 0, max: 6 }).map((n) => `uid-${n}`);
const timestampArb = fc
  .date({ min: new Date('2020-01-01T00:00:00.000Z'), max: new Date('2030-01-01T00:00:00.000Z'), noInvalidDate: true })
  .map((date) => date.toISOString());

/**
 * A generated Live_Certificate in the Marti `TakCert` shape
 * `{ id, creatorDn, clientUid, issuanceDate, expirationDate }`.
 *
 * `creatorDn` is drawn so it sometimes names a generated local username
 * (resolving to a real `user_id`) and sometimes names nobody (resolving to
 * NULL), exercising both attribution outcomes. `issuanceDate` is drawn freely,
 * so a group's newest certificate lands anywhere in the array.
 */
const certificateArb = fc.record({
  clientUid: clientUidArb,
  id: fc.option(fc.integer({ min: 1, max: 100000 }), { nil: undefined }),
  creatorDn: fc.oneof(
    usernameArb.map((username) => `CN=${username},OU=TAK,O=NZ`),
    fc.constant('CN=nobody-local,OU=TAK,O=NZ'),
    fc.constant(undefined)
  ),
  issuanceDate: fc.option(timestampArb, { nil: undefined }),
  expirationDate: fc.option(timestampArb, { nil: undefined })
});

/** A pre-existing Device_Table row: the Last_Seen and revoked flag it holds. */
const seedArb = fc.record({
  clientUid: clientUidArb,
  lastSeenAt: timestampArb
});

const scenarioArb = fc.record({
  users: fc.uniqueArray(usernameArb, { minLength: 1, maxLength: 6 }).map((usernames) =>
    usernames.map((username, index) => ({ id: index + 1, username }))
  ),
  certificates: fc.array(certificateArb, { minLength: 1, maxLength: 14 }),
  seeds: fc.array(seedArb, { maxLength: 6 })
});

// Feature: device-management, Property 4: Device sync is idempotent and preserves Last_Seen
describe('Property 4: Device sync is idempotent and preserves Last_Seen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('holds for all generated Live_Certificate sets', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async ({ users, certificates, seeds }) => {
        // One seeded row per uid: `client_uid` is the primary key.
        const seedByUid = new Map(seeds.map((seed) => [seed.clientUid, seed]));
        const seededRows = [...seedByUid.values()].map((seed) => ({
          client_uid: seed.clientUid,
          // Deliberately stale carried values, so the sync has to
          // overwrite them...
          user_id: null,
          cert_id: STALE_CERT_ID,
          issued_at: null,
          expires_at: null,
          last_polled_at: null,
          // ...while these three must survive untouched. `connected: true` is
          // seeded deliberately AGAINST the column default, so a sync that
          // wrote the column at all -- with a value, or with the `undefined`
          // an unlisted `EXCLUDED.connected` resolves to -- is caught rather
          // than accidentally agreeing with the default (Requirement 20.10).
          last_seen_at: seed.lastSeenAt,
          revoked: true,
          connected: true
        }));

        const db = createInMemoryDb({ users, rows: seededRows });
        const takServerService = {
          listLiveCertificates: jest.fn().mockResolvedValue(
            certificates.map(({ clientUid, id, creatorDn, issuanceDate, expirationDate }) => ({
              clientUid,
              id,
              creatorDn,
              issuanceDate,
              expirationDate
            }))
          )
        };

        const job = new DeviceSync({ takServerService, pool: db });

        await job.run();
        const afterFirstRun = db.snapshot();
        const upsertsAfterFirstRun = db.upsertCount();

        await job.run();
        const afterSecondRun = db.snapshot();

        // Idempotence: the second upsert of the same set yields exactly the
        // same rows, on exactly the same keys, as the first.
        expect(carriedColumns(afterSecondRun)).toEqual(carriedColumns(afterFirstRun));

        const liveUids = new Set(certificates.map((cert) => cert.clientUid));

        // Requirement 4.4: ONE row per distinct `client_uid`, not one per
        // certificate -- so the write count follows the Devices, and each run
        // issues the same number of writes as the last.
        expect(upsertsAfterFirstRun).toBe(liveUids.size);
        expect(db.upsertCount()).toBe(liveUids.size * 2);

        // Requirements 3.3, 7.6, 8.7, 20.10: the columns with another writer
        // appear in NEITHER the insert column list NOR the `DO UPDATE SET`
        // list, read out of the statements the implementation actually issued.
        // `connected`'s writer is the Subscription_Poller and only the
        // Subscription_Poller, so a sync run has no business naming it.
        const written = db.writtenColumns();
        expect(written.inserted).toEqual(
          expect.arrayContaining(['client_uid', 'user_id', 'cert_id', 'issued_at', 'expires_at'])
        );
        for (const column of FOREIGN_COLUMNS) {
          expect(written.inserted).not.toContain(column);
          expect(written.updated).not.toContain(column);
        }

        // Non-vacuity: every generated clientUid is a valid non-empty key, so
        // every one really did produce a row. Since task 25.1 a completed run
        // also DELETES the rows whose `client_uid` carries no Live_Certificate
        // (Requirement 17.1), so the table converges on exactly the live set --
        // a seeded uid that is not live is gone rather than left standing.
        // Requirement 17's own behaviour is covered by tasks 25.3/25.4; what
        // matters here is that this double does not model the sync as if the
        // deletion did not happen.
        expect(Object.keys(afterSecondRun).sort()).toEqual([...liveUids].sort());

        for (const uid of Object.keys(afterSecondRun)) {
          const first = afterFirstRun[uid];
          const second = afterSecondRun[uid];
          const seed = seedByUid.get(uid);

          if (seed) {
            // Preservation: the pre-existing Last_Seen and revoked flag are
            // unchanged by either run. A seeded uid still present after a run
            // is by definition a live one (Requirement 17.4 -- a `client_uid`
            // in the Live_Device_Set is never deleted), so its carried columns
            // WERE refreshed off the stale seed.
            expect(first.last_seen_at).toBe(seed.lastSeenAt);
            expect(second.last_seen_at).toBe(seed.lastSeenAt);
            expect(first.revoked).toBe(true);
            expect(second.revoked).toBe(true);
            // Requirement 20.10: the stored Connection_Status is left exactly
            // as the poller last wrote it, by either run.
            expect(first.connected).toBe(true);
            expect(second.connected).toBe(true);
            expect(liveUids.has(uid)).toBe(true);
            expect(second.cert_id).not.toBe(STALE_CERT_ID);
          } else {
            // A freshly synced Device is "never seen", not revoked, and not
            // connected -- the last from the column default rather than from
            // anything the sync wrote (Requirements 20.10, 20.11) -- and the
            // second run does not change that either.
            expect(first.last_seen_at).toBeNull();
            expect(second.last_seen_at).toBeNull();
            expect(first.revoked).toBe(false);
            expect(second.revoked).toBe(false);
            expect(first.connected).toBe(false);
            expect(second.connected).toBe(false);
          }
        }
      }),
      { numRuns: 200 }
    );
  });
});
