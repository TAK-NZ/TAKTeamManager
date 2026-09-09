/**
 * device-management tasks 16.3 / 21.3 (21.3 wins where they differ): the single
 * `fast-check` property test for design.md's Property 3 (Requirements 3.2, 3.3,
 * 3.4, 13.4, and the explicitly required fast-check test of Requirement 9.8,
 * which Requirement 13.5 keeps required and points at the Monotonic_Guard).
 *
 * design.md's exact Property 3 statement: "For all sequences of reported
 * `lastEventTime` values for a Device (each poll's Client_Endpoints_API entry
 * for that `uid`), applying each in order SHALL leave the Device's stored
 * Last_Seen equal to the maximum reported timestamp seen so far, so that no
 * poll moves Last_Seen backward and no poll nulls an already-set Last_Seen; a
 * Device TAK Server has never reported retains a null Last_Seen."
 *
 * This is a MODEL-BASED property test: the mocked pool is backed by an
 * in-memory `client_uid -> last_seen_at` map that faithfully applies the
 * poller's clamped `UPDATE tak_devices SET connected = ($3 AND revoked = false), last_seen_at = CASE
 * WHEN $2::timestamptz IS NOT NULL AND (last_seen_at IS NULL OR last_seen_at <
 * $2) THEN $2 ELSE last_seen_at END WHERE client_uid = ANY($1::text[])`, and
 * the REAL
 * `SubscriptionPoller.run()` drives it. The expectation is computed
 * independently of that clamp -- as a plain running maximum over the generated
 * REPORTED timestamps -- so the assertions cannot be satisfied tautologically
 * by re-applying the implementation's own logic.
 *
 * Task 28.2 moved that clamp out of the `WHERE` clause and into the `SET` list
 * so the `connected` column beside it is written unconditionally (Requirement
 * 20.3). This property is unchanged in force by that: `last_seen_at` keeps
 * exactly the semantics asserted here. What changed in this file is only what
 * the model must interpret -- the new statement shape, a `null` `$2` for an
 * unusable reported time, and the once-per-run unreported-uid status sweep,
 * which must leave every `last_seen_at` alone. The `connected` column itself is
 * task 28.8's Property 17, not this one's.
 *
 * Task 21.3's change: the generated sequences are the `lastEventTime` values
 * TAK Server reports on each `ClientEndpoint` entry, not observation times.
 * Nothing in the poller reads the clock any more, so there are no fake timers
 * here: every timestamp in play arrives through the payload, deliberately
 * including out-of-order/backward ones, duplicate entries for one `uid` within
 * a single poll, both `lastStatus` values (never filtered on, Requirement
 * 13.2), and unusable `lastEventTime` values that must leave a stored value
 * untouched (Requirement 13.6).
 */

jest.mock('../../config/database', () => ({
  query: jest.fn()
}));

jest.mock('../../config/logger', () => ({
  createLogger: jest.fn(() => ({
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn()
  }))
}));

const fc = require('fast-check');
const { test } = require('@fast-check/jest');

const SubscriptionPoller = require('../SubscriptionPoller');

/** Devices that exist in the Device_Table for a generated run. */
const TRACKED_UIDS = ['uid-a', 'uid-b', 'uid-c'];

/**
 * A `client_uid` the Client_Endpoints_API can report but that has NO
 * Device_Table row: inserting rows is the Device_Sync's job, never the
 * poller's, so this uid must stay absent from the store.
 */
const UNTRACKED_UID = 'uid-untracked';

const REPORTABLE_UIDS = [...TRACKED_UIDS, UNTRACKED_UID];

/** Fixed epoch the generated millisecond offsets are relative to. */
const BASE_MS = Date.UTC(2025, 0, 1, 0, 0, 0);

/**
 * The in-memory Device_Table stand-in: `client_uid -> last_seen_at`
 * (`Date` or `null`). A missing key means "no such Device row".
 *
 * @typedef {Map<string, Date|null>} DeviceStore
 */

/**
 * Builds a pool whose `query` faithfully applies the poller's monotonic-forward
 * clamp against `store`.
 *
 * Each statement's shape is verified before it is interpreted: if the poller
 * ever issues something other than the two statements this model covers -- the
 * per-uid write and the unreported-uid status sweep -- the test fails loudly
 * rather than silently modelling a statement the implementation no longer sends.
 *
 * @param {DeviceStore} store
 * @returns {{query: jest.Mock}}
 */
function createModelPool(store) {
  return {
    query: jest.fn(async (sql, params) => {
      if (typeof sql !== 'string' || !sql.includes('UPDATE tak_devices')) {
        throw new Error(`Unmodelled statement issued by SubscriptionPoller: ${sql}`);
      }

      // Task 28.2's once-per-successful-run status sweep (Requirement 20.6).
      // This property is about `last_seen_at`, and the sweep must never touch
      // it -- asserted here rather than assumed (Requirement 3.4). It is scoped
      // to the uids ABSENT from the reported set, so it is modelled as writing
      // no timestamp at all.
      if (sql.includes('<> ALL')) {
        if (sql.includes('last_seen_at')) {
          throw new Error(`The unreported-uid status sweep must not touch last_seen_at: ${sql}`);
        }
        if (!/WHERE\s+client_uid <> ALL\(\$1::text\[\]\)/.test(sql) || !Array.isArray(params[0])) {
          throw new Error(`The unreported-uid status sweep must be scoped to the reported uids: ${sql}`);
        }

        const reported = new Set(params[0]);
        return { rowCount: [...store.keys()].filter((uid) => !reported.has(uid)).length };
      }

      if (
        // Since the revoked-guard fix the connected write is
        // `connected = ($3 AND revoked = false)` (a revoked row is never marked
        // connected) rather than a bare `connected = $3`. This model is about
        // `last_seen_at` (Property 3), which the guard does not affect, so it
        // only needs to recognise the statement — the `connected` value itself
        // is not stored here.
        !/SET\s+connected = \(\s*\$3\s+AND\s+revoked = false\s*\)/.test(sql) ||
        !/last_seen_at = CASE/.test(sql) ||
        !/last_seen_at IS NULL OR last_seen_at < \$2/.test(sql) ||
        !/ELSE last_seen_at/.test(sql) ||
        // Task 30.2 widened the target from one `client_uid` to the reported
        // uid's Candidate_Client_Uids (Requirement 22.4). Equality against a
        // complete-string array only -- no `LIKE`, no wildcard (Requirement
        // 22.7).
        !/WHERE\s+client_uid = ANY\(\$1::text\[\]\)/.test(sql) ||
        // The clamp must NOT have crept back into the `WHERE` clause, where it
        // would be a no-match for a non-advancing reported time (Requirement
        // 20.3).
        /WHERE[\s\S]*last_seen_at/.test(sql)
      ) {
        throw new Error(`Unmodelled statement issued by SubscriptionPoller: ${sql}`);
      }

      const [clientUids, lastEventTime, connected] = params;
      if (!Array.isArray(clientUids)) {
        throw new Error('Expected the per-entry write to be targeted at an array of candidate client_uids');
      }
      if (typeof connected !== 'boolean') {
        throw new Error('Expected the collapsed connection status to be bound as a boolean');
      }
      if (lastEventTime !== null && (!(lastEventTime instanceof Date) || !Number.isFinite(lastEventTime.getTime()))) {
        // Requirement 13.6: an unusable reported time must never reach the
        // database as an invalid Date or an unparseable string. Since task 28.2
        // it reaches it as `null` -- the statement's CASE leaves the stored
        // value alone for that, which is how the entry's status still lands
        // without costing the Device its Last_Seen (Requirement 20.4).
        throw new Error('Expected the reported lastEventTime to be bound as a valid Date or null');
      }

      // `WHERE client_uid = ANY($1::text[])` matches EVERY row whose
      // `client_uid` is a member of the candidate array, so the model applies
      // the clamp once per matched row and reports how many matched. Since task
      // 30.2 that count may exceed 1 -- a base with both a `<base> (Web)` and a
      // `<base> (ETL)` row legitimately receives the same write (Requirement
      // 22.8) -- and a candidate naming no row simply contributes nothing.
      let matched = 0;
      for (const candidate of clientUids) {
        if (!store.has(candidate)) continue;
        matched += 1;

        const stored = store.get(candidate);
        if (lastEventTime !== null && (stored === null || stored.getTime() < lastEventTime.getTime())) {
          store.set(candidate, lastEventTime);
        }
      }

      // Every matched row had `connected` written -- whether or not its
      // `last_seen_at` moved. That is the point of the clamp's relocation
      // (Requirement 20.3).
      return { rowCount: matched };
    })
  };
}

/**
 * @returns {{getClientEndpoints: jest.Mock, getAllSubscriptions: jest.Mock}}
 *   `getAllSubscriptions` resolves to `[]` -- this property is about the
 *   PRIMARY source's Monotonic_Guard (`lastEventTime`), so the
 *   Requirement-13-freshening merge is kept a no-op throughout rather than
 *   introducing a second timestamp generator into this model. Freshening's
 *   own guarantees are covered by `SubscriptionPoller.test.js`'s
 *   `mergeSubscriptionFreshness` unit tests instead.
 */
function createTakServerService() {
  return { getClientEndpoints: jest.fn(), getAllSubscriptions: jest.fn().mockResolvedValue([]) };
}

/**
 * Every `lastEventTime` shape the Client_Endpoints_API can hand over. A number
 * is an offset from `BASE_MS` (which may be earlier than a previously reported
 * one, exercising the backward case); everything else is unusable and must
 * leave the Device's stored value untouched (Requirement 13.6).
 */
const UNUSABLE_LAST_EVENT_TIMES = [undefined, null, '', '   ', 'whenever', NaN];

/**
 * One generated `ClientEndpoint` entry. `lastStatus` is generated on both
 * values because the poller never filters on it (Requirement 13.2) -- a
 * `Disconnected` entry must be recorded exactly like a `Connected` one.
 */
const entryArb = fc.record({
  uid: fc.constantFrom(...REPORTABLE_UIDS),
  reported: fc.oneof(
    { weight: 9, arbitrary: fc.integer({ min: -50000, max: 150000 }) },
    { weight: 1, arbitrary: fc.constantFrom(...UNUSABLE_LAST_EVENT_TIMES) }
  ),
  lastStatus: fc.constantFrom('Connected', 'Disconnected')
});

/**
 * Generated poll: the `ClientEndpoint` entries one Client_Endpoints_API read
 * returns. Duplicate uids within a poll (TAK Server may report a client more
 * than once) and empty payloads are both reachable.
 */
const pollArb = fc.array(entryArb, { maxLength: 6 });

/**
 * Generated pre-existing Device_Table state: each tracked Device starts
 * either never-seen (`null`) or already carrying a Last_Seen somewhere in
 * the middle of the generated timestamp range, so both "first reported time"
 * and "reported time older than the stored value" arise.
 */
const initialLastSeenArb = fc.tuple(
  ...TRACKED_UIDS.map(() => fc.oneof(fc.constant(null), fc.integer({ min: 0, max: 100000 })))
);

/**
 * Whether a generated `reported` value is a usable offset from `BASE_MS`.
 * `NaN` is drawn as one of the unusable values and is a `number`, so a
 * `typeof` check alone would let it through as a timestamp.
 */
function isUsableOffset(reported) {
  return typeof reported === 'number' && Number.isFinite(reported);
}

/** The wire shape the poller consumes: `lastEventTime` as TAK Server sends it. */
function toClientEndpoint(entry) {
  return {
    callsign: `CALLSIGN-${entry.uid}`,
    uid: entry.uid,
    username: 'alice',
    team: 'Cyan',
    role: 'Team Member',
    lastEventTime: isUsableOffset(entry.reported)
      ? new Date(BASE_MS + entry.reported).toISOString()
      : entry.reported,
    lastStatus: entry.lastStatus
  };
}

/**
 * The greatest USABLE reported time per uid in one poll, computed straight from
 * the generated data -- this is the sequence element Property 3 quantifies
 * over. Entries with an unusable `lastEventTime` contribute nothing, which is
 * how Requirement 13.6's "leave it unchanged" is expressed in the model.
 *
 * @param {Array<{uid: string, reported: unknown}>} poll
 * @returns {Map<string, number>}
 */
function reportedMaxByUid(poll) {
  const reported = new Map();

  for (const entry of poll) {
    if (!isUsableOffset(entry.reported)) continue;

    const ms = BASE_MS + entry.reported;
    const incumbent = reported.get(entry.uid);
    if (incumbent === undefined || ms > incumbent) reported.set(entry.uid, ms);
  }

  return reported;
}

// Feature: device-management, Property 3: Last_Seen is monotonic-forward
describe('Property 3: Last_Seen is monotonic-forward', () => {
  test.prop([initialLastSeenArb, fc.array(pollArb, { minLength: 1, maxLength: 8 })], {
    numRuns: 200
  })(
    'leaves each stored Last_Seen equal to the running max of the reported lastEventTime values, never backward, never nulled, and never invents a row',
    async (initialOffsets, polls) => {
      /** @type {DeviceStore} */
      const store = new Map();
      TRACKED_UIDS.forEach((uid, index) => {
        const offset = initialOffsets[index];
        store.set(uid, offset === null ? null : new Date(BASE_MS + offset));
      });

      const takServerService = createTakServerService();
      const pool = createModelPool(store);
      const poller = new SubscriptionPoller({ takServerService, pool });

      // Model expectation, computed independently of the poller's guard: the
      // running maximum of the initial value and every reported time applied so
      // far. `null` until a Device is first reported with a usable time.
      /** @type {Map<string, number|null>} */
      const expectedMax = new Map(
        TRACKED_UIDS.map((uid, index) => [uid, initialOffsets[index] === null ? null : BASE_MS + initialOffsets[index]])
      );

      for (const poll of polls) {
        const previous = new Map(store);
        const reported = reportedMaxByUid(poll);

        takServerService.getClientEndpoints.mockResolvedValueOnce(poll.map(toClientEndpoint));

        const summary = await poller.run();

        // Every entry carrying a usable uid AND a parseable lastEventTime was
        // acted on; the rest were skipped, not written (Requirement 13.6).
        expect(summary.entries).toBe(poll.length);
        expect(summary.observed).toBe(reported.size);

        for (const uid of TRACKED_UIDS) {
          const priorExpected = expectedMax.get(uid);
          const reportedMax = reported.get(uid);
          if (reportedMax !== undefined) {
            expectedMax.set(uid, priorExpected === null ? reportedMax : Math.max(priorExpected, reportedMax));
          }

          const stored = store.get(uid);
          const expected = expectedMax.get(uid);

          // Stored Last_Seen equals the running max of the REPORTED times
          // (Requirements 3.2, 3.3, 13.1, 13.4).
          if (expected === null) {
            // Never reported with a usable time and no prior value: still null
            // ("never seen", Requirements 3.5, 3.7).
            expect(stored).toBeNull();
          } else {
            expect(stored).toBeInstanceOf(Date);
            expect(stored.getTime()).toBe(expected);
          }

          const priorStored = previous.get(uid);
          if (priorStored !== null) {
            // Never nulls an already-set value, never moves it backward
            // (Requirements 3.3, 3.4, 13.4).
            expect(stored).not.toBeNull();
            expect(stored.getTime()).toBeGreaterThanOrEqual(priorStored.getTime());
          }

          if (reportedMax === undefined) {
            // A Device this poll carried no usable entry for is left entirely
            // untouched, including a null value (Requirements 3.4, 13.6).
            expect(stored).toBe(priorStored);
          }
        }

        // A reported uid with no Device_Table row is never inserted.
        expect(store.has(UNTRACKED_UID)).toBe(false);
      }

      // Every tracked Device ever reported with a usable time ended up with a
      // non-null Last_Seen: no reported time retains null.
      const everReported = new Set(polls.flatMap((poll) => [...reportedMaxByUid(poll).keys()]));
      for (const uid of TRACKED_UIDS) {
        if (everReported.has(uid)) {
          expect(store.get(uid)).toBeInstanceOf(Date);
        }
      }
    }
  );
});
