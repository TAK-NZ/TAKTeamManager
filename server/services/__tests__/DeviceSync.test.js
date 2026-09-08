jest.mock('../../config/database', () => ({
  query: jest.fn(),
  // start() now schedules run() through withJobLock (desiredCount>1
  // single-runner guard); connect() returns a lock-GRANTING client.
  connect: jest.fn()
}));

const mockLoggerInstance = { info: jest.fn(), error: jest.fn(), debug: jest.fn(), warn: jest.fn() };
jest.mock('../../config/logger', () => ({
  createLogger: jest.fn(() => mockLoggerInstance)
}));

const pool = require('../../config/database');
const DeviceSync = require('../DeviceSync');
const TakServerService = require('../TakServerService');

// A client that GRANTS the advisory lock.
function lockGrantingClient() {
  return {
    query: jest.fn(async (sql) =>
      typeof sql === 'string' && sql.includes('pg_try_advisory_lock')
        ? { rows: [{ locked: true }] }
        : { rows: [] }
    ),
    release: jest.fn()
  };
}

// runGuarded() adds async hops (connect -> try-lock) before run(); flush enough
// microtasks under fake timers for the immediate start() sync to reach run().
async function flushJobLock() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

/**
 * device-management tasks 7.4, 20.4: unit tests for `DeviceSync`
 * (Requirements 4.4, 4.5, 4.6, 4.7, 4.8, 4.9, 11.3, 11.4, 11.5, 11.6).
 *
 * Mocked collaborators only: a fake `TakServerService` supplying the
 * Live_Certificates, and the mocked `config/database` pool the sibling
 * `RetentionCleanupJob.test.js` uses.
 *
 * The unit under test consumes the LIVE set -- `GET /active` MINUS
 * `GET /revoked` -- via `listLiveCertificates()`, never the Active_Certificate
 * view (Requirements 4.3, 11.2), and groups it by `clientUid` into one row per
 * Device (Requirements 4.4, 11.1). Most tests therefore hand it an already-
 * computed live set through a `listLiveCertificates` stub. The
 * `DeviceSync.run over the two certificate views` block below is the exception:
 * it drives a real `TakServerService` over a recording HTTP double so the
 * request-level guarantees -- both views fetched, `/replaced` never fetched
 * (Requirement 11.4) -- are checked against the real code that issues them.
 *
 * Broad coverage of the never-overwrite guarantee across many inputs is
 * `DeviceSync.property.test.js` (Property 4); the Newest_Live_Certificate
 * derivation across many inputs is Property 8's own file. These are
 * example/unit tests.
 */

/** @returns {{listLiveCertificates: jest.Mock}} */
function createTakServerService(certificates = []) {
  return { listLiveCertificates: jest.fn().mockResolvedValue(certificates) };
}

/**
 * A real `TakServerService` whose HTTP client is replaced by a recording
 * double serving the two documented certificate views, so `run()` exercises
 * the actual `listLiveCertificates()` set difference and every requested path
 * is observable. No network is touched: `client` is replaced outright, and the
 * env carries no credential paths.
 *
 * @param {{active: object[], revoked: object[]}} views
 * @returns {{service: TakServerService, requestedPaths: string[]}}
 */
function createViewBackedTakServerService({ active = [], revoked = [] } = {}) {
  const requestedPaths = [];
  const service = new TakServerService({ TAK_SERVER_URL: 'https://tak.example.test' });

  service.client = {
    get: jest.fn(async (path) => {
      requestedPaths.push(path);
      if (path === '/Marti/api/certadmin/cert/active') return { data: { data: active } };
      if (path === '/Marti/api/certadmin/cert/revoked') return { data: { data: revoked } };
      throw new Error(`Unexpected TAK Server request in DeviceSync test: ${path}`);
    })
  };

  return { service, requestedPaths };
}

/**
 * Routes `SELECT id, username FROM users` to the given users and every
 * upsert to a successful write, so a test only has to describe the data.
 */
function mockPool({ users = [] } = {}) {
  pool.query.mockImplementation((sql) => {
    if (typeof sql === 'string' && sql.includes('FROM users')) {
      return Promise.resolve({ rows: users });
    }
    return Promise.resolve({ rowCount: 1 });
  });
  pool.connect.mockImplementation(async () => lockGrantingClient());
}

/** Finds every `INSERT INTO tak_devices ...` call made on the pool. */
function upsertCalls() {
  return pool.query.mock.calls.filter(
    ([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO tak_devices')
  );
}

/** The `client_uid` each upsert was keyed on, in upsert order. */
function upsertedClientUids() {
  return upsertCalls().map(([, params]) => params[0]);
}

/**
 * Finds every `DELETE FROM tak_devices ...` call made on the pool -- the
 * reconciliation statement of Requirement 17. Kept alongside `upsertCalls()`
 * because the deletion tests below assert on its ABSENCE as often as on its
 * contents: `deleteCalls()` empty is the load-bearing assertion for every
 * failed run (Requirement 17.2), and it is stronger than checking the returned
 * outcome, which would still pass for a delete that fired with an empty uid
 * array and emptied the table.
 */
function deleteCalls() {
  return pool.query.mock.calls.filter(
    ([sql]) => typeof sql === 'string' && sql.includes('DELETE FROM tak_devices')
  );
}

/**
 * A `pool` double backed by a simulated `tak_devices` table, for the
 * Requirement 17 deletion tests. The shared `mockPool` above answers any
 * non-users SQL with `rowCount: 1`, which is enough to observe THAT a delete
 * was issued but not WHICH rows it removed -- and "the table was left exactly
 * as it was" (Requirement 17.2) is a statement about rows, so these tests need
 * rows.
 *
 * Both writes are modelled from the statements themselves rather than from an
 * assumption about them:
 *
 *   - the upsert takes `last_seen_at`/`revoked`/`connected` from the existing
 *     row when there is one and from their column defaults (NULL / false /
 *     false) when it inserts, because none of the three appears in its column
 *     list or its `DO UPDATE SET` list -- which is what lets a re-appearing
 *     `client_uid` be checked against Requirements 17.5 and 20.11, and a
 *     refreshed row against Requirement 20.10;
 *   - the delete honours `client_uid <> ALL($1::text[])` by RETAINING the
 *     parameterised uids and removing every other row. A statement that
 *     carried no such predicate is treated as retaining nothing, i.e. it
 *     empties the table -- so an unscoped `DELETE FROM tak_devices` fails the
 *     row-level assertions here instead of passing quietly.
 *
 * @param {{users?: object[], rows?: object[], usersError?: Error|null,
 *   deleteError?: Error|null, failUpsertFor?: string[]}} options
 * @returns {{clientUids: () => string[], row: (clientUid: string) => object|undefined}}
 */
function mockDeviceTable({
  users = [],
  rows = [],
  usersError = null,
  deleteError = null,
  failUpsertFor = []
} = {}) {
  const table = new Map(
    rows.map((row) => [row.client_uid, { revoked: false, last_seen_at: null, connected: false, ...row }])
  );

  pool.query.mockImplementation((sql, params) => {
    if (typeof sql !== 'string') {
      return Promise.reject(new Error(`Unexpected non-string SQL: ${String(sql)}`));
    }

    if (sql.includes('FROM users')) {
      return usersError ? Promise.reject(usersError) : Promise.resolve({ rows: users });
    }

    if (sql.includes('INSERT INTO tak_devices')) {
      const clientUid = params[0];
      if (failUpsertFor.includes(clientUid)) {
        return Promise.reject(new Error(`upsert failed for ${clientUid}`));
      }

      const existing = table.get(clientUid);
      table.set(clientUid, {
        client_uid: clientUid,
        user_id: params[1],
        cert_id: params[2],
        issued_at: params[3],
        expires_at: params[4],
        last_polled_at: params[5],
        // Written by neither the insert nor the conflict update.
        last_seen_at: existing ? existing.last_seen_at : null,
        revoked: existing ? existing.revoked : false,
        // Requirement 20.10: same story, one writer -- the Subscription_Poller.
        connected: existing ? existing.connected : false
      });

      return Promise.resolve({ rowCount: 1 });
    }

    if (sql.includes('DELETE FROM tak_devices')) {
      if (deleteError) return Promise.reject(deleteError);

      const retained = new Set(sql.includes('<> ALL($1') ? params[0] : []);
      let rowCount = 0;
      for (const clientUid of [...table.keys()]) {
        if (!retained.has(clientUid)) {
          table.delete(clientUid);
          rowCount += 1;
        }
      }

      return Promise.resolve({ rowCount });
    }

    return Promise.reject(new Error(`Unexpected SQL in DeviceSync deletion test: ${sql}`));
  });

  return {
    /** The `client_uid`s the simulated table still holds, sorted. */
    clientUids() {
      return [...table.keys()].sort();
    },
    /** One row of the simulated table, or `undefined` once it is deleted. */
    row(clientUid) {
      return table.get(clientUid);
    }
  };
}

const CERT = {
  id: 42,
  clientUid: 'uid-1',
  creatorDn: 'CN=alice,OU=TAK,O=NZ',
  issuanceDate: '2024-01-01T00:00:00.000Z',
  expirationDate: '2025-01-01T00:00:00.000Z'
};

/**
 * Requirements 11.1/11.3: the live shape -- one `clientUid` carrying a SET of
 * Live_Certificates (verified live, 95 certificates carried 10 distinct
 * `clientUid`s, 60 of them on one). The Newest_Live_Certificate is
 * deliberately NOT last in the array, so a derivation that took "the last one
 * wins" instead of "the greatest `issuanceDate` wins" fails these tests.
 *
 * The newest certificate also carries a DIFFERENT `creatorDn` from its
 * siblings, which is what gives Requirement 4.5's "the Newest_Live_
 * Certificate's `creatorDn`" its own teeth (see the user-resolution block).
 */
const UID_1_OLDEST = {
  id: 9,
  clientUid: 'uid-1',
  creatorDn: 'CN=carol,OU=TAK,O=NZ',
  issuanceDate: '2024-01-01T00:00:00.000Z',
  expirationDate: '2025-01-01T00:00:00.000Z'
};
const UID_1_NEWEST = {
  id: 11,
  clientUid: 'uid-1',
  creatorDn: 'CN=alice,OU=TAK,O=NZ',
  issuanceDate: '2024-06-01T00:00:00.000Z',
  expirationDate: '2025-06-01T00:00:00.000Z'
};
const UID_1_MIDDLE = {
  id: 10,
  clientUid: 'uid-1',
  creatorDn: 'CN=carol,OU=TAK,O=NZ',
  issuanceDate: '2024-03-01T00:00:00.000Z',
  expirationDate: '2025-03-01T00:00:00.000Z'
};
const UID_2_ONLY = {
  id: 5,
  clientUid: 'uid-2',
  creatorDn: 'CN=carol,OU=TAK,O=NZ',
  issuanceDate: '2024-02-01T00:00:00.000Z',
  expirationDate: '2025-02-01T00:00:00.000Z'
};

/** Four Live_Certificates, two Devices, newest-first-then-shuffled. */
const REUSED_UID_LIVE_SET = [UID_1_MIDDLE, UID_1_NEWEST, UID_1_OLDEST, UID_2_ONLY];

/**
 * Requirement 4.8 / design.md: "`DEVICE_MGMT_SYNC_INTERVAL_SECONDS`, clamped,
 * default e.g. 15 minutes" -- the existing Sync_Worker scheduled-job
 * pattern, no new framework. Bounds are sanity guards: a 1-minute floor
 * against a busy-loop, a 24-hour ceiling against a mistyped value parking
 * the sync for weeks.
 */
describe('DeviceSync interval configuration', () => {
  const originalEnv = process.env.DEVICE_MGMT_SYNC_INTERVAL_SECONDS;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.DEVICE_MGMT_SYNC_INTERVAL_SECONDS;
    } else {
      process.env.DEVICE_MGMT_SYNC_INTERVAL_SECONDS = originalEnv;
    }
  });

  it('defaults to 900000ms (15 minutes) when unset', () => {
    delete process.env.DEVICE_MGMT_SYNC_INTERVAL_SECONDS;
    const job = new DeviceSync({ takServerService: createTakServerService(), pool });
    expect(job.intervalMs).toBe(900000);
  });

  it('respects a valid configured value within the allowed range', () => {
    process.env.DEVICE_MGMT_SYNC_INTERVAL_SECONDS = '300';
    const job = new DeviceSync({ takServerService: createTakServerService(), pool });
    expect(job.intervalMs).toBe(300000);
  });

  it('clamps a value below 60 seconds up to 60000ms', () => {
    process.env.DEVICE_MGMT_SYNC_INTERVAL_SECONDS = '1';
    const job = new DeviceSync({ takServerService: createTakServerService(), pool });
    expect(job.intervalMs).toBe(60000);
  });

  it('clamps a value above 24 hours down to 24 hours', () => {
    process.env.DEVICE_MGMT_SYNC_INTERVAL_SECONDS = '9000000';
    const job = new DeviceSync({ takServerService: createTakServerService(), pool });
    expect(job.intervalMs).toBe(24 * 60 * 60 * 1000);
  });

  it('falls back to the default for a non-numeric value', () => {
    process.env.DEVICE_MGMT_SYNC_INTERVAL_SECONDS = 'quarter-hourly';
    const job = new DeviceSync({ takServerService: createTakServerService(), pool });
    expect(job.intervalMs).toBe(900000);
  });
});

describe('DeviceSync start()/stop() lifecycle', () => {
  let takServerService;
  let job;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    mockPool();
    takServerService = createTakServerService([CERT]);
    job = new DeviceSync({ takServerService, pool });
  });

  afterEach(() => {
    job.stop();
    jest.useRealTimers();
  });

  it('syncs immediately on start(), before any interval elapses', async () => {
    job.start();
    await flushJobLock();

    expect(takServerService.listLiveCertificates).toHaveBeenCalledTimes(1);
  });

  it('syncs again after the configured interval elapses', async () => {
    job.start();
    await flushJobLock();
    expect(takServerService.listLiveCertificates).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(job.intervalMs);

    expect(takServerService.listLiveCertificates).toHaveBeenCalledTimes(2);
  });

  it('does not double-start: calling start() twice only sets up one interval/immediate sync', async () => {
    job.start();
    const timerAfterFirstStart = job.timer;
    job.start();
    await flushJobLock();

    expect(takServerService.listLiveCertificates).toHaveBeenCalledTimes(1);
    expect(job.timer).toBe(timerAfterFirstStart);
  });

  it('stop() clears the interval so no further syncs run', async () => {
    job.start();
    await flushJobLock();
    expect(takServerService.listLiveCertificates).toHaveBeenCalledTimes(1);

    job.stop();

    await jest.advanceTimersByTimeAsync(job.intervalMs * 2);

    expect(takServerService.listLiveCertificates).toHaveBeenCalledTimes(1);
    expect(job.timer).toBeNull();
  });

  it('stop() is a no-op when not running, and idempotent against a double stop()', () => {
    expect(() => job.stop()).not.toThrow();

    job.start();
    job.stop();

    expect(() => job.stop()).not.toThrow();
    expect(job.timer).toBeNull();
  });
});

/**
 * Requirements 4.4/4.7/11.3/11.6: exactly one upserted `tak_devices` row per
 * distinct `client_uid` -- never one per certificate -- carrying that
 * Device's Newest_Live_Certificate's `cert_id`, `issued_at`, `expires_at`,
 * the resolved `user_id`, and `last_polled_at` set to this run's time.
 */
describe('DeviceSync.run upsert', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('upserts one row per client_uid with the right columns (Requirement 4.4)', async () => {
    mockPool({ users: [{ id: 7, username: 'alice' }] });
    const job = new DeviceSync({ takServerService: createTakServerService([CERT]), pool });

    const before = Date.now();
    const counts = await job.run();
    const after = Date.now();

    const calls = upsertCalls();
    expect(calls).toHaveLength(1);

    const [sql, params] = calls[0];
    expect(sql).toContain('INSERT INTO tak_devices (client_uid, user_id, cert_id, issued_at, expires_at, last_polled_at)');
    expect(sql).toContain('ON CONFLICT (client_uid) DO UPDATE SET');

    const [clientUid, userId, certId, issuedAt, expiresAt, lastPolledAt] = params;
    expect(clientUid).toBe('uid-1');
    expect(userId).toBe(7);
    expect(certId).toBe(42);
    expect(issuedAt).toBe(CERT.issuanceDate);
    expect(expiresAt).toBe(CERT.expirationDate);

    // Requirement 4.7: `last_polled_at` is this run's time.
    expect(lastPolledAt).toBeInstanceOf(Date);
    expect(lastPolledAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(lastPolledAt.getTime()).toBeLessThanOrEqual(after);

    // `deleted` is part of every completed run's counts since task 25.1
    // (Requirement 17.9); the mocked pool reports one row removed by the
    // reconciliation statement. Its own behaviour is covered by task 25.3.
    expect(counts).toEqual({
      liveCertificates: 1,
      devices: 1,
      upserted: 1,
      skipped: 0,
      failed: 0,
      matched: 1,
      unmatched: 0,
      deleted: 1
    });
  });

  /**
   * Requirements 4.4/4.6/11.1/11.3: many Live_Certificates commonly share one
   * `clientUid`, and such a group collapses to ONE row carrying the
   * greatest-`issuanceDate` certificate's attributes. The superseded siblings
   * contribute nothing -- not a second row, and not their own dates.
   */
  it('collapses a reused client_uid to one row carrying its Newest_Live_Certificate (Requirements 4.4, 11.3)', async () => {
    mockPool({ users: [{ id: 7, username: 'alice' }] });
    const job = new DeviceSync({ takServerService: createTakServerService(REUSED_UID_LIVE_SET), pool });

    const counts = await job.run();

    expect(upsertedClientUids()).toEqual(['uid-1', 'uid-2']);

    const [, uid1Params] = upsertCalls()[0];
    expect(uid1Params[2]).toBe(UID_1_NEWEST.id);
    expect(uid1Params[3]).toBe(UID_1_NEWEST.issuanceDate);
    expect(uid1Params[4]).toBe(UID_1_NEWEST.expirationDate);

    const [, uid2Params] = upsertCalls()[1];
    expect(uid2Params[2]).toBe(UID_2_ONLY.id);

    // Four Live_Certificates, two Devices: the count of rows written follows
    // the distinct `clientUid`s, not the certificates.
    expect(counts).toMatchObject({ liveCertificates: 4, devices: 2, upserted: 2, skipped: 0, failed: 0 });
  });

  /**
   * Requirement 11.3's tiebreak: two certificates on one `clientUid` sharing
   * an `issuanceDate` resolve to the greater `cert_id` (TAK Server issues ids
   * monotonically), so the winner never depends on the order the view
   * happened to return them in.
   */
  it('breaks an issuanceDate tie on the greater cert_id', async () => {
    mockPool({ users: [] });
    const certificates = [
      { ...CERT, id: 77 },
      { ...CERT, id: 78 },
      { ...CERT, id: 12 }
    ];
    const job = new DeviceSync({ takServerService: createTakServerService(certificates), pool });

    await job.run();

    expect(upsertCalls()).toHaveLength(1);
    expect(upsertCalls()[0][1][2]).toBe(78);
  });

  it('stamps every row in one run with the same last_polled_at (Requirement 4.7)', async () => {
    mockPool({ users: [] });
    const certificates = [
      { ...CERT, clientUid: 'uid-1' },
      { ...CERT, clientUid: 'uid-2' }
    ];
    const job = new DeviceSync({ takServerService: createTakServerService(certificates), pool });

    await job.run();

    const stamps = upsertCalls().map(([, params]) => params[5].getTime());
    expect(stamps).toHaveLength(2);
    expect(stamps[0]).toBe(stamps[1]);
  });

  it('passes missing certificate fields through as NULL rather than undefined', async () => {
    mockPool({ users: [] });
    const job = new DeviceSync({ takServerService: createTakServerService([{ clientUid: 'uid-bare' }]), pool });

    await job.run();

    const [, params] = upsertCalls()[0];
    expect(params[2]).toBeNull(); // cert_id
    expect(params[3]).toBeNull(); // issued_at
    expect(params[4]).toBeNull(); // expires_at
  });

  it('skips a certificate with no clientUid, since client_uid is the primary key', async () => {
    mockPool({ users: [] });
    const certificates = [{ ...CERT, clientUid: undefined }, { ...CERT, clientUid: '' }, CERT];
    const job = new DeviceSync({ takServerService: createTakServerService(certificates), pool });

    const counts = await job.run();

    expect(upsertedClientUids()).toEqual(['uid-1']);
    expect(counts.skipped).toBe(2);
    expect(counts.devices).toBe(1);
    expect(counts.upserted).toBe(1);
  });

  /**
   * Requirement 4.4 vs Requirements 3.3/7.6/8.7/20.10: `last_seen_at` belongs
   * to the Subscription_Poller, `revoked` to the Revoke_Operation handler, and
   * `connected` to the Subscription_Poller as its ONE writer. Their absence
   * from BOTH the insert column list and the `DO UPDATE SET` list is what
   * guarantees this job can never overwrite them -- on insert they take their
   * column defaults, and on conflict Postgres leaves the stored values
   * untouched.
   *
   * Task 28.7 extended this test to `connected` rather than adding a
   * near-duplicate beside it: the claim, the statement under test and the two
   * lists being read are identical, so a second test would only restate this
   * one. The second half is the row-level counterpart -- a seeded `connected`
   * has to survive an actual sync run, which is what the SQL-text assertions
   * are ultimately a statement about.
   */
  it('never writes last_seen_at, revoked or connected, on insert or on conflict', async () => {
    mockPool({ users: [{ id: 7, username: 'alice' }] });
    const job = new DeviceSync({ takServerService: createTakServerService([CERT]), pool });

    await job.run();

    const [sql] = upsertCalls()[0];

    expect(sql).not.toMatch(/last_seen_at/);
    expect(sql).not.toMatch(/\brevoked\b/);
    expect(sql).not.toMatch(/\bconnected\b/);

    // The insert column list, read on its own: the three foreign columns are
    // absent from it, so an inserted row takes their defaults.
    const insertColumns = sql
      .slice(sql.indexOf('(') + 1, sql.indexOf(')'))
      .split(',')
      .map((column) => column.trim());
    expect(insertColumns).toEqual([
      'client_uid',
      'user_id',
      'cert_id',
      'issued_at',
      'expires_at',
      'last_polled_at'
    ]);

    const updateClause = sql.slice(sql.indexOf('DO UPDATE SET'));
    expect(updateClause).toContain('user_id = EXCLUDED.user_id');
    expect(updateClause).toContain('cert_id = EXCLUDED.cert_id');
    expect(updateClause).toContain('issued_at = EXCLUDED.issued_at');
    expect(updateClause).toContain('expires_at = EXCLUDED.expires_at');
    expect(updateClause).toContain('last_polled_at = EXCLUDED.last_polled_at');
    expect(updateClause).not.toMatch(/last_seen_at|revoked|connected/);
  });

  /**
   * Requirement 20.10, at the row level: a stored `connected` survives a sync
   * run that refreshes the row around it. The SQL-text assertions above say the
   * column is unnamed; this says what that BUYS -- the poller's verdict is
   * still there afterwards, alongside the `last_seen_at` and `revoked` the same
   * omission protects, while the carried columns really were refreshed off
   * their stale seed (so the run is not passing by having done nothing).
   */
  it('leaves a stored connected untouched while refreshing the rest of the row', async () => {
    const table = mockDeviceTable({
      users: [{ id: 7, username: 'alice' }],
      rows: [
        {
          client_uid: 'uid-1',
          user_id: null,
          cert_id: -1,
          issued_at: null,
          expires_at: null,
          last_polled_at: null,
          last_seen_at: '2024-05-05T00:00:00.000Z',
          revoked: true,
          connected: true
        }
      ]
    });
    const job = new DeviceSync({ takServerService: createTakServerService([CERT]), pool });

    await job.run();

    const row = table.row('uid-1');
    expect(row.connected).toBe(true);
    expect(row.last_seen_at).toBe('2024-05-05T00:00:00.000Z');
    expect(row.revoked).toBe(true);
    // The refresh did happen: the stale seed values were replaced.
    expect(row.cert_id).toBe(42);
    expect(row.user_id).toBe(7);
  });

  it('is idempotent: replaying the same live-cert set issues the same upsert for the same key', async () => {
    mockPool({ users: [{ id: 7, username: 'alice' }] });
    const job = new DeviceSync({ takServerService: createTakServerService(REUSED_UID_LIVE_SET), pool });

    const first = await job.run();
    const second = await job.run();

    expect(second).toEqual(first);

    const [firstSql, firstParams] = upsertCalls()[0];
    const [replaySql, replayParams] = upsertCalls()[2];
    expect(replaySql).toBe(firstSql);
    expect(replayParams.slice(0, 5)).toEqual(firstParams.slice(0, 5));
    expect(upsertedClientUids()).toEqual(['uid-1', 'uid-2', 'uid-1', 'uid-2']);
  });
});

/**
 * Requirements 4.3, 11.2, 11.4, 11.5: the request-level guarantees, checked
 * against the real `TakServerService.listLiveCertificates()` over a recording
 * HTTP double rather than against a stub of it.
 */
describe('DeviceSync.run over the two certificate views', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('fetches both documented views and NEVER requests /Marti/api/certadmin/cert/replaced (Requirement 11.4)', async () => {
    mockPool({ users: [{ id: 7, username: 'alice' }] });
    const { service, requestedPaths } = createViewBackedTakServerService({
      active: [CERT],
      revoked: []
    });
    const job = new DeviceSync({ takServerService: service, pool });

    await job.run();

    expect(requestedPaths.sort()).toEqual([
      '/Marti/api/certadmin/cert/active',
      '/Marti/api/certadmin/cert/revoked'
    ]);
    // `/replaced` returned the same 95 ids as `/active`, so it distinguishes
    // nothing: superseding is computed locally and that view is never asked
    // for.
    expect(requestedPaths.some((path) => path.includes('replaced'))).toBe(false);
  });

  /**
   * Requirements 11.5/5.4: the live defect. `/active` listed 10 `clientUid`s
   * where only 1 was live, and the rest -- every one of whose certificates was
   * in `/revoked` -- were presented as Devices with `revoked = false`. A
   * `clientUid` with no Live_Certificate must form no group and get no row at
   * all.
   */
  it('does not upsert a client_uid whose every certificate is revoked (Requirement 11.5)', async () => {
    mockPool({ users: [{ id: 7, username: 'alice' }] });
    const deadCerts = [
      { ...CERT, id: 101, clientUid: 'uid-all-revoked', issuanceDate: '2024-04-01T00:00:00.000Z' },
      { ...CERT, id: 102, clientUid: 'uid-all-revoked', issuanceDate: '2024-05-01T00:00:00.000Z' }
    ];
    const { service } = createViewBackedTakServerService({
      active: [...deadCerts, CERT],
      // TAK Server lists every certificate of `uid-all-revoked` as revoked.
      revoked: deadCerts.map(({ id }) => ({ id }))
    });
    const job = new DeviceSync({ takServerService: service, pool });

    const counts = await job.run();

    expect(upsertedClientUids()).toEqual(['uid-1']);
    expect(upsertedClientUids()).not.toContain('uid-all-revoked');
    expect(counts).toMatchObject({ liveCertificates: 1, devices: 1, upserted: 1 });
  });
});

/**
 * Requirement 4.5: each row is associated with the local user whose TAK
 * username matches the `creatorDn` of that Device's Newest_Live_Certificate,
 * reusing the shared `matchesCreatorDn` predicate rather than a
 * reimplementation.
 */
describe('DeviceSync.run user resolution', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('reads only id and username from the local users table', async () => {
    mockPool({ users: [{ id: 7, username: 'alice' }] });
    const job = new DeviceSync({ takServerService: createTakServerService([CERT]), pool });

    await job.run();

    const userCall = pool.query.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('FROM users')
    );
    expect(userCall[0]).toBe('SELECT id, username FROM users');
  });

  it('resolves the user whose username matches the certificate CN component', async () => {
    mockPool({ users: [{ id: 3, username: 'bob' }, { id: 7, username: 'alice' }] });
    const job = new DeviceSync({ takServerService: createTakServerService([CERT]), pool });

    const counts = await job.run();

    expect(upsertCalls()[0][1][1]).toBe(7);
    expect(counts).toMatchObject({ matched: 1, unmatched: 0 });
  });

  /**
   * Requirement 4.5: from the NEWEST certificate's `creatorDn`, not an
   * arbitrary group member's -- so a re-enrollment that changed the issuing DN
   * re-attributes the Device. `uid-1`'s newest certificate was issued to
   * `alice`; its two superseded siblings were issued to `carol`.
   */
  it('resolves the user from the Newest_Live_Certificate creatorDn, not a superseded sibling', async () => {
    mockPool({ users: [{ id: 3, username: 'carol' }, { id: 7, username: 'alice' }] });
    const job = new DeviceSync({ takServerService: createTakServerService(REUSED_UID_LIVE_SET), pool });

    await job.run();

    expect(upsertedClientUids()).toEqual(['uid-1', 'uid-2']);
    expect(upsertCalls()[0][1][1]).toBe(7); // uid-1: alice, from cert 11
    expect(upsertCalls()[1][1][1]).toBe(3); // uid-2: carol, its only certificate
  });

  it('records an unmatched certificate with a NULL user rather than dropping it', async () => {
    mockPool({ users: [{ id: 3, username: 'bob' }] });
    const cert = { ...CERT, creatorDn: 'CN=carol,OU=TAK,O=NZ' };
    const job = new DeviceSync({ takServerService: createTakServerService([cert]), pool });

    const counts = await job.run();

    expect(upsertCalls()).toHaveLength(1);
    expect(upsertCalls()[0][1][1]).toBeNull();
    expect(counts).toMatchObject({ upserted: 1, matched: 0, unmatched: 1 });
  });

  it('leaves user_id NULL when the certificate carries no creatorDn', async () => {
    mockPool({ users: [{ id: 7, username: 'alice' }] });
    const cert = { ...CERT, creatorDn: undefined };
    const job = new DeviceSync({ takServerService: createTakServerService([cert]), pool });

    await job.run();

    expect(upsertCalls()[0][1][1]).toBeNull();
  });
});

/**
 * Requirement 4.9: every failure is logged via the Structured_Logger, not
 * thrown; a failed fetch leaves every existing `tak_devices` row untouched
 * and the next scheduled tick retries. The Sync_Worker process is never
 * crashed or exited. A failed fetch is never degraded to an empty live set,
 * which would present every live Device as gone.
 */
describe('DeviceSync.run failure handling', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('logs and leaves every device row unchanged when the live-cert fetch fails', async () => {
    mockPool({ users: [{ id: 7, username: 'alice' }] });
    const error = new Error('certadmin unreachable');
    const takServerService = createTakServerService();
    takServerService.listLiveCertificates.mockRejectedValue(error);
    const job = new DeviceSync({ takServerService, pool });

    await expect(job.run()).resolves.toBeUndefined();

    expect(pool.query).not.toHaveBeenCalled();
    expect(mockLoggerInstance.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: error }),
      'Device sync failed to fetch live certificates; leaving devices unchanged'
    );
  });

  /**
   * Requirements 4.9/14.2: `listLiveCertificates()` rejects when EITHER
   * documented view fails -- a failed `/revoked` fetch must never read as
   * "nothing is revoked".
   */
  it('logs and writes nothing when the revoked view fails', async () => {
    mockPool({ users: [{ id: 7, username: 'alice' }] });
    const { service } = createViewBackedTakServerService({ active: [CERT], revoked: [] });
    const error = new Error('revoked view unavailable');
    service.client.get.mockImplementation(async (path) => {
      if (path === '/Marti/api/certadmin/cert/active') return { data: { data: [CERT] } };
      throw error;
    });
    const job = new DeviceSync({ takServerService: service, pool });

    await expect(job.run()).resolves.toBeUndefined();

    expect(upsertCalls()).toHaveLength(0);
    expect(mockLoggerInstance.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: error }),
      'Device sync failed to fetch live certificates; leaving devices unchanged'
    );
  });

  it('logs and writes nothing when the local users read fails', async () => {
    const error = new Error('database unavailable');
    pool.query.mockRejectedValue(error);
    const job = new DeviceSync({ takServerService: createTakServerService([CERT]), pool });

    await expect(job.run()).resolves.toBeUndefined();

    expect(upsertCalls()).toHaveLength(0);
    expect(mockLoggerInstance.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: error }),
      expect.stringContaining('failed to load local users')
    );
  });

  it('keeps upserting the remaining devices when one row fails', async () => {
    const users = [{ id: 7, username: 'alice' }];
    let upsertAttempts = 0;
    pool.query.mockImplementation((sql) => {
      if (typeof sql === 'string' && sql.includes('FROM users')) {
        return Promise.resolve({ rows: users });
      }
      upsertAttempts += 1;
      return upsertAttempts === 2
        ? Promise.reject(new Error('unique violation'))
        : Promise.resolve({ rowCount: 1 });
    });

    const certificates = [
      { ...CERT, clientUid: 'uid-1' },
      { ...CERT, clientUid: 'uid-2' },
      { ...CERT, clientUid: 'uid-3' }
    ];
    const job = new DeviceSync({ takServerService: createTakServerService(certificates), pool });

    const counts = await job.run();

    expect(counts).toMatchObject({ liveCertificates: 3, devices: 3, upserted: 2, failed: 1 });
    expect(upsertCalls()).toHaveLength(3);
    expect(mockLoggerInstance.error).toHaveBeenCalledWith(
      expect.objectContaining({ clientUid: 'uid-2' }),
      expect.stringContaining('leaving that row unchanged')
    );
  });

  /**
   * Task 23.2 / Requirements 4.9, 14.1, 14.5: a payload that is not a list is
   * a MALFORMED response, not an empty one. Coercing it to `[]` (which this
   * job used to do) is the same silent degradation a 404-as-empty performs:
   * every live Device stops being refreshed and nothing is logged.
   */
  it.each([
    ['null', null],
    ['a string', 'not a list'],
    ['an object', { data: 'nope' }]
  ])('reports the run failed when the live-certificate payload is %s', async (_label, payload) => {
    mockPool({ users: [] });
    const job = new DeviceSync({ takServerService: createTakServerService(payload), pool });

    await expect(job.run()).resolves.toBeUndefined();

    expect(pool.query).not.toHaveBeenCalled();
    expect(mockLoggerInstance.error).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'failed' }),
      expect.stringContaining('malformed live-certificate payload')
    );
  });

  it('a failed run does not prevent the next run from syncing again', async () => {
    mockPool({ users: [{ id: 7, username: 'alice' }] });
    const takServerService = createTakServerService([CERT]);
    takServerService.listLiveCertificates.mockRejectedValueOnce(new Error('transient failure'));
    const job = new DeviceSync({ takServerService, pool });

    await job.run();
    await job.run();

    expect(takServerService.listLiveCertificates).toHaveBeenCalledTimes(2);
    expect(upsertCalls()).toHaveLength(1);
  });
});

/**
 * device-management task 23.2 (Requirements 4.9, 14.1, 14.2, 14.5): a failed
 * run is REPORTED as failed rather than passing for a quiet empty one.
 *
 * Requirement 14.1 asks for the endpoint AND the status on the error line;
 * Requirement 14.5 for a failed fetch to be distinguishable in the logs from a
 * successful fetch that legitimately returned zero rows -- the exact defect the
 * earlier graceful-404 handling produced, where a non-existent endpoint read as
 * "nothing here" and nothing was ever logged.
 *
 * Broad coverage across every failure mode is Property 12's own file
 * (task 23.3); these are the example tests for the log shape.
 */
describe('DeviceSync.run failure reporting', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  /**
   * An axios-shaped rejection: the HTTP status lives at `error.response.status`
   * and the failing URL at `error.config.url` (the convention
   * `syncWorker.classifyTakServerError()` already reads).
   */
  function httpError(status, url) {
    return Object.assign(new Error(`Request failed with status code ${status}`), {
      response: { status },
      config: { url }
    });
  }

  // Requirement 14.2: a 404 from a DOCUMENTED view is a wrong request, not an
  // empty server, and every other status is reported the same way.
  it.each([
    [404, '/Marti/api/certadmin/cert/active'],
    [403, '/Marti/api/certadmin/cert/revoked'],
    [500, '/Marti/api/certadmin/cert/active'],
    [503, '/Marti/api/certadmin/cert/revoked']
  ])('logs the endpoint and the %s status and writes nothing', async (status, url) => {
    mockPool({ users: [{ id: 7, username: 'alice' }] });
    const takServerService = createTakServerService();
    takServerService.listLiveCertificates.mockRejectedValue(httpError(status, url));
    const job = new DeviceSync({ takServerService, pool });

    await expect(job.run()).resolves.toBeUndefined();

    expect(pool.query).not.toHaveBeenCalled();
    expect(mockLoggerInstance.error).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: url, status, outcome: 'failed' }),
      'Device sync failed to fetch live certificates; leaving devices unchanged'
    );
  });

  /**
   * A transport failure or timeout produced no HTTP response at all, so there
   * is no status to report -- `status` is then a DEFINED `null` rather than an
   * absent field, so "the server answered 404" and "the server never answered"
   * are told apart in the log without reading the `err` object. The endpoint
   * falls back to the two documented views the run required.
   */
  it.each([
    ['a transport failure', new Error('ECONNREFUSED tak.example.test:8443')],
    ['a timeout', Object.assign(new Error('timeout of 5000ms exceeded'), { code: 'ECONNABORTED' })]
  ])('reports %s with a null status and the required endpoints', async (_label, error) => {
    mockPool({ users: [{ id: 7, username: 'alice' }] });
    const takServerService = createTakServerService();
    takServerService.listLiveCertificates.mockRejectedValue(error);
    const job = new DeviceSync({ takServerService, pool });

    await expect(job.run()).resolves.toBeUndefined();

    expect(pool.query).not.toHaveBeenCalled();
    expect(mockLoggerInstance.error).toHaveBeenCalledWith(
      expect.objectContaining({
        err: error,
        endpoint: '/Marti/api/certadmin/cert/active, /Marti/api/certadmin/cert/revoked',
        status: null,
        outcome: 'failed'
      }),
      'Device sync failed to fetch live certificates; leaving devices unchanged'
    );
  });

  /**
   * Requirement 14.5, the heart of it: the two outcomes an operator must never
   * confuse. A run that legitimately found nothing states itself positively --
   * info level, `outcome: 'completed'`, zero counts, and NO error line -- while
   * a failed fetch is error level with `outcome: 'failed'` and no completion
   * line at all. So neither the level, the message, nor a search for `outcome`
   * can read them alike, and "nothing live" is never mere silence.
   */
  it('logs a legitimately empty run as a completed outcome, not as a failure', async () => {
    mockPool({ users: [{ id: 7, username: 'alice' }] });
    const job = new DeviceSync({ takServerService: createTakServerService([]), pool });

    const counts = await job.run();

    expect(counts).toMatchObject({ liveCertificates: 0, devices: 0, upserted: 0 });
    expect(mockLoggerInstance.error).not.toHaveBeenCalled();
    expect(mockLoggerInstance.info).toHaveBeenCalledWith(
      expect.objectContaining({ liveCertificates: 0, devices: 0, outcome: 'completed' }),
      'Device sync run completed'
    );
  });

  it('never logs a completed outcome for a failed fetch', async () => {
    mockPool({ users: [{ id: 7, username: 'alice' }] });
    const takServerService = createTakServerService();
    takServerService.listLiveCertificates.mockRejectedValue(
      httpError(404, '/Marti/api/certadmin/cert/revoked')
    );
    const job = new DeviceSync({ takServerService, pool });

    await job.run();

    expect(mockLoggerInstance.info).not.toHaveBeenCalledWith(
      expect.anything(),
      'Device sync run completed'
    );
    expect(mockLoggerInstance.error).toHaveBeenCalledTimes(1);
  });

  /**
   * Requirements 4.9/14.2 again, at the level that matters most: a failed
   * `/revoked` fetch must never read as an empty revoked set, which would
   * promote every revoked certificate to a live Device. Driven through a real
   * `TakServerService` so the guarantee is checked against the code that
   * actually issues the two requests.
   */
  it('never treats a failed revoked-view fetch as an empty revoked set', async () => {
    mockPool({ users: [{ id: 7, username: 'alice' }] });
    const { service } = createViewBackedTakServerService({ active: [CERT], revoked: [] });
    service.client.get.mockImplementation(async (path) => {
      if (path === '/Marti/api/certadmin/cert/active') return { data: { data: [CERT] } };
      throw httpError(404, path);
    });
    const job = new DeviceSync({ takServerService: service, pool });

    await expect(job.run()).resolves.toBeUndefined();

    // The certificate that WOULD have looked live under an empty revoked set.
    expect(upsertCalls()).toHaveLength(0);
    expect(mockLoggerInstance.error).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: '/Marti/api/certadmin/cert/revoked',
        status: 404,
        outcome: 'failed'
      }),
      'Device sync failed to fetch live certificates; leaving devices unchanged'
    );
  });

  it('reports the run failed without throwing, so the Sync_Worker cannot crash', async () => {
    mockPool({ users: [] });
    const takServerService = createTakServerService();
    // A non-Error rejection: `run()` must still report, not rethrow.
    takServerService.listLiveCertificates.mockRejectedValue('certadmin exploded');
    const job = new DeviceSync({ takServerService, pool });

    await expect(job.run()).resolves.toBeUndefined();

    expect(pool.query).not.toHaveBeenCalled();
    expect(mockLoggerInstance.error).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: '/Marti/api/certadmin/cert/active, /Marti/api/certadmin/cert/revoked',
        status: null,
        outcome: 'failed'
      }),
      'Device sync failed to fetch live certificates; leaving devices unchanged'
    );
  });
});

/**
 * device-management task 25.3 (Requirement 17): the stale-row deletion step.
 *
 * The upsert alone can only add and refresh, so a `client_uid` whose every
 * certificate is revoked -- or that TAK Server no longer holds a certificate
 * for at all -- kept its row indefinitely and kept being returned by the
 * self-view and the admin view (measured live: 13 Devices against 22 rows, nine
 * stale, every one of them still `revoked = false`). A completed run now
 * deletes those rows.
 *
 * These tests run against `mockDeviceTable`, a pool double holding actual rows,
 * because the requirement's central claims are about which rows SURVIVE, not
 * about which statements were issued. The safety claim (Requirement 17.2) is
 * asserted from both ends: `deleteCalls()` is empty on every failure path, AND
 * the simulated table still holds every seeded row.
 *
 * Broad coverage across many live sets and many seeded tables is Property 14's
 * own file (task 25.4); these are example/unit tests.
 */
describe('DeviceSync.run stale-row deletion (Requirement 17)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  /** A Live_Certificate for `clientUid`, otherwise the shared fixture. */
  function certFor(clientUid, id = 1) {
    return { ...CERT, id, clientUid };
  }

  /** A pre-existing `tak_devices` row, as a previous run would have left it. */
  function seedRow(clientUid, overrides = {}) {
    return { client_uid: clientUid, user_id: 7, cert_id: 1, ...overrides };
  }

  const ALICE = [{ id: 7, username: 'alice' }];

  /**
   * Requirements 17.1/17.3: exactly the rows absent from the Live_Device_Set
   * go, and the statement that removes them is parameterised by the uids that
   * stay. The two live uids here are deliberately NOT the whole table, and the
   * two stale ones are interleaved with them, so a delete that keyed off
   * anything other than the live set shows up in `clientUids()`.
   */
  it('deletes exactly the rows absent from the Live_Device_Set, scoped by client_uid', async () => {
    const table = mockDeviceTable({
      users: ALICE,
      rows: [seedRow('uid-stale-a'), seedRow('uid-1'), seedRow('uid-stale-b'), seedRow('uid-2')]
    });
    const job = new DeviceSync({
      takServerService: createTakServerService([certFor('uid-1', 11), certFor('uid-2', 12)]),
      pool
    });

    const counts = await job.run();

    expect(table.clientUids()).toEqual(['uid-1', 'uid-2']);
    expect(counts.deleted).toBe(2);

    // Requirement 17.3: ONE statement, restricted by `client_uid`, and
    // parameterised by the live uids rather than by nothing at all. An
    // unscoped `DELETE FROM tak_devices` fails all three of these.
    expect(deleteCalls()).toHaveLength(1);
    const [deleteSql, deleteParams] = deleteCalls()[0];
    expect(deleteSql).toMatch(/WHERE\s+client_uid/);
    expect(deleteSql).toContain('<> ALL($1::text[])');
    expect(deleteParams).toEqual([['uid-1', 'uid-2']]);
  });

  /**
   * Requirement 17.4, Requirement 11.5's failure mode from the other side: a
   * `client_uid` that DOES carry a Live_Certificate is never deleted -- not
   * even when its own upsert failed on this pass. The predicate is the
   * Live_Device_Set derived from the fetch, not an accumulator of the upserts
   * that happened to succeed, so `uid-2`'s row survives a run that could not
   * refresh it.
   */
  it('deletes no row whose client_uid is live, including one whose own upsert failed', async () => {
    const table = mockDeviceTable({
      users: ALICE,
      rows: [seedRow('uid-1'), seedRow('uid-2', { cert_id: 99 }), seedRow('uid-stale')],
      failUpsertFor: ['uid-2']
    });
    const job = new DeviceSync({
      takServerService: createTakServerService([certFor('uid-1', 11), certFor('uid-2', 12)]),
      pool
    });

    const counts = await job.run();

    expect(counts).toMatchObject({ devices: 2, upserted: 1, failed: 1, deleted: 1 });
    expect(table.clientUids()).toEqual(['uid-1', 'uid-2']);
    // Left exactly as the failed upsert found it, rather than deleted.
    expect(table.row('uid-2')).toMatchObject({ cert_id: 99 });
    expect(deleteCalls()[0][1]).toEqual([['uid-1', 'uid-2']]);
  });

  /**
   * Requirement 17.2, the load-bearing safety constraint. Each failure path is
   * driven separately because they end the run at three different points, and
   * each is asserted as "no DELETE was issued at all" rather than "the run
   * reported failed": a TAK Server outage whose response read as empty would
   * otherwise wipe the whole table through a delete parameterised with `[]`,
   * and a test that only checked the return value would not see it.
   */
  describe('a failed run deletes nothing', () => {
    const SEEDED = ['uid-1', 'uid-stale-a', 'uid-stale-b'];

    /**
     * @param {{payload?: unknown, fetchError?: Error, usersError?: Error}} failure
     */
    function jobForFailure(failure) {
      const table = mockDeviceTable({
        users: ALICE,
        rows: SEEDED.map((clientUid) => seedRow(clientUid)),
        usersError: failure.usersError ?? null
      });

      const takServerService = createTakServerService([certFor('uid-1', 11)]);
      if (failure.fetchError) takServerService.listLiveCertificates.mockRejectedValue(failure.fetchError);
      if ('payload' in failure) takServerService.listLiveCertificates.mockResolvedValue(failure.payload);

      return { table, job: new DeviceSync({ takServerService, pool }) };
    }

    it.each([
      ['listLiveCertificates() rejected', { fetchError: new Error('certadmin unreachable') }],
      ['the payload was not a certificate list', { payload: { data: 'nope' } }],
      ['loadUsers() failed', { usersError: new Error('database unavailable') }]
    ])('issues no DELETE and leaves the table untouched when %s', async (_label, failure) => {
      const { table, job } = jobForFailure(failure);

      await expect(job.run()).resolves.toBeUndefined();

      expect(deleteCalls()).toEqual([]);
      expect(table.clientUids()).toEqual([...SEEDED].sort());
      expect(mockLoggerInstance.error).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'failed' }),
        expect.any(String)
      );
    });
  });

  /**
   * The subtlest case in Requirement 17, asserted as a contrasting pair against
   * the SAME seeded table. A successful run that derived zero Devices and a run
   * that failed ask for opposite table-level outcomes -- delete everything
   * versus delete nothing -- and from the DATA alone the two are
   * indistinguishable: both derive an empty live set. Only the run's outcome
   * separates them. An implementation that discriminated on "is the live set
   * empty?" instead of on the outcome fails one half or the other here.
   */
  describe('an empty live set versus a failed run, against the same table', () => {
    const SEEDED = [seedRow('uid-1'), seedRow('uid-2'), seedRow('uid-3')];

    it('deletes every row when a completed run legitimately derived zero Devices', async () => {
      const table = mockDeviceTable({ users: ALICE, rows: SEEDED });
      const job = new DeviceSync({ takServerService: createTakServerService([]), pool });

      const counts = await job.run();

      expect(counts).toMatchObject({ liveCertificates: 0, devices: 0, upserted: 0, deleted: 3 });
      expect(table.clientUids()).toEqual([]);
      // Still scoped -- with an empty live set the predicate retains nothing,
      // which is exactly what an empty array means, and the explicit
      // `::text[]` cast is what lets Postgres type it.
      expect(deleteCalls()[0][1]).toEqual([[]]);
    });

    it('deletes no row when the run against that same table failed', async () => {
      const table = mockDeviceTable({ users: ALICE, rows: SEEDED });
      const takServerService = createTakServerService([]);
      takServerService.listLiveCertificates.mockRejectedValue(new Error('certadmin unreachable'));
      const job = new DeviceSync({ takServerService, pool });

      await expect(job.run()).resolves.toBeUndefined();

      expect(deleteCalls()).toEqual([]);
      expect(table.clientUids()).toEqual(['uid-1', 'uid-2', 'uid-3']);
    });
  });

  /**
   * Requirement 17.6: a failed delete gets the same handling a single row's
   * failed upsert already gets -- logged, swallowed, the rest of the run
   * completed, retried next run. Deletion is derived state, so a missed pass
   * self-corrects; aborting the pass would cost the upserts as well.
   */
  it('logs a failed delete, completes the run anyway, and never throws', async () => {
    const deleteError = new Error('deadlock detected');
    const table = mockDeviceTable({
      users: ALICE,
      rows: [seedRow('uid-1'), seedRow('uid-stale')],
      deleteError
    });
    const job = new DeviceSync({
      takServerService: createTakServerService([certFor('uid-1', 11), certFor('uid-2', 12)]),
      pool
    });

    const counts = await job.run();

    // The upserts stand, the stale row simply survives this pass.
    expect(counts).toMatchObject({ devices: 2, upserted: 2, failed: 0, deleted: 0 });
    expect(upsertedClientUids()).toEqual(['uid-1', 'uid-2']);
    expect(table.clientUids()).toEqual(['uid-1', 'uid-2', 'uid-stale']);

    expect(mockLoggerInstance.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: deleteError, devices: 2 }),
      'Device sync failed to delete stale device rows; leaving them for the next run'
    );
    // Requirement 4.9: the run still reaches its completion line.
    expect(mockLoggerInstance.info).toHaveBeenCalledWith(
      expect.objectContaining({ deleted: 0, outcome: 'completed' }),
      'Device sync run completed'
    );
  });

  it('never throws out of run() when the delete fails', async () => {
    mockDeviceTable({
      users: ALICE,
      rows: [seedRow('uid-stale')],
      deleteError: new Error('deadlock detected')
    });
    const job = new DeviceSync({ takServerService: createTakServerService([certFor('uid-1', 11)]), pool });

    await expect(job.run()).resolves.toMatchObject({ deleted: 0 });
  });

  /**
   * Requirement 17.9: the deleted count rides on the completion line alongside
   * the existing per-run counts, so a deletion is observable in the logs rather
   * than inferred from rows going missing.
   */
  it('reports the deleted count in the completed-outcome log line', async () => {
    mockDeviceTable({
      users: ALICE,
      rows: [seedRow('uid-1'), seedRow('uid-stale-a'), seedRow('uid-stale-b')]
    });
    const job = new DeviceSync({ takServerService: createTakServerService([certFor('uid-1', 11)]), pool });

    await job.run();

    expect(mockLoggerInstance.info).toHaveBeenCalledWith(
      expect.objectContaining({ devices: 1, upserted: 1, deleted: 2, outcome: 'completed' }),
      'Device sync run completed'
    );
  });

  /**
   * Requirement 17.5: deletion is recoverable rather than destructive. Since
   * Last_Seen comes from TAK Server's own reported `lastEventTime`
   * (Requirement 13.1) rather than being accumulated by our polling, a deleted
   * row's history is re-derivable -- so a `client_uid` that comes back with a
   * fresh certificate is re-inserted by the NORMAL upsert (Requirement 4.4),
   * with `revoked` at its column default and `last_seen_at` back to NULL for
   * the next poll to populate.
   */
  it('re-inserts a re-appearing client_uid through the normal upsert, with revoked at its default', async () => {
    const table = mockDeviceTable({
      users: ALICE,
      // The state a confirmed revocation leaves behind: the flag is set true
      // and the row still carries its Last_Seen (Requirements 7.6, 17.7).
      rows: [seedRow('uid-comeback', { revoked: true, last_seen_at: '2024-05-01T00:00:00.000Z' })]
    });
    const takServerService = createTakServerService([]);
    takServerService.listLiveCertificates
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([certFor('uid-comeback', 55)]);
    const job = new DeviceSync({ takServerService, pool });

    const firstRun = await job.run();

    expect(firstRun).toMatchObject({ deleted: 1 });
    expect(table.row('uid-comeback')).toBeUndefined();

    const secondRun = await job.run();

    expect(secondRun).toMatchObject({ devices: 1, upserted: 1, deleted: 0 });
    expect(upsertedClientUids()).toEqual(['uid-comeback']);
    expect(table.row('uid-comeback')).toMatchObject({
      client_uid: 'uid-comeback',
      user_id: 7,
      cert_id: 55,
      revoked: false,
      last_seen_at: null
    });
  });
});
