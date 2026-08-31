jest.mock('../../config/database', () => ({
  query: jest.fn()
}));

const mockLoggerInstance = { info: jest.fn(), error: jest.fn(), debug: jest.fn(), warn: jest.fn() };
jest.mock('../../config/logger', () => ({
  createLogger: jest.fn(() => mockLoggerInstance)
}));

const pool = require('../../config/database');
const SubscriptionPoller = require('../SubscriptionPoller');
const { parseLastEventTime, mergeSubscriptionFreshness } = require('../SubscriptionPoller');
const TakServerService = require('../TakServerService');

/**
 * device-management tasks 7.4 / 21.3 (21.3 wins where they differ): unit tests
 * for `SubscriptionPoller` (Requirements 3.1, 3.2, 3.3, 3.4, 3.8, 13.1, 13.2,
 * 13.6, 14.4).
 *
 * Task 21.3 repoints these tests at the Client_Endpoints_API
 * (`GET /Marti/api/clientEndPoints`, via
 * `TakServerService.getClientEndpoints()`), matched to a Device by
 * `ClientEndpoint.uid == tak_devices.client_uid`, and at the behavioural change
 * that came with it: what is stored is the ENTRY'S OWN reported
 * `lastEventTime`, never the time of the observation (Requirements 3.2, 13.1).
 * The former "one observation time per run, shared by every row" assertion is
 * therefore gone by design -- each row now carries its own reported time -- and
 * the run summary carries per-run counts (`entries`, `observed`, `skipped`,
 * `updated`, `failed`, and since task 28.2 `connected`, `disconnected` and
 * `unreported`).
 *
 * Mocked collaborators only, except the request-surface block at the bottom,
 * which drives a REAL `TakServerService` over a recording HTTP double (the
 * pattern `DeviceSync.test.js` uses for its `/replaced` guarantee) so
 * Requirement 14.4's "never `/Marti/clients`" is checked against the code that
 * actually issues the request. Fake timers cover the lifecycle only: nothing in
 * the poller reads the clock any more, so system time no longer affects what it
 * stores. Broad monotonic-forward coverage across many inputs is task 16.3's
 * fast-check property test (Requirements 9.8, 13.5); these are example/unit
 * tests.
 */

/**
 * The live `ClientEndpoint` shape (`{ callsign, uid, username, team, role,
 * lastEventTime, lastStatus }`) -- note `uid`, not `clientUid`. Verified live,
 * 46 of 48 entries were `lastStatus: "Disconnected"`, so `Disconnected` is the
 * default here rather than an edge case.
 *
 * @param {Partial<{callsign: string, uid: string, username: string,
 *   team: string, role: string, lastEventTime: unknown, lastStatus: string}>} overrides
 */
function clientEndpoint(overrides = {}) {
  return {
    callsign: 'BRAVO-1',
    uid: 'ANDROID-842f08e120efdbe3',
    username: 'alice',
    team: 'Cyan',
    role: 'Team Member',
    lastEventTime: '2026-01-17T01:15:22.160Z',
    lastStatus: 'Disconnected',
    ...overrides
  };
}

/**
 * @returns {{getClientEndpoints: jest.Mock, getAllSubscriptions: jest.Mock}}
 *   `getAllSubscriptions` defaults to an empty live-subscriptions table, so
 *   the freshening step (Requirement 13 freshening follow-up) is a no-op for
 *   every existing caller unless a test explicitly overrides it -- keeping
 *   `freshened: 0` the default in every summary assertion below.
 */
function createTakServerService(clientEndpoints = [], liveSubscriptions = []) {
  return {
    getClientEndpoints: jest.fn().mockResolvedValue(clientEndpoints),
    getAllSubscriptions: jest.fn().mockResolvedValue(liveSubscriptions)
  };
}

/**
 * A real `TakServerService` whose HTTP client is replaced by a recording
 * double, so every path the poller causes to be requested is observable. No
 * network is touched and the env carries no credential paths.
 *
 * @param {Array<object>} entries the `ClientEndpoint` list the API answers with.
 * @returns {{service: TakServerService, requestedPaths: string[]}}
 */
function createEndpointBackedTakServerService(entries = [], liveSubscriptions = []) {
  const requestedPaths = [];
  const service = new TakServerService({ TAK_SERVER_URL: 'https://tak.example.test' });

  service.client = {
    get: jest.fn(async (path) => {
      requestedPaths.push(path);
      if (path === '/Marti/api/clientEndPoints') return { data: { data: entries } };
      if (path === '/Marti/api/subscriptions/all') return { data: { data: liveSubscriptions } };
      throw new Error(`Unexpected TAK Server request in SubscriptionPoller test: ${path}`);
    })
  };

  return { service, requestedPaths };
}

/**
 * Finds every per-uid `UPDATE tak_devices ... last_seen_at` call made on the
 * pool. Task 28.2's unreported-uid sweep does not mention `last_seen_at` at all
 * (it must never touch it, Requirement 3.4), so it is excluded from these by
 * construction -- see `unreportedSweepCalls()`.
 */
function lastSeenUpdateCalls() {
  return pool.query.mock.calls.filter(
    ([sql]) => typeof sql === 'string' && sql.includes('UPDATE tak_devices') && sql.includes('last_seen_at')
  );
}

/**
 * `[candidate_client_uids, last_seen_at]` pairs, in the order the poller issued
 * them. Since task 30.2 the first bind parameter is the entry's
 * Candidate_Client_Uids ARRAY rather than a single `client_uid` (Requirement
 * 22.4) -- returned exactly as bound, so the assertions below pin the array and
 * its order rather than merely its membership.
 */
function recordedLastSeen() {
  return lastSeenUpdateCalls().map(([, params]) => [params[0], params[1]]);
}

/**
 * Finds the unreported-uid status sweep (task 28.2, Requirement 20.6): the one
 * statement per successful run that sets `connected = false` for the rows this
 * poll reported no entry for, scoped to the `client_uid`s absent from the
 * reported set.
 */
function unreportedSweepCalls() {
  return pool.query.mock.calls.filter(
    ([sql]) => typeof sql === 'string' && sql.includes('UPDATE tak_devices') && sql.includes('<> ALL')
  );
}

/**
 * Requirement 3.1 ("a scheduled cadence"): design.md's stated default for
 * this poller is ~5 minutes, clamped with the same
 * `parseInt(...) || <default>` + `Math.max` pattern as
 * `ExpiryScheduler`/`RetentionCleanupJob`. No upper bound is stated, so
 * none is imposed.
 */
describe('SubscriptionPoller interval configuration', () => {
  const originalEnv = process.env.DEVICE_MGMT_POLL_INTERVAL_SECONDS;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.DEVICE_MGMT_POLL_INTERVAL_SECONDS;
    } else {
      process.env.DEVICE_MGMT_POLL_INTERVAL_SECONDS = originalEnv;
    }
  });

  it('defaults to 300000ms (5 minutes) when unset', () => {
    delete process.env.DEVICE_MGMT_POLL_INTERVAL_SECONDS;
    const poller = new SubscriptionPoller({ takServerService: createTakServerService(), pool });
    expect(poller.intervalMs).toBe(5 * 60 * 1000);
  });

  it('respects a valid configured value above the minimum', () => {
    process.env.DEVICE_MGMT_POLL_INTERVAL_SECONDS = '120';
    const poller = new SubscriptionPoller({ takServerService: createTakServerService(), pool });
    expect(poller.intervalMs).toBe(120000);
  });

  it('clamps a value below 60 seconds up to 60000ms', () => {
    process.env.DEVICE_MGMT_POLL_INTERVAL_SECONDS = '5';
    const poller = new SubscriptionPoller({ takServerService: createTakServerService(), pool });
    expect(poller.intervalMs).toBe(60000);
  });

  it('falls back to the default for a non-numeric value', () => {
    process.env.DEVICE_MGMT_POLL_INTERVAL_SECONDS = 'soon';
    const poller = new SubscriptionPoller({ takServerService: createTakServerService(), pool });
    expect(poller.intervalMs).toBe(5 * 60 * 1000);
  });
});

/**
 * `start()`/`stop()` lifecycle, mirroring `ExpiryScheduler`'s established
 * shape: one poll immediately, then a recurring `setInterval`, both
 * idempotent.
 */
describe('SubscriptionPoller start()/stop() lifecycle', () => {
  let takServerService;
  let poller;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    pool.query.mockResolvedValue({ rowCount: 0 });
    takServerService = createTakServerService([clientEndpoint()]);
    poller = new SubscriptionPoller({ takServerService, pool });
  });

  afterEach(() => {
    poller.stop();
    jest.useRealTimers();
  });

  it('polls immediately on start(), before any interval elapses', () => {
    poller.start();

    expect(takServerService.getClientEndpoints).toHaveBeenCalledTimes(1);
  });

  it('polls again after the configured interval elapses', async () => {
    poller.start();
    expect(takServerService.getClientEndpoints).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(poller.intervalMs);

    expect(takServerService.getClientEndpoints).toHaveBeenCalledTimes(2);
  });

  it('does not double-start: calling start() twice only sets up one interval/immediate poll', () => {
    poller.start();
    const timerAfterFirstStart = poller.timer;
    poller.start();

    expect(takServerService.getClientEndpoints).toHaveBeenCalledTimes(1);
    expect(poller.timer).toBe(timerAfterFirstStart);
  });

  it('stop() clears the interval so no further polls run', async () => {
    poller.start();
    expect(takServerService.getClientEndpoints).toHaveBeenCalledTimes(1);

    poller.stop();

    await jest.advanceTimersByTimeAsync(poller.intervalMs * 2);

    expect(takServerService.getClientEndpoints).toHaveBeenCalledTimes(1);
    expect(poller.timer).toBeNull();
  });

  it('stop() is a no-op when not running, and idempotent against a double stop()', () => {
    expect(() => poller.stop()).not.toThrow();

    poller.start();
    poller.stop();

    expect(() => poller.stop()).not.toThrow();
    expect(poller.timer).toBeNull();
  });
});

/**
 * Requirements 3.2/3.3/3.4/13.1: each reported Device's Last_Seen is recorded
 * as that entry's OWN `lastEventTime`, monotonic-forward, and Devices this poll
 * saw no entry for are left entirely untouched.
 */
describe('SubscriptionPoller.run last-seen recording', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // The mocked pool answers EVERY statement with the same `rowCount`, so the
    // `unreported` count in the summaries below reflects that mock rather than a
    // modelled Device_Table -- the assertion of interest for it is that the
    // sweep was issued and scoped (see `unreportedSweepCalls()`). Task 28.8's
    // property test drives the counts against an in-memory table.
    pool.query.mockResolvedValue({ rowCount: 1 });
  });

  it('records last_seen_at as each entry\'s own reported lastEventTime, not the observation time (Requirements 3.2, 13.1)', async () => {
    const takServerService = createTakServerService([
      clientEndpoint({ uid: 'uid-1', lastEventTime: '2025-03-04T05:06:07.000Z' }),
      clientEndpoint({ uid: 'uid-2', lastEventTime: '2024-11-12T13:14:15.000Z' })
    ]);
    const poller = new SubscriptionPoller({ takServerService, pool });

    const before = Date.now();
    const summary = await poller.run();

    // Each row carries the time TAK Server reported for it -- so the two
    // differ, and neither is the moment this poll ran (both are in the past).
    expect(recordedLastSeen()).toEqual([
      [['uid-1'], new Date('2025-03-04T05:06:07.000Z')],
      [['uid-2'], new Date('2024-11-12T13:14:15.000Z')]
    ]);
    for (const [, lastSeenAt] of recordedLastSeen()) {
      expect(lastSeenAt).toBeInstanceOf(Date);
      expect(lastSeenAt.getTime()).toBeLessThan(before);
    }

    expect(summary).toEqual({
      entries: 2,
      observed: 2,
      skipped: 0,
      freshened: 0,
      updated: 2,
      failed: 0,
      connected: 0,
      disconnected: 2,
      unreported: 1
    });
  });

  /**
   * Requirement 13.2: `lastStatus` is never filtered on -- the disconnected
   * entries are the ones carrying the timestamps this feature exists to show
   * (verified live: 46 of 48 entries were `Disconnected`). A poller that
   * required `Connected` would discard almost the entire result.
   */
  it('stores a lastStatus "Disconnected" entry like any other (Requirements 3.2, 13.2)', async () => {
    const takServerService = createTakServerService([
      clientEndpoint({ uid: 'uid-offline', lastEventTime: '2025-01-02T03:04:05.000Z', lastStatus: 'Disconnected' }),
      clientEndpoint({ uid: 'uid-online', lastEventTime: '2025-01-02T03:04:06.000Z', lastStatus: 'Connected' })
    ]);
    const poller = new SubscriptionPoller({ takServerService, pool });

    const summary = await poller.run();

    expect(recordedLastSeen()).toEqual([
      [['uid-offline'], new Date('2025-01-02T03:04:05.000Z')],
      [['uid-online'], new Date('2025-01-02T03:04:06.000Z')]
    ]);
    // Both timestamps were stored; the `Connected` entry additionally counts as
    // connected (task 28.2, Requirement 20.5). The two concerns are independent.
    expect(summary).toEqual({
      entries: 2,
      observed: 2,
      skipped: 0,
      freshened: 0,
      updated: 2,
      failed: 0,
      connected: 1,
      disconnected: 1,
      unreported: 1
    });
  });

  /**
   * Requirement 3.3 / 13.4: the monotonic clamp is what keeps the write
   * forward-only -- a reported time older than the stored value leaves it
   * exactly as it was, so Last_Seen can never move backward and an existing
   * value can never be nulled. Asserted on the SQL itself (the same approach
   * `RetentionCleanupJob.test.js` uses for its age-independent WHERE-clause
   * guarantee), because the guarantee lives in the statement's own logic rather
   * than in anything a mocked `pool.query` return value could show.
   *
   * Task 28.2 moved the clamp from the `WHERE` clause into the `SET` list, so
   * this asserts the same guarantee at its new site: the comparison is
   * unchanged, it now governs `last_seen_at` alone, and the `WHERE` clause
   * narrows to the Device only. That relocation is load-bearing and is asserted
   * as such below (Requirement 20.3).
   */
  it('clamps the update so last_seen_at only ever moves forward (Requirements 3.3, 13.4)', async () => {
    const takServerService = createTakServerService([clientEndpoint({ uid: 'uid-1' })]);
    const poller = new SubscriptionPoller({ takServerService, pool });

    await poller.run();

    const [[sql]] = lastSeenUpdateCalls();

    expect(sql).toMatch(/last_seen_at = CASE/);
    expect(sql).toMatch(/last_seen_at IS NULL OR last_seen_at < \$2/);
    expect(sql).toMatch(/ELSE last_seen_at/);
    // Task 30.2 widened the target from one `client_uid` to the entry's
    // Candidate_Client_Uids -- equality against a complete-string array
    // (Requirement 22.4). The clamp's home in the `SET` list is unaffected.
    expect(sql).toMatch(/WHERE\s+client_uid = ANY\(\$1::text\[\]\)/);
    // Exact equality only: no `LIKE`, no wildcard, nothing that could reach a
    // row the candidates do not name (Requirement 22.7).
    expect(sql).not.toMatch(/LIKE/i);
    expect(sql).not.toContain('%');

    // Never writes NULL over an existing value, and never rewinds by
    // dropping the clamp in favour of an unconditional write.
    expect(sql).not.toMatch(/last_seen_at\s*=\s*NULL/i);
    expect(sql).not.toMatch(/\bOR\b\s+client_uid/i);

    // And the clamp is NOT in the `WHERE` clause, which is the whole point of
    // its relocation: that predicate is a deliberate no-match for a
    // non-advancing reported time, so the `connected` write beside it would
    // never fire for the Devices most likely to be connected right now
    // (Requirement 20.3).
    expect(sql).not.toMatch(/WHERE[\s\S]*last_seen_at/);
  });

  it('reports zero rows updated when no Device_Table row matches the reported uid', async () => {
    // `rowCount: 0` now means exactly one thing: the Device_Table has no row for
    // this client_uid, so nothing was written (inserting rows is the
    // Device_Sync's job). Since task 28.2 a STALE reported time no longer
    // produces this -- the statement matches the row and writes `connected`,
    // while the CASE leaves `last_seen_at` where it is (Requirement 20.3).
    pool.query.mockResolvedValue({ rowCount: 0 });
    const takServerService = createTakServerService([clientEndpoint({ uid: 'uid-1' })]);
    const poller = new SubscriptionPoller({ takServerService, pool });

    const summary = await poller.run();

    expect(summary).toEqual({
      entries: 1,
      observed: 1,
      skipped: 0,
      freshened: 0,
      updated: 0,
      failed: 0,
      connected: 0,
      disconnected: 1,
      unreported: 0
    });
  });

  it('only targets reported client_uids, leaving unreported devices untouched (Requirement 3.4)', async () => {
    const takServerService = createTakServerService([clientEndpoint({ uid: 'uid-reported' })]);
    const poller = new SubscriptionPoller({ takServerService, pool });

    await poller.run();

    const targetedUids = lastSeenUpdateCalls().map(([, params]) => params[0]);
    // A native uid's candidates are the uid alone, so the widened statement
    // targets exactly the row it targeted before task 30.2 (Requirement 22.2).
    expect(targetedUids).toEqual([['uid-reported']]);

    // Exactly two statements: the per-uid write, and task 28.2's status sweep --
    // which is itself scoped to the uids ABSENT from the reported set
    // (Requirement 20.6) and never mentions `last_seen_at`, so an unreported
    // Device's Last_Seen is still left exactly as it was (Requirement 3.4).
    expect(pool.query).toHaveBeenCalledTimes(2);
    const [[sweepSql, sweepParams]] = unreportedSweepCalls();
    expect(sweepSql).toMatch(/WHERE\s+client_uid <> ALL\(\$1::text\[\]\)/);
    expect(sweepSql).not.toContain('last_seen_at');
    expect(sweepParams).toEqual([['uid-reported']]);
  });

  it('issues no per-uid write when TAK Server reports no entries', async () => {
    const poller = new SubscriptionPoller({ takServerService: createTakServerService([]), pool });

    const summary = await poller.run();

    // Nothing to record: no per-uid statement at all. The one statement issued
    // is task 28.2's status sweep -- a successful poll that reported nothing is
    // positive evidence that nothing is connected (Requirement 20.6), and it is
    // still parameterised by the (empty) reported set rather than unscoped.
    expect(recordedLastSeen()).toEqual([]);
    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(unreportedSweepCalls()).toEqual([
      [expect.stringMatching(/client_uid <> ALL\(\$1::text\[\]\)/), [[]]]
    ]);
    expect(summary).toEqual({
      entries: 0,
      observed: 0,
      skipped: 0,
      freshened: 0,
      updated: 0,
      failed: 0,
      connected: 0,
      disconnected: 0,
      unreported: 1
    });
  });

  /**
   * TAK Server may report one client more than once (e.g. per group). The
   * duplicates collapse to the GREATEST reported `lastEventTime`, so one poll
   * issues at most one update per Device and the winner does not depend on the
   * order the entries happened to arrive in -- here the newest is deliberately
   * NOT last.
   */
  it('collapses duplicate entries for one device into a single update carrying the greatest lastEventTime', async () => {
    const takServerService = createTakServerService([
      clientEndpoint({ uid: 'uid-1', lastEventTime: '2025-05-01T00:00:00.000Z' }),
      clientEndpoint({ uid: 'uid-1', lastEventTime: '2025-07-01T00:00:00.000Z' }),
      clientEndpoint({ uid: 'uid-1', lastEventTime: '2025-06-01T00:00:00.000Z' }),
      clientEndpoint({ uid: 'uid-2', lastEventTime: '2025-02-01T00:00:00.000Z' })
    ]);
    const poller = new SubscriptionPoller({ takServerService, pool });

    const summary = await poller.run();

    expect(recordedLastSeen()).toEqual([
      [['uid-1'], new Date('2025-07-01T00:00:00.000Z')],
      [['uid-2'], new Date('2025-02-01T00:00:00.000Z')]
    ]);
    expect(summary).toEqual({
      entries: 4,
      observed: 2,
      skipped: 0,
      freshened: 0,
      updated: 2,
      failed: 0,
      connected: 0,
      disconnected: 2,
      unreported: 1
    });
  });

  it('skips entries with no usable uid rather than querying with a null parameter', async () => {
    const takServerService = createTakServerService([
      clientEndpoint({ uid: 'uid-1' }),
      clientEndpoint({ uid: '' }),
      clientEndpoint({ uid: null }),
      { lastEventTime: '2025-01-01T00:00:00.000Z' },
      null,
      'not-an-object'
    ]);
    const poller = new SubscriptionPoller({ takServerService, pool });

    const summary = await poller.run();

    expect(lastSeenUpdateCalls().map(([, params]) => params[0])).toEqual([['uid-1']]);
    expect(summary).toEqual({
      entries: 6,
      observed: 1,
      skipped: 5,
      freshened: 0,
      updated: 1,
      failed: 0,
      connected: 0,
      disconnected: 1,
      unreported: 1
    });
  });

  /**
   * Requirement 13.6: an absent or unparseable `lastEventTime` leaves that
   * Device's stored Last_Seen unchanged -- it is never written as NULL, never
   * handed to Postgres as a string it would reject, and never substituted with
   * the observation time. An unusable timestamp must cost a Device nothing, not
   * erase what is already known about it.
   */
  it('skips an entry whose lastEventTime is absent, leaving its stored value untouched (Requirement 13.6)', async () => {
    const takServerService = createTakServerService([
      clientEndpoint({ uid: 'uid-no-time', lastEventTime: undefined }),
      clientEndpoint({ uid: 'uid-null-time', lastEventTime: null }),
      clientEndpoint({ uid: 'uid-usable', lastEventTime: '2025-08-09T10:11:12.000Z' })
    ]);
    const poller = new SubscriptionPoller({ takServerService, pool });

    const summary = await poller.run();

    // Nothing is written to the two timeless uids' `last_seen_at`, least of all
    // a NULL. Since task 28.2 a statement IS issued for them -- their status
    // must still land (Requirement 20.4) -- but it binds `null` for the
    // timestamp, which the statement's CASE leaves `last_seen_at` alone for, so
    // no reported time and no NULL ever reaches the column (Requirement 13.6).
    expect(recordedLastSeen()).toEqual([
      [['uid-no-time'], null],
      [['uid-null-time'], null],
      [['uid-usable'], new Date('2025-08-09T10:11:12.000Z')]
    ]);
    expect(summary).toEqual({
      entries: 3,
      observed: 1,
      skipped: 2,
      freshened: 0,
      updated: 3,
      failed: 0,
      connected: 0,
      disconnected: 3,
      unreported: 1
    });
    expect(mockLoggerInstance.warn).toHaveBeenCalledWith(
      expect.objectContaining({ clientUid: 'uid-no-time' }),
      expect.stringContaining('lastEventTime')
    );
  });

  it('skips an entry whose lastEventTime is unparseable, leaving its stored value untouched (Requirement 13.6)', async () => {
    const takServerService = createTakServerService([
      clientEndpoint({ uid: 'uid-garbage-time', lastEventTime: 'whenever' }),
      clientEndpoint({ uid: 'uid-blank-time', lastEventTime: '   ' }),
      clientEndpoint({ uid: 'uid-usable', lastEventTime: '2025-08-09T10:11:12.000Z' })
    ]);
    const poller = new SubscriptionPoller({ takServerService, pool });

    const summary = await poller.run();

    // As above: a statement per uid, but `null` bound for the two unparseable
    // times, so their stored `last_seen_at` is untouched (Requirements 13.6, 20.4).
    expect(recordedLastSeen()).toEqual([
      [['uid-garbage-time'], null],
      [['uid-blank-time'], null],
      [['uid-usable'], new Date('2025-08-09T10:11:12.000Z')]
    ]);
    expect(summary).toEqual({
      entries: 3,
      observed: 1,
      skipped: 2,
      freshened: 0,
      updated: 3,
      failed: 0,
      connected: 0,
      disconnected: 3,
      unreported: 1
    });
    expect(mockLoggerInstance.warn).toHaveBeenCalledWith(
      expect.objectContaining({ clientUid: 'uid-garbage-time' }),
      expect.stringContaining('lastEventTime')
    );
  });

  /**
   * Task 23.2 / Requirements 3.8, 14.1, 14.5: a payload that is not a list is a
   * MALFORMED response, not an empty history. Coercing it to `[]` (which this
   * job used to do) is the same silent degradation the old 404-as-empty
   * handling performed: every `last_seen_at` stays as it was, nothing is
   * logged, and the run is indistinguishable from a poll that legitimately
   * reported nothing.
   *
   * The legitimately-empty case is a different input, at a different layer: a
   * 200 whose `ApiResponse` omits `data` still yields `[]` from
   * `TakServerService.unwrapArray()` (Requirement 14.3), which reaches this job
   * as an array and completes with zero counts -- asserted in the request
   * surface block below, against the real service that does the unwrapping.
   * Mirrors `DeviceSync.test.js`'s equivalent malformed-payload block.
   */
  it.each([
    ['null', null],
    ['a string', 'not a list'],
    ['an object', { unexpected: 'shape' }]
  ])('reports the run failed when the client endpoints payload is %s', async (_label, payload) => {
    const takServerService = createTakServerService(payload);
    const poller = new SubscriptionPoller({ takServerService, pool });

    await expect(poller.run()).resolves.toBeUndefined();

    expect(pool.query).not.toHaveBeenCalled();
    expect(mockLoggerInstance.error).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: '/Marti/api/clientEndPoints', outcome: 'failed' }),
      expect.stringContaining('malformed client endpoints payload')
    );
    // A failed run never also reads as a completed one (Requirement 14.5).
    expect(mockLoggerInstance.info).not.toHaveBeenCalledWith(
      expect.anything(),
      'Subscription poll completed'
    );
  });
});

/**
 * Requirement 13.6 at the parsing boundary: `parseLastEventTime` is what turns
 * a reported value into either a comparable time or a skip. Mirrors
 * `DeviceSync`'s `parseIssuanceTime` deliberately.
 */
describe('parseLastEventTime', () => {
  it('parses the documented ISO-8601 shape, Date instances and epoch milliseconds', () => {
    expect(parseLastEventTime('2026-01-17T01:15:22.160Z')).toBe(Date.parse('2026-01-17T01:15:22.160Z'));
    expect(parseLastEventTime(new Date('2026-01-17T01:15:22.160Z'))).toBe(Date.parse('2026-01-17T01:15:22.160Z'));
    expect(parseLastEventTime(1737075322160)).toBe(1737075322160);
  });

  it('returns null for anything unusable, so the caller skips rather than writes', () => {
    expect(parseLastEventTime(undefined)).toBeNull();
    expect(parseLastEventTime(null)).toBeNull();
    expect(parseLastEventTime('')).toBeNull();
    expect(parseLastEventTime('   ')).toBeNull();
    expect(parseLastEventTime('whenever')).toBeNull();
    expect(parseLastEventTime(NaN)).toBeNull();
    expect(parseLastEventTime(new Date('nope'))).toBeNull();
    expect(parseLastEventTime({})).toBeNull();
  });
});

/**
 * Requirements 3.8/14.1/14.5: `run()` NEVER throws. A failed
 * Client_Endpoints_API call leaves every `last_seen_at` untouched, reports the
 * run as failed (`undefined`, never an empty result set) with its own
 * error-level log line naming the endpoint, and is retried next tick; a failure
 * on one row still lets the remaining entries be recorded. Nothing here can
 * crash or exit the Sync_Worker process.
 */
describe('SubscriptionPoller.run failure handling', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    pool.query.mockResolvedValue({ rowCount: 1 });
  });

  it('logs and leaves every last_seen_at unchanged when the client endpoints API fails', async () => {
    const error = new Error('tak server unreachable');
    const takServerService = createTakServerService();
    takServerService.getClientEndpoints.mockRejectedValue(error);
    const poller = new SubscriptionPoller({ takServerService, pool });

    // Reported as failed, NOT degraded to "nothing was reported".
    await expect(poller.run()).resolves.toBeUndefined();

    expect(pool.query).not.toHaveBeenCalled();
    expect(mockLoggerInstance.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: error, endpoint: '/Marti/api/clientEndPoints' }),
      expect.stringContaining('client endpoints API')
    );
  });

  it('records the remaining entries when one row update fails', async () => {
    const takServerService = createTakServerService([
      clientEndpoint({ uid: 'uid-1' }),
      clientEndpoint({ uid: 'uid-2' }),
      clientEndpoint({ uid: 'uid-3' })
    ]);
    const poller = new SubscriptionPoller({ takServerService, pool });

    pool.query
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockRejectedValueOnce(new Error('deadlock detected'))
      .mockResolvedValueOnce({ rowCount: 1 });

    const summary = await poller.run();

    expect(summary).toEqual({
      entries: 3,
      observed: 3,
      skipped: 0,
      freshened: 0,
      updated: 2,
      failed: 1,
      connected: 0,
      disconnected: 3,
      unreported: 1
    });
    expect(lastSeenUpdateCalls()).toHaveLength(3);
    expect(mockLoggerInstance.error).toHaveBeenCalledWith(
      expect.objectContaining({ clientUid: 'uid-2' }),
      expect.stringContaining('Failed to record last-seen')
    );
  });

  it('a failed poll does not prevent the next poll from running', async () => {
    const takServerService = createTakServerService([clientEndpoint({ uid: 'uid-1' })]);
    takServerService.getClientEndpoints.mockRejectedValueOnce(new Error('transient failure'));
    const poller = new SubscriptionPoller({ takServerService, pool });

    await poller.run();
    await poller.run();

    expect(takServerService.getClientEndpoints).toHaveBeenCalledTimes(2);
    expect(lastSeenUpdateCalls()).toHaveLength(1);
  });
});

/**
 * Requirement 14.4: `/Marti/clients` is absent from
 * `tak-server-openapispec.json` and answers 404 on the live server, so no code
 * path may request it. This is the POLLER-level version of that guarantee --
 * the poller was the only caller of the deleted `getConnectedSubscriptions()`,
 * so it is where a regression would reappear. The repo-wide structural version
 * (no server source file requests `/Marti/clients` at all) is task 23.4's
 * `martiEndpointContract.test.js`.
 *
 * Requirement 13.7 rides along here: the poll sends no query parameters, so it
 * can never narrow the result to currently-connected clients.
 */
describe('SubscriptionPoller request surface (Requirements 13.7, 14.4)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    pool.query.mockResolvedValue({ rowCount: 1 });
  });

  it('requests /Marti/api/clientEndPoints with no query parameters, and the live-subscriptions freshening endpoint, and nothing else', async () => {
    const { service, requestedPaths } = createEndpointBackedTakServerService([
      clientEndpoint({ uid: 'uid-1' })
    ]);
    const poller = new SubscriptionPoller({ takServerService: service, pool });

    const summary = await poller.run();

    // Requirement 13 freshening follow-up: `/Marti/api/subscriptions/all` is
    // now a SECOND, deliberate request -- see the file header for why. What
    // Requirement 14.4 still forbids is `/Marti/clients`, asserted below.
    expect(requestedPaths).toEqual(['/Marti/api/clientEndPoints', '/Marti/api/subscriptions/all']);
    expect(requestedPaths.some((path) => path.includes('/Marti/clients'))).toBe(false);

    // One argument only: no `params`, so never `showCurrentlyConnectedClients`.
    expect(service.client.get).toHaveBeenCalledWith('/Marti/api/clientEndPoints');
    expect(summary).toEqual({
      entries: 1,
      observed: 1,
      skipped: 0,
      freshened: 0,
      updated: 1,
      failed: 0,
      connected: 0,
      disconnected: 1,
      unreported: 1
    });
  });

  /**
   * Requirement 14.3, asserted where it is actually true: the one tolerated
   * absence lives in `TakServerService.unwrapArray()`, on a SUCCESSFUL
   * response. `ApiResponse` is `@JsonInclude(NON_NULL)`, so TAK Server omits
   * `data` entirely when no client has ever been seen -- the server answered,
   * so that is a real observation of an empty history, and it unwraps to `[]`.
   * The poller therefore receives an ARRAY and completes with zero counts;
   * it never reaches the malformed-payload guard above, which only a shape the
   * job cannot read as an entry list lands in (Requirement 14.5).
   */
  it('treats a 200 whose ApiResponse omits data as a legitimately empty history, via the service layer', async () => {
    const { service, requestedPaths } = createEndpointBackedTakServerService();
    service.client.get.mockImplementation(async (path) => {
      requestedPaths.push(path);
      // The live shape of an empty view: an envelope with no `data` key at all.
      return { data: { version: '3', type: 'ClientEndpoint' } };
    });
    const poller = new SubscriptionPoller({ takServerService: service, pool });

    const summary = await poller.run();

    // The freshening fetch still runs, and its own mocked implementation
    // above answers it with the same shape, so it is requested exactly once
    // too.
    expect(requestedPaths).toEqual(['/Marti/api/clientEndPoints', '/Marti/api/subscriptions/all']);
    expect(summary).toEqual({
      entries: 0,
      observed: 0,
      skipped: 0,
      freshened: 0,
      updated: 0,
      failed: 0,
      connected: 0,
      disconnected: 0,
      unreported: 1
    });
    // Nothing was reported, so no per-uid write; the only statement is task
    // 28.2's scoped status sweep (Requirement 20.6).
    expect(recordedLastSeen()).toEqual([]);
    expect(unreportedSweepCalls()).toHaveLength(1);
    expect(mockLoggerInstance.error).not.toHaveBeenCalled();
    expect(mockLoggerInstance.info).toHaveBeenCalledWith(
      expect.objectContaining({ entries: 0, outcome: 'completed' }),
      'Subscription poll completed'
    );
  });

  it('calls no TakServerService method other than getClientEndpoints and getAllSubscriptions', async () => {
    const accessed = [];
    const target = {
      getClientEndpoints: jest.fn().mockResolvedValue([clientEndpoint({ uid: 'uid-1' })]),
      getAllSubscriptions: jest.fn().mockResolvedValue([])
    };
    const recordingService = new Proxy(target, {
      get(object, property) {
        if (typeof property === 'string') accessed.push(property);
        return object[property];
      }
    });
    const poller = new SubscriptionPoller({ takServerService: recordingService, pool });

    await poller.run();

    expect(accessed).toEqual(['getClientEndpoints', 'getAllSubscriptions']);
    expect(accessed).not.toContain('getConnectedSubscriptions');
  });

  it('has no getConnectedSubscriptions to fall back to: the /Marti/clients method is deleted, not repointed', () => {
    const service = new TakServerService({ TAK_SERVER_URL: 'https://tak.example.test' });

    expect(TakServerService.prototype.getConnectedSubscriptions).toBeUndefined();
    expect('getConnectedSubscriptions' in service).toBe(false);
    expect(typeof service.getClientEndpoints).toBe('function');
  });
});

/**
 * device-management task 28.6 (Requirements 20.3, 20.4, 20.5, 20.6, 20.7, and
 * 13.6 where an unusable timestamp meets a status write): the Connection_Status
 * half of a poll.
 *
 * These run against an in-memory Device_Table stand-in rather than a
 * `mockResolvedValue`, because the guarantees here are about STORED STATE -- "the
 * status was written and `last_seen_at` did NOT move", "the unreported rows went
 * to false and the reported one did not", "a failed poll left every stored
 * `connected` exactly as it was". A pool that answers every statement with the
 * same `rowCount` cannot show any of those; it can only show which statements
 * were issued, which is what the blocks above assert. The two views are
 * complementary and both are used below: the table for the resulting state, the
 * existing `lastSeenUpdateCalls()`/`unreportedSweepCalls()` helpers for the
 * exact statements and parameters.
 *
 * The equal-timestamp case is the regression this whole section exists to
 * prevent (Requirement 20.3): a Device connected RIGHT NOW is precisely the one
 * whose reported `lastEventTime` may be identical to the stored value, so a
 * status write riding on the Monotonic_Guard's `WHERE` predicate would never
 * fire for it. Broad coverage of the collapse rule and the guard independence
 * across the input space is task 28.8's Property 17; these are example tests.
 */

/**
 * An in-memory Device_Table stand-in: `client_uid -> { lastSeenAt, connected }`.
 * A missing key means "no such Device row" -- inserting rows is the
 * Device_Sync's job, never the poller's.
 *
 * @param {Array<{clientUid: string, lastSeenAt?: Date|null, connected?: boolean}>} rows
 * @returns {Map<string, {lastSeenAt: Date|null, connected: boolean}>}
 */
function createDeviceTable(rows) {
  return new Map(
    rows.map(({ clientUid, lastSeenAt = null, connected = false }) => [
      clientUid,
      { lastSeenAt, connected }
    ])
  );
}

/**
 * Points the mocked pool at `table`, applying the two statements a successful
 * poll issues:
 *
 *   - the per-uid write, which sets `connected` unconditionally for a matched
 *     row and moves `last_seen_at` only when the bound time is non-null AND
 *     strictly greater than the stored one (the clamp, as it lives in the `SET`
 *     list). A non-advancing time therefore leaves the stored `Date` INSTANCE
 *     in place, which is what lets the assertions below say "did not move" with
 *     `toBe`.
 *   - the unreported-uid sweep, which sets `connected = false` for the rows
 *     whose `client_uid` is absent from the bound array and touches nothing
 *     else.
 *
 * Anything else throws rather than being silently modelled.
 *
 * @param {Map<string, {lastSeenAt: Date|null, connected: boolean}>} table
 */
function backPoolWith(table) {
  pool.query.mockImplementation(async (sql, params) => {
    if (typeof sql !== 'string' || !sql.includes('UPDATE tak_devices')) {
      throw new Error(`Unexpected statement issued by SubscriptionPoller: ${sql}`);
    }

    if (sql.includes('<> ALL')) {
      const reported = new Set(params[0]);
      let rowCount = 0;
      for (const [clientUid, row] of table) {
        if (reported.has(clientUid)) continue;
        row.connected = false;
        rowCount += 1;
      }
      return { rowCount };
    }

    const [clientUids, lastEventTime, connected] = params;
    if (!Array.isArray(clientUids)) {
      throw new Error(`Expected the per-entry write to bind an array of candidate client_uids: ${clientUids}`);
    }

    // `WHERE client_uid = ANY($1::text[])` matches EVERY row named by the
    // candidate array (task 30.2, Requirement 22.4), so both a `<base> (Web)`
    // and a `<base> (ETL)` row can receive the one entry's write and `rowCount`
    // may exceed 1 (Requirement 22.8). A candidate naming no row contributes
    // nothing.
    let rowCount = 0;
    for (const clientUid of clientUids) {
      const row = table.get(clientUid);
      if (!row) continue;
      rowCount += 1;

      row.connected = connected;
      if (
        lastEventTime !== null &&
        (row.lastSeenAt === null || row.lastSeenAt.getTime() < lastEventTime.getTime())
      ) {
        row.lastSeenAt = lastEventTime;
      }
    }

    return { rowCount };
  });
}

/**
 * A `ClientEndpoint` carrying exactly the given `lastStatus` -- with the key
 * OMITTED, not set to `undefined`, when the absent case is asked for, since
 * "absent" is one of the values Requirement 20.5 enumerates.
 *
 * @param {string} uid
 * @param {unknown} lastStatus
 */
function endpointWithStatus(uid, lastStatus) {
  const endpoint = clientEndpoint({ uid });

  if (lastStatus === undefined) delete endpoint.lastStatus;
  else endpoint.lastStatus = lastStatus;

  return endpoint;
}

describe('SubscriptionPoller.run connection status (task 28.6)', () => {
  /** The stored value the non-advancing cases below report against. */
  const STORED = new Date('2025-06-01T00:00:00.000Z');

  beforeEach(() => {
    jest.clearAllMocks();
  });

  /**
   * Requirement 20.3, the load-bearing one. A reported `lastEventTime` that
   * does not advance past the stored value -- equal, which is the live shape for
   * a Device that has simply stayed connected, or earlier -- still has its
   * status written, and still leaves `last_seen_at` exactly where it was.
   *
   * Both halves matter in opposite directions: the status MUST land (the defect
   * this section exists to prevent) and the timestamp MUST NOT move (Property 3,
   * unchanged).
   */
  it.each([
    ['equals the stored value', STORED.toISOString()],
    ['is earlier than the stored value', new Date(STORED.getTime() - 3600000).toISOString()]
  ])(
    'writes connected while leaving last_seen_at untouched when the reported lastEventTime %s (Requirement 20.3)',
    async (_label, lastEventTime) => {
      const table = createDeviceTable([{ clientUid: 'uid-1', lastSeenAt: STORED, connected: false }]);
      backPoolWith(table);

      const takServerService = createTakServerService([
        clientEndpoint({ uid: 'uid-1', lastEventTime, lastStatus: 'Connected' })
      ]);
      const poller = new SubscriptionPoller({ takServerService, pool });

      const summary = await poller.run();

      // The status landed...
      expect(table.get('uid-1').connected).toBe(true);
      // ...and the stored timestamp is the very same instance it was: not
      // rewound, not re-written, not nulled.
      expect(table.get('uid-1').lastSeenAt).toBe(STORED);

      // The statement was issued for this uid with the reported time bound as
      // `$2` and the collapsed status as `$3`, so the clamp -- which now lives
      // in the `SET` list -- is what declined to move the column, NOT a `WHERE`
      // clause that declined to match the row.
      expect(lastSeenUpdateCalls()).toHaveLength(1);
      expect(lastSeenUpdateCalls()[0][1]).toEqual([['uid-1'], new Date(lastEventTime), true]);

      expect(summary).toEqual({
        entries: 1,
        observed: 1,
        skipped: 0,
        freshened: 0,
        // `rowCount` means "a row exists for this uid" now, not "Last_Seen
        // moved": the row matched, so the status write counted.
        updated: 1,
        failed: 0,
        connected: 1,
        disconnected: 0,
        unreported: 0
      });
    }
  );

  /**
   * Requirements 20.4 / 13.6: an unusable `lastEventTime` costs a Device its
   * Last_Seen update and NOT its status. The entry is still counted as skipped
   * and still warns (asserted in the last-seen block above); what is asserted
   * here is the resulting state -- `connected` written, `last_seen_at` untouched.
   */
  it.each([
    ['absent', undefined],
    ['null', null],
    ['unparseable', 'whenever'],
    ['blank', '   ']
  ])(
    'writes connected but leaves last_seen_at untouched when lastEventTime is %s (Requirements 20.4, 13.6)',
    async (_label, lastEventTime) => {
      const table = createDeviceTable([{ clientUid: 'uid-1', lastSeenAt: STORED, connected: false }]);
      backPoolWith(table);

      const takServerService = createTakServerService([
        clientEndpoint({ uid: 'uid-1', lastEventTime, lastStatus: 'Connected' })
      ]);
      const poller = new SubscriptionPoller({ takServerService, pool });

      const summary = await poller.run();

      expect(table.get('uid-1').connected).toBe(true);
      expect(table.get('uid-1').lastSeenAt).toBe(STORED);

      // `null` is bound for the timestamp -- never an invalid Date, never the
      // unparseable string itself, never the observation time.
      expect(lastSeenUpdateCalls()[0][1]).toEqual([['uid-1'], null, true]);

      expect(summary).toEqual({
        entries: 1,
        // Not `observed`: this poll could not move that Device's Last_Seen.
        observed: 0,
        skipped: 1,
        freshened: 0,
        updated: 1,
        failed: 0,
        connected: 1,
        disconnected: 0,
        unreported: 0
      });
    }
  );

  /**
   * Requirement 20.5, the Status_Collapse_Rule: ANY entry reporting `Connected`
   * makes the Device connected. Four entries for one uid is the live shape --
   * one Windows SID returned four entries under different callsigns -- and the
   * single `Connected` one is placed at each position in turn, so the verdict
   * cannot depend on the order TAK Server happened to return them in.
   */
  it.each([0, 1, 2, 3])(
    'collapses four entries for one uid to connected when the only Connected entry is at index %i (Requirement 20.5)',
    async (connectedIndex) => {
      const table = createDeviceTable([{ clientUid: 'uid-1', lastSeenAt: null, connected: false }]);
      backPoolWith(table);

      const entries = [0, 1, 2, 3].map((index) =>
        clientEndpoint({
          uid: 'uid-1',
          callsign: `BRAVO-${index}`,
          lastEventTime: new Date(STORED.getTime() + index * 1000).toISOString(),
          lastStatus: index === connectedIndex ? 'Connected' : 'Disconnected'
        })
      );
      const poller = new SubscriptionPoller({ takServerService: createTakServerService(entries), pool });

      const summary = await poller.run();

      expect(table.get('uid-1').connected).toBe(true);

      // One write for the uid, carrying the collapsed verdict and the GREATEST
      // reported time -- the two collapse rules are independent, and the newest
      // entry is deliberately not the Connected one in three of these cases.
      expect(lastSeenUpdateCalls()).toHaveLength(1);
      expect(lastSeenUpdateCalls()[0][1]).toEqual([
        ['uid-1'],
        new Date(STORED.getTime() + 3000),
        true
      ]);

      expect(summary).toMatchObject({ entries: 4, observed: 1, connected: 1, disconnected: 0 });
    }
  );

  /**
   * Requirement 20.5's per-entry half: `Connected` in ANY casing counts, and an
   * absent, null or any other `lastStatus` -- `Disconnected` included -- counts
   * as not connected. `connected` is a positive claim, so a value this code does
   * not understand must never produce one.
   */
  it.each([
    ['Connected', true],
    ['connected', true],
    ['CONNECTED', true],
    ['connECTed', true],
    ['Disconnected', false],
    ['disconnected', false],
    [undefined, false],
    [null, false],
    ['', false],
    ['Unknown', false],
    [42, false]
  ])('treats a lastStatus of %p as connected=%p (Requirement 20.5)', async (lastStatus, expected) => {
    const table = createDeviceTable([{ clientUid: 'uid-1', lastSeenAt: null, connected: !expected }]);
    backPoolWith(table);

    const poller = new SubscriptionPoller({
      takServerService: createTakServerService([endpointWithStatus('uid-1', lastStatus)]),
      pool
    });

    const summary = await poller.run();

    expect(table.get('uid-1').connected).toBe(expected);
    // Bound as a real boolean, whatever shape `lastStatus` arrived in.
    expect(lastSeenUpdateCalls()[0][1][2]).toBe(expected);
    expect(summary).toMatchObject({
      connected: expected ? 1 : 0,
      disconnected: expected ? 0 : 1
    });
  });

  /**
   * Requirement 20.6: a successful poll is positive evidence about the rows it
   * did NOT report, so those go to not connected -- through a statement
   * parameterised by the reported `client_uid`s and never one unrestricted by
   * `client_uid`. The reported row keeps the status this poll gave it, and every
   * unreported row keeps its `last_seen_at` exactly as it was (Requirement 3.4).
   */
  it('sets connected = false for exactly the rows absent from the reported set, scoped to the reported uids (Requirement 20.6)', async () => {
    const goneLastSeen = new Date('2025-02-03T04:05:06.000Z');
    const table = createDeviceTable([
      { clientUid: 'uid-reported', lastSeenAt: null, connected: false },
      { clientUid: 'uid-gone', lastSeenAt: goneLastSeen, connected: true },
      { clientUid: 'uid-also-gone', lastSeenAt: null, connected: true }
    ]);
    backPoolWith(table);

    const poller = new SubscriptionPoller({
      takServerService: createTakServerService([
        clientEndpoint({ uid: 'uid-reported', lastStatus: 'Connected' })
      ]),
      pool
    });

    const summary = await poller.run();

    expect(table.get('uid-reported').connected).toBe(true);
    expect(table.get('uid-also-gone').connected).toBe(false);
    expect(table.get('uid-gone')).toEqual({
      connected: false,
      // Requirement 3.4: the sweep is about `connected` alone.
      lastSeenAt: goneLastSeen
    });

    // Exactly one sweep, parameterised by the reported set.
    expect(unreportedSweepCalls()).toHaveLength(1);
    const [[sweepSql, sweepParams]] = unreportedSweepCalls();
    expect(sweepSql).toMatch(/WHERE\s+client_uid <> ALL\(\$1::text\[\]\)/);
    expect(sweepParams).toEqual([['uid-reported']]);

    // NEVER unscoped: every statement this run issued has a `WHERE` clause, and
    // every one of those restricts on `client_uid`.
    for (const [sql] of pool.query.mock.calls) {
      expect(sql).toMatch(/\bWHERE\b/);
      expect(sql.slice(sql.search(/\bWHERE\b/))).toContain('client_uid');
    }

    expect(summary).toMatchObject({ connected: 1, disconnected: 0, unreported: 2 });
  });

  /**
   * Requirement 20.7: a failed poll writes NO status. In particular it does not
   * mark every Device not connected -- a TAK Server outage would then be
   * indistinguishable from every device having gone offline, which is the
   * failure mode this criterion exists to forbid. Asserted on the stored state,
   * not only on "no statement was issued", because it is the state that would be
   * wrong.
   */
  it.each([
    [
      'the fetch rejects',
      () => {
        const service = createTakServerService();
        service.getClientEndpoints.mockRejectedValue(new Error('tak server unreachable'));
        return service;
      }
    ],
    ['the payload is not a list', () => createTakServerService({ unexpected: 'shape' })],
    ['the payload is null', () => createTakServerService(null)]
  ])('writes no connection status at all when %s (Requirement 20.7)', async (_label, createService) => {
    const table = createDeviceTable([
      { clientUid: 'uid-1', lastSeenAt: STORED, connected: true },
      { clientUid: 'uid-2', lastSeenAt: null, connected: true },
      { clientUid: 'uid-3', lastSeenAt: STORED, connected: false }
    ]);
    backPoolWith(table);

    const poller = new SubscriptionPoller({ takServerService: createService(), pool });

    await expect(poller.run()).resolves.toBeUndefined();

    // No statement of either kind reached the database...
    expect(pool.query).not.toHaveBeenCalled();
    // ...so every stored `connected` is exactly as it was. The two that were
    // true are still true: an outage is not "everything went offline".
    expect([...table.entries()]).toEqual([
      ['uid-1', { lastSeenAt: STORED, connected: true }],
      ['uid-2', { lastSeenAt: null, connected: true }],
      ['uid-3', { lastSeenAt: STORED, connected: false }]
    ]);
  });
});

/**
 * device-management task 30.5: the Connection_Alias reaching the two statements
 * a successful poll issues (Requirements 22.2, 22.4, 22.5, 22.6, 22.7, 22.8,
 * 22.9, 20.3).
 *
 * The derivation itself is `../../utils/connectionAlias.test.js` (examples) and
 * `../../utils/connectionAlias.property.test.js` (Property 18). What is asserted
 * HERE is what the poller does with it: the exact SQL and the exact parameter
 * array of the per-entry write and of the unreported sweep, that a native
 * payload's statements are behaviourally identical to the pre-alias ones, and --
 * the load-bearing one -- that a row the per-entry write just marked connected
 * is NOT swept back to not connected inside the same poll.
 *
 * The live examples are used throughout rather than synthetic uids, so a failure
 * names the measured defect rather than a made-up one.
 */
const LIVE_CLOUDTAK_WEB_REPORTED = 'ANDROID-CloudTAK-chris@chriselsen.net';
const LIVE_CLOUDTAK_WEB_CLIENT_UID = 'chris@chriselsen.net (Web)';
const LIVE_CLOUDTAK_ETL_CLIENT_UID = 'chris@chriselsen.net (ETL)';
const LIVE_NATIVE_UID = 'ANDROID-63040a40563b5fab';

describe('SubscriptionPoller.run connection alias (task 30.5)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  /**
   * Requirements 22.4, 22.5, 22.7: the per-entry write targets the entry's
   * Candidate_Client_Uids by EQUALITY against a complete-string array. Asserted
   * as the exact statement and the exact ordered parameter array, so neither the
   * statement's shape nor the candidate order can drift unnoticed.
   */
  it('binds the ordered Candidate_Client_Uids to `= ANY($1::text[])` with no wildcard anywhere (Requirements 22.4, 22.5, 22.7)', async () => {
    pool.query.mockResolvedValue({ rowCount: 1 });
    const poller = new SubscriptionPoller({
      takServerService: createTakServerService([
        clientEndpoint({
          uid: LIVE_CLOUDTAK_WEB_REPORTED,
          lastEventTime: '2026-08-24T06:40:16.361Z',
          lastStatus: 'Connected'
        })
      ]),
      pool
    });

    await poller.run();

    expect(lastSeenUpdateCalls()).toHaveLength(1);
    const [[sql, params]] = lastSeenUpdateCalls();

    expect(sql).toMatch(/WHERE\s+client_uid = ANY\(\$1::text\[\]\)/);
    expect(params).toEqual([
      [LIVE_CLOUDTAK_WEB_REPORTED, LIVE_CLOUDTAK_WEB_CLIENT_UID, LIVE_CLOUDTAK_ETL_CLIENT_UID],
      new Date('2026-08-24T06:40:16.361Z'),
      true
    ]);

    // Neither statement may reach a row by anything but equality (Requirement
    // 22.7): a `LIKE` or a wildcard is how a candidate lands on a row it does
    // not name.
    for (const [issuedSql] of pool.query.mock.calls) {
      expect(issuedSql).not.toMatch(/LIKE/i);
      expect(issuedSql).not.toContain('%');
      expect(issuedSql).not.toContain('*');
    }
  });

  /**
   * Requirement 22.6: the sweep is parameterised by the deduplicated UNION of
   * every entry's candidates -- the exact array, so a stale raw-keys
   * implementation fails on the parameter and not only on the resulting state.
   */
  it('binds the deduplicated candidate union to the sweep\'s `<> ALL($1::text[])` (Requirement 22.6)', async () => {
    pool.query.mockResolvedValue({ rowCount: 1 });
    const poller = new SubscriptionPoller({
      takServerService: createTakServerService([
        clientEndpoint({ uid: LIVE_NATIVE_UID }),
        // Reported twice, as TAK Server reports a client per callsign: the union
        // must not carry one copy per entry.
        clientEndpoint({ uid: LIVE_CLOUDTAK_WEB_REPORTED, callsign: 'CHRIS-1' }),
        clientEndpoint({ uid: LIVE_CLOUDTAK_WEB_REPORTED, callsign: 'CHRIS-2' })
      ]),
      pool
    });

    await poller.run();

    expect(unreportedSweepCalls()).toHaveLength(1);
    const [[sweepSql, sweepParams]] = unreportedSweepCalls();

    expect(sweepSql).toMatch(/WHERE\s+client_uid <> ALL\(\$1::text\[\]\)/);
    expect(sweepParams).toEqual([
      [
        LIVE_NATIVE_UID,
        LIVE_CLOUDTAK_WEB_REPORTED,
        LIVE_CLOUDTAK_WEB_CLIENT_UID,
        LIVE_CLOUDTAK_ETL_CLIENT_UID
      ]
    ]);
  });

  /**
   * Requirements 22.2, 22.9: a native-only payload's statements are
   * BEHAVIOURALLY IDENTICAL to the pre-alias ones -- one-element arrays holding
   * the reported uids, and a sweep union equal to the raw reported set in the
   * order it was reported. The alias is additive, so if this changes, a native
   * Device's match changed and the implementation is wrong.
   */
  it('leaves a native-only payload\'s statements behaviourally unchanged (Requirements 22.2, 22.9)', async () => {
    pool.query.mockResolvedValue({ rowCount: 1 });
    const nativeUids = [LIVE_NATIVE_UID, 'ANDROID-842f08e120efdbe3', 'S-1-5-21-2281966494-490247268-205662872-1002'];
    const poller = new SubscriptionPoller({
      takServerService: createTakServerService(nativeUids.map((uid) => clientEndpoint({ uid }))),
      pool
    });

    await poller.run();

    // One statement per reported uid, each targeted at exactly that one row.
    expect(lastSeenUpdateCalls().map(([, params]) => params[0])).toEqual(
      nativeUids.map((uid) => [uid])
    );
    // And the sweep excludes exactly the reported set -- no candidate was added.
    expect(unreportedSweepCalls()[0][1]).toEqual([nativeUids]);
  });

  /**
   * THE LOAD-BEARING REGRESSION (Requirement 22.6). The Device_Table holds
   * `chris@chriselsen.net (Web)`; the payload reports
   * `ANDROID-CloudTAK-chris@chriselsen.net`, which does not name that row. The
   * per-entry write marks it connected through the alias -- and the sweep, keyed
   * on the raw reported uids, would then set it straight back to false inside
   * the SAME poll, leaving the fix invisible on the UI while every per-entry
   * assertion above still passed.
   *
   * Asserted BOTH ways round: on the row's state at the END of the poll, and on
   * the sweep's exclusion array containing that `client_uid`.
   */
  it('leaves a row the alias just marked connected still connected at the END of the poll (Requirement 22.6)', async () => {
    const table = createDeviceTable([
      { clientUid: LIVE_CLOUDTAK_WEB_CLIENT_UID, lastSeenAt: null, connected: false },
      // A row this poll genuinely did not report, so the sweep is doing its job
      // rather than being a no-op that would pass vacuously.
      { clientUid: 'ANDROID-unreported', lastSeenAt: null, connected: true }
    ]);
    backPoolWith(table);

    const poller = new SubscriptionPoller({
      takServerService: createTakServerService([
        clientEndpoint({
          uid: LIVE_CLOUDTAK_WEB_REPORTED,
          lastEventTime: '2026-08-24T06:40:16.361Z',
          lastStatus: 'Connected'
        })
      ]),
      pool
    });

    const summary = await poller.run();

    // At the END of the poll, after the sweep ran.
    expect(table.get(LIVE_CLOUDTAK_WEB_CLIENT_UID)).toEqual({
      connected: true,
      lastSeenAt: new Date('2026-08-24T06:40:16.361Z')
    });
    // The sweep did run, and it did reach the row that really was unreported.
    expect(table.get('ANDROID-unreported').connected).toBe(false);

    // The mechanism: the excluded set CONTAINS the aliased `client_uid`, even
    // though no reported uid names it.
    const [[, sweepParams]] = unreportedSweepCalls();
    expect(sweepParams[0]).toContain(LIVE_CLOUDTAK_WEB_CLIENT_UID);
    expect(sweepParams[0]).not.toContain('ANDROID-unreported');

    expect(summary).toMatchObject({ entries: 1, observed: 1, updated: 1, connected: 1, unreported: 1 });
  });

  /**
   * Requirement 22.8: where a base has BOTH a `(Web)` and an `(ETL)` row, one
   * reported entry writes the same Last_Seen and the same Connection_Status to
   * both. The ambiguity is ACCEPTED rather than resolved -- nothing in the entry
   * distinguishes which certificate the connection used -- so `rowCount` is 2
   * and the run's `updated` count means "rows matched".
   */
  it('writes the same Last_Seen and Connection_Status to both a (Web) and an (ETL) row (Requirement 22.8)', async () => {
    const table = createDeviceTable([
      { clientUid: LIVE_CLOUDTAK_WEB_CLIENT_UID, lastSeenAt: null, connected: false },
      { clientUid: LIVE_CLOUDTAK_ETL_CLIENT_UID, lastSeenAt: null, connected: false }
    ]);
    backPoolWith(table);

    const poller = new SubscriptionPoller({
      takServerService: createTakServerService([
        clientEndpoint({
          uid: LIVE_CLOUDTAK_WEB_REPORTED,
          lastEventTime: '2026-08-24T06:40:16.361Z',
          lastStatus: 'Connected'
        })
      ]),
      pool
    });

    const summary = await poller.run();

    const expectedRow = { connected: true, lastSeenAt: new Date('2026-08-24T06:40:16.361Z') };
    expect(table.get(LIVE_CLOUDTAK_WEB_CLIENT_UID)).toEqual(expectedRow);
    expect(table.get(LIVE_CLOUDTAK_ETL_CLIENT_UID)).toEqual(expectedRow);

    // ONE statement matched TWO rows: `updated` counts Device_Table rows
    // matched, not reported uids.
    expect(lastSeenUpdateCalls()).toHaveLength(1);
    expect(summary).toMatchObject({ entries: 1, observed: 1, updated: 2, connected: 1 });
  });

  /**
   * Requirement 20.3: widening WHICH rows the statement may match must not have
   * moved the Monotonic_Guard. A reported time EQUAL to the stored value -- the
   * live shape for a Device that has simply stayed connected -- still has its
   * `connected` written to both aliased rows, and neither `last_seen_at` moves.
   * Asserted with `toBe` on the stored instance, so a re-write of the same value
   * would still be visible as a moved column, plus on the statement itself: the
   * clamp is in the `SET` list and the `WHERE` clause mentions no timestamp.
   */
  it('keeps the Monotonic_Guard in the SET list and out of the WHERE clause for an aliased row (Requirement 20.3)', async () => {
    const stored = new Date('2026-08-24T06:40:16.361Z');
    const table = createDeviceTable([
      { clientUid: LIVE_CLOUDTAK_WEB_CLIENT_UID, lastSeenAt: stored, connected: false }
    ]);
    backPoolWith(table);

    const poller = new SubscriptionPoller({
      takServerService: createTakServerService([
        clientEndpoint({
          uid: LIVE_CLOUDTAK_WEB_REPORTED,
          // Exactly the stored value: nothing to advance.
          lastEventTime: stored.toISOString(),
          lastStatus: 'Connected'
        })
      ]),
      pool
    });

    await poller.run();

    // The status landed anyway...
    expect(table.get(LIVE_CLOUDTAK_WEB_CLIENT_UID).connected).toBe(true);
    // ...and the timestamp is the very same instance: not re-written, not
    // rewound, not nulled.
    expect(table.get(LIVE_CLOUDTAK_WEB_CLIENT_UID).lastSeenAt).toBe(stored);

    const [[sql]] = lastSeenUpdateCalls();
    expect(sql).toMatch(/last_seen_at IS NULL OR last_seen_at < \$2/);
    // The clamp is in the `SET` list, so the `WHERE` clause is the candidate
    // array alone -- if the clamp were back in the `WHERE`, this statement would
    // not have matched the row and the status above would not have landed.
    expect(sql.slice(sql.search(/\bWHERE\b/))).toBe('WHERE client_uid = ANY($1::text[])');
  });
});

/**
 * Requirement 13 freshening follow-up: unit tests for
 * `mergeSubscriptionFreshness()` in isolation. TAK Server's live subscription
 * table (`GET /Marti/api/subscriptions/all`) tracks a currently-reporting
 * connection's freshness far more granularly than `ClientEndpoint.
 * lastEventTime` does -- verified live, one CloudTAK connection's
 * `lastEventTime` sat unchanged for over 20 minutes of consecutive
 * `lastStatus: "Connected"` polls while its live-subscription entry's
 * `lastReportMilliseconds` advanced multiple times within a single minute.
 * This is the pure merge step that closes that gap, called from `run()`
 * after `extractLastEventTimes()` and before the per-uid write loop.
 */
describe('mergeSubscriptionFreshness', () => {
  /** A `SubscriptionInfo`-shaped live entry, matching the live payload's fields. */
  function subscriptionInfo(overrides = {}) {
    return {
      dn: null,
      callsign: 'FENZ-STL-C.Elsen',
      clientUid: 'uid-1',
      lastReportMilliseconds: Date.parse('2026-08-25T04:40:50.553Z'),
      takClient: 'CloudTAK',
      username: 'chris@chriselsen.net',
      ...overrides
    };
  }

  it('advances a reported uid\'s lastEventTime when the live subscription reports a later time', () => {
    const reportedByUid = new Map([
      ['uid-1', { lastEventTime: new Date('2026-08-25T04:26:26.181Z'), connected: true }]
    ]);
    const laterMs = Date.parse('2026-08-25T04:40:50.553Z');

    const freshened = mergeSubscriptionFreshness(reportedByUid, [
      subscriptionInfo({ clientUid: 'uid-1', lastReportMilliseconds: laterMs })
    ]);

    expect(freshened).toBe(1);
    expect(reportedByUid.get('uid-1').lastEventTime).toEqual(new Date(laterMs));
    // `connected` is untouched -- this merge concerns Last_Seen only.
    expect(reportedByUid.get('uid-1').connected).toBe(true);
  });

  it('does not move lastEventTime backward when the live subscription reports an earlier time (Monotonic_Guard)', () => {
    const stored = new Date('2026-08-25T04:40:50.553Z');
    const reportedByUid = new Map([['uid-1', { lastEventTime: stored, connected: true }]]);
    const earlierMs = Date.parse('2026-08-25T04:26:26.181Z');

    const freshened = mergeSubscriptionFreshness(reportedByUid, [
      subscriptionInfo({ clientUid: 'uid-1', lastReportMilliseconds: earlierMs })
    ]);

    expect(freshened).toBe(0);
    // The very same Date instance -- not rewound, not replaced with an equal
    // value either.
    expect(reportedByUid.get('uid-1').lastEventTime).toBe(stored);
  });

  it('sets lastEventTime from the live subscription when the primary source reported none at all (Requirement 13.6 territory)', () => {
    // An entry whose ClientEndpoint.lastEventTime was absent/unparseable still
    // reaches this map with `lastEventTime: null` (task 28.2, Requirement
    // 20.4) -- carrying a status but no timestamp. The live-subscriptions
    // merge can still supply one.
    const reportedByUid = new Map([['uid-1', { lastEventTime: null, connected: true }]]);
    const reportMs = Date.parse('2026-08-25T04:40:50.553Z');

    const freshened = mergeSubscriptionFreshness(reportedByUid, [
      subscriptionInfo({ clientUid: 'uid-1', lastReportMilliseconds: reportMs })
    ]);

    expect(freshened).toBe(1);
    expect(reportedByUid.get('uid-1').lastEventTime).toEqual(new Date(reportMs));
  });

  it('does not insert a uid the primary source did not report this poll (additive only, Requirement 22.2 parity)', () => {
    // `uid-untracked` is not a key of `reportedByUid` at all -- the primary
    // source (`getClientEndpoints()`) never reported it this poll. The live
    // subscription naming it must not add it: this merge freshens an EXISTING
    // reported uid's timestamp, it never widens which uids a poll reports.
    const reportedByUid = new Map([['uid-1', { lastEventTime: null, connected: false }]]);

    const freshened = mergeSubscriptionFreshness(reportedByUid, [
      subscriptionInfo({ clientUid: 'uid-untracked', lastReportMilliseconds: Date.now() })
    ]);

    expect(freshened).toBe(0);
    expect(reportedByUid.has('uid-untracked')).toBe(false);
    expect(reportedByUid.size).toBe(1);
  });

  it('skips entries with an empty clientUid without logging -- the normal shape for a non-Device connection (e.g. a CloudTAK ETL)', () => {
    const reportedByUid = new Map([['uid-1', { lastEventTime: null, connected: false }]]);

    const freshened = mergeSubscriptionFreshness(reportedByUid, [
      subscriptionInfo({ dn: 'CN=etl-adsbx, OU=TAK Unit, O=TAK', clientUid: '', callsign: 'tls:7101' })
    ]);

    expect(freshened).toBe(0);
    expect(reportedByUid.get('uid-1').lastEventTime).toBeNull();
  });

  it.each([
    ['missing clientUid', { clientUid: undefined }],
    ['null clientUid', { clientUid: null }],
    ['numeric clientUid', { clientUid: 42 }],
    ['missing lastReportMilliseconds', { lastReportMilliseconds: undefined }],
    ['null lastReportMilliseconds', { lastReportMilliseconds: null }],
    ['string lastReportMilliseconds', { lastReportMilliseconds: '1787633240530' }],
    ['NaN lastReportMilliseconds', { lastReportMilliseconds: NaN }],
    ['Infinity lastReportMilliseconds', { lastReportMilliseconds: Infinity }]
  ])('is total: does not throw and leaves the map unchanged for %s', (_label, overrides) => {
    const reportedByUid = new Map([['uid-1', { lastEventTime: null, connected: false }]]);

    expect(() =>
      mergeSubscriptionFreshness(reportedByUid, [subscriptionInfo({ clientUid: 'uid-1', ...overrides })])
    ).not.toThrow();
    expect(reportedByUid.get('uid-1').lastEventTime).toBeNull();
  });

  it.each([
    ['a non-object entry (string)', 'not-an-object'],
    ['a non-object entry (number)', 42],
    ['null', null]
  ])('is total: does not throw for %s as a list entry', (_label, entry) => {
    const reportedByUid = new Map([['uid-1', { lastEventTime: null, connected: false }]]);

    expect(() => mergeSubscriptionFreshness(reportedByUid, [entry])).not.toThrow();
  });

  /**
   * Bugfix (Connection_Status disagreement between TAK Server's two views).
   * Presence in this view is itself proof of an open session -- verified
   * live, a CloudTAK session's live-subscription entry reported every few
   * seconds while its clientEndPoints entry sat at `lastStatus:
   * "Disconnected"` throughout, leaving the "Currently Connected" badge
   * absent for a session that plainly was connected. This is the OR this
   * fix adds: a uid the live-subscriptions table names is marked connected
   * REGARDLESS of what ClientEndpoint.lastStatus said for it, and
   * regardless of whether this call also finds a usable
   * lastReportMilliseconds to freshen the timestamp with.
   */
  it('marks a reported uid connected on PRESENCE alone, even when the primary source reported it disconnected (Connection_Status bugfix)', () => {
    const reportedByUid = new Map([
      ['uid-1', { lastEventTime: new Date('2026-08-25T04:00:00.000Z'), connected: false }]
    ]);

    const freshened = mergeSubscriptionFreshness(reportedByUid, [
      subscriptionInfo({ clientUid: 'uid-1', lastReportMilliseconds: Date.parse('2026-08-25T04:26:26.181Z') })
    ]);

    expect(freshened).toBe(1);
    expect(reportedByUid.get('uid-1').connected).toBe(true);
  });

  it('marks a reported uid connected on presence alone even without a usable lastReportMilliseconds (Connection_Status bugfix)', () => {
    const reportedByUid = new Map([
      ['uid-1', { lastEventTime: new Date('2026-08-25T04:00:00.000Z'), connected: false }]
    ]);

    const freshened = mergeSubscriptionFreshness(reportedByUid, [
      subscriptionInfo({ clientUid: 'uid-1', lastReportMilliseconds: null })
    ]);

    // The timestamp effect declines (nothing usable to advance with)...
    expect(freshened).toBe(0);
    // ...but the connected effect does not depend on it at all.
    expect(reportedByUid.get('uid-1').connected).toBe(true);
  });

  it('never turns an already-true connected value false (OR, never AND/overwrite)', () => {
    const reportedByUid = new Map([['uid-1', { lastEventTime: null, connected: true }]]);

    mergeSubscriptionFreshness(reportedByUid, [
      subscriptionInfo({ clientUid: 'uid-1', lastReportMilliseconds: Date.now() })
    ]);

    expect(reportedByUid.get('uid-1').connected).toBe(true);
  });

  it('leaves connected untouched for a uid this view does not name (additive only)', () => {
    const reportedByUid = new Map([['uid-1', { lastEventTime: null, connected: false }]]);

    mergeSubscriptionFreshness(reportedByUid, [
      subscriptionInfo({ clientUid: 'uid-other', lastReportMilliseconds: Date.now() })
    ]);

    expect(reportedByUid.get('uid-1').connected).toBe(false);
  });

  it('freshens multiple reported uids independently in one call, counting only those it actually advances', () => {
    const reportedByUid = new Map([
      ['uid-a', { lastEventTime: new Date('2026-01-01T00:00:00Z'), connected: true }],
      ['uid-b', { lastEventTime: new Date('2026-06-01T00:00:00Z'), connected: false }],
      ['uid-c', { lastEventTime: null, connected: false }]
    ]);

    const freshened = mergeSubscriptionFreshness(reportedByUid, [
      // Advances uid-a.
      subscriptionInfo({ clientUid: 'uid-a', lastReportMilliseconds: Date.parse('2026-02-01T00:00:00Z') }),
      // Does NOT advance uid-b: earlier than what is already stored.
      subscriptionInfo({ clientUid: 'uid-b', lastReportMilliseconds: Date.parse('2026-01-01T00:00:00Z') }),
      // Advances uid-c from null.
      subscriptionInfo({ clientUid: 'uid-c', lastReportMilliseconds: Date.parse('2026-03-01T00:00:00Z') })
    ]);

    expect(freshened).toBe(2);
    expect(reportedByUid.get('uid-a').lastEventTime).toEqual(new Date('2026-02-01T00:00:00Z'));
    expect(reportedByUid.get('uid-b').lastEventTime).toEqual(new Date('2026-06-01T00:00:00Z'));
    expect(reportedByUid.get('uid-c').lastEventTime).toEqual(new Date('2026-03-01T00:00:00Z'));
  });
});

/**
 * Requirement 13 freshening follow-up: `run()`-level integration of the
 * freshening merge -- the interaction between the two fetches, the
 * per-uid write loop consuming the freshened value, and the best-effort
 * failure handling that must never touch `outcome` or the primary source's
 * own guarantees.
 */
describe('SubscriptionPoller.run live-subscriptions freshening', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    pool.query.mockResolvedValue({ rowCount: 1 });
  });

  it('writes the freshened (later) timestamp, not the primary source\'s own lastEventTime, when the live subscription is more recent', async () => {
    const takServerService = createTakServerService(
      [clientEndpoint({ uid: 'uid-1', lastEventTime: '2026-08-25T04:26:26.181Z', lastStatus: 'Connected' })],
      [
        {
          clientUid: 'uid-1',
          lastReportMilliseconds: Date.parse('2026-08-25T04:40:50.553Z')
        }
      ]
    );
    const poller = new SubscriptionPoller({ takServerService, pool });

    const summary = await poller.run();

    expect(recordedLastSeen()).toEqual([[['uid-1'], new Date('2026-08-25T04:40:50.553Z')]]);
    expect(summary).toEqual({
      entries: 1,
      observed: 1,
      skipped: 0,
      freshened: 1,
      updated: 1,
      failed: 0,
      connected: 1,
      disconnected: 0,
      // The mocked pool answers every statement with rowCount: 1 (this
      // describe block's beforeEach), including the unreported sweep -- same
      // convention the other describe blocks in this file use.
      unreported: 1
    });
  });

  it('reports freshened: 0 and writes the primary source\'s own value when the live subscription has nothing newer', async () => {
    const takServerService = createTakServerService(
      [clientEndpoint({ uid: 'uid-1', lastEventTime: '2026-08-25T04:40:50.553Z', lastStatus: 'Connected' })],
      [{ clientUid: 'uid-1', lastReportMilliseconds: Date.parse('2026-08-25T04:26:26.181Z') }]
    );
    const poller = new SubscriptionPoller({ takServerService, pool });

    const summary = await poller.run();

    expect(recordedLastSeen()).toEqual([[['uid-1'], new Date('2026-08-25T04:40:50.553Z')]]);
    expect(summary.freshened).toBe(0);
  });

  it('leaves a Device the live-subscriptions table cannot identify (empty clientUid, e.g. a CloudTAK ETL) sourced from lastEventTime alone', async () => {
    const takServerService = createTakServerService(
      [clientEndpoint({ uid: 'etl-adsbx', lastEventTime: '2026-08-25T04:00:00.000Z' })],
      [{ dn: 'CN=etl-adsbx, OU=TAK Unit, O=TAK', clientUid: '', lastReportMilliseconds: Date.now() }]
    );
    const poller = new SubscriptionPoller({ takServerService, pool });

    const summary = await poller.run();

    expect(recordedLastSeen()).toEqual([[['etl-adsbx'], new Date('2026-08-25T04:00:00.000Z')]]);
    expect(summary.freshened).toBe(0);
  });

  it('does not fail the run, does not touch outcome, and logs at warn (not error) when the live-subscriptions fetch rejects', async () => {
    const takServerService = createTakServerService([clientEndpoint({ uid: 'uid-1' })]);
    takServerService.getAllSubscriptions.mockRejectedValue(new Error('subscriptions endpoint unreachable'));

    const summary = await new SubscriptionPoller({ takServerService, pool }).run();

    // The run still COMPLETES -- this is best-effort, not a second
    // documented-endpoint failure path (contrast the primary fetch's
    // failure handling, which returns undefined).
    expect(summary).toBeDefined();
    expect(summary.freshened).toBe(0);
    expect(summary.updated).toBe(1);
    expect(mockLoggerInstance.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error), endpoint: '/Marti/api/subscriptions/all' }),
      expect.stringContaining('live subscriptions')
    );
    expect(mockLoggerInstance.error).not.toHaveBeenCalled();
    expect(mockLoggerInstance.info).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'completed' }),
      'Subscription poll completed'
    );
  });

  it('does not fail the run and logs at warn when the live-subscriptions payload is malformed (not a list)', async () => {
    const takServerService = createTakServerService([clientEndpoint({ uid: 'uid-1' })]);
    takServerService.getAllSubscriptions.mockResolvedValue({ not: 'a list' });

    const summary = await new SubscriptionPoller({ takServerService, pool }).run();

    expect(summary).toBeDefined();
    expect(summary.freshened).toBe(0);
    expect(summary.updated).toBe(1);
    expect(mockLoggerInstance.warn).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: '/Marti/api/subscriptions/all', payloadType: 'object' }),
      expect.stringContaining('malformed')
    );
    expect(mockLoggerInstance.error).not.toHaveBeenCalled();
  });

  /**
   * Bugfix (Connection_Status disagreement between TAK Server's two views),
   * at the `run()` level: the exact live scenario that motivated it. The
   * primary source reports the uid `lastStatus: "Disconnected"`; the
   * live-subscriptions table reports that SAME uid as an open session. The
   * fix ORs the two, so the write and the run summary both land connected
   * -- previously this scenario landed `connected: false` because the
   * freshening merge touched only the timestamp.
   */
  it('writes connected when the primary source says Disconnected but the live subscriptions table names the same uid (Connection_Status bugfix)', async () => {
    const takServerService = createTakServerService(
      [clientEndpoint({ uid: 'uid-1', lastEventTime: '2026-08-25T04:22:16.383Z', lastStatus: 'Disconnected' })],
      [{ clientUid: 'uid-1', lastReportMilliseconds: Date.parse('2026-08-25T04:40:50.553Z') }]
    );
    const poller = new SubscriptionPoller({ takServerService, pool });

    const summary = await poller.run();

    expect(lastSeenUpdateCalls()[0][1]).toEqual([['uid-1'], new Date('2026-08-25T04:40:50.553Z'), true]);
    expect(summary).toMatchObject({ connected: 1, disconnected: 0 });
  });

  it('freshening failure does not prevent the per-uid write or the unreported sweep from running', async () => {
    const takServerService = createTakServerService([clientEndpoint({ uid: 'uid-1' })]);
    takServerService.getAllSubscriptions.mockRejectedValue(new Error('boom'));

    await new SubscriptionPoller({ takServerService, pool }).run();

    expect(lastSeenUpdateCalls()).toHaveLength(1);
    expect(unreportedSweepCalls()).toHaveLength(1);
  });
});
